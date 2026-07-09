# API clients, models, protocol, prompts, and transport support tests  `stage-23.6.4`

This stage is cross-cutting test infrastructure for the system’s client-facing and protocol-heavy layers: it validates the code that sits between startup configuration and the main execution loop, where models are selected, prompts are rendered, requests are encoded, transports are opened, and responses are interpreted. The model and provider tests cover registry TOML parsing, built-in provider defaults, collaboration presets, `ModelInfo` construction and override semantics, manager refresh/cache policy, and on-disk model-cache TTL behavior, with `models-manager` test support supplying deterministic fixtures. API and auth client tests then lock down HTTP paths, payloads, headers, retries, error mapping, JWT parsing, workspace URL encoding, and TLS/CA handling across backend, login, ChatGPT, Codex API, and core client code. Prompt tests pin exact rendered text for goals, reviews, exits, and memory-writing flows. Protocol and execution tests verify error formatting, shell-output decoding, code-mode session/cell contracts, and RMCP framing, auth-challenge parsing, OAuth startup, and recovery logic. Finally, transport-support tests exercise WebSocket, SSE, Unix sockets, MITM proxy policy, rustls provider installation, and mock cloud backends so higher-level tests can run against realistic but controlled environments.

## Files in this stage

### Model registry and cache tests
These tests build from provider and preset definitions through model-info overrides into full model-manager orchestration and cache behavior.

### `model-provider-info/src/model_provider_info_tests.rs`

`test` · `test execution for provider config parsing and validation`

This test module is the executable specification for `ModelProviderInfo` behavior. Several tests deserialize TOML snippets into full `ModelProviderInfo` values and compare every field, covering simple providers, Azure-style providers with `query_params`, custom static and env-backed headers, websocket timeout parsing, command-backed auth defaults, and AWS auth blocks. `test_deserialize_chat_wire_api_shows_helpful_error` specifically checks that `wire_api = "chat"` fails with the migration guidance string rather than a generic enum error.

Capability and conversion behavior are covered by tests for `supports_remote_compaction` on OpenAI, Azure-like, and unrelated providers, plus `test_personal_access_token_uses_chatgpt_codex_base_url`, which verifies `to_api_provider` switches OpenAI to the ChatGPT Codex base URL under `AuthMode::PersonalAccessToken`. Bedrock-focused tests assert the exact provider produced by `create_amazon_bedrock_provider`, confirm the Mantle client-agent header survives conversion to `ApiProvider`, and ensure the built-in provider map includes the Bedrock entry.

The merge tests document the special treatment of `amazon-bedrock`: custom providers are added normally, Bedrock `aws.profile`/`aws.region` overrides are applied into the built-in entry, non-default Bedrock fields are rejected, and default-only Bedrock config is accepted as a no-op. Finally, validation tests prove AWS auth cannot coexist with conflicting auth fields or websocket support, and that command auth deserialization allows a zero refresh interval. Together these tests capture both the schema surface and the policy constraints encoded in the library.

#### Function details

##### `test_deserialize_ollama_model_provider_toml`  (lines 9–36)

```
fn test_deserialize_ollama_model_provider_toml()
```

**Purpose**: Verifies that a minimal TOML provider definition for an Ollama-style endpoint deserializes into the expected `ModelProviderInfo` with defaulted optional fields.

**Data flow**: It defines a TOML string with `name` and `base_url`, deserializes it with `toml::from_str`, constructs the expected `ModelProviderInfo` value explicitly, and asserts equality.

**Call relations**: This test exercises serde defaults for omitted provider fields and confirms `wire_api` defaults to `Responses`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_deserialize_azure_model_provider_toml`  (lines 39–70)

```
fn test_deserialize_azure_model_provider_toml()
```

**Purpose**: Checks deserialization of an Azure-style provider including `env_key` and query parameters.

**Data flow**: It parses TOML containing `name`, `base_url`, `env_key`, and `query_params`, builds the expected struct with a one-entry `HashMap` for `api-version`, and asserts the parsed provider matches.

**Call relations**: This test validates that provider query parameters survive TOML parsing into the runtime schema.

*Call graph*: 3 external calls (assert_eq!, hashmap!, from_str).


##### `test_deserialize_example_model_provider_toml`  (lines 73–107)

```
fn test_deserialize_example_model_provider_toml()
```

**Purpose**: Verifies deserialization of both static HTTP headers and environment-backed HTTP headers from TOML.

**Data flow**: It parses a TOML provider containing `http_headers` and `env_http_headers`, constructs the expected `ModelProviderInfo` with corresponding maps, and asserts equality.

**Call relations**: This test covers the schema fields later consumed by `ModelProviderInfo::build_header_map`.

*Call graph*: 3 external calls (assert_eq!, hashmap!, from_str).


##### `test_deserialize_chat_wire_api_shows_helpful_error`  (lines 110–120)

```
fn test_deserialize_chat_wire_api_shows_helpful_error()
```

**Purpose**: Ensures legacy `wire_api = "chat"` configuration fails with the explicit migration help text.

**Data flow**: It parses a TOML provider string containing `wire_api = "chat"`, captures the deserialization error, converts it to a string, and asserts that string contains `CHAT_WIRE_API_REMOVED_ERROR`.

**Call relations**: This test targets the custom `WireApi::deserialize` implementation and its user-facing error message.

*Call graph*: 1 external calls (assert!).


##### `test_deserialize_websocket_connect_timeout`  (lines 123–133)

```
fn test_deserialize_websocket_connect_timeout()
```

**Purpose**: Checks that `websocket_connect_timeout_ms` deserializes correctly into the provider struct.

**Data flow**: It parses a TOML provider with `websocket_connect_timeout_ms = 15000` and `supports_websockets = true`, then asserts the resulting field is `Some(15_000)`.

**Call relations**: This test covers one of the timeout fields later exposed through `websocket_connect_timeout`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_supports_remote_compaction_for_openai`  (lines 136–140)

```
fn test_supports_remote_compaction_for_openai()
```

**Purpose**: Verifies that the built-in OpenAI provider is recognized as supporting remote compaction.

**Data flow**: It constructs the provider with `ModelProviderInfo::create_openai_provider(None)` and asserts `supports_remote_compaction()` returns true.

**Call relations**: This test exercises the positive OpenAI branch inside `supports_remote_compaction`.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert!).


##### `test_personal_access_token_uses_chatgpt_codex_base_url`  (lines 143–149)

```
fn test_personal_access_token_uses_chatgpt_codex_base_url()
```

**Purpose**: Checks that converting the OpenAI provider to an API provider under personal-access-token auth selects the ChatGPT Codex backend URL.

**Data flow**: It creates the built-in OpenAI provider, calls `to_api_provider(Some(AuthMode::PersonalAccessToken))`, unwraps the result, and asserts `api_provider.base_url` equals `CHATGPT_CODEX_BASE_URL`.

**Call relations**: This test targets the auth-mode-dependent base URL selection logic in `to_api_provider`.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_supports_remote_compaction_for_azure_name`  (lines 152–174)

```
fn test_supports_remote_compaction_for_azure_name()
```

**Purpose**: Verifies that an Azure-like provider is treated as remote-compaction capable.

**Data flow**: It constructs a `ModelProviderInfo` named `Azure` with an `/openai` base URL and asserts `supports_remote_compaction()` returns true.

**Call relations**: This test exercises the Azure-detection branch delegated to `is_azure_responses_provider`.

*Call graph*: 1 external calls (assert!).


##### `test_supports_remote_compaction_for_non_openai_non_azure_provider`  (lines 177–199)

```
fn test_supports_remote_compaction_for_non_openai_non_azure_provider()
```

**Purpose**: Ensures unrelated providers are not incorrectly marked as supporting remote compaction.

**Data flow**: It constructs a generic `Example` provider and asserts `supports_remote_compaction()` returns false.

**Call relations**: This is the negative control for the capability predicate tested in the previous two cases.

*Call graph*: 1 external calls (assert!).


##### `test_deserialize_provider_auth_config_defaults`  (lines 202–227)

```
fn test_deserialize_provider_auth_config_defaults()
```

**Purpose**: Checks deserialization defaults for command-backed provider auth, including timeout, refresh interval, and cwd resolution.

**Data flow**: It creates a temporary base directory, installs an `AbsolutePathBufGuard` so relative paths resolve against that directory, parses TOML containing an `[auth]` block with `command` and `args`, and asserts the resulting `provider.auth` equals a fully populated `ModelProviderAuthInfo` with default timeout, default refresh interval, and cwd resolved to the base directory.

**Call relations**: This test validates serde behavior for the nested auth config type consumed by `ModelProviderInfo`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, tempdir, from_str).


##### `test_deserialize_provider_aws_config`  (lines 230–249)

```
fn test_deserialize_provider_aws_config()
```

**Purpose**: Verifies TOML deserialization of the nested AWS auth configuration block.

**Data flow**: It parses a provider TOML string containing an `[aws]` table with `profile` and `region`, then asserts `provider.aws` equals the expected `ModelProviderAwsAuthInfo`.

**Call relations**: This test covers the schema used later by Bedrock auth resolution and merge logic.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_create_amazon_bedrock_provider`  (lines 252–281)

```
fn test_create_amazon_bedrock_provider()
```

**Purpose**: Checks that the built-in Bedrock constructor returns the exact expected provider definition.

**Data flow**: It calls `ModelProviderInfo::create_amazon_bedrock_provider(None)` and asserts equality with a manually constructed `ModelProviderInfo` containing the Mantle base URL, default AWS auth, Mantle client-agent header, and disabled websocket/OpenAI auth flags.

**Call relations**: This test is the canonical specification for the Bedrock built-in provider defaults.

*Call graph*: 1 external calls (assert_eq!).


##### `test_amazon_bedrock_provider_adds_mantle_client_agent_header`  (lines 284–296)

```
fn test_amazon_bedrock_provider_adds_mantle_client_agent_header()
```

**Purpose**: Ensures the Bedrock provider’s required Mantle client-agent header survives conversion into the runtime API provider.

**Data flow**: It creates the built-in Bedrock provider, converts it with `to_api_provider(None)`, reads the named header from `api_provider.headers`, converts it to `&str`, and asserts it equals `codex`.

**Call relations**: This test bridges provider-definition construction and runtime header-map generation.

*Call graph*: calls 1 internal fn (create_amazon_bedrock_provider); 1 external calls (assert_eq!).


##### `test_built_in_model_providers_include_amazon_bedrock`  (lines 299–308)

```
fn test_built_in_model_providers_include_amazon_bedrock()
```

**Purpose**: Verifies that the built-in provider registry contains the Amazon Bedrock entry under its expected id.

**Data flow**: It calls `built_in_model_providers(None)`, looks up `AMAZON_BEDROCK_PROVIDER_ID`, maps the result through `ModelProviderInfo::is_amazon_bedrock`, and asserts the outcome is `Some(true)`.

**Call relations**: This test covers the composition performed by `built_in_model_providers`.

*Call graph*: 1 external calls (assert_eq!).


##### `test_merge_configured_model_providers_adds_custom_provider`  (lines 311–330)

```
fn test_merge_configured_model_providers_adds_custom_provider()
```

**Purpose**: Checks that a non-built-in configured provider is added to the built-in catalog unchanged.

**Data flow**: It constructs a custom provider, wraps it in a one-entry configured-provider map, builds the expected merged map by inserting that provider into `built_in_model_providers(None)`, then asserts `merge_configured_model_providers(...)` returns `Ok(expected)`.

**Call relations**: This test exercises the normal insertion path in `merge_configured_model_providers`.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_applies_amazon_bedrock_profile_override`  (lines 333–361)

```
fn test_merge_configured_model_providers_applies_amazon_bedrock_profile_override()
```

**Purpose**: Verifies that configured Bedrock `aws.profile` and `aws.region` values are merged into the built-in Bedrock provider rather than replacing it wholesale.

**Data flow**: It creates a configured-provider map containing only `amazon-bedrock` with an `aws` override, mutates an expected built-in provider map to contain those AWS values, and asserts the merge result equals `Ok(expected)`.

**Call relations**: This test targets the Bedrock-specific override branch in `merge_configured_model_providers`.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_rejects_amazon_bedrock_non_default_fields`  (lines 364–387)

```
fn test_merge_configured_model_providers_rejects_amazon_bedrock_non_default_fields()
```

**Purpose**: Ensures that attempting to override unsupported Bedrock fields produces the documented error.

**Data flow**: It constructs a configured Bedrock provider with a non-default `name` plus an AWS override, calls `merge_configured_model_providers`, and asserts the result is the exact expected `Err(String)`.

**Call relations**: This test covers the guard that only `aws.profile` and `aws.region` may be customized for the built-in Bedrock provider.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_allows_amazon_bedrock_default_fields`  (lines 390–410)

```
fn test_merge_configured_model_providers_allows_amazon_bedrock_default_fields()
```

**Purpose**: Checks that a Bedrock config containing only default-valued fields and a default AWS block is accepted as a no-op.

**Data flow**: It builds a configured-provider map for `amazon-bedrock` whose fields are all default-equivalent, calls `merge_configured_model_providers`, and asserts the result equals the unmodified built-in provider map.

**Call relations**: This test exercises the permissive Bedrock path where the configured provider is effectively default except for allowed AWS structure presence.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_validate_provider_aws_rejects_conflicting_auth`  (lines 413–428)

```
fn test_validate_provider_aws_rejects_conflicting_auth()
```

**Purpose**: Verifies that AWS-authenticated providers cannot also specify conflicting auth-related fields such as `env_key` or inherited OpenAI auth requirements.

**Data flow**: It builds a provider by taking `create_openai_provider(None)` and overriding `aws`, `env_key`, and `supports_websockets`, then calls `validate()` and asserts the returned error string lists the conflicting fields.

**Call relations**: This test targets the AWS conflict-detection branch in `ModelProviderInfo::validate`.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_validate_provider_aws_rejects_websockets`  (lines 431–446)

```
fn test_validate_provider_aws_rejects_websockets()
```

**Purpose**: Ensures AWS-authenticated providers are rejected when websocket support is enabled.

**Data flow**: It starts from the built-in OpenAI provider, overrides `aws`, clears `requires_openai_auth`, sets `supports_websockets: true`, calls `validate()`, and asserts the returned error string matches the websocket-specific rejection.

**Call relations**: This test covers the early AWS-plus-websockets validation failure path.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_deserialize_provider_auth_config_allows_zero_refresh_interval`  (lines 449–467)

```
fn test_deserialize_provider_auth_config_allows_zero_refresh_interval()
```

**Purpose**: Checks that command-auth config accepts `refresh_interval_ms = 0` and interprets it as no periodic refresh.

**Data flow**: It creates a temporary base directory and path-resolution guard, parses TOML with an `[auth]` block containing `command` and `refresh_interval_ms = 0`, extracts `provider.auth`, and asserts both the raw `refresh_interval_ms` field is zero and `auth.refresh_interval()` returns `None`.

**Call relations**: This test documents a specific edge case in nested auth-config deserialization and interpretation.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, tempdir, from_str).


### `models-manager/src/collaboration_mode_presets_tests.rs`

`test` · `test`

This test module exercises the concrete outputs of `plan_preset`, `default_preset`, and the default instruction rendering path. The first test checks that preset names are derived from `ModeKind::display_name()` rather than duplicated string literals, and that the two presets differ in the expected protocol fields: both leave `model` unset, but `plan_preset` carries `Some(Some(ReasoningEffort::Medium))` while `default_preset` leaves `reasoning_effort` as `None`.

The second test focuses on the templated default instructions. It obtains the nested `developer_instructions` string from `default_preset`, asserting both outer and inner `Option` layers are populated. It then confirms the raw `{{KNOWN_MODE_NAMES}}` placeholder is gone, computes the expected replacement text using the same `format_mode_names(&TUI_VISIBLE_COLLABORATION_MODES)` helper as production code, and checks that the rendered instructions contain the resulting sentence fragment. The test also asserts the presence of two important behavioral guidance snippets about when to use `request_user_input` and when to ask the user directly in plain text.

Together these tests pin down both structural correctness and prompt content, catching regressions in enum naming, optional field wiring, and template rendering.

#### Function details

##### `preset_names_use_mode_display_names`  (lines 5–15)

```
fn preset_names_use_mode_display_names()
```

**Purpose**: Verifies that the built-in plan and default presets use `ModeKind` display names and expected optional fields. It checks both naming and reasoning/model defaults.

**Data flow**: It calls `plan_preset()` and `default_preset()`, reads their `name`, `model`, and `reasoning_effort` fields, and compares them against expected values derived from `ModeKind` and `ReasoningEffort`. It returns no value and writes no state beyond test assertions.

**Call relations**: This is a direct unit test of the preset constructors. It does not orchestrate other helpers beyond invoking the production functions and asserting on their outputs.

*Call graph*: 1 external calls (assert_eq!).


##### `default_mode_instructions_replace_mode_names_placeholder`  (lines 18–36)

```
fn default_mode_instructions_replace_mode_names_placeholder()
```

**Purpose**: Checks that the default preset's instruction template is rendered, not left with an unresolved placeholder, and still contains key guidance text. It validates both substitution and prompt content.

**Data flow**: It calls `default_preset()`, unwraps the nested `developer_instructions` options into a `String`, computes `known_mode_names` via `format_mode_names(&TUI_VISIBLE_COLLABORATION_MODES)`, builds an expected snippet with `format!`, and asserts that the rendered instructions omit the raw placeholder while containing the expected replacement and two fixed guidance substrings.

**Call relations**: This test exercises the production path from `default_preset` through `default_mode_instructions` and `format_mode_names` indirectly. Its assertions are aimed at catching regressions in template rendering and instruction text composition.

*Call graph*: 2 external calls (assert!, format!).


### `models-manager/src/test_support.rs`

`test` · `test setup`

This module is explicitly marked as non-production support code and exposes two small helpers that bypass the normal online model-resolution path. The first helper, `get_model_offline_for_tests`, implements the same broad preference shape tests expect from the bundled catalog: if the caller already supplied a model string, it returns that verbatim; otherwise it loads the bundled model response, falls back to an empty default response if loading fails, sorts bundled models by ascending `priority`, converts each bundled entry into a `ModelPreset`, and chooses the first preset with `show_in_picker == true`, falling back again to the first preset overall and finally to an empty string if no bundled models exist. That means tests remain stable even when bundled metadata is absent or malformed enough to trigger `unwrap_or_default()`.

The second helper, `construct_model_info_offline_for_tests`, builds a `codex_protocol::openai_models::ModelInfo` strictly from the caller’s `ModelsManagerConfig`. It extracts `config.model_catalog.models` when present, otherwise uses an empty slice, and delegates all actual synthesis to `manager::construct_model_info_from_candidates`. The important invariant is that both helpers avoid consulting remote state and cache layers entirely, so tests can exercise session setup and rate-limit behavior with predictable local inputs.

#### Function details

##### `get_model_offline_for_tests`  (lines 12–25)

```
fn get_model_offline_for_tests(model: Option<&str>) -> String
```

**Purpose**: Returns a concrete model identifier for tests without querying any live model source. It prefers an explicit caller-provided model, otherwise derives a default from bundled model metadata using picker visibility and priority ordering.

**Data flow**: It takes `model: Option<&str>`. If `Some`, it clones that string into the return value immediately. If `None`, it reads bundled model metadata via `bundled_models_response()`, substitutes a default empty response on error, sorts `response.models` by `priority`, converts those entries into `Vec<ModelPreset>`, selects the first preset marked `show_in_picker` or else the first preset, and returns that preset’s `model` field; if no presets exist, it returns an empty `String`.

**Call relations**: This helper is invoked broadly by session-building tests when they need a model name but do not want network or cache dependencies. It delegates only to the bundled catalog loader because those callers are specifically exercising higher-level session creation paths while keeping model selection offline and deterministic.

*Call graph*: called by 38 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, session_telemetry, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, get_model_offline (+15 more)); 1 external calls (bundled_models_response).


##### `construct_model_info_offline_for_tests`  (lines 28–38)

```
fn construct_model_info_offline_for_tests(
    model: &str,
    config: &ModelsManagerConfig,
) -> ModelInfo
```

**Purpose**: Builds a `ModelInfo` for a named model using only the supplied `ModelsManagerConfig` and any embedded catalog candidates. It gives tests the same `ModelInfo` shaping logic as production code while skipping remote lookup and cache hydration.

**Data flow**: It takes `model: &str` and `config: &ModelsManagerConfig`. It reads `config.model_catalog.as_ref()`, borrows `&model_catalog.models` when present or uses an empty slice otherwise, then passes the requested model name, candidate slice, and full config into `construct_model_info_from_candidates`. It returns the resulting `ModelInfo` and does not mutate external state.

**Call relations**: Session-construction and rate-limit tests call this after obtaining a model identifier so they can populate realistic model metadata offline. The function itself is a thin adapter around `construct_model_info_from_candidates`, supplying either configured catalog entries or an empty candidate set depending on whether the test config includes a catalog.

*Call graph*: calls 1 internal fn (construct_model_info_from_candidates); called by 12 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, construct_model_info_offline, test_session_telemetry (+2 more)).


### `models-manager/src/model_info_tests.rs`

`test` · `test`

This test module focuses narrowly on `with_config_overrides` and `model_info_from_slug`. Each test starts from a fallback `ModelInfo` built by `model_info_from_slug("unknown-model")`, mutates either the config or the model, and compares the full resulting struct against an expected value using `pretty_assertions::assert_eq`.

Three tests pin down the asymmetric reasoning-summary override behavior. Setting `model_supports_reasoning_summaries: Some(true)` must force `supports_reasoning_summaries` to `true`, but `Some(false)` must not disable support if the model already has it, and must also be a no-op when the model already lacks it. This ensures config can opt in to support but cannot accidentally erase model-declared capability.

The remaining two tests cover context-window handling. When `model_context_window` is configured above `max_context_window`, the override must clamp to the model's maximum rather than exceeding it. Conversely, when no override is provided, the model's existing `context_window` must remain unchanged.

Because these tests compare whole structs, they also implicitly guard against unrelated field mutations in `with_config_overrides`, making them useful regression tests for future changes to metadata override behavior.

#### Function details

##### `reasoning_summaries_override_true_enables_support`  (lines 6–18)

```
fn reasoning_summaries_override_true_enables_support()
```

**Purpose**: Checks that `model_supports_reasoning_summaries: Some(true)` forces reasoning-summary support on. It verifies the positive override path.

**Data flow**: It creates a fallback model, builds a config with `model_supports_reasoning_summaries: Some(true)`, calls `with_config_overrides`, mutates a cloned expected model to set `supports_reasoning_summaries = true`, and asserts equality between actual and expected.

**Call relations**: This is a direct unit test of `with_config_overrides`, using `model_info_from_slug` only to obtain a baseline `ModelInfo`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `reasoning_summaries_override_false_does_not_disable_support`  (lines 21–32)

```
fn reasoning_summaries_override_false_does_not_disable_support()
```

**Purpose**: Verifies that `Some(false)` does not turn off reasoning-summary support when the model already supports it. The override is intentionally one-way.

**Data flow**: It creates a fallback model, manually sets `model.supports_reasoning_summaries = true`, builds a config with `Some(false)`, calls `with_config_overrides`, and asserts the returned model equals the original mutated model.

**Call relations**: This test targets the non-destructive branch of `with_config_overrides` for reasoning-summary support.

*Call graph*: 2 external calls (default, assert_eq!).


##### `reasoning_summaries_override_false_is_noop_when_model_is_false`  (lines 35–45)

```
fn reasoning_summaries_override_false_is_noop_when_model_is_false()
```

**Purpose**: Checks that `Some(false)` is also a no-op when the model already lacks reasoning-summary support. It confirms no unrelated mutation occurs.

**Data flow**: It creates a fallback model, builds a config with `model_supports_reasoning_summaries: Some(false)`, calls `with_config_overrides`, and asserts the result equals the original model.

**Call relations**: Like the previous test, this directly exercises `with_config_overrides`, but for the already-false case.

*Call graph*: 2 external calls (default, assert_eq!).


##### `model_context_window_override_clamps_to_max_context_window`  (lines 48–62)

```
fn model_context_window_override_clamps_to_max_context_window()
```

**Purpose**: Verifies that a configured context-window override cannot exceed the model's `max_context_window`. The function must clamp rather than trust the config blindly.

**Data flow**: It creates a fallback model, sets `context_window = Some(273_000)` and `max_context_window = Some(400_000)`, builds a config with `model_context_window: Some(500_000)`, calls `with_config_overrides`, mutates an expected clone to set `context_window = Some(400_000)`, and asserts equality.

**Call relations**: This test targets the clamping logic inside `with_config_overrides` for context-window overrides.

*Call graph*: 2 external calls (default, assert_eq!).


##### `model_context_window_uses_model_value_without_override`  (lines 65–74)

```
fn model_context_window_uses_model_value_without_override()
```

**Purpose**: Checks that when no context-window override is configured, the model's existing context-window value is preserved. It guards against accidental default rewriting.

**Data flow**: It creates a fallback model, sets explicit `context_window` and `max_context_window`, uses `ModelsManagerConfig::default()`, calls `with_config_overrides`, and asserts the result equals the original model.

**Call relations**: This test covers the no-op path in `with_config_overrides` for context-window handling.

*Call graph*: 2 external calls (assert_eq!, default).


### `models-manager/src/manager_tests.rs`

`test` · `test`

This is the main test harness for `manager.rs`. It defines reusable fixtures for synthetic `ModelInfo` values (`remote_model`, `remote_model_with_visibility`), assertion helpers, and several fake endpoint/auth implementations. `TestModelsEndpoint` simulates a provider with configurable `has_command_auth`, `uses_codex_backend`, queued model responses, and an atomic fetch counter. `TestAuthAwareModelsEndpoint` derives `uses_codex_backend` from a real `AuthManager`, allowing tests to verify interactions between ChatGPT auth, external API-key overrides, and refresh gating. Two `ExternalAuth` fakes model a resolved external API key and an unresolved one.

The helper constructors `openai_manager_for_tests`, `openai_manager_for_tests_with_auth`, and `static_manager_for_tests` create managers with realistic auth defaults or explicit overrides. `chatgpt_auth_tokens_for_tests` writes an `auth.json` file into a temp Codex home and reloads it through `CodexAuth::from_auth_storage`, exercising the file-backed auth path.

The tests cover several subtle invariants: remote catalogs replace bundled models only for ChatGPT auth when the remote list contains visible entries; hidden-only or API-auth catalogs merge with bundled models instead. Cache freshness depends on TTL and normalized client version, and stale or mismatched cache entries force refetch. Removed remote models disappear after a fresh fetch because merge starts from bundled models each time rather than accumulating old remote entries. Metadata lookup supports longest-prefix and single-segment namespace suffix matching but rejects multi-segment namespaces. Additional tests verify auth-sensitive picker filtering, bundled JSON serde round-tripping, and default selection after hidden models are processed.

#### Function details

##### `remote_model`  (lines 27–29)

```
fn remote_model(slug: &str, display: &str, priority: i32) -> ModelInfo
```

**Purpose**: Creates a synthetic visible `ModelInfo` fixture with standard fields for tests. It is a convenience wrapper around the more general visibility-aware constructor.

**Data flow**: It takes `slug`, `display`, and `priority`, forwards them with a hard-coded visibility of `"list"` to `remote_model_with_visibility`, and returns the resulting `ModelInfo`.

**Call relations**: Many tests use this helper when they need a normal visible remote model. It delegates all actual JSON fixture construction to `remote_model_with_visibility`.

*Call graph*: calls 1 internal fn (remote_model_with_visibility); called by 4 (get_model_info_matches_hyphenated_provider_namespace_suffix, get_model_info_matches_namespaced_suffix, get_model_info_uses_custom_catalog, static_manager_reads_latest_auth_mode).


##### `remote_model_with_visibility`  (lines 31–62)

```
fn remote_model_with_visibility(
    slug: &str,
    display: &str,
    priority: i32,
    visibility: &str,
) -> ModelInfo
```

**Purpose**: Builds a fully populated `ModelInfo` test fixture from a JSON literal, allowing tests to control visibility explicitly. It centralizes the default field set used across manager tests.

**Data flow**: It accepts `slug`, `display`, `priority`, and `visibility`, constructs a `serde_json::Value` with all required `ModelInfo` fields via `json!`, deserializes that value with `serde_json::from_value`, and returns the parsed `ModelInfo`, panicking if the fixture is invalid.

**Call relations**: This helper underpins `remote_model` and is also used directly by tests that need hidden models. It keeps fixture shape consistent across the suite.

*Call graph*: called by 3 (build_available_models_picks_default_after_hiding_hidden_models, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, remote_model); 2 external calls (json!, from_value).


##### `assert_models_contain`  (lines 64–72)

```
fn assert_models_contain(actual: &[ModelInfo], expected: &[ModelInfo])
```

**Purpose**: Asserts that a model list contains entries with the same slugs as an expected list. It ignores ordering and non-slug field differences.

**Data flow**: It takes `actual: &[ModelInfo]` and `expected: &[ModelInfo]`, iterates over each expected model, and asserts that `actual` contains at least one candidate with the same `slug`. It returns no value.

**Call relations**: Several cache and refresh tests use this helper after fetching or reloading models. It does not delegate beyond standard iteration and assertions.

*Call graph*: called by 4 (refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority, refresh_available_models_uses_cache_when_fresh); 1 external calls (assert!).


##### `TestModelsEndpoint::new`  (lines 83–90)

```
fn new(responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Constructs a fake endpoint that reports Codex-backend capability and serves a queued sequence of model responses. It is the default endpoint fixture for refresh tests.

**Data flow**: It takes `responses: Vec<Vec<ModelInfo>>`, wraps them in a `Mutex<VecDeque<_>>`, initializes `has_command_auth` to `false`, `uses_codex_backend` to `true`, `fetch_count` to zero, and returns the endpoint inside an `Arc<Self>`.

**Call relations**: Most tests that expect refreshes to be allowed use this constructor. The resulting endpoint is later consumed through the `ModelsEndpointClient` trait methods implemented below.

*Call graph*: called by 15 (get_model_info_rejects_multi_segment_namespace_suffix_matching, get_model_info_tracks_fallback_usage, get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative, refresh_available_models_drops_removed_remote_models, refresh_available_models_fetches_with_chatgpt_auth_tokens, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote, refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority (+5 more)); 3 external calls (new, new, new).


##### `TestModelsEndpoint::without_refresh`  (lines 92–99)

```
fn without_refresh(responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Constructs a fake endpoint that reports no refresh capability, causing manager refresh logic to skip network fetches. It is used to test auth-gated no-op behavior.

**Data flow**: It takes queued `responses`, stores them in the same way as `new`, but initializes both `has_command_auth` and `uses_codex_backend` to `false`. It returns `Arc<Self>`.

**Call relations**: This constructor is used specifically by tests that verify `should_refresh_models` blocks network access. It feeds into the same trait implementation as `TestModelsEndpoint::new`.

*Call graph*: called by 1 (refresh_available_models_skips_network_without_chatgpt_auth); 3 external calls (new, new, new).


##### `TestModelsEndpoint::fetch_count`  (lines 101–103)

```
fn fetch_count(&self) -> usize
```

**Purpose**: Returns how many times the fake endpoint has been asked to list models. It lets tests assert whether refresh logic hit the network.

**Data flow**: It takes `&self`, reads the `AtomicUsize` with `Ordering::SeqCst`, and returns the resulting `usize`.

**Call relations**: Tests call this after refresh attempts to distinguish cache hits, skipped refreshes, and actual fetches. It is purely observational.

*Call graph*: 1 external calls (load).


##### `TestExternalApiKeyAuth::auth_mode`  (lines 121–123)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Reports `AuthMode::ApiKey` for the resolved external-auth test double. This makes the auth manager behave as though an external API key is active.

**Data flow**: It takes `&self` and returns the enum value `AuthMode::ApiKey`.

**Call relations**: This method is used indirectly by auth-manager logic in tests that install `TestExternalApiKeyAuth` as external auth.


##### `TestExternalApiKeyAuth::resolve`  (lines 125–131)

```
fn resolve(&self) -> codex_login::ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Simulates successful resolution of external API-key credentials. It returns a fixed access token without needing refresh.

**Data flow**: It takes `&self` and returns a boxed future that resolves to `Ok(Some(ExternalAuthTokens::access_token_only("test-external-api-key")))`.

**Call relations**: Tests that install this auth double rely on auth-manager code to call into it and thereby suppress ChatGPT-backed refresh behavior.

*Call graph*: calls 1 internal fn (access_token_only); 1 external calls (pin).


##### `TestExternalApiKeyAuth::refresh`  (lines 133–142)

```
fn refresh(
        &self,
        _context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Simulates successful refresh of external API-key credentials. It mirrors `resolve` by returning the same fixed token.

**Data flow**: It takes an unused `ExternalAuthRefreshContext` and returns a boxed future yielding `Ok(ExternalAuthTokens::access_token_only("test-external-api-key"))`.

**Call relations**: This method supports auth-manager flows that may refresh external auth during tests. It complements `resolve` for the same fake auth source.

*Call graph*: calls 1 internal fn (access_token_only); 1 external calls (pin).


##### `TestUnresolvedExternalApiKeyAuth::auth_mode`  (lines 149–151)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Reports `AuthMode::ApiKey` for the unresolved external-auth test double. This models an external API-key source that exists conceptually but cannot currently provide credentials.

**Data flow**: It takes `&self` and returns `AuthMode::ApiKey`.

**Call relations**: Used indirectly by auth-manager logic in tests that verify fallback from unresolved external auth back to cached ChatGPT auth.


##### `TestUnresolvedExternalApiKeyAuth::refresh`  (lines 153–158)

```
fn refresh(
        &self,
        _context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Simulates failure to refresh external API-key credentials. It forces auth resolution to error so manager logic can fall back to other auth state.

**Data flow**: It takes an unused refresh context and returns a boxed future yielding `Err(std::io::Error::other("unresolved test auth"))`.

**Call relations**: This fake is installed in tests that verify unresolved external auth does not permanently block ChatGPT-backed model refresh.

*Call graph*: 2 external calls (pin, other).


##### `TestModelsEndpoint::has_command_auth`  (lines 162–164)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Exposes the fake endpoint's configured command-auth capability. It lets tests control one branch of `should_refresh_models`.

**Data flow**: It takes `&self` and returns the stored `bool` field `has_command_auth`.

**Call relations**: This trait method is called by `OpenAiModelsManager::should_refresh_models` during refresh decisions.


##### `TestModelsEndpoint::uses_codex_backend`  (lines 166–168)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Exposes the fake endpoint's configured Codex-backend capability asynchronously. It lets tests control the other branch of refresh eligibility.

**Data flow**: It takes `&self` and returns a boxed future that resolves to the stored `uses_codex_backend` boolean.

**Call relations**: This trait method is awaited by `OpenAiModelsManager::should_refresh_models` in refresh tests.

*Call graph*: 1 external calls (pin).


##### `TestModelsEndpoint::list_models`  (lines 170–175)

```
fn list_models(
        &'a self,
        _client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Serves the next queued fake remote model response and increments the fetch counter. It simulates the provider's `/models` endpoint.

**Data flow**: It takes `&self`, increments `fetch_count`, locks `responses`, pops the front `Vec<ModelInfo>` or uses an empty vector if exhausted, and returns `Ok((models, None))` in a boxed future.

**Call relations**: This trait method is called by `OpenAiModelsManager::fetch_and_update_models` whenever a test scenario reaches the network-fetch path.

*Call graph*: 2 external calls (fetch_add, pin).


##### `openai_manager_for_tests`  (lines 178–189)

```
fn openai_manager_for_tests(
    codex_home: std::path::PathBuf,
    endpoint_client: Arc<dyn ModelsEndpointClient>,
) -> OpenAiModelsManager
```

**Purpose**: Creates an `OpenAiModelsManager` test instance with dummy ChatGPT auth already installed. It is the common constructor for tests that want refreshes to be allowed by default.

**Data flow**: It takes a `codex_home` path and endpoint client, creates an `AuthManager` from `CodexAuth::create_dummy_chatgpt_auth_for_testing()`, wraps that in `Some(...)`, and forwards all arguments to `openai_manager_for_tests_with_auth`, returning the resulting manager.

**Call relations**: Many tests use this helper instead of constructing auth manually. It delegates actual manager creation to `openai_manager_for_tests_with_auth`.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, openai_manager_for_tests_with_auth); called by 12 (get_model_info_rejects_multi_segment_namespace_suffix_matching, get_model_info_tracks_fallback_usage, get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative, refresh_available_models_drops_removed_remote_models, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote, refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority, refresh_available_models_uses_cache_when_fresh (+2 more)).


##### `openai_manager_for_tests_with_auth`  (lines 191–197)

```
fn openai_manager_for_tests_with_auth(
    codex_home: std::path::PathBuf,
    endpoint_client: Arc<dyn ModelsEndpointClient>,
    auth_manager: Option<Arc<AuthManager>>,
) -> OpenAiModelsManager
```

**Purpose**: Creates an `OpenAiModelsManager` test instance with an explicitly supplied auth manager option. It is the flexible constructor used by auth-sensitive tests.

**Data flow**: It takes `codex_home`, an endpoint client, and `auth_manager: Option<Arc<AuthManager>>`, calls `OpenAiModelsManager::new`, and returns the new manager.

**Call relations**: This helper is used directly by tests that need no auth, API-key auth, or custom auth-manager state. It delegates all initialization to the production constructor.

*Call graph*: calls 1 internal fn (new); called by 6 (openai_manager_for_tests, refresh_available_models_fetches_with_chatgpt_auth_tokens, refresh_available_models_keeps_merging_for_api_auth, refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth, refresh_available_models_skips_network_without_chatgpt_auth, refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved).


##### `static_manager_for_tests`  (lines 199–201)

```
fn static_manager_for_tests(model_catalog: ModelsResponse) -> StaticModelsManager
```

**Purpose**: Creates a `StaticModelsManager` test instance with no auth manager. It is a convenience wrapper for metadata and preset-shaping tests that do not need refresh behavior.

**Data flow**: It takes a `ModelsResponse`, passes `None` and the catalog into `StaticModelsManager::new`, and returns the resulting manager.

**Call relations**: Tests that focus on static catalog behavior use this helper. It delegates directly to the production static-manager constructor.

*Call graph*: calls 1 internal fn (new); called by 4 (build_available_models_picks_default_after_hiding_hidden_models, get_model_info_matches_hyphenated_provider_namespace_suffix, get_model_info_matches_namespaced_suffix, get_model_info_uses_custom_catalog).


##### `chatgpt_auth_tokens_for_tests`  (lines 203–239)

```
async fn chatgpt_auth_tokens_for_tests(codex_home: &Path) -> CodexAuth
```

**Purpose**: Creates a file-backed ChatGPT-auth fixture by writing `auth.json` into a temporary Codex home and reloading it through the real auth-storage path. It exercises realistic token parsing and loading.

**Data flow**: It takes `codex_home: &Path`, builds a `codex_login::AuthDotJson` containing `AuthMode::ChatgptAuthTokens`, parsed fake JWT claims, access/refresh tokens, account id, and current timestamp, creates the directory, writes serialized JSON to `auth.json`, then awaits `CodexAuth::from_auth_storage(...)` and returns the loaded `CodexAuth` after unwrapping expected success.

**Call relations**: This helper is used by the test that verifies refresh works with ChatGPT auth tokens loaded from disk. It delegates parsing and storage loading to real `codex_login` code.

*Call graph*: calls 3 internal fn (default, from_auth_storage, parse_chatgpt_jwt_claims); called by 1 (refresh_available_models_fetches_with_chatgpt_auth_tokens); 5 external calls (join, now, to_string, create_dir_all, write).


##### `get_model_info_tracks_fallback_usage`  (lines 242–266)

```
async fn get_model_info_tracks_fallback_usage()
```

**Purpose**: Verifies that known bundled models resolve without fallback metadata while unknown slugs do use fallback metadata. It checks the `used_fallback_model_metadata` flag and slug preservation.

**Data flow**: It creates a temp manager with default config, reads the first bundled slug from `get_remote_models()`, calls `get_model_info` for that known slug and for an unknown slug, and asserts on the returned `used_fallback_model_metadata` and `slug` fields.

**Call relations**: This test exercises the `ModelsManager::get_model_info` path against an OpenAI manager seeded from bundled models. It relies on `openai_manager_for_tests` to provide a realistic manager setup.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `get_model_info_uses_custom_catalog`  (lines 269–288)

```
async fn get_model_info_uses_custom_catalog()
```

**Purpose**: Checks that metadata lookup uses a provided static catalog entry as the source for a prefixed model slug. It confirms remote fields are copied while the requested slug is preserved.

**Data flow**: It builds a custom `ModelInfo` fixture with `supports_image_detail_original = true`, wraps it in a static manager, calls `get_model_info("gpt-overlay-experiment", &config)`, and asserts on slug, display name, context window, feature flags, and fallback usage.

**Call relations**: This test targets `construct_model_info_from_candidates` through the trait method on a static manager. It uses `remote_model` and `static_manager_for_tests` to set up the candidate catalog.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_matches_namespaced_suffix`  (lines 291–305)

```
async fn get_model_info_matches_namespaced_suffix()
```

**Purpose**: Verifies that a single-segment namespace like `custom/gpt-image` can resolve metadata from the suffix `gpt-image`. It confirms the namespaced slug remains the returned slug.

**Data flow**: It creates a static manager containing one `gpt-image` model, calls `get_model_info` with `custom/gpt-image`, and asserts that the returned `ModelInfo` keeps the namespaced slug, inherits the image-support flag, and is not marked as fallback metadata.

**Call relations**: This test specifically exercises the namespaced-suffix fallback branch in `construct_model_info_from_candidates` after direct prefix matching would fail.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_matches_hyphenated_provider_namespace_suffix`  (lines 308–320)

```
async fn get_model_info_matches_hyphenated_provider_namespace_suffix()
```

**Purpose**: Checks that namespace stripping accepts provider-like namespaces containing hyphens, such as `openai-codex/gpt-image`. It validates the namespace character whitelist.

**Data flow**: It creates a static manager with a `gpt-image` candidate, calls `get_model_info` for `openai-codex/gpt-image`, and asserts that the returned slug matches the namespaced input and that fallback metadata was not used.

**Call relations**: This test targets the namespace validation logic inside `find_model_by_namespaced_suffix`, confirming hyphenated provider ids are allowed.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_rejects_multi_segment_namespace_suffix_matching`  (lines 323–343)

```
async fn get_model_info_rejects_multi_segment_namespace_suffix_matching()
```

**Purpose**: Ensures that namespaced suffix matching does not strip more than one namespace segment. Multi-segment paths must fall back instead of matching bundled metadata.

**Data flow**: It creates an OpenAI manager, obtains a known bundled slug, constructs `ns1/ns2/{known_slug}`, calls `get_model_info`, and asserts that the returned slug is unchanged and `used_fallback_model_metadata` is true.

**Call relations**: This test exercises the rejection path in `find_model_by_namespaced_suffix` where the suffix still contains a slash.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 6 external calls (new, assert!, assert_eq!, format!, default, tempdir).


##### `refresh_available_models_sorts_by_priority`  (lines 346–376)

```
async fn refresh_available_models_sorts_by_priority()
```

**Purpose**: Verifies that fetched models are retained in the remote cache and exposed to callers sorted by ascending `priority`. It also confirms only one network fetch occurs in the cache-first path.

**Data flow**: It creates two remote fixtures with different priorities, refreshes an OpenAI manager with `OnlineIfUncached`, checks the raw cached models contain both entries, calls `list_models`, finds the positions of the two presets by slug, and asserts the higher-priority model appears first and the endpoint fetch count is one.

**Call relations**: This test exercises `refresh_available_models`, `get_remote_models`, and the trait's `list_models`/`build_available_models` pipeline together.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_remote_only_catalog_for_chatgpt_auth`  (lines 379–396)

```
async fn refresh_available_models_uses_remote_only_catalog_for_chatgpt_auth()
```

**Purpose**: Checks that for ChatGPT auth, a non-empty remote catalog with visible models becomes the sole source of truth. Bundled models should be replaced rather than merged.

**Data flow**: It creates a manager with dummy ChatGPT auth and one visible remote model, refreshes with `OnlineIfUncached`, then asserts that `get_remote_models()` equals exactly the remote vector and that one fetch occurred.

**Call relations**: This test targets the `should_use_remote_models_only` branch inside `apply_remote_models` after a successful fetch.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cached_remote_only_catalog_for_chatgpt_auth`  (lines 399–430)

```
async fn refresh_available_models_uses_cached_remote_only_catalog_for_chatgpt_auth()
```

**Purpose**: Verifies that a previously cached authoritative ChatGPT remote catalog is reused without another fetch. It confirms cache loads follow the same replacement semantics as live fetches.

**Data flow**: It first refreshes one manager to populate cache with a visible remote model, then constructs a second manager pointing at the same temp home but with an endpoint that has no responses, refreshes again with `OnlineIfUncached`, and asserts the second manager's remote models equal the cached remote vector while fetch count remains zero.

**Call relations**: This test exercises the interaction between `try_load_cache` and `apply_remote_models` under ChatGPT-authoritative conditions.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 4 external calls (new, assert_eq!, tempdir, vec!).


##### `get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative`  (lines 433–460)

```
async fn get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative()
```

**Purpose**: Ensures that once a ChatGPT-visible remote catalog becomes authoritative, bundled-only slugs no longer resolve from bundled metadata. Looking up such a slug should fall back.

**Data flow**: It loads a bundled slug, refreshes a manager with a different visible remote model so remote-only mode activates, then calls `get_model_info` for the bundled slug and asserts the slug is preserved but `used_fallback_model_metadata` is true.

**Call relations**: This test connects `apply_remote_models` replacement behavior with later metadata lookup through `get_model_info`.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 5 external calls (assert!, assert_eq!, default, tempdir, vec!).


##### `refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote`  (lines 463–475)

```
async fn refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote()
```

**Purpose**: Checks that an empty remote response does not wipe out the bundled catalog even under ChatGPT auth. The manager should keep the bundled models intact.

**Data flow**: It creates a manager whose endpoint returns an empty vector, captures the expected bundled models via `load_remote_models_from_file`, refreshes with `OnlineIfUncached`, and asserts that `get_remote_models()` equals the bundled list.

**Call relations**: This test exercises the negative side of the authoritative-remote condition in `apply_remote_models`: empty remote lists must not replace bundled data.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog`  (lines 478–497)

```
async fn refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog()
```

**Purpose**: Verifies that a ChatGPT remote catalog containing only hidden models is merged into the bundled catalog rather than replacing it. Visibility drives the replacement decision.

**Data flow**: It creates one hidden remote model, builds the expected result by appending it to the bundled list, refreshes the manager, and asserts that `get_remote_models()` equals the merged expected vector.

**Call relations**: This test targets the `ModelVisibility::List` requirement inside `apply_remote_models`'s authoritative-remote branch.

*Call graph*: calls 3 internal fn (new, openai_manager_for_tests, remote_model_with_visibility); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_keeps_merging_for_api_auth`  (lines 500–530)

```
async fn refresh_available_models_keeps_merging_for_api_auth()
```

**Purpose**: Checks that API-key auth never switches to remote-only mode even when the remote catalog contains visible models. Remote entries should be merged with bundled models.

**Data flow**: It constructs an endpoint with `has_command_auth = true`, an auth manager backed by `CodexAuth::from_api_key`, builds the expected merged catalog from bundled plus remote models, refreshes the manager, and asserts both the merged result and a single fetch.

**Call relations**: This test exercises `should_refresh_models` allowing refresh via command auth while `apply_remote_models` declines remote-only replacement because auth is not ChatGPT-account based.

*Call graph*: calls 3 internal fn (from_auth_for_testing, from_api_key, openai_manager_for_tests_with_auth); 6 external calls (new, new, new, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cache_when_fresh`  (lines 533–556)

```
async fn refresh_available_models_uses_cache_when_fresh()
```

**Purpose**: Verifies that a fresh cache entry satisfies `OnlineIfUncached` without a second network request. It confirms both cache persistence and cache reuse.

**Data flow**: It refreshes once to populate cache, asserts the fetched model is present, refreshes again with the same strategy, asserts the model is still present, and checks that the endpoint fetch count stayed at one.

**Call relations**: This test exercises the cache-hit branch in `refresh_available_models` via `try_load_cache`.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_refetches_when_cache_stale`  (lines 559–590)

```
async fn refresh_available_models_refetches_when_cache_stale()
```

**Purpose**: Checks that stale cache timestamps force a new fetch under `OnlineIfUncached`. It validates TTL-based cache invalidation.

**Data flow**: It performs an initial refresh, mutates the cache's `fetched_at` timestamp to one hour in the past via `cache_manager.manipulate_cache_for_test`, refreshes again, asserts the updated model is now present, and checks that fetch count increased to two.

**Call relations**: This test drives the stale-cache path through the cache manager and then back into `fetch_and_update_models`.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_refetches_when_version_mismatch`  (lines 593–624)

```
async fn refresh_available_models_refetches_when_version_mismatch()
```

**Purpose**: Ensures that cache entries with a mismatched client version are treated as unusable and trigger a refetch. It validates version-based cache eligibility.

**Data flow**: It refreshes once, mutates the stored cache's `client_version` to append `-mismatch`, refreshes again, asserts the updated model is present, and checks that the endpoint was fetched twice.

**Call relations**: This test exercises the version-checking logic inside `cache_manager.load_fresh` as consumed by `try_load_cache`.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_drops_removed_remote_models`  (lines 627–669)

```
async fn refresh_available_models_drops_removed_remote_models()
```

**Purpose**: Verifies that remote models removed by the provider disappear after a subsequent refresh. The manager should not accumulate stale remote-only entries across fetches.

**Data flow**: It creates an endpoint that first returns `remote-old` then `remote-new`, forces cache TTL to zero, refreshes twice, calls `try_list_models`, and asserts that `remote-new` is present while `remote-old` is absent; it also checks fetch count is two.

**Call relations**: This test validates that `apply_remote_models` rebuilds merge state from bundled models each time rather than mutating the previous merged list in place.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_skips_network_without_chatgpt_auth`  (lines 672–702)

```
async fn refresh_available_models_skips_network_without_chatgpt_auth()
```

**Purpose**: Checks that refresh is skipped entirely when no auth manager is present and the endpoint reports no refresh capability. The remote-only test model must never appear.

**Data flow**: It creates an endpoint via `without_refresh`, constructs a manager with `auth_manager = None`, calls `refresh_available_models(Online)`, reads `get_remote_models()`, asserts the dynamic slug is absent, and checks fetch count is zero.

**Call relations**: This test exercises the early-return branch in `refresh_available_models` when `should_refresh_models` is false.

*Call graph*: calls 2 internal fn (without_refresh, openai_manager_for_tests_with_auth); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `TestAuthAwareModelsEndpoint::new`  (lines 712–718)

```
fn new(auth_manager: Option<Arc<AuthManager>>, responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Constructs a fake endpoint whose `uses_codex_backend` answer is derived from a real `AuthManager`. It is used to test refresh gating under changing auth conditions.

**Data flow**: It takes an optional `Arc<AuthManager>` and queued responses, stores them in the struct along with a zeroed fetch counter, and returns `Arc<Self>`.

**Call relations**: Auth-sensitive refresh tests use this constructor so endpoint capability reflects actual auth-manager state rather than a fixed boolean.

*Call graph*: called by 2 (refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth, refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved); 3 external calls (new, new, new).


##### `TestAuthAwareModelsEndpoint::fetch_count`  (lines 720–722)

```
fn fetch_count(&self) -> usize
```

**Purpose**: Returns the number of fake fetches performed by the auth-aware endpoint. It supports assertions about whether refresh logic hit the network.

**Data flow**: It reads the endpoint's `AtomicUsize` with `Ordering::SeqCst` and returns the count.

**Call relations**: Used by the external-auth tests after refresh attempts.

*Call graph*: 1 external calls (load).


##### `TestAuthAwareModelsEndpoint::has_command_auth`  (lines 748–750)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Reports that the auth-aware endpoint never supports command auth. This isolates tests to the `uses_codex_backend` branch of refresh eligibility.

**Data flow**: It takes `&self` and returns `false`.

**Call relations**: This trait method is consumed by `OpenAiModelsManager::should_refresh_models` during auth-aware endpoint tests.


##### `TestAuthAwareModelsEndpoint::uses_codex_backend`  (lines 752–754)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Asynchronously reports whether the current auth manager resolves to Codex-backend-capable auth. It mirrors production behavior more closely than a fixed flag.

**Data flow**: It takes `&self` and returns a boxed future that awaits the helper `TestAuthAwareModelsEndpoint::uses_codex_backend(self)` and yields the resulting boolean.

**Call relations**: This trait method is awaited by `OpenAiModelsManager::should_refresh_models` in tests involving external auth overrides.

*Call graph*: 1 external calls (pin).


##### `TestAuthAwareModelsEndpoint::list_models`  (lines 756–761)

```
fn list_models(
        &'a self,
        _client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Serves queued fake model responses while counting fetches, just like `TestModelsEndpoint`, but in the auth-aware endpoint type. It simulates the provider fetch step.

**Data flow**: It increments `fetch_count`, pops the next queued response from the mutex-protected deque or defaults to empty, and returns `Ok((models, None))` in a boxed future.

**Call relations**: This trait method is called by `fetch_and_update_models` when auth-aware tests reach the network path.

*Call graph*: 2 external calls (fetch_add, pin).


##### `refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth`  (lines 765–802)

```
async fn refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth()
```

**Purpose**: Verifies that an active external API key suppresses ChatGPT-backed remote refresh even if the base auth manager contains ChatGPT auth. The manager should not fetch models in that state.

**Data flow**: It creates a ChatGPT auth manager, installs `TestExternalApiKeyAuth` as external auth, builds an auth-aware endpoint and manager, calls `refresh_available_models(Online)`, then asserts the dynamic slug is absent from `get_remote_models()` and fetch count is zero.

**Call relations**: This test exercises the interaction between auth-manager external-auth override logic and `should_refresh_models` through `TestAuthAwareModelsEndpoint`.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, openai_manager_for_tests_with_auth); 6 external calls (clone, new, assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved`  (lines 805–843)

```
async fn refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved()
```

**Purpose**: Checks that unresolved external API-key auth falls back to cached ChatGPT auth for refresh eligibility. In that case the manager should still fetch remote models.

**Data flow**: It creates a ChatGPT auth manager, installs `TestUnresolvedExternalApiKeyAuth`, builds an auth-aware endpoint and manager, refreshes online, then asserts the dynamic slug appears in `get_remote_models()` and fetch count is one.

**Call relations**: This test covers the fallback path where external auth exists but cannot resolve, allowing ChatGPT-backed refresh to proceed.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, openai_manager_for_tests_with_auth); 6 external calls (clone, new, assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_fetches_with_chatgpt_auth_tokens`  (lines 846–879)

```
async fn refresh_available_models_fetches_with_chatgpt_auth_tokens()
```

**Purpose**: Verifies that file-backed ChatGPT auth tokens are sufficient for remote model refresh. It exercises the real auth-storage loading path rather than a dummy in-memory auth object.

**Data flow**: It creates a temp home, endpoint, and `CodexAuth` via `chatgpt_auth_tokens_for_tests`, wraps that auth in an `AuthManager`, constructs the manager, refreshes online, and asserts the dynamic slug is present and fetch count is one.

**Call relations**: This test combines the auth fixture helper with the normal refresh path to validate end-to-end compatibility with ChatGPT auth tokens.

*Call graph*: calls 4 internal fn (from_auth_for_testing, new, chatgpt_auth_tokens_for_tests, openai_manager_for_tests_with_auth); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `build_available_models_picks_default_after_hiding_hidden_models`  (lines 882–897)

```
fn build_available_models_picks_default_after_hiding_hidden_models()
```

**Purpose**: Checks that default selection happens after visibility processing so a hidden model is not chosen as the default picker entry. The visible model should become default instead.

**Data flow**: It creates a static manager, builds one hidden and one visible `ModelInfo`, converts both to expected `ModelPreset` values, manually marks the visible expected preset as default, calls `build_available_models`, and asserts the returned vector matches the expected presets.

**Call relations**: This test directly exercises the trait default method `build_available_models` on a static manager, focusing on the interaction between auth/visibility filtering and default marking.

*Call graph*: calls 3 internal fn (remote_model_with_visibility, static_manager_for_tests, from); 3 external calls (new, assert_eq!, vec!).


##### `static_manager_reads_latest_auth_mode`  (lines 900–935)

```
async fn static_manager_reads_latest_auth_mode()
```

**Purpose**: Verifies that `build_available_models` consults the current auth manager state each time rather than caching an old auth mode. Changing external auth should change the visible preset list.

**Data flow**: It creates a static manager with ChatGPT auth and two models, one unsupported in API and one normal, calls `list_models` and asserts both appear, then installs `TestExternalApiKeyAuth` on the same auth manager, calls `list_models` again, and asserts only the API-supported model remains.

**Call relations**: This test exercises the trait's `build_available_models` and `auth_manager` hook over time, proving that auth-sensitive filtering is dynamic.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, remote_model); 4 external calls (clone, new, assert_eq!, vec!).


##### `bundled_models_json_roundtrips`  (lines 938–955)

```
fn bundled_models_json_roundtrips()
```

**Purpose**: Ensures the bundled `models.json` parses and serializes cleanly through Serde and contains at least one model. It protects the embedded catalog format itself.

**Data flow**: It calls `crate::bundled_models_response()`, serializes the resulting `ModelsResponse` with `serde_json::to_string`, deserializes it back with `serde_json::from_str`, and asserts equality with the original plus non-emptiness of `response.models`.

**Call relations**: This test targets the crate-level bundled catalog loader rather than manager orchestration. It validates the static asset consumed by `load_remote_models_from_file` and manager initialization.

*Call graph*: 5 external calls (assert!, assert_eq!, bundled_models_response, from_str, to_string).


### `models-manager/src/model_info_overrides_tests.rs`

`test` · `test`

This small async test module validates the `with_config_overrides` behavior as observed through the manager API rather than by calling the override function directly. Both tests create an `OpenAiModelsManager` in a temporary Codex home using `openai_manager_for_tests` and a `TestModelsEndpoint` with no remote responses, ensuring metadata resolution happens against bundled/offline state.

The first test uses `ModelsManagerConfig::default()` and requests `gpt-5.2`, asserting that the resulting `ModelInfo.truncation_policy` remains the default byte-based limit of `TruncationPolicyConfig::bytes(10_000)`. This pins the baseline behavior when no tool-output override is configured.

The second test sets `tool_output_token_limit: Some(123)` in `ModelsManagerConfig` and requests `gpt-5.4`. It then asserts that the returned truncation policy is `TruncationPolicyConfig::tokens(123)`, confirming that the override rewrites the policy in token units for a model whose original truncation mode is token-based.

Together these tests verify that offline metadata lookup still passes through config override logic and that truncation-policy rewriting preserves the model's truncation mode semantics rather than always converting to bytes.

#### Function details

##### `offline_model_info_without_tool_output_override`  (lines 11–25)

```
async fn offline_model_info_without_tool_output_override()
```

**Purpose**: Verifies that offline model-info lookup leaves the default truncation policy unchanged when no tool-output override is configured. It checks the byte-based baseline path.

**Data flow**: It creates a temporary Codex home, a default `ModelsManagerConfig`, and an OpenAI test manager with no remote responses, then awaits `manager.get_model_info("gpt-5.2", &config)` and asserts that `model_info.truncation_policy` equals `TruncationPolicyConfig::bytes(10_000)`.

**Call relations**: This test exercises the production `ModelsManager::get_model_info` path in an offline scenario. It relies on `openai_manager_for_tests` and the manager's bundled-model initialization.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert_eq!, default, openai_manager_for_tests).


##### `offline_model_info_with_tool_output_override`  (lines 28–45)

```
async fn offline_model_info_with_tool_output_override()
```

**Purpose**: Verifies that offline model-info lookup rewrites truncation policy when `tool_output_token_limit` is configured. It checks the token-based override path.

**Data flow**: It creates a temporary Codex home, a `ModelsManagerConfig` with `tool_output_token_limit: Some(123)`, and an OpenAI test manager with no remote responses, then awaits `manager.get_model_info("gpt-5.4", &config)` and asserts that `model_info.truncation_policy` equals `TruncationPolicyConfig::tokens(123)`.

**Call relations**: This test also exercises `ModelsManager::get_model_info` end to end, but with config set to trigger `with_config_overrides`'s truncation-policy mutation.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, new, assert_eq!, openai_manager_for_tests).


### `core/tests/suite/models_cache_ttl.rs`

`test` · `startup model catalog load and request-time cache refresh`

This module exercises the models-manager cache file directly by reading and rewriting `models_cache.json` under the test Codex home. It defines a local `ModelsCache` struct matching the serialized cache schema (`fetched_at`, optional `etag`, optional `client_version`, and `models`) plus helpers to read, write, and mutate that file. The tests use mock `/models` endpoints and, in one case, a `/responses` SSE response carrying `X-Models-Etag` to trigger cache renewal logic without a second catalog fetch.

The first test populates the cache through a real online refresh, rewrites `fetched_at` to the Unix epoch, then performs a turn whose `/responses` reply includes the same ETag. It asserts the cache timestamp is renewed, `/models` is not refetched, and offline listing still returns the cached remote model. The remaining tests seed the cache before startup using `with_pre_build_hook`: if `client_version` matches `client_version_to_whole()`, the cache is used and `/models` is skipped; if the version is missing or differs, the manager refreshes from the server. `test_remote_model` provides a stable `ModelInfo` fixture with realistic defaults so the cache contents and refreshed catalog are structurally valid.

#### Function details

##### `renews_cache_ttl_on_matching_models_etag`  (lines 47–148)

```
async fn renews_cache_ttl_on_matching_models_etag() -> Result<()>
```

**Purpose**: Verifies that a `/responses` reply carrying the same `X-Models-Etag` as the cached catalog renews the cache TTL without issuing another `/models` request. It also confirms the renewed cache remains usable for offline model listing.

**Data flow**: The test mounts `/models` once with `ETAG`, builds an authenticated session, triggers an initial online model refresh to populate `models_cache.json`, rewrites `fetched_at` to epoch via `rewrite_cache_timestamp`, then submits a user turn whose mocked SSE response includes the same `X-Models-Etag`. After `TurnComplete`, it reads the cache back with `read_cache`, asserts `fetched_at` advanced beyond the stale time, checks the original `/models` mock saw only one request, and finally verifies `RefreshStrategy::Offline` still returns the cached remote model.

**Call relations**: This top-level test is the only caller of `rewrite_cache_timestamp` and one of the callers of `read_cache`. It ties together cache-file mutation, request execution, and post-turn offline listing to validate the full TTL-renewal path.

*Call graph*: calls 11 internal fn (mount_models_once_with_etag, mount_response_once, sse, sse_response, local_selections, test_codex, turn_permission_fields, read_cache, rewrite_cache_timestamp, test_remote_model (+1 more)); 7 external calls (clone, default, start, assert!, assert_eq!, wait_for_event, vec!).


##### `uses_cache_when_version_matches`  (lines 151–195)

```
async fn uses_cache_when_version_matches() -> Result<()>
```

**Purpose**: Checks that a pre-seeded cache with a matching `client_version` is accepted as-is and prevents any `/models` fetch during `OnlineIfUncached` listing. This guards the fast path for compatible cache files.

**Data flow**: The test seeds `models_cache.json` in a pre-build hook with `client_version = Some(client_version_to_whole())` and a cached model fixture, then builds the session and calls `list_models(RefreshStrategy::OnlineIfUncached)`. It asserts the returned presets include the cached model slug and that the mounted `/models` mock received zero requests.

**Call relations**: It uses `test_remote_model` to create both the cached fixture and an alternate remote response that should never be consulted. The pre-build hook delegates persistence to `write_cache_sync`.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, assert!, assert_eq!, vec!).


##### `refreshes_when_cache_version_missing`  (lines 198–242)

```
async fn refreshes_when_cache_version_missing() -> Result<()>
```

**Purpose**: Ensures that a cache file lacking `client_version` is treated as stale/incompatible and triggers a `/models` refresh. The returned model list should come from the server, not the seeded cache.

**Data flow**: The test seeds the cache with `client_version: None`, builds the session, and requests `OnlineIfUncached` models. It then asserts the returned presets contain the remote model slug from the mock server and that `/models` was called exactly once.

**Call relations**: This is the missing-version negative case corresponding to `uses_cache_when_version_matches`. It also uses `write_cache_sync` in the pre-build hook and `test_remote_model` for fixture generation.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, assert!, assert_eq!, vec!).


##### `refreshes_when_cache_version_differs`  (lines 245–292)

```
async fn refreshes_when_cache_version_differs() -> Result<()>
```

**Purpose**: Verifies that a cache file whose `client_version` differs from the current whole client version causes a refresh from `/models`. The test tolerates retries by mounting multiple identical mocks and only requiring at least one request.

**Data flow**: The test seeds the cache with `client_version = Some("<current>-diff")`, mounts the same `/models` response three times, builds the session, and calls `list_models(RefreshStrategy::OnlineIfUncached)`. It asserts the returned presets include the remote model slug and sums request counts across all mocks to ensure `/models` was fetched at least once.

**Call relations**: It is the version-mismatch counterpart to the previous two tests. The multiple mocks make the assertion robust against internal retry behavior while still proving the cache was not trusted.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, new, assert!, vec!).


##### `rewrite_cache_timestamp`  (lines 294–299)

```
async fn rewrite_cache_timestamp(path: &Path, fetched_at: DateTime<Utc>) -> Result<()>
```

**Purpose**: Loads the serialized models cache, replaces its `fetched_at` timestamp, and writes it back. It is a small async helper for forcing the cache into a stale state.

**Data flow**: Inputs are a cache-file path and the replacement `DateTime<Utc>`. It reads the current `ModelsCache` via `read_cache`, mutates `cache.fetched_at`, persists the updated struct with `write_cache`, and returns `Ok(())` on success.

**Call relations**: Only `renews_cache_ttl_on_matching_models_etag` calls this helper, using it to simulate an expired cache before exercising TTL renewal.

*Call graph*: calls 2 internal fn (read_cache, write_cache); called by 1 (renews_cache_ttl_on_matching_models_etag).


##### `read_cache`  (lines 301–305)

```
async fn read_cache(path: &Path) -> Result<ModelsCache>
```

**Purpose**: Deserializes the on-disk `models_cache.json` file into the local `ModelsCache` struct. It gives tests direct visibility into cache metadata after startup or request processing.

**Data flow**: Input is a filesystem path. The function asynchronously reads the file bytes with `tokio::fs::read`, parses them with `serde_json::from_slice`, and returns the resulting `ModelsCache`.

**Call relations**: It is used directly by the TTL-renewal test and indirectly by `rewrite_cache_timestamp`. The helper isolates the cache schema parsing from the tests themselves.

*Call graph*: called by 2 (renews_cache_ttl_on_matching_models_etag, rewrite_cache_timestamp); 2 external calls (from_slice, read).


##### `write_cache`  (lines 307–311)

```
async fn write_cache(path: &Path, cache: &ModelsCache) -> Result<()>
```

**Purpose**: Serializes a `ModelsCache` value to pretty JSON and writes it asynchronously to disk. It is the async counterpart to the synchronous pre-build helper.

**Data flow**: Inputs are a path and a borrowed `ModelsCache`. It converts the struct to pretty JSON bytes with `serde_json::to_vec_pretty`, writes them using `tokio::fs::write`, and returns `Ok(())` or the propagated error.

**Call relations**: Only `rewrite_cache_timestamp` calls this helper after mutating the loaded cache.

*Call graph*: called by 1 (rewrite_cache_timestamp); 2 external calls (to_vec_pretty, write).


##### `write_cache_sync`  (lines 313–317)

```
fn write_cache_sync(path: &Path, cache: &ModelsCache) -> Result<()>
```

**Purpose**: Synchronously writes a `ModelsCache` fixture to disk for use during test setup before the async runtime starts interacting with the session. It is intended for `with_pre_build_hook` closures.

**Data flow**: Inputs are a path and a borrowed `ModelsCache`. It serializes the struct with `serde_json::to_vec_pretty`, writes the bytes via `std::fs::write`, and returns a `Result<()>`.

**Call relations**: The version-match, missing-version, and version-diff tests use this helper inside pre-build hooks to seed `models_cache.json` before constructing `TestCodex`.

*Call graph*: 2 external calls (to_vec_pretty, write).


##### `test_remote_model`  (lines 329–379)

```
fn test_remote_model(slug: &str, priority: i32) -> ModelInfo
```

**Purpose**: Constructs a realistic remote `ModelInfo` fixture for cache and refresh tests. It keeps the catalog schema valid while allowing callers to vary only the slug and priority.

**Data flow**: Inputs are a model slug and integer priority. It returns a `ModelInfo` with list visibility, medium default reasoning, low/medium supported reasoning levels, shell-command tool type, empty service tiers, byte truncation policy, 272k context window, 95% effective window percentage, default input modalities, and the provided slug/priority.

**Call relations**: All four top-level cache tests call this helper to create either cached models or mocked remote catalog entries. It ensures both cache contents and server responses share the same structural baseline.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); called by 4 (refreshes_when_cache_version_differs, refreshes_when_cache_version_missing, renews_cache_ttl_on_matching_models_etag, uses_cache_when_version_matches); 3 external calls (default, new, vec!).


### API client and authentication tests
These files verify client-side HTTP/WebSocket contracts, auth/token handling, transport shaping, and backend-facing support behavior across the API stack.

### `backend-client/src/client/rate_limit_resets_tests.rs`

`test` · `test`

This test file validates the externally visible wire contract for the rate-limit reset credit feature without making network calls. The main test checks both URL builders against exact expected strings for `PathStyle::CodexApi` and `PathStyle::ChatGptApi`, ensuring the parent client’s path-style split is preserved for usage reads and reset-credit redemption.

It also verifies JSON serialization of `ConsumeRateLimitResetCreditRequest`, confirming that the request body uses the snake_case field name `redeem_request_id`. On the response side, it deserializes representative JSON into `RateLimitStatusWithResetCredits` and `ConsumeRateLimitResetCreditResponse`, asserting that the CLI-facing types correctly ignore irrelevant backend fields like the nested `credit.id` while preserving the fields the CLI actually uses, such as `available_count`, `code`, and `windows_reset`.

A local `test_client` helper constructs a minimal `Client` directly, bypassing the heavier production constructor because these tests only need deterministic URL generation and type-level serde behavior.

#### Function details

##### `rate_limit_reset_contract_uses_expected_paths_and_payloads`  (lines 7–59)

```
fn rate_limit_reset_contract_uses_expected_paths_and_payloads()
```

**Purpose**: Verifies the full contract surface for rate-limit reset credits: URL generation for both path styles, request JSON shape, and deserialization of representative status and consume responses. It ensures the CLI and backend stay aligned on these wire formats.

**Data flow**: Builds test clients for Codex and ChatGPT path styles, calls `rate_limit_status_url()` and `consume_rate_limit_reset_credit_url()` and asserts exact strings, serializes `ConsumeRateLimitResetCreditRequest` to JSON and asserts the field name/value, deserializes sample JSON into `RateLimitStatusWithResetCredits` and `ConsumeRateLimitResetCreditResponse`, and asserts the resulting typed values.

**Call relations**: It exercises the URL builders defined in `rate_limit_resets.rs` and the serde contracts of the request/response types used by that submodule.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `test_client`  (lines 61–71)

```
fn test_client(base_url: &str, path_style: PathStyle) -> Client
```

**Purpose**: Builds a minimal `Client` fixture for contract tests in this file. It avoids unrelated constructor behavior so tests can focus on path generation and serde.

**Data flow**: Consumes a base URL and `PathStyle`, constructs a `Client` with those values plus a fresh `reqwest::Client`, unauthenticated auth provider, and default optional fields, and returns it.

**Call relations**: It is used by `rate_limit_reset_contract_uses_expected_paths_and_payloads` to access the submodule URL builders.

*Call graph*: calls 1 internal fn (new); 1 external calls (unauthenticated_auth_provider).


### `login/src/token_data_tests.rs`

`test` · `unit test execution`

This test module exercises the parsing helpers in `token_data.rs` with compact, deterministic JWT fixtures. The local `fake_jwt` helper builds a syntactically valid three-part JWT by serializing a fixed `{alg:"none", typ:"JWT"}` header, serializing an arbitrary JSON payload, base64url-encoding both without padding, and appending a dummy signature. Individual tests then feed those tokens into `parse_chatgpt_jwt_claims` or `parse_jwt_expiration`. Coverage includes top-level email extraction, mapping raw plan slugs like `pro`, `go`, and `hc` into display names, preserving raw values for usage-based business plans, and classifying workspace plans correctly. Missing-claim tests confirm that absent auth/profile sections yield `None` fields and a false FedRAMP flag rather than errors. Separate expiration tests verify successful `exp` conversion to `Utc.timestamp_opt(...).single()`, graceful `None` when `exp` is absent, and a specific error string for malformed non-JWT input. The final test bypasses parsing entirely and constructs `IdTokenInfo` values directly with `PlanType::Known(KnownPlan::...)` to validate `is_workspace_account()` semantics independently of JWT decoding.

#### Function details

##### `fake_jwt`  (lines 8–27)

```
fn fake_jwt(payload: serde_json::Value) -> String
```

**Purpose**: Builds a minimal unsigned JWT string around an arbitrary JSON payload for parser tests. It ensures the token matches the exact base64url-no-padding format expected by the production decoder.

**Data flow**: Accepts `payload: serde_json::Value` → serializes a fixed header struct and the payload to bytes → base64url-no-pad encodes header, payload, and a literal `sig` signature → concatenates them with `.` separators → returns the JWT string.

**Call relations**: Used by most tests in this file to generate valid inputs for `parse_chatgpt_jwt_claims` and `parse_jwt_expiration`, avoiding dependence on external fixtures.

*Call graph*: called by 8 (id_token_info_handles_missing_fields, id_token_info_parses_email_and_plan, id_token_info_parses_fedramp_account_claim, id_token_info_parses_go_plan, id_token_info_parses_hc_plan_as_enterprise, id_token_info_parses_usage_based_business_plans, jwt_expiration_handles_missing_exp, jwt_expiration_parses_exp_claim); 2 external calls (format!, to_vec).


##### `id_token_info_parses_email_and_plan`  (lines 30–41)

```
fn id_token_info_parses_email_and_plan()
```

**Purpose**: Verifies that a token with top-level `email` and auth `chatgpt_plan_type: pro` is parsed into the expected email and display plan name.

**Data flow**: Creates a fake JWT payload with email and auth claims → parses it with `parse_chatgpt_jwt_claims` → asserts `info.email` is `user@example.com` and `get_chatgpt_plan_type()` returns `Some("Pro")`.

**Call relations**: Invoked by the Rust test runner as a unit test; it uses `fake_jwt` to drive the happy-path parser behavior.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_go_plan`  (lines 44–55)

```
fn id_token_info_parses_go_plan()
```

**Purpose**: Checks that the raw plan slug `go` is normalized to the display label `Go`.

**Data flow**: Builds a JWT with email plus `chatgpt_plan_type: "go"` → parses claims → asserts the parsed email and display plan string.

**Call relations**: Runs as a unit test alongside the other plan-mapping cases, using `fake_jwt` to isolate parser logic.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_hc_plan_as_enterprise`  (lines 58–70)

```
fn id_token_info_parses_hc_plan_as_enterprise()
```

**Purpose**: Confirms that the backend plan slug `hc` is interpreted as the Enterprise display plan and classified as a workspace account.

**Data flow**: Constructs a JWT with `chatgpt_plan_type: "hc"` → parses it → asserts email, display plan `Enterprise`, and `is_workspace_account() == true`.

**Call relations**: Exercises both plan-name normalization and workspace-account classification in one parser-driven scenario.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_usage_based_business_plans`  (lines 73–108)

```
fn id_token_info_parses_usage_based_business_plans()
```

**Purpose**: Tests two usage-based workspace plan variants, ensuring both display-name formatting and raw-value preservation work correctly.

**Data flow**: Creates one JWT for `self_serve_business_usage_based` and another for `enterprise_cbp_usage_based` → parses each → asserts display names, raw plan strings from `get_chatgpt_plan_type_raw()`, and workspace classification.

**Call relations**: This test broadens plan coverage beyond simple personal tiers and validates both accessor methods on `IdTokenInfo`.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_handles_missing_fields`  (lines 111–118)

```
fn id_token_info_handles_missing_fields()
```

**Purpose**: Ensures sparse JWT payloads without relevant claims still parse successfully into defaulted `IdTokenInfo` values.

**Data flow**: Builds a JWT containing only `sub` → parses it → asserts `email` is `None`, plan type accessor returns `None`, and FedRAMP detection is false.

**Call relations**: Covers the parser branch where namespaced auth/profile claims are absent and defaults are synthesized.

*Call graph*: calls 1 internal fn (fake_jwt); 3 external calls (assert!, assert_eq!, json!).


##### `id_token_info_parses_fedramp_account_claim`  (lines 121–133)

```
fn id_token_info_parses_fedramp_account_claim()
```

**Purpose**: Verifies extraction of workspace account ID and the FedRAMP routing flag from the auth namespace.

**Data flow**: Creates a JWT with `chatgpt_account_id` and `chatgpt_account_is_fedramp: true` → parses it → asserts the account id string and `is_fedramp_account() == true`.

**Call relations**: Targets the FedRAMP-specific fields added to `IdTokenInfo`, again using `fake_jwt` as the fixture source.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_parses_exp_claim`  (lines 136–143)

```
fn jwt_expiration_parses_exp_claim()
```

**Purpose**: Checks that `parse_jwt_expiration` converts a numeric `exp` claim into the expected UTC timestamp.

**Data flow**: Builds a JWT with `exp: 1_700_000_000` → parses expiration → compares the result to `Utc.timestamp_opt(...).single()`.

**Call relations**: Exercises the expiration-only parsing path rather than the ChatGPT-specific claim parser.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_handles_missing_exp`  (lines 146–151)

```
fn jwt_expiration_handles_missing_exp()
```

**Purpose**: Confirms that tokens without an `exp` claim return `Ok(None)` instead of failing.

**Data flow**: Creates a JWT with only `sub` → calls `parse_jwt_expiration` → asserts the returned option is `None`.

**Call relations**: Covers the optional-claim branch in `parse_jwt_expiration`.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_rejects_malformed_jwt`  (lines 154–157)

```
fn jwt_expiration_rejects_malformed_jwt()
```

**Purpose**: Verifies that a non-JWT string is rejected with the expected invalid-format error message.

**Data flow**: Calls `parse_jwt_expiration("not-a-jwt")` → expects an error → asserts its string form equals `invalid ID token format`.

**Call relations**: Exercises the structural validation in `decode_jwt_payload` through the expiration parser entrypoint.

*Call graph*: 1 external calls (assert_eq!).


##### `workspace_account_detection_matches_workspace_plans`  (lines 160–178)

```
fn workspace_account_detection_matches_workspace_plans()
```

**Purpose**: Tests `IdTokenInfo::is_workspace_account` directly against known plan enums without involving JWT parsing.

**Data flow**: Constructs three `IdTokenInfo` values with `KnownPlan::Business`, `KnownPlan::Pro`, and `KnownPlan::ProLite` respectively → calls `is_workspace_account()` on each → asserts true only for the business plan.

**Call relations**: Complements parser tests by validating the classification helper in isolation from claim decoding.

*Call graph*: 3 external calls (assert_eq!, Known, default).


### `login/src/auth/default_client_tests.rs`

`test` · `test execution`

These tests pin down the externally visible behavior of the shared client factory in `default_client.rs`. The simplest checks assert that `get_codex_user_agent` begins with the current originator plus a slash, and that the first-party originator classifiers accept and reject the expected hard-coded strings. Two sanitization tests exercise invalid control characters in the optional suffix path, confirming that carriage returns and NUL bytes are rewritten to underscores rather than producing an invalid header.

The most integration-heavy test spins up a local `wiremock` server, enables a residency requirement, creates a default client, sends a GET request, and inspects the captured request headers. It verifies that the generated client actually emits the `originator` header matching `originator().value`, the `user-agent` header matching `get_codex_user_agent()`, and the residency header with value `us`. The test resets the residency requirement afterward to avoid leaking global state into later tests. A macOS-only regex test further constrains the exact user-agent shape on that platform, including semantic version formatting, `Mac OS` version text, architecture, and the terminal-detection suffix token.

#### Function details

##### `test_get_codex_user_agent`  (lines 7–12)

```
fn test_get_codex_user_agent()
```

**Purpose**: Checks that the generated user-agent string is prefixed by the current originator and a version separator.

**Data flow**: It calls `get_codex_user_agent()` and `originator().value`, formats the expected prefix as `<originator>/`, and asserts that the UA string starts with that prefix.

**Call relations**: This is a direct unit test of the read-side UA generator, with no network or storage dependencies.

*Call graph*: 2 external calls (assert!, format!).


##### `is_first_party_originator_matches_known_values`  (lines 15–22)

```
fn is_first_party_originator_matches_known_values()
```

**Purpose**: Verifies the allowlist and reject list encoded in `is_first_party_originator`.

**Data flow**: It passes several literal strings into `is_first_party_originator` and asserts exact boolean outcomes for official and non-official values.

**Call relations**: The test documents the intended classification boundary for first-party originators by exercising the helper with representative constants and near-misses.

*Call graph*: 1 external calls (assert_eq!).


##### `is_first_party_chat_originator_matches_known_values`  (lines 25–33)

```
fn is_first_party_chat_originator_matches_known_values()
```

**Purpose**: Verifies the narrower chat-originator classifier against known accepted and rejected values.

**Data flow**: It invokes `is_first_party_chat_originator` with two accepted literals and several rejected ones, asserting the expected booleans.

**Call relations**: This test isolates the chat-specific classification helper so policy code depending on it has a stable contract.

*Call graph*: 1 external calls (assert_eq!).


##### `test_create_client_sets_default_headers`  (lines 36–90)

```
async fn test_create_client_sets_default_headers()
```

**Purpose**: Confirms that a client created by `create_client` actually sends the default originator, user-agent, and residency headers on outbound requests.

**Data flow**: After optionally skipping when network tests are unavailable, it sets the global residency requirement to `Some(Us)`, creates a client, starts a `wiremock` server, mounts a GET `/` responder, sends a request through the client, and inspects the first received request’s headers. It asserts success status, presence and exact values of `originator`, `user-agent`, and `RESIDENCY_HEADER_NAME`, then clears the residency requirement back to `None`.

**Call relations**: This is the integration test for the whole default-client stack: global residency state influences `default_headers`, `create_client` wraps the configured reqwest client, and the mock server proves those headers survive onto the wire.

*Call graph*: 6 external calls (given, start, new, assert!, assert_eq!, skip_if_no_network!).


##### `test_invalid_suffix_is_sanitized`  (lines 93–101)

```
fn test_invalid_suffix_is_sanitized()
```

**Purpose**: Checks that a carriage return in the user-agent suffix is replaced with an underscore.

**Data flow**: It constructs a fixed prefix and a suffix containing `\r`, passes the formatted candidate UA plus fallback prefix into `sanitize_user_agent`, and asserts the returned string contains `bad_suffix`.

**Call relations**: This directly exercises the sanitization branch that rewrites invalid header characters instead of rejecting the whole UA.

*Call graph*: 1 external calls (assert_eq!).


##### `test_invalid_suffix_is_sanitized2`  (lines 104–112)

```
fn test_invalid_suffix_is_sanitized2()
```

**Purpose**: Checks that a NUL byte in the user-agent suffix is replaced with an underscore.

**Data flow**: It mirrors the previous test but uses a suffix containing `\0`, then asserts the sanitized UA string matches the expected underscore-substituted form.

**Call relations**: Together with the carriage-return case, this test covers multiple invalid-character paths through `sanitize_user_agent`.

*Call graph*: 1 external calls (assert_eq!).


##### `test_macos`  (lines 116–125)

```
fn test_macos()
```

**Purpose**: On macOS, verifies the full user-agent format against a regex that constrains version, OS label, architecture, and trailing terminal token.

**Data flow**: It computes the current user agent and escaped originator, builds a regex string incorporating that originator, compiles it, and asserts the UA matches.

**Call relations**: This platform-specific test guards the exact formatting contract of `get_codex_user_agent` on macOS, beyond the looser prefix-only assertion used cross-platform.

*Call graph*: 4 external calls (new, assert!, format!, escape).


### `chatgpt/src/workspace_settings_tests.rs`

`test` · `test run`

This file is a tiny test module that imports the parent module with `use super::*;` and exercises the `encode_path_segment` helper through two focused assertions. The first test establishes the invariant that unreserved ASCII characters commonly allowed in URL path segments — letters, digits, hyphen, underscore, dot, and tilde — are preserved exactly, with no unnecessary escaping. The second test verifies the opposite boundary: characters that would alter path structure or readability, specifically `/` and spaces, are percent-encoded as `%2F` and `%20`. Together these tests define the intended encoding contract at the character-class level rather than through broad property testing. That makes the behavior concrete for maintainers: the encoder is expected to be conservative about reserved separators while leaving safe ASCII untouched. Because the tests compare exact output strings, they also implicitly require uppercase hex escapes and stable formatting.

#### Function details

##### `encode_path_segment_leaves_unreserved_ascii_unchanged`  (lines 4–9)

```
fn encode_path_segment_leaves_unreserved_ascii_unchanged()
```

**Purpose**: Verifies that `encode_path_segment` returns an identical string when given only unreserved ASCII characters. It protects against regressions that would over-escape safe path content.

**Data flow**: The test passes the literal input `account-123_ABC.~` into `encode_path_segment`, then compares the produced string to the exact same literal with `assert_eq!`. It reads no external state and writes no state beyond the test assertion outcome.

**Call relations**: This is a standalone unit test invoked by Rust's test harness. Its only downstream action is the equality assertion that validates the imported encoder's behavior for the safe-character case.

*Call graph*: 1 external calls (assert_eq!).


##### `encode_path_segment_escapes_path_separators_and_spaces`  (lines 12–17)

```
fn encode_path_segment_escapes_path_separators_and_spaces()
```

**Purpose**: Checks that `encode_path_segment` percent-encodes path separators and spaces instead of leaving them literal. It specifically confirms that embedded `/` does not survive as a structural delimiter.

**Data flow**: The test feeds `account/123 with space` to `encode_path_segment` and asserts that the result is exactly `account%2F123%20with%20space`. It consumes only the hard-coded input and produces a pass/fail assertion result.

**Call relations**: This test is also run directly by the test harness. It complements the previous test by covering reserved characters and delegates validation to a single exact-string `assert_eq!`.

*Call graph*: 1 external calls (assert_eq!).


### `codex-api/src/api_bridge_tests.rs`

`test` · `test execution`

This test module exercises the translation rules implemented in `api_bridge.rs` by constructing concrete `ApiError::Transport(TransportError::Http { ... })` values and asserting on the resulting `CodexErr`. The tests intentionally cover both direct semantic mappings and wire-format quirks.

Several cases validate body-driven special handling: a plain `ApiError::ServerOverloaded` maps directly, while a 503 body containing `error.code = server_is_overloaded` must also normalize to `ServerOverloaded`. For 400 responses, tests verify that `error.code = cyber_policy` is recognized in both standard and websocket-wrapped JSON shapes, that a missing message falls back to the fixed cybersecurity warning, and that unrelated 400 codes remain generic `InvalidRequest` carrying the original body.

The 429 tests focus on rate-limit metadata. They verify that `x-codex-active-limit` is used to select the correct limit-name header, that the implementation does not incorrectly fall back from limit name to limit ID, and that malformed or future `x-codex-rate-limit-reached-type` values are ignored rather than causing parse failures. The final test checks extraction of request ID, Cloudflare ray, authorization error, and base64-encoded `x-error-json` code into `UnexpectedStatus`.

Together these tests define the compatibility contract for error normalization from raw HTTP responses into protocol errors.

#### Function details

##### `map_api_error_maps_server_overloaded`  (lines 6–9)

```
fn map_api_error_maps_server_overloaded()
```

**Purpose**: Checks the direct semantic mapping from `ApiError::ServerOverloaded` to `CodexErr::ServerOverloaded`.

**Data flow**: Constructs the semantic error, passes it to `map_api_error`, and asserts the returned enum matches the overloaded variant. No external state is read or written.

**Call relations**: This is the simplest baseline test for the mapper, covering the non-HTTP branch before the more complex transport-based cases.

*Call graph*: 1 external calls (assert!).


##### `map_api_error_maps_server_overloaded_from_503_body`  (lines 12–27)

```
fn map_api_error_maps_server_overloaded_from_503_body()
```

**Purpose**: Verifies that a 503 HTTP response with the overload error code in its JSON body is normalized to `ServerOverloaded`.

**Data flow**: Builds a JSON body containing `error.code = server_is_overloaded`, wraps it in `TransportError::Http` with status 503, maps it, and asserts the result is `CodexErr::ServerOverloaded`.

**Call relations**: Exercises the special 503-body parsing branch inside `map_api_error`, proving overload detection is not limited to the semantic `ApiError::ServerOverloaded` variant.

*Call graph*: 3 external calls (assert!, Transport, json!).


##### `map_api_error_maps_cyber_policy_from_400_body`  (lines 30–54)

```
fn map_api_error_maps_cyber_policy_from_400_body()
```

**Purpose**: Checks that a standard 400 invalid-request payload with `code = cyber_policy` becomes `CodexErr::CyberPolicy` with the server-provided message.

**Data flow**: Creates a representative JSON error body, maps the wrapped HTTP error, destructures the result as `CodexErr::CyberPolicy`, and asserts the extracted message equals the body message. A mismatch triggers a panic with the unexpected variant.

**Call relations**: Covers the main cyber-policy parsing path for ordinary REST responses.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_maps_wrapped_websocket_cyber_policy_from_400_body`  (lines 57–79)

```
fn map_api_error_maps_wrapped_websocket_cyber_policy_from_400_body()
```

**Purpose**: Verifies cyber-policy detection still works when the 400 body is wrapped in a websocket-style envelope containing top-level `type` and `status` fields.

**Data flow**: Builds the wrapped JSON body, maps it through `map_api_error`, pattern-matches the result as `CodexErr::CyberPolicy`, and asserts the message came from the nested `error.message` field.

**Call relations**: Protects compatibility with websocket error payloads, ensuring the mapper only cares that an `error` object with `code = cyber_policy` exists.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_uses_cyber_policy_fallback_for_missing_message`  (lines 82–103)

```
fn map_api_error_uses_cyber_policy_fallback_for_missing_message()
```

**Purpose**: Ensures the mapper supplies the fixed fallback cybersecurity message when a cyber-policy 400 body omits a usable message.

**Data flow**: Constructs a minimal body containing only `error.code = cyber_policy`, maps it, destructures the `CyberPolicy` result, and asserts the message equals the fallback constant's text.

**Call relations**: Exercises the branch in `map_api_error` that filters out missing or blank messages and substitutes a stable fallback.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_keeps_unknown_400_errors_generic`  (lines 106–125)

```
fn map_api_error_keeps_unknown_400_errors_generic()
```

**Purpose**: Confirms that unrelated 400 error codes are not over-classified as cyber-policy and remain generic invalid requests.

**Data flow**: Creates a 400 body with a different `error.code`, maps it, destructures the result as `CodexErr::InvalidRequest`, and asserts the returned message is the original raw body string.

**Call relations**: Acts as a negative test for the cyber-policy special case, proving the mapper preserves generic behavior for unknown bad-request payloads.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_maps_usage_limit_limit_name_header`  (lines 128–162)

```
fn map_api_error_maps_usage_limit_limit_name_header()
```

**Purpose**: Checks that usage-limit errors use the active-limit header to select and expose the correct parsed limit name.

**Data flow**: Builds headers containing `x-codex-active-limit = codex_other` and the corresponding `x-codex-other-limit-name`, constructs a 429 `usage_limit_reached` body, maps it, destructures `CodexErr::UsageLimitReached`, and asserts the nested rate-limit snapshot exposes `limit_name = Some("codex_other")`.

**Call relations**: Exercises the 429 usage-limit branch plus the helper parsing in `rate_limits`, specifically the path where an active limit ID guides which limit-name header should be read.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, panic!, json!).


##### `map_api_error_does_not_fallback_limit_name_to_limit_id`  (lines 165–195)

```
fn map_api_error_does_not_fallback_limit_name_to_limit_id()
```

**Purpose**: Verifies that when the active limit ID is present but no corresponding limit-name header exists, the mapper leaves `limit_name` unset instead of copying the ID.

**Data flow**: Creates headers with only `x-codex-active-limit`, maps a 429 `usage_limit_reached` response, extracts the `UsageLimitReached` payload, and asserts the nested `limit_name` is `None`.

**Call relations**: Protects a subtle invariant in rate-limit parsing: limit IDs and human-facing limit names are distinct, and the mapper must not invent a name from the ID.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, panic!, json!).


##### `map_api_error_ignores_unparseable_rate_limit_reached_type_headers`  (lines 198–226)

```
fn map_api_error_ignores_unparseable_rate_limit_reached_type_headers()
```

**Purpose**: Ensures malformed or unknown `x-codex-rate-limit-reached-type` headers do not break usage-limit parsing and simply yield no reached-type metadata.

**Data flow**: Iterates over two problematic header values—an unknown future string and opaque non-UTF8 bytes—builds a 429 `usage_limit_reached` response for each, maps it, extracts the `UsageLimitReached` payload, and asserts `rate_limit_reached_type` is `None`.

**Call relations**: Covers robustness of the optional header parsing path used by `map_api_error`, showing that unsupported values are ignored rather than surfaced as errors.

*Call graph*: 7 external calls (new, assert_eq!, Transport, from_bytes, from_static, panic!, json!).


##### `map_api_error_extracts_identity_auth_details_from_headers`  (lines 229–261)

```
fn map_api_error_extracts_identity_auth_details_from_headers()
```

**Purpose**: Checks that unexpected-status errors include request tracking and identity-auth metadata extracted from headers, including base64-decoded `x-error-json`.

**Data flow**: Builds headers with request ID, Cloudflare ray, authorization error, and a base64-encoded JSON header containing `error.code = token_expired`; wraps them in a 401 HTTP transport error; maps it; destructures the result as `CodexErr::UnexpectedStatus`; and asserts each extracted field matches the header contents.

**Call relations**: Exercises the helper functions `extract_request_id`, `extract_header`, and `extract_x_error_json_code` indirectly through the default unexpected-status branch of `map_api_error`.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, from_str, panic!).


### `codex-api/tests/clients.rs`

`test` · `test execution`

This integration-style test file builds a small in-memory harness around the public `ResponsesClient`. `RecordingState` and `RecordingTransport` capture streamed `Request` objects without performing real network I/O, making it possible to inspect URLs, headers, and prepared bodies after a client call. `FlakyTransport` simulates a transport-level failure on the first streaming attempt and success on the second while recording each request body, header map, and transport compression flag; this is used to prove retry behavior and body reuse. On the auth side, `NoAuth` is a no-op provider, `StaticAuth` injects bearer and account headers, and `FailsOnceAuth` fails exactly once with either a transient or build-time `AuthError` before succeeding, allowing tests to distinguish retryable from non-retryable auth failures.

The shared `provider` helper constructs a minimal `Provider` with deterministic retry and timeout settings. The tests then cover several concrete invariants: Responses requests target `/responses`; `stream_request` preserves the exact serialized JSON bytes and content type; auth headers and `Accept: text/event-stream` are attached; transport retries resend an identical encoded body and preserve pre-encoded zstd content via headers rather than transport compression; transient auth failures are retried but auth build failures are not; and Azure-mode requests add session/thread/subagent headers plus copy input item IDs into the outgoing JSON body when `store` is enabled.

#### Function details

##### `assert_path_ends_with`  (lines 31–38)

```
fn assert_path_ends_with(requests: &[Request], suffix: &str)
```

**Purpose**: Asserts that exactly one recorded request exists and that its URL ends with the expected suffix. It is a small convenience for endpoint-path tests.

**Data flow**: Reads the `requests` slice, asserts its length is 1, reads `requests[0].url`, and asserts `url.ends_with(suffix)` with a custom failure message.

**Call relations**: Used by `responses_client_uses_responses_path` to verify the client targeted the correct endpoint.

*Call graph*: called by 1 (responses_client_uses_responses_path); 2 external calls (assert!, assert_eq!).


##### `request_body_bytes`  (lines 40–45)

```
fn request_body_bytes(request: &Request) -> &[u8]
```

**Purpose**: Extracts the raw bytes from a request whose body has already been prepared as `RequestBody::EncodedJson`. It panics if the request body is absent or of a different variant.

**Data flow**: Reads `request.body.as_ref()`, pattern-matches `Some(RequestBody::EncodedJson(body))`, and returns `body.as_bytes()`. Any mismatch triggers `panic!`.

**Call relations**: This helper is used by the Azure request-shaping test to deserialize and inspect the exact outgoing JSON payload.

*Call graph*: called by 1 (azure_default_store_attaches_ids_and_headers); 1 external calls (panic!).


##### `RecordingState::record`  (lines 53–59)

```
fn record(&self, req: Request)
```

**Purpose**: Appends a streamed request to the shared recording buffer. It is the mutation point behind the recording transport.

**Data flow**: Locks `self.stream_requests`, panicking if the mutex is poisoned, and pushes the owned `Request` into the inner `Vec<Request>`.

**Call relations**: Called by `RecordingTransport::stream` whenever the fake transport receives a streaming request.

*Call graph*: called by 1 (stream).


##### `RecordingState::take_stream_requests`  (lines 61–67)

```
fn take_stream_requests(&self) -> Vec<Request>
```

**Purpose**: Drains and returns all recorded stream requests collected so far. This lets each test inspect requests without retaining old state.

**Data flow**: Locks `self.stream_requests`, panicking on poison, then uses `std::mem::take` to replace the inner vector with an empty one and returns the previous contents.

**Call relations**: Tests call this after invoking the client to inspect what the recording transport observed.

*Call graph*: 1 external calls (take).


##### `RecordingTransport::new`  (lines 76–78)

```
fn new(state: RecordingState) -> Self
```

**Purpose**: Constructs a recording transport around shared mutable state. Clones of the transport share the same request log.

**Data flow**: Consumes a `RecordingState` and returns `RecordingTransport { state }`.

**Call relations**: Most tests create this transport to capture outbound streaming requests without real network activity.

*Call graph*: called by 6 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error).


##### `RecordingTransport::execute`  (lines 82–84)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements the unary transport method as an intentional failure because these tests are only concerned with streaming requests. Any accidental unary call is surfaced immediately.

**Data flow**: Ignores the request argument and returns `Err(TransportError::Build("execute should not run".to_string()))`.

**Call relations**: This method exists to satisfy `HttpTransport`; the tests expect the Responses client paths under test to use `stream`, not `execute`.

*Call graph*: 1 external calls (Build).


##### `RecordingTransport::stream`  (lines 86–95)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Records the incoming streaming request and returns an empty successful `StreamResponse`. It is the core fake transport used by most tests.

**Data flow**: Consumes the `Request`, passes it to `self.state.record(req)`, constructs an empty byte stream from `futures::stream::iter`, and returns `Ok(StreamResponse { status: 200 OK, headers: empty HeaderMap, bytes: Box::pin(stream) })`.

**Call relations**: Responses client tests invoke this indirectly through `ResponsesClient::stream` or `stream_request`; it supplies captured requests for later assertions.

*Call graph*: calls 1 internal fn (record); 4 external calls (pin, new, new, iter).


##### `NoAuth::add_auth_headers`  (lines 102–102)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements an auth provider that adds no headers. It is the baseline auth fixture for tests that do not care about authentication.

**Data flow**: Receives a mutable `HeaderMap` reference and leaves it unchanged.

**Call relations**: Used in tests where auth behavior should not affect the request under inspection.


##### `StaticAuth::new`  (lines 112–117)

```
fn new(token: &str, account_id: &str) -> Self
```

**Purpose**: Builds a fixed auth provider carrying a bearer token and account id. The values are stored as owned strings for later header insertion.

**Data flow**: Copies the `token` and `account_id` string slices into owned `String`s and returns `StaticAuth { token, account_id }`.

**Call relations**: Used by `streaming_client_adds_auth_headers` to verify auth header injection.

*Call graph*: called by 1 (streaming_client_adds_auth_headers).


##### `StaticAuth::add_auth_headers`  (lines 121–129)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds an `Authorization: Bearer ...` header and `ChatGPT-Account-ID` header when both values can be encoded as valid HTTP header values. Invalid values are silently skipped.

**Data flow**: Reads `self.token` and `self.account_id`, formats `Bearer {token}`, converts each string to `HeaderValue` with `from_str`, and inserts successful conversions into the mutable `HeaderMap`.

**Call relations**: This is exercised indirectly by the Responses client when a test uses `StaticAuth`.

*Call graph*: 3 external calls (insert, from_str, format!).


##### `provider`  (lines 132–147)

```
fn provider(name: &str) -> Provider
```

**Purpose**: Creates a minimal `Provider` fixture with a configurable name and deterministic retry/timeout settings. It standardizes test setup across all client tests in this file.

**Data flow**: Builds and returns a `Provider` with `base_url` set to `https://example.com/v1`, empty headers, no query params, `RetryConfig { max_attempts: 1, base_delay: 1ms, retry_429: false, retry_5xx: false, retry_transport: true }`, and `stream_idle_timeout` of 10ms.

**Call relations**: Nearly every test uses this helper, sometimes mutating the returned provider's retry settings before constructing a client.

*Call graph*: called by 7 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error, streaming_client_retries_on_transport_error); 2 external calls (from_millis, new).


##### `FlakyTransport::default`  (lines 161–163)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor for the flaky transport by delegating to `new`. It keeps the fixture ergonomic in tests.

**Data flow**: Calls `Self::new()` and returns the resulting transport.

**Call relations**: This is the `Default` implementation backing any default construction of `FlakyTransport`.

*Call graph*: 1 external calls (new).


##### `FlakyTransport::new`  (lines 167–171)

```
fn new() -> Self
```

**Purpose**: Constructs a flaky transport with zero attempts and an empty request log. The state is shared behind `Arc<Mutex<...>>` so clones observe the same counters.

**Data flow**: Allocates a default `FlakyTransportState`, wraps it in `Arc<Mutex<_>>`, and returns `FlakyTransport { state }`.

**Call relations**: Used by the transport-retry test to simulate one failing attempt followed by success.

*Call graph*: called by 1 (streaming_client_retries_on_transport_error); 3 external calls (new, new, default).


##### `FlakyTransport::attempts`  (lines 173–178)

```
fn attempts(&self) -> i64
```

**Purpose**: Returns how many streaming attempts the flaky transport has observed so far. It is used to assert retry counts.

**Data flow**: Locks the shared state mutex, panicking on poison, reads `attempts`, and returns it.

**Call relations**: Called by `streaming_client_retries_on_transport_error` after the client call completes.


##### `FlakyTransport::requests`  (lines 180–186)

```
fn requests(&self) -> Vec<(RequestBody, HeaderMap, codex_client::RequestCompression)>
```

**Purpose**: Returns a clone of the recorded request bodies, headers, and compression flags seen by the flaky transport. This allows tests to compare attempts for exact equality.

**Data flow**: Locks the shared state mutex, clones the `requests` vector, and returns the clone.

**Call relations**: Used by the transport-retry test to verify that retries resend the same prepared request.


##### `FailsOnceAuth::transient`  (lines 196–203)

```
fn transient() -> Self
```

**Purpose**: Constructs an auth provider that fails exactly once with a transient auth error before succeeding. It is used to verify retry-on-auth behavior.

**Data flow**: Initializes `attempts` to `0` inside `Arc<Mutex<i64>>`, stores `AuthError::Transient("sts temporarily unavailable")` inside an `Arc`, and returns the new `FailsOnceAuth`.

**Call relations**: Used by `streaming_client_retries_on_transient_auth_error`.

*Call graph*: called by 1 (streaming_client_retries_on_transient_auth_error); 3 external calls (new, new, Transient).


##### `FailsOnceAuth::build`  (lines 205–210)

```
fn build() -> Self
```

**Purpose**: Constructs an auth provider that fails exactly once with a non-retryable build error before it would otherwise succeed. This fixture distinguishes fatal auth setup failures from transient ones.

**Data flow**: Initializes the shared attempt counter and stores `AuthError::Build("invalid auth configuration")` inside an `Arc`, then returns the provider.

**Call relations**: Used by `streaming_client_does_not_retry_auth_build_error`.

*Call graph*: called by 1 (streaming_client_does_not_retry_auth_build_error); 3 external calls (new, new, Build).


##### `FailsOnceAuth::attempts`  (lines 212–217)

```
fn attempts(&self) -> i64
```

**Purpose**: Returns how many times auth application has been attempted. Tests use it to confirm whether retries occurred.

**Data flow**: Locks the shared attempts mutex, panicking on poison, dereferences the stored counter, and returns it.

**Call relations**: Called by both auth-retry tests after invoking the client.


##### `FailsOnceAuth::add_auth_headers`  (lines 238–238)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements the synchronous auth-header hook as a no-op because this fixture exercises the asynchronous `apply_auth` path instead. It keeps the test focused on retry semantics around auth application.

**Data flow**: Receives a mutable `HeaderMap` and leaves it unchanged.

**Call relations**: Part of the `AuthProvider` implementation required by the client under test.


##### `FailsOnceAuth::apply_auth`  (lines 240–242)

```
fn apply_auth(&self, request: Request) -> codex_api::AuthProviderFuture<'_>
```

**Purpose**: Implements the async auth hook by failing on the first call with the configured auth error and returning the original request unchanged on subsequent calls. It is the core behavior behind the auth retry tests.

**Data flow**: Locks and increments the shared attempt counter. If the new count is 1, it clones and returns either `AuthError::Build` or `AuthError::Transient` based on the stored error variant; otherwise it returns `Ok(request)` unchanged.

**Call relations**: The `AuthProvider` trait implementation boxes this future and the Responses client invokes it during request preparation. Tests observe whether the client retries based on which error variant this function returns.

*Call graph*: 3 external calls (pin, Build, Transient).


##### `FlakyTransport::execute`  (lines 246–248)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements unary execution for the flaky transport as an intentional failure, since the tests only exercise streaming behavior. Any accidental unary path is treated as a test failure.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("execute should not run".to_string()))`.

**Call relations**: This satisfies the `HttpTransport` trait while steering the tested client paths toward `stream`.

*Call graph*: 1 external calls (Build).


##### `FlakyTransport::stream`  (lines 250–279)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Simulates a transport that fails once and then succeeds, while recording each request's prepared body, headers, and compression setting. It is used to prove retry behavior and request reuse.

**Data flow**: Clones `req.body` and panics if absent, locks shared state, increments `attempts`, and pushes `(body, req.headers.clone(), req.compression)` into the request log. On the first attempt it returns `Err(TransportError::Network("first attempt fails"))`; on later attempts it returns a successful `StreamResponse` whose byte stream contains one canned SSE message.

**Call relations**: The Responses client's retry logic invokes this through the transport interface; `streaming_client_retries_on_transport_error` then inspects the recorded attempts.

*Call graph*: 6 external calls (pin, new, Network, iter, panic!, vec!).


##### `responses_client_uses_responses_path`  (lines 283–301)

```
async fn responses_client_uses_responses_path() -> Result<()>
```

**Purpose**: Verifies that the Responses client targets the `/responses` endpoint when streaming a generic JSON body. This is the basic endpoint-routing test.

**Data flow**: Creates recording state and transport, constructs a `ResponsesClient`, sends a simple JSON body through `client.stream(...)`, drains recorded requests with `take_stream_requests`, and asserts the URL suffix with `assert_path_ends_with`.

**Call relations**: This test exercises the normal streaming request path through the public client API.

*Call graph*: calls 4 internal fn (new, new, assert_path_ends_with, provider); 4 external calls (new, new, default, json!).


##### `responses_client_stream_request_preserves_exact_json_body`  (lines 304–347)

```
async fn responses_client_stream_request_preserves_exact_json_body() -> Result<()>
```

**Purpose**: Checks that `stream_request` preserves the exact serialized JSON bytes of a typed `ResponsesApiRequest` and sets `Content-Type: application/json`. It guards against lossy reserialization or body mutation during request preparation.

**Data flow**: Builds a typed `ResponsesApiRequest`, serializes it to `expected` bytes with `serde_json::to_vec`, sends it via `client.stream_request`, retrieves the recorded request, calls `prepare_body_for_send()`, and asserts that the prepared body bytes and content-type header match expectations.

**Call relations**: This test focuses on the typed request path rather than the generic JSON-body path used in simpler streaming tests.

*Call graph*: calls 3 internal fn (new, new, provider); 7 external calls (new, new, assert_eq!, default, default, to_vec, vec!).


##### `streaming_client_adds_auth_headers`  (lines 350–388)

```
async fn streaming_client_adds_auth_headers() -> Result<()>
```

**Purpose**: Verifies that the streaming client applies auth headers from `StaticAuth` and also sets the SSE `Accept` header. It checks both authentication and protocol-negotiation headers on the outgoing request.

**Data flow**: Constructs a client with `StaticAuth`, sends a simple JSON body through `client.stream`, retrieves the recorded request, and asserts the values of `Authorization`, `ChatGPT-Account-ID`, and `Accept` headers.

**Call relations**: This test exercises the interaction between request assembly and the auth provider's synchronous header hook.

*Call graph*: calls 4 internal fn (new, new, new, provider); 6 external calls (new, new, assert!, assert_eq!, default, json!).


##### `streaming_client_retries_on_transport_error`  (lines 391–444)

```
async fn streaming_client_retries_on_transport_error() -> Result<()>
```

**Purpose**: Checks that a transport-level streaming failure is retried according to provider retry settings and that the retried request is byte-for-byte equivalent to the first. It also verifies how zstd compression is represented on the request.

**Data flow**: Creates a `FlakyTransport`, raises `provider.retry.max_attempts` to 2, builds a typed `ResponsesApiRequest`, sends it with `ResponsesOptions { compression: Compression::Zstd, .. }`, then asserts `transport.attempts() == 2`, compares the two recorded requests for equality, checks that both `EncodedJson` bodies share the same underlying byte pointer, and asserts `Content-Encoding: zstd` while transport compression remains `RequestCompression::None`.

**Call relations**: This test exercises the client's retry orchestration around the flaky transport and confirms that request preparation happens once and is reused across attempts.

*Call graph*: calls 3 internal fn (new, new, provider); 5 external calls (new, default, new, assert_eq!, panic!).


##### `streaming_client_retries_on_transient_auth_error`  (lines 447–469)

```
async fn streaming_client_retries_on_transient_auth_error() -> Result<()>
```

**Purpose**: Verifies that a transient auth failure triggers a retry and that only the successful attempt reaches the transport. It distinguishes auth retries from transport retries.

**Data flow**: Creates recording transport and `FailsOnceAuth::transient`, sets provider max attempts to 2, sends a simple JSON body through `client.stream`, then asserts that auth was attempted twice while only one request was recorded by the transport.

**Call relations**: This test exercises the client's auth-application retry path using the fixture's first-call transient failure.

*Call graph*: calls 4 internal fn (new, transient, new, provider); 5 external calls (new, new, assert_eq!, default, json!).


##### `streaming_client_does_not_retry_auth_build_error`  (lines 472–502)

```
async fn streaming_client_does_not_retry_auth_build_error() -> Result<()>
```

**Purpose**: Checks that a non-retryable auth build error fails immediately without contacting the transport or consuming retry budget. This protects callers from masking configuration errors as transient failures.

**Data flow**: Creates recording transport and `FailsOnceAuth::build`, sets provider max attempts to 2, calls `client.stream`, captures the resulting error, asserts it is `ApiError::Transport(TransportError::Build("invalid auth configuration"))`, and then asserts auth attempts stayed at 1 and no transport requests were recorded.

**Call relations**: This test complements the transient-auth case by covering the fatal auth branch.

*Call graph*: calls 4 internal fn (new, build, new, provider); 6 external calls (new, new, assert!, assert_eq!, default, json!).


##### `azure_default_store_attaches_ids_and_headers`  (lines 505–589)

```
async fn azure_default_store_attaches_ids_and_headers() -> Result<()>
```

**Purpose**: Verifies Azure-specific request shaping when `store` is enabled: session/thread/subagent headers are attached, extra headers are preserved, and input item IDs are copied into the serialized JSON body. It is the most feature-rich request-construction test in the file.

**Data flow**: Builds a client with provider name `azure`, constructs a typed `ResponsesApiRequest` containing a message with `id`, prepares extra headers and `ResponsesOptions` with session/thread IDs and `SessionSource::SubAgent(SubAgentSource::Review)`, sends the request, retrieves the recorded request, asserts the presence and values of `session-id`, `thread-id`, `x-client-request-id`, `x-openai-subagent`, and the custom extra header, then parses the request body bytes as JSON and asserts that `input[0].id == "msg_1"`.

**Call relations**: This test exercises the Azure-specific branch in request construction, including the header helpers from `requests/headers.rs` and the payload mutation performed by `attach_item_ids`.

*Call graph*: calls 4 internal fn (new, new, provider, request_body_bytes); 9 external calls (new, new, from_static, new, SubAgent, assert_eq!, default, from_slice, vec!).


### `codex-api/tests/models_integration.rs`

`test` · `test execution`

This test file validates the `ModelsClient` against an actual HTTP stack rather than an in-memory fake transport. `DummyAuth` is a minimal `AuthProvider` that leaves headers untouched so authentication does not affect the request under test. The local `provider` helper constructs a `Provider` pointing at a supplied base URL with simple retry settings and a one-second stream idle timeout, mirroring production configuration shape closely enough for integration testing.

The main test, `models_client_hits_models_endpoint`, starts a `wiremock::MockServer`, builds a base URL with an `/api/codex` prefix, and prepares a realistic `ModelsResponse` containing one fully populated `ModelInfo`. The fixture intentionally includes many fields—reasoning presets, shell type, visibility, truncation policy, context window, modalities, and feature flags—so deserialization covers more than just the endpoint path. A wiremock expectation is then installed for `GET /api/codex/models`, returning the JSON body.

The test constructs a real `ReqwestTransport` and `ModelsClient`, calls `list_models`, and asserts both the parsed response (`models.len() == 1`, slug `gpt-test`) and the captured HTTP request details from the mock server (`GET` method and exact `/api/codex/models` path). This confirms both URL joining and response decoding through the public client API.

#### Function details

##### `DummyAuth::add_auth_headers`  (lines 28–28)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements a no-op auth provider for the models integration test. It ensures authentication does not influence the observed request.

**Data flow**: Receives a mutable `HeaderMap` reference and leaves it unchanged.

**Call relations**: Used when constructing the `ModelsClient` in the integration test.


##### `provider`  (lines 31–46)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Builds a `Provider` fixture for the models integration test using the mock server's base URL. It standardizes retry and timeout settings while leaving headers and query params empty.

**Data flow**: Copies `base_url` into a `Provider` with name `test`, empty `HeaderMap`, no query params, `RetryConfig { max_attempts: 1, base_delay: 1ms, retry_429: false, retry_5xx: true, retry_transport: true }`, and `stream_idle_timeout` of 1 second.

**Call relations**: Called by `models_client_hits_models_endpoint` before constructing the `ModelsClient`.

*Call graph*: called by 1 (models_client_hits_models_endpoint); 3 external calls (new, from_millis, from_secs).


##### `models_client_hits_models_endpoint`  (lines 49–137)

```
async fn models_client_hits_models_endpoint()
```

**Purpose**: End-to-end integration test that verifies `ModelsClient::list_models` requests the correct endpoint and successfully deserializes a realistic models payload. It checks both client behavior and actual HTTP traffic.

**Data flow**: Starts a `MockServer`, formats a base URL with `/api/codex`, constructs a detailed `ModelsResponse` fixture, mounts a wiremock expectation for `GET /api/codex/models`, creates a real `ReqwestTransport` and `ModelsClient`, calls `list_models("0.1.0", HeaderMap::new())`, asserts the returned model list contents, then fetches recorded requests from the mock server and asserts there was exactly one `GET` to `/api/codex/models`.

**Call relations**: This is the sole integration test in the file and exercises the public models client over a real HTTP transport rather than a fake one.

*Call graph*: calls 4 internal fn (new, new, provider, new); 10 external calls (new, new, given, start, new, assert_eq!, format!, vec!, method, path).


### `codex-api/tests/sse_end_to_end.rs`

`test` · `request handling`

This file defines a minimal transport/auth fixture pair and uses them to verify that `ResponsesClient::stream` parses a realistic SSE payload into typed `ResponseEvent` values. `FixtureSseTransport` stores a single `body: String`; its `execute` method intentionally fails so the test proves the streaming code path is used, while `stream` wraps the stored body in a one-chunk `futures::stream::iter` of `Bytes` and returns a successful `StreamResponse` with HTTP 200 and empty headers. `NoAuth` implements `AuthProvider` as a no-op so authentication does not affect the test.

The helper `provider` constructs a `Provider` aimed at `https://example.com/v1` with retries effectively disabled except `retry_transport: true` and a short `stream_idle_timeout`. `build_responses_body` converts a vector of JSON event objects into SSE wire format, emitting `event: <type>` lines and, when the object contains more than just `type`, a matching `data: <json>` line followed by a blank separator. The single async test builds two `response.output_item.done` events and one `response.completed` event, streams them through `ResponsesClient`, collects all parsed events, filters out any `RateLimits` noise, and then pattern-matches the resulting sequence to confirm two assistant `ResponseItem::Message` outputs followed by a completed event with response ID `resp1` and absent token/end-turn metadata.

#### Function details

##### `FixtureSseTransport::new`  (lines 30–32)

```
fn new(body: String) -> Self
```

**Purpose**: Constructs the in-memory SSE transport fixture by storing the exact body string that later will be exposed as the streaming HTTP response.

**Data flow**: It takes a `String` containing preformatted SSE text and returns `FixtureSseTransport { body }`. No parsing or validation occurs at construction time.

**Call relations**: The end-to-end SSE test calls this helper after generating the fixture body with `build_responses_body`, then passes the resulting transport into `ResponsesClient::new`.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end).


##### `FixtureSseTransport::execute`  (lines 36–38)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements the non-streaming `HttpTransport` method as an intentional failure so any accidental use of the wrong client path is caught immediately.

**Data flow**: It accepts a `Request` but ignores it, then returns `Err(TransportError::Build("execute should not run".to_string()))`. It does not mutate fixture state.

**Call relations**: This method is part of the `HttpTransport` trait implementation and is not expected to be used by the test scenario. Its presence enforces that `ResponsesClient::stream` must call the transport’s streaming method instead.

*Call graph*: 1 external calls (Build).


##### `FixtureSseTransport::stream`  (lines 40–49)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Implements the streaming `HttpTransport` method by turning the stored SSE body into a single successful bytes chunk and packaging it as an HTTP 200 stream response.

**Data flow**: It accepts a `Request` but ignores it. The method clones `self.body`, converts it to `Bytes`, wraps that in `futures::stream::iter(vec![Ok::<Bytes, TransportError>(...)])`, pins the stream into `Box::pin`, and returns `Ok(StreamResponse { status: StatusCode::OK, headers: HeaderMap::new(), bytes })`.

**Call relations**: This is the core fixture behavior exercised by `ResponsesClient::stream` in the test. The client consumes the returned byte stream as if it came from a real SSE endpoint.

*Call graph*: 4 external calls (pin, new, iter, vec!).


##### `NoAuth::add_auth_headers`  (lines 56–56)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Provides a no-op authentication implementation so the test can instantiate `ResponsesClient` without introducing authorization-specific behavior.

**Data flow**: It receives a mutable `HeaderMap` reference and deliberately leaves it unchanged. It returns unit and writes no state.

**Call relations**: This trait method is invoked indirectly by client request construction when the test creates a `ResponsesClient` with `Arc::new(NoAuth)`.


##### `provider`  (lines 59–74)

```
fn provider(name: &str) -> Provider
```

**Purpose**: Builds a deterministic `Provider` configuration for SSE tests, pointing at a dummy base URL and using short retry/timeout settings suitable for fixture-driven execution.

**Data flow**: It takes a provider name `&str`, converts it to `String`, and returns a `Provider` with `base_url = "https://example.com/v1"`, `query_params = None`, empty headers, `RetryConfig { max_attempts: 1, base_delay: 1 ms, retry_429: false, retry_5xx: false, retry_transport: true }`, and `stream_idle_timeout = 50 ms`.

**Call relations**: The end-to-end test calls this helper when constructing `ResponsesClient`, ensuring the client has a complete provider definition even though the transport is fully mocked.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end); 2 external calls (from_millis, new).


##### `build_responses_body`  (lines 76–90)

```
fn build_responses_body(events: Vec<Value>) -> String
```

**Purpose**: Serializes a list of JSON event objects into raw SSE text matching the responses API framing expected by the parser under test.

**Data flow**: It takes `Vec<Value>`, initializes an empty `String`, and iterates over each event object. For each value it extracts the `type` string, then appends either `event: <type>\n\n` when the object contains only that field or `event: <type>\ndata: <json>\n\n` when additional payload fields are present. It returns the concatenated SSE body string.

**Call relations**: The test uses this helper to generate the exact wire-format body consumed by `FixtureSseTransport::stream`, allowing parser behavior to be exercised without a live server.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end); 2 external calls (new, format!).


##### `responses_stream_parses_items_and_completed_end_to_end`  (lines 93–170)

```
async fn responses_stream_parses_items_and_completed_end_to_end() -> Result<()>
```

**Purpose**: Validates that the responses streaming client parses SSE output-item and completed events into the expected typed `ResponseEvent` sequence from end to end.

**Data flow**: The test constructs three JSON values: two `response.output_item.done` events containing assistant message items with output text, and one `response.completed` event with response ID `resp1`. It converts them to SSE text via `build_responses_body`, wraps that body in `FixtureSseTransport`, and creates a `ResponsesClient` with the fixture transport, a provider from `provider("openai")`, and `Arc<NoAuth>`. It then calls `client.stream` with a simple JSON request body, empty headers, `Compression::None`, and no turn state; asynchronously drains the returned stream into a `Vec<ResponseEvent>`; filters out `ResponseEvent::RateLimits`; asserts there are exactly three remaining events; and pattern-matches each one to verify assistant roles on the first two and `response_id == "resp1"`, `token_usage.is_none()`, and `end_turn.is_none()` on the completed event. It returns `Result<()>` so transport or parsing failures propagate with `?`.

**Call relations**: This is the sole top-level test in the file and orchestrates all local helpers. It depends on `build_responses_body` for fixture generation, `FixtureSseTransport::new` for transport setup, and `provider` for client configuration before exercising `ResponsesClient::stream`.

*Call graph*: calls 4 internal fn (new, new, build_responses_body, provider); 8 external calls (new, new, new, assert!, assert_eq!, panic!, json!, vec!).


### `codex-api/tests/realtime_websocket_e2e.rs`

`test` · `request handling`

This test file builds a tiny one-connection WebSocket fixture around `tokio::net::TcpListener` and `tokio_tungstenite`, then drives `codex_api::RealtimeWebsocketClient` against it with realistic JSON frames. The shared helper `spawn_realtime_ws_server` binds an ephemeral localhost port, accepts exactly one TCP connection, upgrades it to a WebSocket, and hands the socket to a per-test async closure; `test_provider` constructs a `Provider` with empty query params and headers, a very short retry delay, and a 5-second stream idle timeout so tests stay deterministic.

The tests cover several concrete protocol paths. One verifies that `connect` immediately sends a `session.update` containing session type, instructions, and PCM input format, then that `send_audio_frame` emits `input_audio_buffer.append` and incoming `conversation.output_audio.delta` becomes `RealtimeEvent::AudioOut`. Another exercises `connect_webrtc_sideband`, intentionally delaying server startup to prove the client’s join logic retries until the endpoint is reachable. A concurrency test uses `tokio::join!` plus `timeout` to ensure `send_audio_frame` does not block while `next_event` is awaiting input, implying independent send/receive paths. Additional tests assert that a remote close yields `None` repeatedly rather than duplicate disconnect events, that unknown text events are skipped instead of surfacing as errors, and that the `RealtimeV2` parser accumulates transcript context across multiple incoming messages before emitting a fully populated `RealtimeEvent::HandoffRequested` with `handoff_id`, `item_id`, input transcript, and active transcript history.

#### Function details

##### `spawn_realtime_ws_server`  (lines 31–58)

```
async fn spawn_realtime_ws_server(
    handler: Handler,
) -> (String, tokio::task::JoinHandle<()>)
```

**Purpose**: Creates a one-shot localhost WebSocket test server and returns both its address string and the spawned task running the supplied connection handler. It encapsulates bind, accept, and WebSocket upgrade so each test only needs to describe server-side message expectations.

**Data flow**: It takes a `Handler` closure from `RealtimeWsStream` to an async future. The function binds `127.0.0.1:0`, reads the assigned socket address, then spawns a Tokio task that accepts one TCP stream, upgrades it with `accept_async`, and awaits the handler on the resulting `tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>`. It returns `(String, JoinHandle<()>)` and does not retain shared state beyond the spawned task.

**Call relations**: This helper is invoked by the WebSocket end-to-end tests that need a controllable peer. Those tests call it before constructing `RealtimeWebsocketClient`, then await the returned server task after client assertions to ensure the scripted server-side flow completed.

*Call graph*: called by 5 (realtime_ws_e2e_disconnected_emitted_once, realtime_ws_e2e_ignores_unknown_text_events, realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested, realtime_ws_e2e_send_while_next_event_waits, realtime_ws_e2e_session_create_and_event_flow); 3 external calls (bind, spawn, accept_async).


##### `test_provider`  (lines 60–75)

```
fn test_provider(base_url: String) -> Provider
```

**Purpose**: Builds a minimal `Provider` tailored for local realtime WebSocket tests. The returned configuration disables all retries except where a test mutates it afterward and supplies empty headers/query parameters.

**Data flow**: It accepts a `base_url: String` and constructs a `Provider` with `name = "test"`, `query_params = Some(HashMap::new())`, `headers = HeaderMap::new()`, `RetryConfig { max_attempts: 1, base_delay: 1ms, retry_429: false, retry_5xx: false, retry_transport: false }`, and `stream_idle_timeout = 5s`. It returns that provider by value without side effects.

**Call relations**: Most tests call this helper immediately before `RealtimeWebsocketClient::new` so they all share the same baseline transport settings. The sideband retry test then adjusts the returned provider’s retry fields to create a delayed-connect scenario.

*Call graph*: called by 6 (realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available, realtime_ws_e2e_disconnected_emitted_once, realtime_ws_e2e_ignores_unknown_text_events, realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested, realtime_ws_e2e_send_while_next_event_waits, realtime_ws_e2e_session_create_and_event_flow); 4 external calls (from_millis, from_secs, new, new).


##### `realtime_ws_e2e_session_create_and_event_flow`  (lines 78–202)

```
async fn realtime_ws_e2e_session_create_and_event_flow()
```

**Purpose**: Verifies the normal conversational WebSocket lifecycle: initial session update sent by the client, session confirmation parsed from the server, outbound audio append, and inbound output-audio delta converted into `RealtimeEvent::AudioOut`.

**Data flow**: The test starts a fixture server that reads the first client text frame, parses it as `serde_json::Value`, and asserts concrete fields under `type`, `session.type`, `session.instructions`, and `session.audio.input.format`. The server then sends a `session.updated` JSON message, waits for a second client frame asserting `input_audio_buffer.append`, and finally sends `conversation.output_audio.delta` with base64 audio and audio metadata. On the client side, it builds a `RealtimeSessionConfig` with instructions, model, session ID, parser `V1`, conversational mode, audio output, and voice `Cove`; connects; reads one event expecting `RealtimeEvent::SessionUpdated`; sends a `RealtimeAudioFrame`; reads another event expecting `RealtimeEvent::AudioOut`; then closes the connection and awaits server completion.

**Call relations**: This is a top-level Tokio test that drives both helper functions. It exercises the standard `RealtimeWebsocketClient::connect` path and then the connection object’s `next_event`, `send_audio_frame`, and `close` methods in sequence.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available`  (lines 205–280)

```
async fn realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available()
```

**Purpose**: Checks that the WebRTC sideband connection path tolerates an initially unavailable server and still joins successfully once the endpoint starts listening. It specifically validates retry behavior around connection establishment rather than message parsing breadth.

**Data flow**: The test first reserves an ephemeral port with `TcpListener::bind`, captures the address, and drops the listener so no server is present. A spawned task sleeps 20 ms, then binds that same address, accepts one connection, upgrades to WebSocket, asserts the first client frame is a `session.update` carrying the expected instructions, and replies with `session.updated`. The client mutates a provider from `test_provider` to use `max_attempts = 1` and `base_delay = 100 ms`, constructs `RealtimeWebsocketClient`, and calls `connect_webrtc_sideband` with parser `RealtimeV2`, voice `Marin`, and sideband ID `rtc_test`. It then reads one event expecting `RealtimeEvent::SessionUpdated`, closes, and awaits the delayed server task.

**Call relations**: This test does not use `spawn_realtime_ws_server` because it needs precise control over a period where no listener exists. It drives the specialized `connect_webrtc_sideband` path and confirms that the client’s internal join/retry logic bridges the startup gap before normal event consumption begins.

*Call graph*: calls 2 internal fn (new, test_provider); 11 external calls (from_millis, new, bind, assert_eq!, format!, json!, from_str, spawn, sleep, accept_async (+1 more)).


##### `realtime_ws_e2e_send_while_next_event_waits`  (lines 283–367)

```
async fn realtime_ws_e2e_send_while_next_event_waits()
```

**Purpose**: Ensures the connection can send audio while another task is blocked waiting for the next inbound event. The test guards against a design where receive-side waiting would monopolize the socket or internal lock and stall outbound writes.

**Data flow**: The fixture server accepts the initial `session.update`, then waits for a second client frame and asserts it is `input_audio_buffer.append`; only after receiving that send does it emit `session.updated`. The client connects with a standard conversational audio config, then runs `tokio::join!` over two futures: a `tokio::time::timeout(200 ms, connection.send_audio_frame(...))` and `connection.next_event()`. The send branch must complete before the timeout, and the receive branch must yield `RealtimeEvent::SessionUpdated { realtime_session_id: "sess_after_send", ... }`. The test then closes the connection and joins the server task.

**Call relations**: As a top-level concurrency regression test, it uses `spawn_realtime_ws_server` and `test_provider` to create the environment, then intentionally overlaps `send_audio_frame` with `next_event` to validate the connection’s internal send/receive separation.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 4 external calls (new, assert_eq!, format!, join!).


##### `realtime_ws_e2e_disconnected_emitted_once`  (lines 370–411)

```
async fn realtime_ws_e2e_disconnected_emitted_once()
```

**Purpose**: Confirms that a remote WebSocket close is represented as stream termination (`None`) and remains terminated on subsequent polls instead of producing repeated synthetic disconnect events or errors.

**Data flow**: The server fixture reads and validates the initial `session.update` frame, then sends `Message::Close(None)` and exits. The client connects with the standard config and calls `next_event()` twice. Each call returns `Result<Option<RealtimeEvent>, _>`; the test asserts the inner value is `None` both times. No explicit client close is needed because the peer already closed.

**Call relations**: This test uses the shared server and provider helpers, then focuses exclusively on repeated `next_event` calls after shutdown. It documents the post-disconnect contract for consumers of the realtime connection stream.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_e2e_ignores_unknown_text_events`  (lines 414–483)

```
async fn realtime_ws_e2e_ignores_unknown_text_events()
```

**Purpose**: Verifies that unrecognized JSON event types from the server are skipped rather than surfaced as failures or placeholder events. This protects the client against protocol extensions it does not yet model.

**Data flow**: The server validates the initial `session.update`, sends a text frame with `type: "response.created"` and a response ID, then sends a valid `session.updated` frame. The client connects using parser `V1`, calls `next_event()`, and expects the first delivered event to be `RealtimeEvent::SessionUpdated { realtime_session_id: "sess_after_unknown", instructions: Some("backend prompt") }`, proving the unknown event was consumed internally and not emitted. The test then closes and awaits the server task.

**Call relations**: This test follows the normal `connect` path but scripts an unsupported server event before a supported one. It relies on `spawn_realtime_ws_server` to inject that sequence and on `next_event` to demonstrate filtering behavior.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested`  (lines 486–632)

```
async fn realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested()
```

**Purpose**: Exercises the richer `RealtimeV2` event parser, showing that it emits transcript events incrementally and later synthesizes a `HandoffRequested` event from a function-call item plus previously accumulated transcript context.

**Data flow**: The server first checks the client’s `session.update`, then sends four text events in order: `conversation.item.input_audio_transcription.completed` with transcript `delegate now`; `response.output_audio_transcript.delta` with assistant text `secret context`; `conversation.item.created` containing a user message whose content is a realtime collaboration control tag; and `conversation.item.done` describing a `function_call` named `background_agent` with `item.id = item_123`, `call_id = call_123`, and JSON arguments. The client connects with parser `RealtimeV2` and voice `Marin`, then consumes four events in sequence: `RealtimeEvent::InputTranscriptDone`, `RealtimeEvent::OutputTranscriptDelta`, a `ConversationItemAdded` variant, and finally `RealtimeEvent::HandoffRequested`. The final assertion checks that the handoff includes the function call identifiers, the input transcript text, and an `active_transcript` vector containing both the user and assistant transcript entries accumulated from earlier messages.

**Call relations**: This test is the deepest parser integration case in the file. It uses the shared helpers to stand up the socket, then validates that `next_event` on a `RealtimeV2` connection both forwards raw transcript-related events and later combines prior parser state into a higher-level handoff request.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 4 external calls (new, assert!, assert_eq!, format!).


### `core/src/client_tests.rs`

`test` · `test execution`

This test file targets the nontrivial edges of the model client implementation. Several helpers build realistic fixtures: `test_model_client` creates a `ModelClient` against an OSS Responses provider; `test_responses_metadata_for_client` derives `CodexResponsesMetadata` tied to that client’s thread/session ids; `test_model_info` and `test_session_telemetry` provide minimal but valid model and telemetry contexts. For feedback-tag assertions, `TagCollectorVisitor` and `TagCollectorLayer` install a tracing subscriber layer that captures events emitted to the `feedback_tags` target into a shared `BTreeMap`.

The stream-mapping tests are especially concrete. `started_inference_attempt` creates an on-disk rollout trace with thread and turn start events, `output_message` builds assistant output items, and `replay_until_cancelled` repeatedly replays the trace bundle until cancellation is observed. Combined with `NotifyAfterEventStream`, these helpers verify that dropping a mapped response stream records cancellation and preserves partial output both in the ordinary case and when the mapper is blocked on a full downstream channel.

Other tests pin down metadata/header behavior: subagent labels for internal and external sources, websocket client metadata carrying installation/session/thread/window/parent-thread lineage and turn metadata, auth telemetry context fields after unauthorized recovery, and attestation generation being included only for ChatGPT/OpenAI Codex endpoints.

#### Function details

##### `test_model_client`  (lines 67–81)

```
fn test_model_client(session_source: SessionSource) -> ModelClient
```

**Purpose**: Builds a minimal `ModelClient` fixture backed by an OSS Responses provider and a fresh thread id. It is the common starting point for tests that do not need special auth or attestation behavior.

**Data flow**: Accepts a `SessionSource` → creates provider info with `create_oss_provider_with_base_url("https://example.com/v1", WireApi::Responses)` and a new `ThreadId` → calls `ModelClient::new` with no auth manager, no verbosity override, compression/timing disabled, no beta header, and no attestation provider → returns the client.

**Call relations**: Used by tests covering subagent headers, websocket client metadata, and empty memory summarization. It isolates those behaviors from auth-specific setup.

*Call graph*: calls 2 internal fn (new, new); called by 4 (build_subagent_headers_sets_internal_memory_consolidation_label, build_subagent_headers_sets_other_subagent_label, build_ws_client_metadata_includes_window_lineage_and_turn_metadata, summarize_memories_returns_empty_for_empty_input); 1 external calls (create_oss_provider_with_base_url).


##### `test_responses_metadata_for_client`  (lines 83–101)

```
fn test_responses_metadata_for_client(
    client: &ModelClient,
    turn_id: Option<&str>,
    window_id: String,
    parent_thread_id: Option<ThreadId>,
    request_kind: TestCodexResponsesRequestKi
```

**Purpose**: Builds `CodexResponsesMetadata` aligned with a specific test client’s thread/session identity. It avoids repeating metadata construction details in tests.

**Data flow**: Reads the client’s thread id as a string, then calls the shared `test_responses_metadata(...)` helper with the fixed installation id, thread/session ids, optional turn id, window id, session source, optional parent thread id, and request kind → returns the metadata object.

**Call relations**: Used by websocket metadata and attestation-handshake tests to generate realistic request metadata tied to the client under test.

*Call graph*: calls 1 internal fn (responses_metadata); called by 2 (build_ws_client_metadata_includes_window_lineage_and_turn_metadata, websocket_handshake_includes_attestation_for_chatgpt_codex_responses).


##### `test_model_info`  (lines 103–131)

```
fn test_model_info() -> ModelInfo
```

**Purpose**: Creates a minimal `ModelInfo` fixture suitable for transport tests. It encodes a non-reasoning-summary, non-verbosity model with standard Responses support.

**Data flow**: Builds a JSON object literal describing the model and deserializes it with `serde_json::from_value` into `ModelInfo` → returns the parsed struct.

**Call relations**: Used by the empty-memory-summarization test to satisfy the method signature without depending on production model catalogs.

*Call graph*: called by 1 (summarize_memories_returns_empty_for_empty_input); 2 external calls (json!, from_value).


##### `test_session_telemetry`  (lines 133–146)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Creates a `SessionTelemetry` fixture for tests that need to drive telemetry-aware code paths. It supplies stable placeholder identifiers and origin metadata.

**Data flow**: Constructs a new `SessionTelemetry` with a fresh thread id, model/provider names `gpt-test`, no account/auth info, fixed originator/terminal strings, and `SessionSource::Cli` → returns it.

**Call relations**: Used by stream-mapping tests and the empty-memory-summarization test whenever client code requires telemetry objects.

*Call graph*: calls 2 internal fn (new, new); called by 4 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output, response_stream_records_last_model_feedback_ids, summarize_memories_returns_empty_for_empty_input).


##### `TagCollectorVisitor::record_str`  (lines 154–157)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: Captures string-valued tracing fields into the tag collector map. It is part of the custom tracing subscriber used to inspect emitted feedback tags.

**Data flow**: Receives a tracing field and `&str` value → inserts `field.name().to_string()` mapped to `value.to_string()` into `self.tags`.

**Call relations**: Called by tracing when `TagCollectorLayer` records a `feedback_tags` event. It works alongside `record_debug` to capture all field types used in those events.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_debug`  (lines 159–162)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Captures debug-formatted tracing fields into the tag collector map. This allows the test layer to observe non-string feedback-tag values.

**Data flow**: Receives a tracing field and `Debug` value → formats the value with `format!("{value:?}")` and inserts it under `field.name()` in `self.tags`.

**Call relations**: Used by `TagCollectorLayer::on_event` when tracing records fields that are not emitted through `record_str`.

*Call graph*: 2 external calls (name, format!).


##### `TagCollectorLayer::on_event`  (lines 174–181)

```
fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>)
```

**Purpose**: Intercepts tracing events targeted at `feedback_tags` and stores their fields in a shared map for assertions. It filters out all unrelated tracing traffic.

**Data flow**: Receives each tracing `Event` → returns immediately unless `event.metadata().target() == "feedback_tags"` → creates a default `TagCollectorVisitor`, records the event into it, locks the shared map, and extends it with the collected tags.

**Call relations**: Installed in `response_stream_records_last_model_feedback_ids` to verify that `map_response_events` emits the expected request/response id feedback tags.

*Call graph*: 3 external calls (default, metadata, record).


##### `started_inference_attempt`  (lines 184–218)

```
fn started_inference_attempt(temp: &TempDir) -> anyhow::Result<InferenceTraceAttempt>
```

**Purpose**: Creates an on-disk rollout trace writer and records the initial thread/turn/inference-start events needed for later cancellation assertions. It returns a live `InferenceTraceAttempt` ready to receive completion or cancellation updates.

**Data flow**: Accepts a temporary directory → creates a `TraceWriter` rooted there, appends `ThreadStarted` and `CodexTurnStarted` raw events, constructs an enabled `InferenceTraceContext`, starts an attempt, records a synthetic request payload with model/input JSON, and returns the `InferenceTraceAttempt`.

**Call relations**: Used by both cancellation-tracing tests before they invoke `map_response_events`. It provides the trace context that the mapper updates when the stream is dropped.

*Call graph*: calls 2 internal fn (enabled, create); called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 3 external calls (new, path, json!).


##### `output_message`  (lines 220–230)

```
fn output_message(id: &str, text: &str) -> ResponseItem
```

**Purpose**: Builds a simple assistant `ResponseItem::Message` fixture containing one output-text content item. It is used as partial output in stream-cancellation tests.

**Data flow**: Accepts `id` and `text` strings → constructs `ResponseItem::Message` with assistant role, one `ContentItem::OutputText { text }`, and no phase/metadata → returns the item.

**Call relations**: Used by both cancellation-tracing tests to simulate a provider having already produced one complete output item before the stream is abandoned.

*Call graph*: called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 1 external calls (vec!).


##### `replay_until_cancelled`  (lines 232–247)

```
async fn replay_until_cancelled(temp: &TempDir) -> anyhow::Result<RolloutTrace>
```

**Purpose**: Polls the replayed rollout trace bundle until the recorded inference execution reaches `Cancelled` or a retry limit is hit. It hides the asynchronous delay between dropping the stream and the mapper task flushing trace output.

**Data flow**: Accepts a temp directory → repeatedly calls `replay_bundle(temp.path())`, inspects the first reduced inference call’s execution status, and if not yet `Cancelled` sleeps 10 ms and retries up to 50 times → returns the latest `RolloutTrace`.

**Call relations**: Used after dropping mapped streams in the cancellation tests to wait for the background mapper task to persist the terminal cancellation event.

*Call graph*: called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 4 external calls (from_millis, path, replay_bundle, sleep).


##### `NotifyAfterEventStream::poll_next`  (lines 259–268)

```
fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements a custom test stream that notifies once a configured number of events have been yielded. It is used to force the mapper into a backpressured send state before the consumer is dropped.

**Data flow**: Pops the next `ResponseEvent` from `self.events`; if none remain, returns `Poll::Pending`. Otherwise increments `yielded`, calls `notify.notify_one()` when `yielded == notify_after`, and returns `Poll::Ready(Some(Ok(event)))`.

**Call relations**: Used only by `dropped_backpressured_response_stream_traces_cancelled_partial_output` to coordinate the exact moment when the downstream channel is full and the mapper has observed a partial output item.

*Call graph*: 2 external calls (Ready, pop_front).


##### `build_subagent_headers_sets_other_subagent_label`  (lines 272–281)

```
fn build_subagent_headers_sets_other_subagent_label()
```

**Purpose**: Verifies that `build_subagent_headers` emits the expected `x-openai-subagent` value for an `Other(...)` subagent source. It checks the external-subagent labeling path.

**Data flow**: Creates a test client with `SessionSource::SubAgent(SubAgentSource::Other("memory_consolidation"))`, calls `client.build_subagent_headers()`, extracts `X_OPENAI_SUBAGENT_HEADER` as a string, and asserts it equals `Some("memory_consolidation")`.

**Call relations**: Exercises `ModelClient::build_subagent_headers` for one session-source variant.

*Call graph*: calls 1 internal fn (test_model_client); 3 external calls (SubAgent, assert_eq!, Other).


##### `build_subagent_headers_sets_internal_memory_consolidation_label`  (lines 284–293)

```
fn build_subagent_headers_sets_internal_memory_consolidation_label()
```

**Purpose**: Verifies that internal memory-consolidation sessions also emit the expected subagent label. It checks the internal-session-source branch.

**Data flow**: Creates a test client with `SessionSource::Internal(InternalSessionSource::MemoryConsolidation)`, calls `build_subagent_headers`, extracts the subagent header, and asserts it equals `Some("memory_consolidation")`.

**Call relations**: Complements the previous test by covering the internal memory-consolidation path in `ModelClient::build_subagent_headers`.

*Call graph*: calls 1 internal fn (test_model_client); 2 external calls (Internal, assert_eq!).


##### `build_ws_client_metadata_includes_window_lineage_and_turn_metadata`  (lines 296–356)

```
fn build_ws_client_metadata_includes_window_lineage_and_turn_metadata()
```

**Purpose**: Checks that websocket client metadata includes installation/session/thread/window lineage, parent-thread lineage, turn metadata JSON, and the expected subagent label for thread-spawn sessions. It validates the metadata shape consumed by websocket requests.

**Data flow**: Creates a thread-spawn subagent client with a fresh parent thread id, derives expected window id and responses metadata, calls `client.build_ws_client_metadata(...)`, parses the `x-codex-turn-metadata` JSON string, and asserts that both top-level metadata entries and nested turn-metadata fields contain the expected installation id, session id, thread id, turn id, window id, and parent thread id. It also asserts `x-openai-subagent` equals `collab_spawn`.

**Call relations**: Directly exercises `ModelClient::build_ws_client_metadata` and indirectly the metadata-generation logic in `CodexResponsesMetadata`.

*Call graph*: calls 3 internal fn (test_model_client, test_responses_metadata_for_client, new); 4 external calls (SubAgent, assert_eq!, format!, from_str).


##### `summarize_memories_returns_empty_for_empty_input`  (lines 359–374)

```
async fn summarize_memories_returns_empty_for_empty_input()
```

**Purpose**: Verifies the empty-input fast path for memory summarization. It ensures no network work is required when there are no memories to summarize.

**Data flow**: Builds a test client, model info, and session telemetry → calls `client.summarize_memories(Vec::new(), &model_info, None, &session_telemetry).await` → unwraps success and asserts the returned vector length is zero.

**Call relations**: Exercises the early return branch in `ModelClient::summarize_memories`.

*Call graph*: calls 3 internal fn (test_model_client, test_model_info, test_session_telemetry); 2 external calls (new, assert_eq!).


##### `dropped_response_stream_traces_cancelled_partial_output`  (lines 377–420)

```
async fn dropped_response_stream_traces_cancelled_partial_output() -> anyhow::Result<()>
```

**Purpose**: Verifies that dropping a mapped response stream after one completed output item but before `response.completed` records a cancelled inference trace that preserves the partial output item. It covers the consumer-drop cancellation branch.

**Data flow**: Creates a temp trace directory and started inference attempt, builds an API stream that yields one `OutputItemDone` then never completes, maps it through `super::map_response_events`, consumes the first mapped event, drops the stream, waits for replay to show cancellation, and asserts the reduced inference status is `Cancelled`, exactly one response item id was preserved, and two raw payloads exist.

**Call relations**: Directly exercises `map_response_events` cancellation handling when the consumer drops while the mapper is waiting on the next upstream event.

*Call graph*: calls 4 internal fn (output_message, replay_until_cancelled, started_inference_attempt, test_session_telemetry); 7 external calls (new, assert!, assert_eq!, OutputItemDone, iter, pending, map_response_events).


##### `response_stream_records_last_model_feedback_ids`  (lines 423–455)

```
async fn response_stream_records_last_model_feedback_ids()
```

**Purpose**: Checks that mapped response streams emit feedback tags for the upstream request id and terminal response id. It validates the tracing side effects of `map_response_events`.

**Data flow**: Installs `TagCollectorLayer`, builds an API stream with `Created` then `Completed { response_id: "resp-123" }`, maps it through `super::map_response_events` with upstream request id `req-123`, drains the stream, then inspects the collected tags and asserts `last_model_request_id` and `last_model_response_id` were recorded.

**Call relations**: Exercises the feedback-tag emission paths inside `map_response_events` for both upstream request id and completed response id.

*Call graph*: calls 2 internal fn (test_session_telemetry, disabled); 7 external calls (new, new, new, assert_eq!, iter, map_response_events, registry).


##### `dropped_backpressured_response_stream_traces_cancelled_partial_output`  (lines 458–504)

```
async fn dropped_backpressured_response_stream_traces_cancelled_partial_output() -> anyhow::Result<()>
```

**Purpose**: Verifies cancellation tracing when the mapper has already observed a partial output item but is blocked trying to send it into a full downstream channel. It covers the send-failure cancellation path rather than the explicit consumer-drop select branch.

**Data flow**: Creates a temp trace directory and started inference attempt, fills a `NotifyAfterEventStream` with `RESPONSE_STREAM_CHANNEL_CAPACITY` `Created` events followed by one `OutputItemDone`, maps it through `super::map_response_events`, waits until the custom stream notifies that the output item has been yielded upstream, drops the consumer stream, replays until cancellation, and asserts cancelled status plus preservation of one response item id and two raw payloads.

**Call relations**: Targets the backpressure edge case in `map_response_events` where downstream send fails after partial output has already been accumulated.

*Call graph*: calls 4 internal fn (output_message, replay_until_cancelled, started_inference_attempt, test_session_telemetry); 8 external calls (clone, new, new, new, new, assert_eq!, OutputItemDone, map_response_events).


##### `auth_request_telemetry_context_tracks_attached_auth_and_retry_phase`  (lines 507–523)

```
fn auth_request_telemetry_context_tracks_attached_auth_and_retry_phase()
```

**Purpose**: Checks that `AuthRequestTelemetryContext::new` captures auth mode, attached auth header details, and retry/recovery metadata after unauthorized recovery. It validates telemetry normalization logic.

**Data flow**: Builds a bearer auth provider fixture and a `PendingUnauthorizedRetry` from `UnauthorizedRecoveryExecution { mode: "managed", phase: "refresh_token" }`, passes them with `Some(AuthMode::Chatgpt)` into `AuthRequestTelemetryContext::new`, and asserts the resulting fields match the expected normalized values.

**Call relations**: Directly exercises `PendingUnauthorizedRetry::from_recovery` and `AuthRequestTelemetryContext::new` together.

*Call graph*: calls 3 internal fn (new, from_recovery, for_test); 2 external calls (assert!, assert_eq!).


##### `model_client_with_counting_attestation`  (lines 525–574)

```
fn model_client_with_counting_attestation(
    include_attestation: bool,
) -> (ModelClient, Arc<AtomicUsize>)
```

**Purpose**: Builds a `ModelClient` fixture with an attestation provider that counts how many times header generation is requested. It supports both attestation-enabled OpenAI/ChatGPT and attestation-disabled OSS provider scenarios.

**Data flow**: Defines a local `CountingAttestationProvider` whose `header_for_request` increments an `AtomicUsize` and returns a synthetic header value. Depending on `include_attestation`, it either creates a ChatGPT/OpenAI provider with an auth manager or an OSS provider without auth. It then constructs `ModelClient::new` with the counting provider and returns `(model_client, attestation_calls_counter)`.

**Call relations**: Used by the attestation tests to verify both inclusion and omission of attestation generation.

*Call graph*: calls 5 internal fn (new, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_openai_provider, new); called by 2 (non_chatgpt_codex_endpoints_omit_attestation_generation, websocket_handshake_includes_attestation_for_chatgpt_codex_responses); 3 external calls (new, new, create_oss_provider_with_base_url).


##### `websocket_handshake_includes_attestation_for_chatgpt_codex_responses`  (lines 577–599)

```
async fn websocket_handshake_includes_attestation_for_chatgpt_codex_responses()
```

**Purpose**: Verifies that websocket handshake headers include an attestation header for ChatGPT/OpenAI Codex Responses sessions and that attestation generation is invoked exactly once. It checks the positive attestation path.

**Data flow**: Builds an attestation-enabled model client and responses metadata for a websocket connection request, awaits `model_client.build_websocket_headers(&responses_metadata)`, extracts the attestation header string, and asserts it equals `v1.header-1`; it also asserts the call counter is 1.

**Call relations**: Exercises `ModelClient::build_websocket_headers` and, transitively, `generate_attestation_header_for` in the supported-provider case.

*Call graph*: calls 2 internal fn (model_client_with_counting_attestation, test_responses_metadata_for_client); 2 external calls (assert_eq!, format!).


##### `non_chatgpt_codex_endpoints_omit_attestation_generation`  (lines 602–632)

```
async fn non_chatgpt_codex_endpoints_omit_attestation_generation()
```

**Purpose**: Verifies that non-ChatGPT/non-attested providers do not generate attestation headers for response, compaction, or realtime request contexts. It checks both omission and zero invocation count.

**Data flow**: Builds an attestation-disabled model client and three empty header maps, repeatedly awaits `generate_attestation_header_for()` and conditionally inserts the result into each map, then asserts all three maps lack the attestation header and the call counter remains zero.

**Call relations**: Directly exercises `ModelClient::generate_attestation_header_for` in the unsupported-provider case.

*Call graph*: calls 1 internal fn (model_client_with_counting_attestation); 2 external calls (assert_eq!, new).


### `cloud-tasks-mock-client/src/mock.rs`

`test` · `tests and debug-mode backend selection`

This file supplies a zero-dependency mock backend that implements the same `CloudBackend` trait as the real HTTP client. `MockClient` itself is stateless; every response is synthesized from the requested environment or task ID. The mock task list intentionally varies by environment (`env-A`, `env-B`, or default) so callers can verify filtering behavior. Each generated `TaskSummary` includes a fresh `updated_at`, environment metadata, a one-file diff summary computed from a canned unified diff, and an `attempt_total` hint that marks `T-1000` as having two attempts.

Detail methods are similarly synthetic: `get_task_diff` returns the canned diff, `get_task_messages` and `get_task_text` return fixed assistant output and prompt metadata, and `list_sibling_attempts` only returns an alternate completed attempt for `T-1000`. Apply methods never touch the filesystem; they simply report success with mock messages, with preflight distinguished by `applied: false`.

Two local helpers support this behavior. `mock_diff_for` maps task IDs to hard-coded unified diffs, and `count_from_unified` derives insertion/deletion counts either by parsing with `diffy::Patch` or by falling back to manual line-prefix counting. The trait implementation is just boxing wrappers around the inherent async methods, keeping the mock interchangeable with the real backend.

#### Function details

##### `MockClient::list_tasks`  (lines 164–171)

```
fn list_tasks(
        &'a self,
        env: Option<&'a str>,
        limit: Option<i64>,
        cursor: Option<&'a str>,
    ) -> CloudBackendFuture<'a, TaskListPage>
```

**Purpose**: Synthesizes a page of task summaries, varying the returned rows by requested environment to support filter-sensitive tests and local mock runs.

**Data flow**: It takes optional environment, limit, and cursor arguments but only uses the environment to choose a fixed set of `(id, title, status)` tuples. For each row it builds a `TaskId`, gets a canned diff from `mock_diff_for`, computes added/deleted counts with `count_from_unified`, fills a `TaskSummary` with `Utc::now()`, environment metadata, one changed file, and an `attempt_total` of 2 for `T-1000` or 1 otherwise, then returns `TaskListPage { tasks: out, cursor: None }`.

**Call relations**: This is the core mock data source. `MockClient::get_task_summary` reuses it to find a single task, and the trait implementation boxes this async method for callers expecting `CloudBackend`.

*Call graph*: calls 2 internal fn (count_from_unified, mock_diff_for); called by 1 (get_task_summary); 5 external calls (pin, now, new, new, vec!).


##### `MockClient::get_task_summary`  (lines 173–175)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Finds one synthesized task summary by ID from the mock task list.

**Data flow**: It takes a `TaskId`, awaits `self.list_tasks(None, None, None)`, consumes the returned `tasks` vector, searches for a matching `t.id == id`, and returns that `TaskSummary` or `CloudTaskError::Msg("Task ... not found (mock)")`.

**Call relations**: This method is the mock equivalent of a backend summary lookup and is implemented by reusing the list-generation path rather than duplicating summary construction.

*Call graph*: calls 1 internal fn (list_tasks); 1 external calls (pin).


##### `MockClient::get_task_diff`  (lines 177–179)

```
fn get_task_diff(&self, id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Returns the canned unified diff associated with a mock task ID.

**Data flow**: It takes a `TaskId`, passes a reference to `mock_diff_for`, wraps the resulting string in `Some`, and returns `Ok(Some(diff))`.

**Call relations**: Used through the trait wherever callers need diff content from the mock backend.

*Call graph*: calls 1 internal fn (mock_diff_for); 1 external calls (pin).


##### `MockClient::get_task_messages`  (lines 181–183)

```
fn get_task_messages(&self, id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Returns a fixed assistant message for mock tasks.

**Data flow**: It ignores the task ID and returns a one-element `Vec<String>` containing `"Mock assistant output: this task contains no diff."` inside `Ok`.

**Call relations**: This provides a simple text-only fallback for consumers exercising message retrieval against the mock backend.

*Call graph*: 2 external calls (pin, vec!).


##### `MockClient::get_task_text`  (lines 185–187)

```
fn get_task_text(&self, id: TaskId) -> CloudBackendFuture<'_, TaskText>
```

**Purpose**: Returns a fixed `TaskText` payload with prompt, assistant message, and completed attempt metadata.

**Data flow**: It ignores the task ID and returns `TaskText { prompt: Some("Why is there no diff?"), messages: [mock message], turn_id: Some("mock-turn"), sibling_turn_ids: [], attempt_placement: Some(0), attempt_status: Completed }`.

**Call relations**: Used by higher layers that expect prompt-plus-attempt metadata rather than just plain messages.

*Call graph*: 3 external calls (pin, new, vec!).


##### `MockClient::apply_task`  (lines 189–195)

```
fn apply_task(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Pretends to apply a task successfully without touching the working tree.

**Data flow**: It takes a `TaskId` and ignores any diff override, then returns `ApplyOutcome { applied: true, status: Success, message: "Applied task ... locally (mock)", skipped_paths: [], conflict_paths: [] }`.

**Call relations**: This is the mock implementation behind real apply flows when the debug-mode mock backend is selected.

*Call graph*: 3 external calls (pin, new, format!).


##### `MockClient::apply_task_preflight`  (lines 197–203)

```
fn apply_task_preflight(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Pretends that preflight validation succeeded for a task without modifying anything.

**Data flow**: It takes a `TaskId`, ignores any diff override, and returns `ApplyOutcome { applied: false, status: Success, message: "Preflight passed for task ... (mock)", skipped_paths: [], conflict_paths: [] }`.

**Call relations**: Used by UI and CLI preflight flows against the mock backend; it mirrors the shape of the real preflight response while remaining deterministic.

*Call graph*: 3 external calls (pin, new, format!).


##### `MockClient::list_sibling_attempts`  (lines 205–211)

```
fn list_sibling_attempts(
        &self,
        task: TaskId,
        turn_id: String,
    ) -> CloudBackendFuture<'_, Vec<TurnAttempt>>
```

**Purpose**: Returns one alternate completed attempt only for task `T-1000`, and no siblings for all other tasks.

**Data flow**: It takes a `TaskId` and ignores the provided turn ID. If `task.0 == "T-1000"`, it returns a single `TurnAttempt` with placement 1, current timestamp, completed status, the same canned diff as the base task, and one mock message; otherwise it returns an empty vector.

**Call relations**: This supports attempt-switching tests and UI behavior by making exactly one task appear to have a second attempt.

*Call graph*: 3 external calls (pin, new, vec!).


##### `MockClient::create_task`  (lines 213–224)

```
fn create_task(
        &'a self,
        env_id: &'a str,
        prompt: &'a str,
        git_ref: &'a str,
        qa_mode: bool,
        best_of_n: usize,
    ) -> CloudBackendFuture<'a, CreatedTa
```

**Purpose**: Synthesizes a newly created task ID using the current timestamp.

**Data flow**: It accepts environment, prompt, git ref, QA mode, and best-of-N arguments but only binds them to suppress unused warnings. It formats `task_local_<timestamp_millis>` from `Utc::now()`, wraps it in `TaskId`, and returns `CreatedTask`.

**Call relations**: This lets CLI exec and TUI submission flows complete successfully against the mock backend without any persistence.

*Call graph*: 3 external calls (pin, new, format!).


##### `mock_diff_for`  (lines 227–239)

```
fn mock_diff_for(id: &TaskId) -> String
```

**Purpose**: Maps known mock task IDs to hard-coded unified diff strings.

**Data flow**: It reads `id.0.as_str()` and returns one of three embedded diff literals: a README edit for `T-1000`, a Rust import deletion for `T-1001`, or a new `CONTRIBUTING.md` file for all other IDs.

**Call relations**: This helper underpins both task-list summary generation and direct diff retrieval in the mock backend.

*Call graph*: called by 2 (get_task_diff, list_tasks).


##### `count_from_unified`  (lines 241–267)

```
fn count_from_unified(diff: &str) -> (usize, usize)
```

**Purpose**: Counts inserted and deleted lines from a unified diff, preferring structured parsing and falling back to manual prefix scanning.

**Data flow**: It takes a diff string, first tries `diffy::Patch::from_str(diff)`, and if successful folds over all hunk lines counting `Insert` and `Delete` variants. If parsing fails, it iterates raw lines, skips `+++`, `---`, and `@@` headers, counts leading `+` and `-` bytes, and returns `(added, deleted)`.

**Call relations**: Used by `MockClient::list_tasks` to populate `DiffSummary` counts from the canned diff text.

*Call graph*: called by 1 (list_tasks); 1 external calls (from_str).


### `codex-client/tests/ca_env.rs`

`test` · `integration test execution`

This integration test file validates the process-level contract around custom CA handling. Rather than calling helper functions in-process, it launches the `custom_ca_probe` binary with carefully scrubbed environment variables so inherited shell or CI settings cannot influence results. Constants define the CA-related environment variable names and embedded PEM fixtures. Several small structs package state for ephemeral test servers: a direct TLS 1.3 server, a plain HTTP origin, and a TLS-intercepting CONNECT proxy, each exposing a URL and an `mpsc::Receiver` used to report the captured request back to the test.

Helper functions fall into three groups. Process helpers (`probe_command`, `run_probe`, and the posting variants) build subprocess commands with selected env vars. Certificate/server helpers generate a self-signed CA plus server cert using `rcgen`, bind local listeners, configure rustls for TLS 1.3 only, and spawn threads that accept exactly one request. Network parsing helpers implement simple HTTP message reading, CONNECT authority extraction, and polling accept-with-timeout for nonblocking listeners. The proxy path is especially concrete: it reads the CONNECT request, acknowledges tunnel establishment, terminates TLS itself, forwards the decrypted HTTP request to the plain origin, reads the origin response, and writes it back over TLS.

The tests cover precedence between `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE`, multi-cert bundles, malformed or empty PEM diagnostics, OpenSSL-trusted certs, CRL-containing bundles, direct HTTPS POSTs to a generated TLS server, and HTTPS through a TLS-intercepting proxy. Request assertions verify the probe actually sent the expected OAuth token exchange payload.

#### Function details

##### `write_cert_file`  (lines 84–88)

```
fn write_cert_file(temp_dir: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes PEM fixture contents into a temporary file and returns its path for subprocess or server setup.

**Data flow**: Takes a `TempDir`, filename, and string contents; joins the filename onto the temp directory path, writes the contents with `fs::write`, and returns the resulting `PathBuf`.

**Call relations**: Most tests call this first to materialize embedded certificate fixtures before passing the path into subprocess environment variables.

*Call graph*: called by 10 (accepts_bundle_with_crl, accepts_openssl_trusted_certificate, falls_back_to_ssl_cert_file, handles_multi_certificate_bundle, posts_to_tls13_server_using_custom_ca_bundle, posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle, prefers_codex_ca_cert_over_ssl_cert_file, rejects_empty_pem_file_with_hint, rejects_malformed_pem_with_hint, uses_codex_ca_cert_env); 2 external calls (path, write).


##### `probe_command`  (lines 90–105)

```
fn probe_command() -> Command
```

**Purpose**: Builds a `Command` for the `custom_ca_probe` binary with all CA- and proxy-related inherited environment variables removed.

**Data flow**: Resolves the binary path via `cargo_bin("custom_ca_probe")`, constructs `Command::new(...)`, removes `CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE`, probe-specific env vars, and every proxy env var listed in `PROXY_ENV_VARS`, then returns the configured `Command`.

**Call relations**: All subprocess-launch helpers delegate here so every probe starts from the same hermetic environment baseline.

*Call graph*: called by 3 (run_probe, run_probe_posting_through_tls_intercepting_proxy, run_probe_posting_to_tls13_server); 2 external calls (new, cargo_bin).


##### `run_probe`  (lines 107–113)

```
fn run_probe(envs: &[(&str, &Path)]) -> std::process::Output
```

**Purpose**: Runs the probe binary with a supplied set of environment variable path bindings and captures its output.

**Data flow**: Creates a scrubbed command with `probe_command()`, iterates over `envs` to set each `(key, value)` pair on the command, executes `cmd.output()`, and returns `std::process::Output`.

**Call relations**: Used by the non-network CA selection and PEM parsing tests. It is the simplest subprocess path built on top of `probe_command`.

*Call graph*: calls 1 internal fn (probe_command); called by 8 (accepts_bundle_with_crl, accepts_openssl_trusted_certificate, falls_back_to_ssl_cert_file, handles_multi_certificate_bundle, prefers_codex_ca_cert_over_ssl_cert_file, rejects_empty_pem_file_with_hint, rejects_malformed_pem_with_hint, uses_codex_ca_cert_env).


##### `run_probe_posting_to_tls13_server`  (lines 115–123)

```
fn run_probe_posting_to_tls13_server(envs: &[(&str, &Path)], url: &str) -> std::process::Output
```

**Purpose**: Runs the probe binary configured to perform a real HTTPS POST to a supplied TLS 1.3 test server URL.

**Data flow**: Starts from `probe_command()`, applies the provided env vars, sets `CODEX_CUSTOM_CA_PROBE_TLS13=1` and `CODEX_CUSTOM_CA_PROBE_URL` to the target URL, executes the command, and returns the captured output.

**Call relations**: Called only by the direct TLS server integration test after that test has spawned a local rustls server and written its CA certificate to disk.

*Call graph*: calls 1 internal fn (probe_command); called by 1 (posts_to_tls13_server_using_custom_ca_bundle).


##### `run_probe_posting_through_tls_intercepting_proxy`  (lines 125–138)

```
fn run_probe_posting_through_tls_intercepting_proxy(
    envs: &[(&str, &Path)],
    url: &str,
    proxy_url: &str,
) -> std::process::Output
```

**Purpose**: Runs the probe binary configured to POST to a target URL through a local TLS-intercepting proxy.

**Data flow**: Builds a scrubbed command, applies the provided env vars, sets `CODEX_CUSTOM_CA_PROBE_PROXY`, `CODEX_CUSTOM_CA_PROBE_TLS13=1`, and `CODEX_CUSTOM_CA_PROBE_URL`, executes it, and returns the subprocess output.

**Call relations**: Used by the proxy integration test to verify that the custom CA bundle is trusted for the proxy’s forged TLS certificate.

*Call graph*: calls 1 internal fn (probe_command); called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle).


##### `spawn_tls13_test_server`  (lines 140–169)

```
fn spawn_tls13_test_server() -> Tls13TestServer
```

**Purpose**: Starts a one-shot local TLS 1.3 server with a generated CA and reports the first received request through a channel.

**Data flow**: Ensures the rustls crypto provider is installed, generates CA/server material with `generate_tls13_material`, binds a nonblocking `TcpListener` on `127.0.0.1:0`, builds a TLS 1.3-only `rustls::ServerConfig` with the generated cert/key, creates an `mpsc` channel, and spawns a thread that calls `accept_tls13_request` and sends either the request string or an error string. It returns `Tls13TestServer { ca_cert_pem, request_rx, url }`.

**Call relations**: The direct HTTPS probe test calls this before launching the subprocess so it can both trust the generated CA and later inspect the exact request sent.

*Call graph*: calls 1 internal fn (generate_tls13_material); called by 1 (posts_to_tls13_server_using_custom_ca_bundle); 8 external calls (new, bind, ensure_rustls_crypto_provider, format!, channel, builder_with_protocol_versions, spawn, vec!).


##### `spawn_plain_http_origin`  (lines 171–191)

```
fn spawn_plain_http_origin() -> PlainHttpOrigin
```

**Purpose**: Starts a one-shot plain TCP HTTP origin server that records the first request and replies `200 OK`.

**Data flow**: Binds a nonblocking listener on localhost, creates an `mpsc` channel, spawns a thread that runs `accept_plain_http_origin_request`, and returns `PlainHttpOrigin { request_rx, url }` where the URL intentionally uses `https://` so the client will tunnel through the proxy.

**Call relations**: Used only in the TLS-intercepting proxy test as the ultimate destination that receives the decrypted forwarded request.

*Call graph*: called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 4 external calls (bind, format!, channel, spawn).


##### `spawn_tls_intercepting_proxy`  (lines 193–222)

```
fn spawn_tls_intercepting_proxy() -> TlsInterceptingProxy
```

**Purpose**: Starts a local CONNECT proxy that terminates TLS with a generated certificate, forwards the decrypted request to the origin, and records the intercepted request.

**Data flow**: Ensures rustls provider setup, generates CA/server material, binds a nonblocking listener, builds a TLS 1.3-only server config, creates an `mpsc` channel, spawns a thread running `accept_tls_intercepting_proxy_request`, and returns `TlsInterceptingProxy { ca_cert_pem, request_rx, url }`.

**Call relations**: The proxy integration test calls this alongside `spawn_plain_http_origin`; the returned CA PEM is written to disk and supplied to the subprocess so the forged proxy certificate is trusted.

*Call graph*: calls 1 internal fn (generate_tls13_material); called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 8 external calls (new, bind, ensure_rustls_crypto_provider, format!, channel, builder_with_protocol_versions, spawn, vec!).


##### `generate_tls13_material`  (lines 224–255)

```
fn generate_tls13_material() -> Tls13Material
```

**Purpose**: Creates a self-signed CA and a server certificate/key pair suitable for localhost TLS 1.3 tests.

**Data flow**: Builds CA `CertificateParams` with CA constraints and signing usages, generates an ECDSA P-256 key pair, self-signs the CA via `CertifiedIssuer::self_signed`, then builds server params for `localhost` and `127.0.0.1` with server-auth usages, generates a server key pair, signs the server cert with the CA, and returns `Tls13Material { ca_cert_pem, server_cert, server_key }`.

**Call relations**: Both TLS server spawners depend on this helper to produce ephemeral trust material for each test run.

*Call graph*: called by 2 (spawn_tls13_test_server, spawn_tls_intercepting_proxy); 8 external calls (default, new, self_signed, new, Ca, generate_for, from, vec!).


##### `accept_plain_http_origin_request`  (lines 257–267)

```
fn accept_plain_http_origin_request(listener: TcpListener) -> io::Result<String>
```

**Purpose**: Accepts one plain HTTP connection, reads the full request, replies with a fixed `200 OK`, and returns the request text.

**Data flow**: Calls `accept_with_timeout` on the listener, switches the accepted `TcpStream` to blocking mode with read/write timeouts, reads the request via `read_http_message`, writes a minimal HTTP response body `ok`, flushes, and returns `io::Result<String>` containing the request.

**Call relations**: Executed inside the background thread created by `spawn_plain_http_origin`.

*Call graph*: calls 2 internal fn (accept_with_timeout, read_http_message); 1 external calls (from_secs).


##### `accept_tls13_request`  (lines 269–284)

```
fn accept_tls13_request(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
) -> io::Result<String>
```

**Purpose**: Accepts one TLS 1.3 connection, reads the HTTP request over rustls, replies `200 OK`, and returns the request text.

**Data flow**: Accepts a TCP stream with timeout, configures blocking/read/write timeouts, creates a `rustls::ServerConnection` from the supplied config, wraps it in `rustls::StreamOwned`, reads the HTTP message with `read_http_message`, writes a fixed HTTP response, flushes, and returns the request string.

**Call relations**: Run in the thread spawned by `spawn_tls13_test_server` to capture the probe’s HTTPS request.

*Call graph*: calls 2 internal fn (accept_with_timeout, read_http_message); 3 external calls (from_secs, new, new).


##### `accept_tls_intercepting_proxy_request`  (lines 286–314)

```
fn accept_tls_intercepting_proxy_request(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
) -> io::Result<String>
```

**Purpose**: Implements a one-shot CONNECT proxy that acknowledges tunneling, terminates TLS itself, forwards the decrypted request to the origin, and relays the origin response back.

**Data flow**: Accepts a TCP stream with timeout, reads the initial CONNECT request via `read_http_message`, extracts the target authority with `connect_authority_from_request`, writes `200 Connection Established`, upgrades the same socket into a rustls server stream, reads the tunneled HTTP request, opens a plain `TcpStream` to the origin authority, forwards the request bytes, reads the origin response with `read_http_message`, writes that response back over TLS, flushes, and returns the intercepted request string.

**Call relations**: This is the core of the proxy integration test and runs inside the thread spawned by `spawn_tls_intercepting_proxy`.

*Call graph*: calls 3 internal fn (accept_with_timeout, connect_authority_from_request, read_http_message); 4 external calls (from_secs, connect, new, new).


##### `connect_authority_from_request`  (lines 316–329)

```
fn connect_authority_from_request(request: &str) -> io::Result<String>
```

**Purpose**: Parses the authority host:port from the first line of an HTTP CONNECT request.

**Data flow**: Takes the raw request string, reads the first line, splits it on whitespace, and if it matches `CONNECT <authority> <version>` returns `Ok(authority.to_string())`; otherwise it returns an `io::Error` describing the malformed request.

**Call relations**: Used only by `accept_tls_intercepting_proxy_request` after reading the proxy CONNECT preamble.

*Call graph*: called by 1 (accept_tls_intercepting_proxy_request); 2 external calls (new, format!).


##### `accept_with_timeout`  (lines 331–348)

```
fn accept_with_timeout(listener: TcpListener, timeout: Duration) -> io::Result<TcpStream>
```

**Purpose**: Polls a nonblocking listener until a connection arrives or a deadline expires.

**Data flow**: Computes a deadline from `Instant::now() + timeout`, loops on `listener.accept()`, returns the accepted `TcpStream` on success, sleeps 10 ms and retries on `WouldBlock`, returns a timed-out `io::Error` once the deadline passes, and propagates any other accept error immediately.

**Call relations**: All one-shot server acceptors use this helper so tests fail quickly and deterministically instead of hanging forever.

*Call graph*: called by 3 (accept_plain_http_origin_request, accept_tls13_request, accept_tls_intercepting_proxy_request); 5 external calls (from_millis, now, accept, new, sleep).


##### `read_http_message`  (lines 350–377)

```
fn read_http_message(stream: &mut impl Read) -> io::Result<String>
```

**Purpose**: Reads an HTTP request or response from a stream until headers and any declared body bytes have been fully received.

**Data flow**: Repeatedly reads up to 1024-byte chunks into a growing `Vec<u8>`, searches for `\r\n\r\n`, parses `Content-Length` from the header section case-insensitively, and stops once the buffer contains the full header plus declared body length or the stream closes. It returns the accumulated bytes as a lossy UTF-8 `String`.

**Call relations**: Used by all local server/proxy handlers to capture requests and relay responses without depending on a full HTTP parser.

*Call graph*: called by 3 (accept_plain_http_origin_request, accept_tls13_request, accept_tls_intercepting_proxy_request); 3 external calls (read, from_utf8_lossy, new).


##### `assert_token_exchange_request`  (lines 379–388)

```
fn assert_token_exchange_request(request: &str)
```

**Purpose**: Asserts that a captured HTTP request is the expected OAuth token exchange POST with the expected form body.

**Data flow**: Reads the request string and performs two assertions: it must start with `POST /oauth/token HTTP/1.1`, and it must contain `grant_type=authorization_code&code=test`.

**Call relations**: The network integration tests call this on requests captured by the TLS server, proxy, and origin to prove the subprocess completed the intended POST.

*Call graph*: called by 2 (posts_to_tls13_server_using_custom_ca_bundle, posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 1 external calls (assert!).


##### `uses_codex_ca_cert_env`  (lines 391–398)

```
fn uses_codex_ca_cert_env()
```

**Purpose**: Tests that the probe succeeds when the CA bundle is supplied via `CODEX_CA_CERTIFICATE`.

**Data flow**: Creates a temp directory, writes `TEST_CERT_1` to `ca.pem`, runs the probe with that env var set to the file path, and asserts the subprocess exit status is successful.

**Call relations**: This is the baseline environment-selection test for the preferred Codex-specific CA variable.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `falls_back_to_ssl_cert_file`  (lines 401–408)

```
fn falls_back_to_ssl_cert_file()
```

**Purpose**: Tests that the probe accepts `SSL_CERT_FILE` when the Codex-specific CA variable is absent.

**Data flow**: Writes `TEST_CERT_1` to a temp file, runs the probe with only `SSL_CERT_FILE` set, and asserts success.

**Call relations**: This verifies fallback behavior after `probe_command` has scrubbed inherited CA variables.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `prefers_codex_ca_cert_over_ssl_cert_file`  (lines 411–422)

```
fn prefers_codex_ca_cert_over_ssl_cert_file()
```

**Purpose**: Tests that `CODEX_CA_CERTIFICATE` takes precedence over `SSL_CERT_FILE` when both are present.

**Data flow**: Writes a valid CA PEM and an empty bad PEM, runs the probe with both env vars set to those paths, and asserts the subprocess still succeeds.

**Call relations**: This checks precedence rules by pairing a good Codex CA path with a deliberately invalid fallback path.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `handles_multi_certificate_bundle`  (lines 425–433)

```
fn handles_multi_certificate_bundle()
```

**Purpose**: Tests that a PEM bundle containing multiple certificates is accepted.

**Data flow**: Concatenates `TEST_CERT_1` and `TEST_CERT_2`, writes the bundle to disk, runs the probe with `CODEX_CA_CERTIFICATE` pointing at it, and asserts success.

**Call relations**: This covers bundle parsing rather than single-certificate files.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (new, assert!, format!).


##### `posts_to_tls13_server_using_custom_ca_bundle`  (lines 436–455)

```
fn posts_to_tls13_server_using_custom_ca_bundle()
```

**Purpose**: Tests an end-to-end HTTPS POST to a generated TLS 1.3 server using a custom CA bundle trusted by the subprocess.

**Data flow**: Creates a temp dir, spawns the TLS server, writes the server CA PEM to disk, runs the probe configured to POST to the server URL, waits up to 5 seconds for the server thread to report the captured request, asserts subprocess success with detailed stdout/stderr on failure, then validates the request via `assert_token_exchange_request`.

**Call relations**: This is the direct network integration test tying together server generation, subprocess CA configuration, and request capture.

*Call graph*: calls 4 internal fn (assert_token_exchange_request, run_probe_posting_to_tls13_server, spawn_tls13_test_server, write_cert_file); 3 external calls (from_secs, new, assert!).


##### `posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle`  (lines 458–486)

```
fn posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle()
```

**Purpose**: Tests an HTTPS POST routed through a TLS-intercepting CONNECT proxy whose forged certificate is trusted via the custom CA bundle.

**Data flow**: Creates temp storage, spawns a plain origin and TLS-intercepting proxy, writes the proxy CA PEM to disk, runs the probe with proxy and target URL env vars, waits for both proxy and origin request reports, asserts subprocess success with detailed diagnostics, and validates both captured requests with `assert_token_exchange_request`.

**Call relations**: This is the most realistic CA test in the file, proving the subprocess trusts the proxy’s CA and still sends the expected token exchange through the tunnel.

*Call graph*: calls 5 internal fn (assert_token_exchange_request, run_probe_posting_through_tls_intercepting_proxy, spawn_plain_http_origin, spawn_tls_intercepting_proxy, write_cert_file); 3 external calls (from_secs, new, assert!).


##### `rejects_empty_pem_file_with_hint`  (lines 489–500)

```
fn rejects_empty_pem_file_with_hint()
```

**Purpose**: Tests that an empty PEM file causes probe failure with a user-facing diagnostic mentioning both supported CA env vars.

**Data flow**: Writes an empty file, runs the probe with `CODEX_CA_CERTIFICATE` pointing to it, asserts failure, decodes stderr with `String::from_utf8_lossy`, and asserts stderr contains `no certificates found in PEM file`, `CODEX_CA_CERTIFICATE`, and `SSL_CERT_FILE`.

**Call relations**: This validates error messaging, not just failure behavior, for a common misconfiguration.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (from_utf8_lossy, new, assert!).


##### `rejects_malformed_pem_with_hint`  (lines 503–518)

```
fn rejects_malformed_pem_with_hint()
```

**Purpose**: Tests that malformed PEM input causes probe failure with a parsing diagnostic and env-var hints.

**Data flow**: Writes an intentionally broken PEM fragment, runs the probe with that path, asserts failure, decodes stderr, and checks for `failed to parse PEM file` plus both CA environment variable names.

**Call relations**: This complements the empty-file test by covering syntactically invalid PEM content.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (from_utf8_lossy, new, assert!).


##### `accepts_openssl_trusted_certificate`  (lines 521–528)

```
fn accepts_openssl_trusted_certificate()
```

**Purpose**: Tests that a PEM file containing an OpenSSL-trusted certificate format is accepted.

**Data flow**: Writes the embedded `TRUSTED_TEST_CERT` fixture, runs the probe with `CODEX_CA_CERTIFICATE` set to that path, and asserts success.

**Call relations**: This broadens parsing coverage beyond plain PEM certificates.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `accepts_bundle_with_crl`  (lines 531–540)

```
fn accepts_bundle_with_crl()
```

**Purpose**: Tests that a PEM bundle containing a certificate plus a CRL block is still accepted.

**Data flow**: Builds a bundle string from `TEST_CERT_1` and a dummy CRL PEM block, writes it to disk, runs the probe with `CODEX_CA_CERTIFICATE` set, and asserts success.

**Call relations**: This ensures non-certificate PEM blocks in a bundle do not break CA loading.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (new, assert!, format!).


### Prompt and tool rendering tests
These tests lock down prompt/template output and tool-side normalization helpers used when preparing model-facing inputs and outputs.

### `prompts/src/goals_tests.rs`

`test` · `test run`

This test module exercises three prompt constructors from the surrounding goals prompt code: `continuation_prompt`, `budget_limit_prompt`, and `objective_updated_prompt`. Each test builds a concrete `ThreadGoal` with realistic fields such as `thread_id`, `objective`, `status`, `token_budget`, `tokens_used`, timestamps, and then normalizes line endings with `replace("\r\n", "\n")` before asserting on substrings. The assertions are intentionally content-specific rather than structural: they check for exact phrases like `call update_goal with status "complete"`, the stricter blocked-state criteria requiring repeated goal turns with the same blocking condition, and the absence of deprecated or disallowed statuses such as `paused` or `budgetLimited`. The budget-limited case confirms the prompt steers the model toward wrapping up soon instead of pausing. The objective-updated case confirms the new objective is treated as superseding prior goal context and is wrapped in an `<untrusted_objective>` tag, with explicit instruction not to mark completion prematurely. The final test is a prompt-injection hardening check: it feeds an objective containing closing tags and embedded XML-like content, computes the escaped form via `escape_xml_text`, and ensures every prompt variant contains only the escaped text and never the raw delimiter-bearing string.

#### Function details

##### `continuation_prompt_allows_complete_and_strict_blocked_updates`  (lines 6–30)

```
fn continuation_prompt_allows_complete_and_strict_blocked_updates()
```

**Purpose**: Builds an active `ThreadGoal`, renders the continuation prompt, and checks that the prompt includes the current objective, token budget, completion guidance, and narrowly-scoped blocked guidance.

**Data flow**: Creates a fresh `ThreadId` and a `ThreadGoal` populated with objective text, active status, budget, token/time usage, and timestamps; passes it into `continuation_prompt`; normalizes CRLF to LF; then reads the resulting string through a series of substring assertions. It produces no return value and writes no persistent state beyond test assertions.

**Call relations**: This is a standalone unit test invoked by the Rust test harness. It directly exercises the continuation prompt path and does not delegate further beyond constructing the goal and asserting on the rendered text.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `budget_limit_prompt_steers_model_to_wrap_up_without_pausing`  (lines 33–52)

```
fn budget_limit_prompt_steers_model_to_wrap_up_without_pausing()
```

**Purpose**: Checks the prompt variant used when a goal has exceeded its token budget, ensuring it reports budget usage and nudges the model to finish soon without suggesting a paused state.

**Data flow**: Constructs a `ThreadGoal` whose status is `ThreadGoalStatus::BudgetLimited` and whose `tokens_used` exceeds `token_budget`; renders it with `budget_limit_prompt`; normalizes line endings; then inspects the string for objective, budget, token usage, wrap-up wording, and absence of `status "paused"`. It returns nothing.

**Call relations**: Run by the test harness as a focused regression test for the budget-limited prompt branch. It validates the wording contract of `budget_limit_prompt` by observing only its output text.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `objective_updated_prompt_supersedes_previous_goal_context`  (lines 55–78)

```
fn objective_updated_prompt_supersedes_previous_goal_context()
```

**Purpose**: Confirms that the prompt shown after a user edits the goal explicitly treats the new objective as authoritative and preserves budget accounting details.

**Data flow**: Builds an active `ThreadGoal` with a revised objective string and budget metadata; renders `objective_updated_prompt`; normalizes line endings; then asserts that the output mentions user editing, superseding previous context, includes the escaped objective inside `<untrusted_objective>`, reports budget and remaining tokens, and warns against calling `update_goal` unless the updated goal is truly complete.

**Call relations**: This test is invoked independently by the test runner to pin the semantics of the objective-update prompt. It covers the branch where prior goal context must be overridden by a newly supplied objective.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `goal_prompts_escape_objective_delimiters`  (lines 81–120)

```
fn goal_prompts_escape_objective_delimiters()
```

**Purpose**: Validates that all goal prompt variants escape XML-sensitive objective text so user content cannot break prompt delimiters or inject extra sections.

**Data flow**: Defines a malicious-looking objective containing `</objective>` and another tag, computes its escaped representation with `escape_xml_text`, constructs three `ThreadGoal` values for continuation, budget-limited, and objective-updated scenarios, renders all three prompts, and iterates over them asserting each contains the escaped objective and omits the raw unescaped string.

**Call relations**: The test harness runs this as a cross-cutting safety test over all goal prompt constructors. Rather than checking one prompt branch, it compares the escaping invariant shared by all three rendered outputs.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### `prompts/src/review_request_tests.rs`

`test` · `test run`

This test module focuses on the string-generation logic in `review_request.rs`. Two tests call the internal `render_review_prompt` helper directly with the parsed base-branch templates and explicit variable bindings, asserting exact equality with the expected English instructions. This verifies both placeholder substitution and the wording difference between the backup branch prompt—which tells the reviewer how to compute a merge base manually against the branch’s upstream—and the preferred prompt that includes a concrete `merge_base_sha` and a direct `git diff` command. The other two tests exercise `review_prompt` through the `ReviewTarget::Commit` branch, using `AbsolutePathBuf::current_dir()` only to satisfy the function signature while confirming that commit prompts do not depend on repository inspection. They assert exact output for both the plain commit form and the variant that includes the commit title in parentheses and quotes. Together these tests document the exact review instructions emitted for the supported non-custom prompt templates.

#### Function details

##### `review_prompt_template_renders_base_branch_backup_variant`  (lines 5–10)

```
fn review_prompt_template_renders_base_branch_backup_variant()
```

**Purpose**: Checks the fallback base-branch template that instructs the reviewer how to compute the merge base manually.

**Data flow**: Calls `render_review_prompt` with `BASE_BRANCH_PROMPT_BACKUP_TEMPLATE` and a single `branch = main` variable, then compares the returned string against the full expected prompt literal.

**Call relations**: Executed by the test harness to validate the backup branch-template rendering path independently of git lookup logic.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_base_branch_variant`  (lines 13–21)

```
fn review_prompt_template_renders_base_branch_variant()
```

**Purpose**: Verifies the preferred base-branch template that embeds a known merge-base SHA and direct diff command.

**Data flow**: Invokes `render_review_prompt` with `BASE_BRANCH_PROMPT_TEMPLATE` and variables for `base_branch` and `merge_base_sha`, then asserts exact equality with the expected rendered sentence.

**Call relations**: This test isolates the merge-base-aware template branch used by `review_prompt` when git resolution succeeds.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_commit_variant`  (lines 24–36)

```
fn review_prompt_template_renders_commit_variant()
```

**Purpose**: Checks that commit review prompts render correctly when no commit title is available.

**Data flow**: Constructs a `ReviewTarget::Commit` with `sha = deadbeef` and `title = None`, calls `review_prompt` with the current directory, unwraps the successful result, and compares it to the expected plain commit prompt.

**Call relations**: Run by the test harness to cover the title-less commit branch inside `review_prompt`.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_commit_variant_with_title`  (lines 39–51)

```
fn review_prompt_template_renders_commit_variant_with_title()
```

**Purpose**: Checks that commit review prompts include the commit title when one is provided.

**Data flow**: Builds a `ReviewTarget::Commit` with both SHA and title, calls `review_prompt`, unwraps the result, and asserts exact equality with the expected title-bearing prompt string.

**Call relations**: This test covers the alternate commit branch in `review_prompt` that selects the title-aware template.

*Call graph*: 1 external calls (assert_eq!).


### `prompts/src/review_exit_tests.rs`

`test` · `test run`

This compact test module validates the two key behaviors in `review_exit.rs`. The first test calls `render_review_exit_success` with a multi-line findings string and compares the entire returned XML payload against a hard-coded expected string, including indentation, `<user_action>` structure, `<context>`, `<action>review</action>`, and placement of the injected results inside `<results>`. That makes the test sensitive not just to placeholder substitution but also to whitespace and trailing newline behavior. The second test targets the internal normalization helper directly, passing a short XML fragment containing CRLF line endings and asserting that the returned text uses only LF. Together these tests document that review-exit templates are expected to be deterministic and platform-independent, with exact output suitable for downstream consumers that parse or display the XML literally.

#### Function details

##### `render_review_exit_success_replaces_results_placeholder`  (lines 5–10)

```
fn render_review_exit_success_replaces_results_placeholder()
```

**Purpose**: Checks that the success template substitutes the provided review results into the `<results>` block exactly as expected.

**Data flow**: Passes a two-line findings string into `render_review_exit_success`, receives the rendered XML string, and compares it with a full expected literal using `assert_eq!`.

**Call relations**: Run by the test harness as the primary regression test for successful review-exit rendering. It validates both placeholder replacement and exact surrounding XML formatting.

*Call graph*: 1 external calls (assert_eq!).


##### `normalize_review_template_line_endings_rewrites_crlf`  (lines 13–18)

```
fn normalize_review_template_line_endings_rewrites_crlf()
```

**Purpose**: Verifies that the line-ending normalizer rewrites CRLF sequences to LF.

**Data flow**: Supplies a short CRLF-terminated XML fragment to `normalize_review_template_line_endings`, obtains the normalized text, and asserts exact equality with the LF-only version.

**Call relations**: This test directly exercises the helper used by review-exit rendering to guarantee platform-neutral template text.

*Call graph*: 1 external calls (assert_eq!).


### `memories/write/src/prompts_tests.rs`

`test` · `test`

This file contains narrow unit tests for the prompt-building helpers in `prompts.rs`. The first two tests exercise `build_stage_one_input_message` with very large synthetic rollout text made from long `a...middle...z` strings so truncation behavior is visible at both ends. One test sets an explicit `context_window` on a real `ModelInfo` loaded from a model slug and recomputes the expected token limit using the same scaling formula as production code; the other clears both `context_window` and `max_context_window` to force the default rollout token limit path. In both cases the test compares the rendered message against the exact output of `truncate_text`, ensuring the prompt includes the same truncated payload the helper would independently produce.

The third test creates a temporary memories directory with an `extensions` subdirectory and then renders the consolidation prompt. It asserts that the prompt mentions the workspace diff file name and includes extension-tree guidance tied to the concrete extensions path. Together these tests lock down the two most important prompt invariants: phase-1 input size control and phase-2 operator instructions about workspace diffs and extension resources.

#### Function details

##### `build_stage_one_input_message_truncates_rollout_using_model_context_window`  (lines 6–32)

```
fn build_stage_one_input_message_truncates_rollout_using_model_context_window()
```

**Purpose**: Verifies that stage-one prompt construction derives its truncation budget from the active model’s context window and effective-context percentage. It also checks that truncation preserves both the head and tail of the rollout text.

**Data flow**: Builds a huge input string, loads `ModelInfo` from a model slug, overrides `context_window`, computes the expected token limit with the same arithmetic as production code, truncates the input independently, then calls `build_stage_one_input_message` with concrete rollout paths. It asserts the truncated text reports truncation, starts with `a`, ends with `z`, and appears inside the rendered message.

**Call relations**: This test directly exercises `build_stage_one_input_message` under the model-aware limit branch.

*Call graph*: calls 1 internal fn (model_info_from_slug); 5 external calls (new, assert!, format!, Tokens, try_from).


##### `build_stage_one_input_message_uses_default_limit_when_model_context_window_missing`  (lines 35–53)

```
fn build_stage_one_input_message_uses_default_limit_when_model_context_window_missing()
```

**Purpose**: Checks that stage-one prompt construction falls back to the crate default token limit when model context-window metadata is unavailable. This protects the no-model-metadata path from silently changing behavior.

**Data flow**: Creates a large input string, loads `ModelInfo`, clears both `context_window` and `max_context_window`, computes the expected truncation using `DEFAULT_ROLLOUT_TOKEN_LIMIT`, renders the stage-one message, and asserts the expected truncated text is present in the message.

**Call relations**: This is the fallback-path companion to the previous truncation test and targets the same production helper.

*Call graph*: calls 1 internal fn (model_info_from_slug); 4 external calls (new, assert!, format!, Tokens).


##### `build_consolidation_prompt_points_to_workspace_diff_and_extension_tree`  (lines 56–71)

```
fn build_consolidation_prompt_points_to_workspace_diff_and_extension_tree()
```

**Purpose**: Ensures the consolidation prompt mentions the workspace diff file and includes extension-tree guidance when an extensions directory exists. It validates the conditional extension-block rendering path.

**Data flow**: Creates a temporary directory tree with `memories/extensions`, calls `build_consolidation_prompt` on the memory root, and asserts the resulting prompt contains the diff heading, the `phase2_workspace_diff.md` filename, the concrete extensions-root path, and text about deleted extension resource files.

**Call relations**: This test exercises `build_consolidation_prompt` in the branch where extension-specific prompt blocks should be rendered.

*Call graph*: 3 external calls (assert!, create_dir_all, tempdir).


### `tools/src/image_detail_tests.rs`

`test` · `test execution`

This test module builds a realistic `ModelInfo` fixture from JSON and uses it to validate the behavior of the helpers in `image_detail.rs`. The `model_info` fixture intentionally includes the full set of required model metadata fields so deserialization mirrors production shapes, while setting `supports_image_detail_original: true` by default. The tests then cover the policy matrix: when support is enabled, `can_request_original_image_detail` returns true, explicit `Original` survives normalization, and `None` remains omitted; when support is disabled by mutating the fixture, explicit `Original` is dropped to `None`; and explicit non-original values (`Auto`, `Low`, `High`) are preserved regardless of support. The final test exercises the mutating sanitation path over a heterogeneous vector of `FunctionCallOutputContentItem`, proving that only `InputImage` entries with `detail: Some(Original)` are rewritten to `Some(DEFAULT_IMAGE_DETAIL)`, while text items and already-supported image detail values remain unchanged. Together these tests document the intended distinction between omission, preservation, and fallback behavior, and they ensure the code does not accidentally rewrite unrelated content variants or non-original detail levels.

#### Function details

##### `model_info`  (lines 9–42)

```
fn model_info() -> ModelInfo
```

**Purpose**: Constructs a fully populated `ModelInfo` fixture suitable for image-detail tests, with original-detail support enabled by default.

**Data flow**: Builds a JSON object literal containing all required `ModelInfo` fields, including modality support and `supports_image_detail_original: true`, then deserializes it with `serde_json::from_value`. It returns the resulting `ModelInfo` and panics if the fixture shape is invalid.

**Call relations**: This helper is called by the tests that need a baseline model configuration. It centralizes fixture creation so individual tests can focus on toggling one capability or asserting one normalization rule.

*Call graph*: called by 3 (explicit_non_original_detail_is_preserved, explicit_original_is_allowed_when_model_supports_it, explicit_original_is_dropped_without_model_support); 2 external calls (json!, from_value).


##### `explicit_original_is_allowed_when_model_supports_it`  (lines 45–57)

```
fn explicit_original_is_allowed_when_model_supports_it()
```

**Purpose**: Verifies that a supporting model both reports original-detail capability and preserves explicit original requests during normalization.

**Data flow**: Obtains a `ModelInfo` from `model_info`, passes it to `can_request_original_image_detail`, and calls `normalize_output_image_detail` with both `Some(ImageDetail::Original)` and `None`. It asserts the boolean is true, the explicit original request remains `Some(Original)`, and the absent detail remains `None`.

**Call relations**: Run by the test harness, this test exercises both the capability predicate and the normalization function on the supported path. It depends on the shared fixture helper to provide a model with original-detail support enabled.

*Call graph*: calls 1 internal fn (model_info); 2 external calls (assert!, assert_eq!).


##### `explicit_original_is_dropped_without_model_support`  (lines 60–67)

```
fn explicit_original_is_dropped_without_model_support()
```

**Purpose**: Checks that explicit original detail is removed when the model does not support it.

**Data flow**: Creates a mutable `ModelInfo` via `model_info`, flips `supports_image_detail_original` to `false`, then calls `normalize_output_image_detail` with `Some(ImageDetail::Original)`. It asserts the returned value is `None`.

**Call relations**: This test is invoked by the harness to cover the unsupported branch of normalization. It reuses the fixture helper and then mutates only the capability flag to isolate the behavior under test.

*Call graph*: calls 1 internal fn (model_info); 1 external calls (assert_eq!).


##### `explicit_non_original_detail_is_preserved`  (lines 70–85)

```
fn explicit_non_original_detail_is_preserved()
```

**Purpose**: Ensures that explicit non-original detail levels are passed through unchanged.

**Data flow**: Builds a supporting `ModelInfo` with `model_info` and calls `normalize_output_image_detail` three times with `Some(Auto)`, `Some(Low)`, and `Some(High)`. It asserts each call returns the same explicit variant.

**Call relations**: This harness-driven test covers the pass-through branches of `normalize_output_image_detail`. By using the shared fixture unchanged, it demonstrates that support gating applies only to `Original`, not to the other enum variants.

*Call graph*: calls 1 internal fn (model_info); 1 external calls (assert_eq!).


##### `sanitize_original_falls_back_to_high_without_support`  (lines 88–121)

```
fn sanitize_original_falls_back_to_high_without_support()
```

**Purpose**: Validates the in-place sanitation pass that rewrites unsupported original image detail to the default detail while leaving other items untouched.

**Data flow**: Creates a mutable `Vec<FunctionCallOutputContentItem>` containing one `InputText`, one `InputImage` with `Some(Original)`, and one `InputImage` with `Some(Low)`. It calls `sanitize_original_image_detail(false, &mut items)` and then asserts the vector now contains the same text item, the first image rewritten to `Some(DEFAULT_IMAGE_DETAIL)`, and the second image unchanged.

**Call relations**: This test is run directly by the harness and targets the mutating bulk-rewrite helper rather than the pure normalization helper. It demonstrates the function’s selective traversal over mixed content and its fallback behavior when original detail is unsupported.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tools/src/json_schema_tests.rs`

`test` · `test execution`

This test module is the executable specification for `json_schema.rs`. It covers three broad areas. First, normalization tests verify coercions and inference rules: boolean schemas become strings, malformed descriptive-only objects collapse to `{}`, missing object/array child fields are synthesized, `const` becomes single-value `enum`, numeric keywords imply `number`, `additionalProperties` can imply object shape, and singleton `null` is rejected. Second, preservation tests ensure the sanitizer does not over-flatten valid structures: explicit primitive unions remain unions rather than becoming `anyOf`, nested `anyOf`/`oneOf`/`allOf` survive recursively, refs are preserved, both `$defs` and legacy `definitions` are supported, cyclic refs terminate safely, percent-encoded local refs are recognized for reachability, and malformed definition tables are dropped instead of causing parse failure. Third, compaction tests exercise the lossy size-budget path: descriptions are stripped first, root definitions are dropped only after local refs are neutralized to `{}`, deep complex objects collapse beyond the configured depth, and composition nodes are pruned only as a last resort. The helper `many_string_properties` generates oversized definition payloads for those budget tests. Because each test compares against explicit `JsonSchema` or serialized JSON output, the file doubles as detailed behavioral documentation for the parser’s exact output shapes.

#### Function details

##### `parse_tool_input_schema_coerces_boolean_schemas`  (lines 14–25)

```
fn parse_tool_input_schema_coerces_boolean_schemas()
```

**Purpose**: Verifies that a top-level boolean JSON Schema is coerced into a permissive string schema.

**Data flow**: Passes `serde_json::json!(true)` into `parse_tool_input_schema`, unwraps the parsed schema, and asserts equality with `JsonSchema::string(None)`.

**Call relations**: This harness-run test exercises the boolean-schema branch in the sanitizer and confirms the parser returns a concrete internal schema instead of rejecting the boolean form.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `json_schema_serializes_encrypted_marker`  (lines 28–39)

```
fn json_schema_serializes_encrypted_marker()
```

**Purpose**: Checks that the fluent encrypted marker is serialized into JSON output.

**Data flow**: Builds `JsonSchema::string(Some("Secret value".to_string())).with_encrypted()`, serializes it with `serde_json::to_value`, and asserts the JSON contains `type`, `description`, and `encrypted: true`.

**Call relations**: This test targets the data model rather than parsing. It documents the wire shape produced by `with_encrypted`.

*Call graph*: calls 1 internal fn (string); 1 external calls (assert_eq!).


##### `parse_tool_input_schema_infers_object_shape_and_defaults_properties`  (lines 42–69)

```
fn parse_tool_input_schema_infers_object_shape_and_defaults_properties()
```

**Purpose**: Confirms that `properties` without an explicit `type` implies an object schema and that descriptive-only child properties become empty schemas.

**Data flow**: Parses a JSON schema containing only `properties.query.description`, unwraps success, and compares the result to `JsonSchema::object` with one `query` property mapped to `JsonSchema::default()`.

**Call relations**: This test covers object-type inference plus recursive child sanitization on malformed property schemas.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_coerces_unrecognized_object_schema_to_empty_schema`  (lines 72–89)

```
fn parse_tool_input_schema_coerces_unrecognized_object_schema_to_empty_schema()
```

**Purpose**: Ensures an object containing only unsupported metadata keys is normalized to the empty permissive schema.

**Data flow**: Parses a JSON object with `description` and `title` but no recognized schema hints, then asserts the result is `JsonSchema::default()`.

**Call relations**: This test exercises the sanitizer branch that clears maps with no supported schema signal instead of inventing a type.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_integer_and_defaults_array_items`  (lines 92–134)

```
fn parse_tool_input_schema_preserves_integer_and_defaults_array_items()
```

**Purpose**: Verifies that integer types remain distinct and arrays missing `items` receive a default string item schema.

**Data flow**: Parses an object schema with `page: {type: integer}` and `tags: {type: array}`, then asserts the result contains `JsonSchema::integer(None)` for `page` and `JsonSchema::array(JsonSchema::string(None), None)` for `tags`.

**Call relations**: This test covers both primitive-type preservation and default child insertion for arrays.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_sanitizes_additional_properties_schema`  (lines 137–189)

```
fn parse_tool_input_schema_sanitizes_additional_properties_schema()
```

**Purpose**: Checks that schema-valued `additionalProperties` is recursively sanitized, including nested object inference and preserved `anyOf` composition.

**Data flow**: Parses an object schema whose `additionalProperties` contains `required`, `properties`, and nested `anyOf`, then asserts the result is an object with `additional_properties` set to `AdditionalProperties::Schema(Box<JsonSchema::object(...)>)` containing the normalized nested schema.

**Call relations**: This test exercises recursive sanitation through the `additionalProperties` path rather than only through `properties` or `items`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_object_shape_from_boolean_additional_properties_only`  (lines 192–210)

```
fn parse_tool_input_schema_infers_object_shape_from_boolean_additional_properties_only()
```

**Purpose**: Verifies that boolean `additionalProperties` alone implies an object schema when `type` is omitted.

**Data flow**: Parses `{ "additionalProperties": false }` and asserts the result is `JsonSchema::object(BTreeMap::new(), None, Some(false.into()))`.

**Call relations**: This test covers object inference from `additionalProperties` without any explicit `properties` field.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_number_from_numeric_keywords`  (lines 213–228)

```
fn parse_tool_input_schema_infers_number_from_numeric_keywords()
```

**Purpose**: Ensures numeric constraint keywords imply a number schema when no explicit type is present.

**Data flow**: Parses `{ "minimum": 1 }` and asserts the result is `JsonSchema::number(None)`.

**Call relations**: This test exercises one of the numeric-keyword inference branches in the sanitizer.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_number_from_multiple_of`  (lines 231–246)

```
fn parse_tool_input_schema_infers_number_from_multiple_of()
```

**Purpose**: Checks that `multipleOf` follows the same number-inference rule as other numeric constraints.

**Data flow**: Parses `{ "multipleOf": 5 }` and asserts the result is `JsonSchema::number(None)`.

**Call relations**: This complements the previous numeric inference test by covering a different keyword path.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_string_from_enum_const_and_format_keywords`  (lines 249–283)

```
fn parse_tool_input_schema_infers_string_from_enum_const_and_format_keywords()
```

**Purpose**: Verifies string inference and normalization for `enum`, `const`, and `format`-only schemas.

**Data flow**: Parses three separate schemas: one with `enum`, one with `const`, and one with `format`. It asserts the first becomes `JsonSchema::string_enum([...], None)`, the second becomes a single-value `string_enum`, and the third becomes `JsonSchema::string(None)`.

**Call relations**: This test covers both `const` rewriting and string-type inference from non-type keywords.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_empty_schema`  (lines 286–296)

```
fn parse_tool_input_schema_preserves_empty_schema()
```

**Purpose**: Confirms that an already-valid empty schema remains empty after parsing.

**Data flow**: Parses `{}` and asserts the result is `JsonSchema::default()`.

**Call relations**: This test guards against over-eager inference that would rewrite the permissive empty schema into some typed form.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_empty_schema`  (lines 299–342)

```
fn parse_tool_input_schema_preserves_nested_empty_schema()
```

**Purpose**: Ensures recursive sanitation preserves nested empty schemas instead of rewriting them.

**Data flow**: Parses an object schema whose nested property `extra` is `{}`, then asserts the resulting nested `JsonSchema::object` still contains `JsonSchema::default()` at that leaf.

**Call relations**: This test covers recursive traversal through nested `properties` while preserving valid empty-schema leaves.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_array_from_prefix_items`  (lines 345–371)

```
fn parse_tool_input_schema_infers_array_from_prefix_items()
```

**Purpose**: Checks that `prefixItems` implies an array schema and yields a regular array representation with string items.

**Data flow**: Parses a schema containing only `prefixItems: [{type: string}]` and asserts the result is `JsonSchema::array(JsonSchema::string(None), None)`.

**Call relations**: This test exercises the array-inference branch that treats `prefixItems` as sufficient evidence of array shape.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_boolean_additional_properties_on_inferred_object`  (lines 374–410)

```
fn parse_tool_input_schema_preserves_boolean_additional_properties_on_inferred_object()
```

**Purpose**: Verifies that nested schemas inferred as objects from `additionalProperties` preserve a boolean `additionalProperties` value unchanged.

**Data flow**: Parses an object with nested `metadata: { additionalProperties: true }` and asserts the nested property becomes `JsonSchema::object(BTreeMap::new(), None, Some(true.into()))`.

**Call relations**: This test combines nested object inference with preservation of boolean `additionalProperties` semantics.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_object_shape_from_schema_additional_properties_only`  (lines 413–441)

```
fn parse_tool_input_schema_infers_object_shape_from_schema_additional_properties_only()
```

**Purpose**: Checks that schema-valued `additionalProperties` alone also implies object shape.

**Data flow**: Parses `{ "additionalProperties": { "type": "string" } }` and asserts the result is an object schema whose `additional_properties` wraps `JsonSchema::string(None)`.

**Call relations**: This complements the boolean-only case by covering schema-valued `additionalProperties` inference.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_rewrites_const_to_single_value_enum`  (lines 444–462)

```
fn parse_tool_input_schema_rewrites_const_to_single_value_enum()
```

**Purpose**: Verifies the sanitizer’s explicit rewrite from `const` to a single-value string enum.

**Data flow**: Parses `{ "const": "tagged" }` and asserts the result is `JsonSchema::string_enum(vec![json!("tagged")], None)`.

**Call relations**: This test isolates the `map.remove("const")` rewrite path documented in the parser.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_rejects_singleton_null_type`  (lines 465–476)

```
fn parse_tool_input_schema_rejects_singleton_null_type()
```

**Purpose**: Ensures a schema whose only type is `null` is rejected with the expected error message.

**Data flow**: Parses `{ "type": "null" }`, expects an error, converts it to string, and asserts the message contains `tool input schema must not be a singleton null type`.

**Call relations**: This test covers the post-deserialization validation in `deserialize_tool_input_schema`, not just sanitizer behavior.

*Call graph*: 3 external calls (assert!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_fills_default_properties_for_nullable_object_union`  (lines 479–504)

```
fn parse_tool_input_schema_fills_default_properties_for_nullable_object_union()
```

**Purpose**: Checks that object/null unions preserve both types while still receiving default object `properties`.

**Data flow**: Parses `{ "type": ["object", "null"] }` and asserts the result has `schema_type: Multiple([Object, Null])` plus `properties: Some(BTreeMap::new())`.

**Call relations**: This test verifies that child-default insertion applies even when object appears inside a primitive union.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_fills_default_items_for_nullable_array_union`  (lines 507–532)

```
fn parse_tool_input_schema_fills_default_items_for_nullable_array_union()
```

**Purpose**: Checks that array/null unions preserve both types while still receiving default array `items`.

**Data flow**: Parses `{ "type": ["array", "null"] }` and asserts the result has `schema_type: Multiple([Array, Null])` plus `items: Some(Box::new(JsonSchema::string(None)))`.

**Call relations**: This is the array counterpart to the nullable object-union test.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_nullable_any_of_shape`  (lines 538–628)

```
fn parse_tool_input_schema_preserves_nested_nullable_any_of_shape()
```

**Purpose**: Verifies that deeply nested nullable `anyOf` structures are preserved recursively rather than flattened or inferred away.

**Data flow**: Parses a nested object/array/object schema where one property uses `anyOf` between an array of objects and `null`, with another nested `anyOf` for `lineno`. It asserts the full resulting `JsonSchema` tree preserves both `any_of` nodes, required fields, and `additionalProperties: false`.

**Call relations**: This test exercises recursive preservation of composition schemas through multiple nesting levels and mixed object/array contexts.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_nullable_type_union`  (lines 631–679)

```
fn parse_tool_input_schema_preserves_nested_nullable_type_union()
```

**Purpose**: Ensures explicit nested primitive unions like `["string", "null"]` remain unions and keep surrounding object constraints intact.

**Data flow**: Parses an object schema with property `nickname` typed as `["string", "null"]`, plus object-level `required` and `additionalProperties: false`, then asserts those exact structures survive in the parsed `JsonSchema`.

**Call relations**: This test covers preservation of explicit `type` unions inside object properties without rewriting them into composition forms.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_any_of_property`  (lines 682–729)

```
fn parse_tool_input_schema_preserves_nested_any_of_property()
```

**Purpose**: Checks that a nested property-level `anyOf` is preserved as `JsonSchema::any_of`.

**Data flow**: Parses an object schema whose `query` property has `anyOf` string/number variants, then asserts the parsed object contains `JsonSchema::any_of(vec![string, number], None)` for that property.

**Call relations**: This test isolates the property-level `anyOf` preservation path.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_one_of_property`  (lines 732–782)

```
fn parse_tool_input_schema_preserves_nested_one_of_property()
```

**Purpose**: Checks that a nested property-level `oneOf` is preserved and that child variants are still sanitized.

**Data flow**: Parses an object schema whose `query` property has `oneOf` variants `{const: "exact"}` and `{type: number}`, then asserts the parsed property is `JsonSchema::one_of` containing a rewritten single-value string enum and a number schema.

**Call relations**: This test combines composition preservation with recursive child sanitation inside `oneOf` variants.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_all_of_property`  (lines 785–832)

```
fn parse_tool_input_schema_preserves_nested_all_of_property()
```

**Purpose**: Ensures `allOf` is preserved structurally and that malformed child variants are sanitized to empty schemas.

**Data flow**: Parses an object schema whose `query` property has `allOf` variants `{type: string}` and `{description: ...}`, then asserts the parsed property is `JsonSchema::all_of(vec![string, default()], None)`.

**Call relations**: This test covers the `allOf` preservation path and demonstrates that unsupported child fragments are still normalized recursively.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_type_unions_without_rewriting_to_any_of`  (lines 835–862)

```
fn parse_tool_input_schema_preserves_type_unions_without_rewriting_to_any_of()
```

**Purpose**: Verifies that explicit primitive unions remain in the `type` field rather than being transformed into `anyOf`.

**Data flow**: Parses `{ "type": ["string", "null"], "description": "optional string" }` and asserts the result has `schema_type: Multiple([String, Null])` and the same description.

**Call relations**: This test guards against a regression where unions might be rewritten into composition schemas unnecessarily.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_explicit_enum_type_union`  (lines 865–898)

```
fn parse_tool_input_schema_preserves_explicit_enum_type_union()
```

**Purpose**: Checks that enum values can coexist with an explicit string/null union and are preserved together.

**Data flow**: Parses a schema with `type: ["string", "null"]`, `enum`, and `description`, then asserts the parsed `JsonSchema` retains the union, enum values, and description.

**Call relations**: This test covers the interaction between explicit unions and enum constraints.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `many_string_properties`  (lines 900–909)

```
fn many_string_properties(count: usize) -> serde_json::Map<String, serde_json::Value>
```

**Purpose**: Generates a large map of numbered string-typed property schemas for compaction tests.

**Data flow**: Takes a `count`, iterates from `0..count`, formats each index as `field_{index:03}`, pairs it with `json!({"type": "string"})`, collects the pairs into a `serde_json::Map<String, serde_json::Value>`, and returns that map.

**Call relations**: This helper is used by oversized-schema tests to create bulky `$defs` payloads that trigger compaction behavior.


##### `parse_large_tool_input_schema_compacts_descriptions_only_on_default_path`  (lines 912–966)

```
fn parse_large_tool_input_schema_compacts_descriptions_only_on_default_path()
```

**Purpose**: Verifies that the default parser strips descriptions to meet budget while the no-compaction parser preserves them.

**Data flow**: Builds an oversized schema with long root description and described `$defs` entry, parses it once with `parse_tool_input_schema` and once with `parse_tool_input_schema_without_compaction`, serializes both results, and asserts the first output has descriptions removed while the second retains them.

**Call relations**: This test compares the two public parse entrypoints directly to document the sole behavioral difference introduced by compaction.

*Call graph*: 4 external calls (assert_eq!, json!, parse_tool_input_schema, parse_tool_input_schema_without_compaction).


##### `parse_large_tool_input_schema_ignores_dropped_metadata_for_budget`  (lines 969–1018)

```
fn parse_large_tool_input_schema_ignores_dropped_metadata_for_budget()
```

**Purpose**: Checks that unsupported metadata like `title` and `examples` is dropped during sanitization and therefore does not force additional compaction.

**Data flow**: Parses a nested object schema containing large `examples` payloads and `title` fields, serializes the result, and asserts the output keeps only the structural object/property/type information.

**Call relations**: This test demonstrates that sanitization happens before budget measurement, so removed metadata does not count against compaction thresholds.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_stops_after_dropping_root_definitions_when_under_budget`  (lines 1021–1078)

```
fn parse_large_tool_input_schema_stops_after_dropping_root_definitions_when_under_budget()
```

**Purpose**: Ensures compaction halts once dropping root definitions and neutralizing local refs is sufficient to fit the budget.

**Data flow**: Parses an oversized schema with long descriptions and a huge `$defs.metadata` object referenced from a property, serializes the result, and asserts descriptions are stripped, the root `$defs` table is gone, and the referencing property has become `{}` rather than being further collapsed.

**Call relations**: This test exercises the ordered pass sequence and confirms later passes do not run once the schema is under budget.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_strips_descriptions_without_removing_description_property`  (lines 1081–1174)

```
fn parse_large_tool_input_schema_strips_descriptions_without_removing_description_property()
```

**Purpose**: Checks that description stripping removes schema metadata keys named `description` but does not delete user-defined properties whose field name is literally `description`.

**Data flow**: Parses an oversized object schema containing a property named `description` plus nested descriptions in objects, arrays, additionalProperties, and compositions, then serializes and asserts only metadata descriptions are removed while the `description` property schema remains.

**Call relations**: This test validates the traversal logic in `strip_schema_descriptions`, especially its distinction between schema metadata and entries inside the `properties` map.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_prunes_compositions_as_last_resort`  (lines 1177–1217)

```
fn parse_large_tool_input_schema_prunes_compositions_as_last_resort()
```

**Purpose**: Verifies that when oversized composition schemas still exceed budget after earlier passes, composition nodes are finally replaced with empty schemas.

**Data flow**: Loops over each composition keyword in `COMPOSITION_SCHEMA_KEYS`, builds an object schema whose `choice` property contains a large composition array, parses it, serializes the result, and asserts `choice` becomes `{}`.

**Call relations**: This test directly exercises the final compaction pass across `anyOf`, `oneOf`, and `allOf` variants.

*Call graph*: 6 external calls (assert_eq!, new, Array, json!, parse_tool_input_schema, vec!).


##### `parse_large_tool_input_schema_prunes_single_composition_variant_if_still_over_budget`  (lines 1220–1245)

```
fn parse_large_tool_input_schema_prunes_single_composition_variant_if_still_over_budget()
```

**Purpose**: Checks that even a composition with only one oversized variant is pruned to `{}` if still over budget.

**Data flow**: Parses an object schema whose `choice` property contains a single huge `anyOf` variant, serializes the result, and asserts the property becomes an empty schema.

**Call relations**: This complements the multi-variant composition test by showing the last-resort pruning rule is based on node kind and budget, not variant count.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_preserves_object_enum_literal_descriptions`  (lines 1248–1290)

```
fn parse_large_tool_input_schema_preserves_object_enum_literal_descriptions()
```

**Purpose**: Ensures description stripping does not recurse into enum literal payloads and remove their internal `description` fields.

**Data flow**: Parses an oversized schema whose property has `enum` values that are JSON objects containing `description` keys, serializes the result, and asserts the outer schema description is stripped but the object literals inside `enum` remain unchanged.

**Call relations**: This test documents an important boundary of schema traversal: enum values are treated as literals, not nested schemas.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `collapse_deep_schema_objects_traverses_schema_children`  (lines 1293–1416)

```
fn collapse_deep_schema_objects_traverses_schema_children()
```

**Purpose**: Directly tests deep-object collapsing across all recognized child-bearing schema positions.

**Data flow**: Builds a mutable JSON schema containing nested complex objects under `properties`, `items`, `additionalProperties`, and `anyOf`, calls `super::collapse_deep_schema_objects(&mut schema, 0)`, and asserts only the deep complex descendants are replaced with `{}` while shallower structure and scalar leaves remain.

**Call relations**: Unlike most tests, this one calls an internal helper directly to validate traversal coverage across every schema-child path used by compaction.

*Call graph*: 3 external calls (assert_eq!, json!, collapse_deep_schema_objects).


##### `parse_tool_input_schema_preserves_string_enum_constraints`  (lines 1419–1486)

```
fn parse_tool_input_schema_preserves_string_enum_constraints()
```

**Purpose**: Checks that legacy enum/const-like inputs normalize into the current string-enum representation for multiple properties.

**Data flow**: Parses an object schema whose properties use legacy `type: "enum"` with `enum` and `type: "const"` with `const`, then asserts each property becomes the expected `JsonSchema::string_enum` inside the parsed object.

**Call relations**: This test covers compatibility with older schema encodings while still expecting the modern internal representation.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_refs_and_prunes_unreachable_defs`  (lines 1489–1546)

```
fn parse_tool_input_schema_preserves_refs_and_prunes_unreachable_defs()
```

**Purpose**: Verifies that local `$ref` values are preserved and only referenced `$defs` entries remain attached to the root schema.

**Data flow**: Parses an object schema with property `user` referencing `#/$defs/User` and a `$defs` table containing `User` and `Unused`, then asserts the parsed schema preserves the ref and retains only the `User` definition.

**Call relations**: This test exercises both ref preservation and reachability-based pruning for modern `$defs`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_refs_from_properties_named_def_tables`  (lines 1549–1594)

```
fn parse_tool_input_schema_preserves_refs_from_properties_named_def_tables()
```

**Purpose**: Ensures a user property literally named `$defs` is treated as a normal property while still contributing refs to definition reachability.

**Data flow**: Parses an object schema whose `properties` map contains a `$defs` field with a local ref, plus a root `$defs` table with one used and one unused entry, then asserts the property is preserved and only the referenced definition remains.

**Call relations**: This test guards the traversal logic against confusing property names with root definition-table keywords.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_collects_refs_from_schema_child_keywords`  (lines 1597–1681)

```
fn parse_tool_input_schema_collects_refs_from_schema_child_keywords()
```

**Purpose**: Checks that reachability analysis finds refs under `items`, schema-valued `additionalProperties`, `anyOf`, `oneOf`, and `allOf`.

**Data flow**: Parses an object schema with refs in each of those child positions plus a `$defs` table containing matching and unused entries, serializes the result, and asserts all referenced definitions remain while `Unused` is pruned.

**Call relations**: This test validates the completeness of `for_each_schema_child`-based traversal used to seed reachable definitions.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_handles_cyclic_local_refs`  (lines 1684–1745)

```
fn parse_tool_input_schema_handles_cyclic_local_refs()
```

**Purpose**: Ensures cyclic local refs are preserved and do not cause infinite recursion during definition reachability analysis.

**Data flow**: Parses an object schema whose property references `$defs.Node`, where `Node` recursively references itself through `next`, then asserts the parsed schema preserves both refs and retains the single `Node` definition.

**Call relations**: This test covers the visited-set logic in `collect_reachable_definitions`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_legacy_definitions`  (lines 1748–1827)

```
fn parse_tool_input_schema_preserves_legacy_definitions()
```

**Purpose**: Verifies support for legacy `definitions` tables and transitive reachability through them.

**Data flow**: Parses an object schema with a property ref into `#/definitions/User`, where `User` references `Profile`, plus an unused definition, then asserts the parsed schema preserves the refs and retains only `User` and `Profile` under `definitions`.

**Call relations**: This test exercises the same pruning logic as `$defs` tests but through the legacy table name.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_unresolved_and_external_refs`  (lines 1830–1880)

```
fn parse_tool_input_schema_preserves_unresolved_and_external_refs()
```

**Purpose**: Checks that unresolved local refs and external refs are preserved verbatim even though unreachable local definitions are still pruned.

**Data flow**: Parses an object schema with one missing local ref, one external URL ref, and an unused `$defs` entry, then asserts the parsed schema keeps both refs and drops the unused definitions table.

**Call relations**: This test documents that reachability pruning is best-effort and non-destructive for refs the parser cannot resolve locally.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_defs_ref_parent`  (lines 1883–1942)

```
fn parse_tool_input_schema_preserves_nested_defs_ref_parent()
```

**Purpose**: Ensures nested JSON Pointer refs into a definition keep the parent definition reachable.

**Data flow**: Parses an object schema with property ref `#/$defs/User/properties/name` and a `$defs` table containing `User`, `name`, and `Unused`, then asserts the parsed schema preserves the original ref string and retains only the parent `User` definition.

**Call relations**: This test covers the special-case behavior in `parse_local_definition_ref` that treats nested local refs as references to the parent definition entry.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_percent_encoded_definition_refs`  (lines 1945–2012)

```
fn parse_tool_input_schema_preserves_percent_encoded_definition_refs()
```

**Purpose**: Verifies that percent-encoded local definition refs are decoded for reachability while the original ref strings remain unchanged in output.

**Data flow**: Parses an object schema with refs like `#/$defs/User%20Name` and `#/%24defs/Profile%7E0Name`, plus matching `$defs` entries and an unused one, then asserts the parsed schema preserves the original ref strings and retains only the decoded reachable definitions.

**Call relations**: This test exercises the percent-decoding and JSON Pointer parsing logic in `parse_local_definition_ref`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_drops_malformed_definition_tables`  (lines 2015–2049)

```
fn parse_tool_input_schema_drops_malformed_definition_tables()
```

**Purpose**: Checks that malformed `$defs` tables are removed instead of causing parse failure.

**Data flow**: Parses an object schema with a property ref into `$defs.User` but a root `$defs` value that is an array, then asserts the parsed schema preserves the unresolved ref and contains no definitions table.

**Call relations**: This test covers the graceful-degradation behavior implemented by `sanitize_schema_table` for invalid definition-table shapes.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


### Protocol and execution semantics tests
These files cover protocol error/output encoding plus code-mode session and service-contract behavior around execution lifecycle and failure propagation.

### `protocol/src/error_tests.rs`

`test` · `test`

This file is the dedicated test companion for the error module. It builds representative `UsageLimitReachedError`, `UnexpectedResponseError`, `CodexErr`, and sandbox-output values and asserts on their exact rendered strings or protocol mappings. Because many of these messages are user-facing and product-sensitive, the tests are intentionally concrete and compare full strings rather than broad predicates.

Two helpers support the suite. `rate_limit_snapshot` constructs a reusable `RateLimitSnapshot` with primary and secondary windows so usage-limit errors can be instantiated without repeating boilerplate. `with_now_override` temporarily sets the thread-local clock override defined in `error.rs`, runs a closure, and then clears the override; this makes retry-time formatting deterministic across tests.

The tests cover plan-specific usage-limit copy for Plus, Free, Go, Pro, Team, Business, self-serve business, enterprise CBP, Enterprise/default, promo-message overrides, and workspace credit/spend-cap variants. They also verify that non-`codex` limit names suppress upsell copy in favor of model-switch guidance. Separate tests exercise `CodexErr::to_codex_protocol_error`, `to_error_event`, and `get_error_message_ui` for sandbox denials with aggregated output, mixed stderr/stdout, stdout-only output, and no output at all. Finally, the suite validates `UnexpectedResponseError` formatting for Cloudflare block pages, plain-text bodies, extracted JSON `error.message`, long-body truncation, and inclusion of cf-ray, request ID, and identity-auth metadata.

#### Function details

##### `rate_limit_snapshot`  (lines 15–42)

```
fn rate_limit_snapshot() -> RateLimitSnapshot
```

**Purpose**: Builds a reusable `RateLimitSnapshot` fixture with two reset windows and otherwise empty optional metadata.

**Data flow**: It computes two fixed UTC timestamps, constructs `RateLimitWindow` values for primary and secondary limits, inserts them into a `RateLimitSnapshot` with all other optional fields set to `None`, and returns the snapshot.

**Call relations**: Many usage-limit formatting tests call this helper to avoid repeating snapshot construction while keeping the reset-window shape realistic.

*Call graph*: called by 9 (usage_limit_reached_error_formats_business_plan_without_reset, usage_limit_reached_error_formats_default_for_other_plans, usage_limit_reached_error_formats_default_when_none, usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan, usage_limit_reached_error_formats_free_plan, usage_limit_reached_error_formats_go_plan, usage_limit_reached_error_formats_plus_plan, usage_limit_reached_error_formats_rate_limit_reached_types, usage_limit_reached_error_formats_self_serve_business_usage_based_plan).


##### `with_now_override`  (lines 44–51)

```
fn with_now_override(now: DateTime<Utc>, f: impl FnOnce() -> T) -> T
```

**Purpose**: Runs a closure with the error module's test-only current-time override temporarily set.

**Data flow**: It takes a `DateTime<Utc>` and a closure, writes `Some(now)` into the thread-local `NOW_OVERRIDE`, executes the closure, resets the override back to `None`, and returns the closure's result.

**Call relations**: Tests that assert on retry timestamps call this helper so `format_retry_timestamp` and the retry-suffix helpers behave deterministically.

*Call graph*: called by 8 (usage_limit_reached_error_formats_pro_plan_with_reset, usage_limit_reached_error_formats_team_plan, usage_limit_reached_error_hides_upsell_for_non_codex_limit_name, usage_limit_reached_includes_days_hours_minutes, usage_limit_reached_includes_hours_and_minutes, usage_limit_reached_includes_minutes_when_available, usage_limit_reached_less_than_minute, usage_limit_reached_with_promo_message).


##### `usage_limit_reached_error_formats_plus_plan`  (lines 54–66)

```
fn usage_limit_reached_error_formats_plus_plan()
```

**Purpose**: Verifies the exact Plus-plan usage-limit message when no reset time is available.

**Data flow**: It constructs a `UsageLimitReachedError` with `PlanType::Known(KnownPlan::Plus)`, a boxed snapshot fixture, and no reset or promo data, then compares `to_string()` to the expected upsell-and-credits message.

**Call relations**: This test exercises the Plus branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_rate_limit_reached_types`  (lines 69–104)

```
fn usage_limit_reached_error_formats_rate_limit_reached_types()
```

**Purpose**: Verifies the specialized messages for each `RateLimitReachedType` variant.

**Data flow**: It defines a table of `(RateLimitReachedType, expected_message)` pairs, constructs a `UsageLimitReachedError` for each with a Plus plan and snapshot fixture, and asserts that `to_string()` matches the expected string.

**Call relations**: This test covers the early `rate_limit_reached_type` branch in `UsageLimitReachedError::fmt`, including workspace credit and spend-cap wording.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `server_overloaded_maps_to_protocol`  (lines 107–113)

```
fn server_overloaded_maps_to_protocol()
```

**Purpose**: Checks that `CodexErr::ServerOverloaded` maps to the `ServerOverloaded` protocol error category.

**Data flow**: It constructs the enum variant, calls `to_codex_protocol_error()`, and asserts equality with `CodexErrorInfo::ServerOverloaded`.

**Call relations**: This test targets the protocol-classification logic in `CodexErr::to_codex_protocol_error`.

*Call graph*: 1 external calls (assert_eq!).


##### `sandbox_denied_uses_aggregated_output_when_stderr_empty`  (lines 116–130)

```
fn sandbox_denied_uses_aggregated_output_when_stderr_empty()
```

**Purpose**: Verifies that UI error extraction prefers aggregated sandbox output when present.

**Data flow**: It builds an `ExecToolCallOutput` with empty stdout/stderr and non-empty `aggregated_output`, wraps it in `CodexErr::Sandbox(SandboxErr::Denied { ... })`, calls `get_error_message_ui`, and asserts the aggregated text is returned.

**Call relations**: This test exercises the highest-priority branch in `get_error_message_ui` for sandbox denials.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `sandbox_denied_reports_both_streams_when_available`  (lines 133–147)

```
fn sandbox_denied_reports_both_streams_when_available()
```

**Purpose**: Verifies that UI sandbox errors concatenate stderr and stdout when both contain text and no aggregated output is available.

**Data flow**: It constructs sandbox output with non-empty stdout and stderr, empty aggregated output, wraps it in a denied sandbox error, calls `get_error_message_ui`, and asserts the result is `stderr` followed by newline and `stdout`.

**Call relations**: This test covers the mixed-stream branch in `get_error_message_ui`.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `sandbox_denied_reports_stdout_when_no_stderr`  (lines 150–164)

```
fn sandbox_denied_reports_stdout_when_no_stderr()
```

**Purpose**: Verifies that UI sandbox errors fall back to stdout when stderr is empty and no aggregated output exists.

**Data flow**: It builds denied sandbox output with only stdout populated, calls `get_error_message_ui`, and asserts the stdout text is returned.

**Call relations**: This test covers the stdout-only branch in the sandbox-denied formatting logic.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `to_error_event_handles_response_stream_failed`  (lines 167–191)

```
fn to_error_event_handles_response_stream_failed()
```

**Purpose**: Checks that response-stream failures produce an `ErrorEvent` with the expected prefixed message and protocol metadata.

**Data flow**: It constructs an HTTP 429 response, converts it into a reqwest error via `error_for_status_ref`, wraps that in `ResponseStreamFailed` and then `CodexErr::ResponseStreamFailed`, calls `to_error_event(Some("prefix".to_string()))`, and asserts both the final message string and `codex_error_info` payload.

**Call relations**: This test exercises the interaction between `ResponseStreamFailed::fmt`, `CodexErr::to_error_event`, and `CodexErr::to_codex_protocol_error`.

*Call graph*: 5 external calls (builder, parse, assert_eq!, from, ResponseStreamFailed).


##### `sandbox_denied_reports_exit_code_when_no_output_available`  (lines 194–211)

```
fn sandbox_denied_reports_exit_code_when_no_output_available()
```

**Purpose**: Verifies that sandbox UI errors synthesize an exit-code message when no output streams contain text.

**Data flow**: It constructs denied sandbox output with empty stdout, stderr, and aggregated output, calls `get_error_message_ui`, and asserts the fallback message mentions the exit code.

**Call relations**: This test covers the final fallback branch in sandbox-denied UI formatting.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `usage_limit_reached_error_formats_free_plan`  (lines 214–226)

```
fn usage_limit_reached_error_formats_free_plan()
```

**Purpose**: Verifies the exact Free-plan usage-limit upsell message.

**Data flow**: It constructs a `UsageLimitReachedError` with `KnownPlan::Free`, snapshot fixture, and no reset, then asserts the rendered string matches the expected Plus-upgrade wording.

**Call relations**: This test covers the Free-plan branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_go_plan`  (lines 229–241)

```
fn usage_limit_reached_error_formats_go_plan()
```

**Purpose**: Verifies the exact Go-plan usage-limit upsell message.

**Data flow**: It constructs a `UsageLimitReachedError` with `KnownPlan::Go`, snapshot fixture, and no reset, then asserts the rendered string matches the expected Plus-upgrade wording.

**Call relations**: This test covers the Go-plan branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_default_when_none`  (lines 244–256)

```
fn usage_limit_reached_error_formats_default_when_none()
```

**Purpose**: Verifies the generic usage-limit message when no plan type is known.

**Data flow**: It constructs a `UsageLimitReachedError` with `plan_type: None`, snapshot fixture, and no reset or promo data, then asserts the rendered string is the generic retry-later message.

**Call relations**: This test covers the unknown-plan/default branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 2 external calls (new, assert_eq!).


##### `usage_limit_reached_error_formats_team_plan`  (lines 259–276)

```
fn usage_limit_reached_error_formats_team_plan()
```

**Purpose**: Verifies Team-plan wording and inclusion of a formatted reset timestamp.

**Data flow**: It computes a base time and one-hour-later reset time, runs the assertion inside `with_now_override`, formats the expected timestamp via `format_retry_timestamp`, constructs a Team-plan `UsageLimitReachedError`, and compares the rendered string to the expected admin-request message with `or try again at ...`.

**Call relations**: This test covers both the Team-plan branch and same-day retry timestamp formatting.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_error_formats_business_plan_without_reset`  (lines 279–291)

```
fn usage_limit_reached_error_formats_business_plan_without_reset()
```

**Purpose**: Verifies Business-plan wording when no reset time is available.

**Data flow**: It constructs a Business-plan `UsageLimitReachedError` with snapshot fixture and no reset, then asserts the rendered string uses the admin-request plus retry-later wording.

**Call relations**: This test covers the Business-plan branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_self_serve_business_usage_based_plan`  (lines 294–306)

```
fn usage_limit_reached_error_formats_self_serve_business_usage_based_plan()
```

**Purpose**: Verifies wording for the self-serve business usage-based plan.

**Data flow**: It constructs a `UsageLimitReachedError` with `KnownPlan::SelfServeBusinessUsageBased`, snapshot fixture, and no reset, then asserts the rendered string matches the admin-request wording.

**Call relations**: This test covers one of the grouped workspace-plan branches in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan`  (lines 309–321)

```
fn usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan()
```

**Purpose**: Verifies wording for the enterprise CBP usage-based plan.

**Data flow**: It constructs a `UsageLimitReachedError` with `KnownPlan::EnterpriseCbpUsageBased`, snapshot fixture, and no reset, then asserts the rendered string matches the admin-request wording.

**Call relations**: This test covers another grouped workspace-plan branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_default_for_other_plans`  (lines 324–336)

```
fn usage_limit_reached_error_formats_default_for_other_plans()
```

**Purpose**: Verifies that Enterprise falls back to the generic usage-limit wording rather than an upsell or admin message.

**Data flow**: It constructs an Enterprise-plan `UsageLimitReachedError` with snapshot fixture and no reset, then asserts the rendered string is the generic retry-later message.

**Call relations**: This test covers the Enterprise/default branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_pro_plan_with_reset`  (lines 339–356)

```
fn usage_limit_reached_error_formats_pro_plan_with_reset()
```

**Purpose**: Verifies Pro-plan wording and inclusion of a formatted reset timestamp.

**Data flow**: It computes base and reset times, runs inside `with_now_override`, formats the expected timestamp, constructs a Pro-plan `UsageLimitReachedError`, and asserts the rendered string includes the credits-purchase message plus `or try again at ...`.

**Call relations**: This test covers the Pro-plan branch and same-day timestamp formatting path.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_error_hides_upsell_for_non_codex_limit_name`  (lines 359–383)

```
fn usage_limit_reached_error_hides_upsell_for_non_codex_limit_name()
```

**Purpose**: Verifies that a non-`codex` limit name suppresses plan-specific upsell copy in favor of model-switch guidance.

**Data flow**: Inside `with_now_override`, it constructs a Plus-plan `UsageLimitReachedError` whose `RateLimitSnapshot` has `limit_name: Some("codex_other")`, formats the expected retry timestamp, and asserts the rendered string says `You've hit your usage limit for codex_other. Switch to another model now, ...`.

**Call relations**: This test targets the highest-priority `limit_name` branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_includes_minutes_when_available`  (lines 386–401)

```
fn usage_limit_reached_includes_minutes_when_available()
```

**Purpose**: Verifies generic retry messaging when the reset time is only a few minutes away.

**Data flow**: It computes a base time and a reset five minutes later, runs inside `with_now_override`, formats the expected timestamp, constructs a generic `UsageLimitReachedError`, and asserts the rendered string includes `Try again at ...`.

**Call relations**: This test exercises same-day time-only formatting for short future intervals.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (minutes).


##### `unexpected_status_cloudflare_html_is_simplified`  (lines 404–421)

```
fn unexpected_status_cloudflare_html_is_simplified()
```

**Purpose**: Verifies that a Cloudflare-style blocked HTML body is rendered as the simplified friendly message.

**Data flow**: It constructs an `UnexpectedResponseError` with status 403, an HTML body containing `Cloudflare` and `blocked`, plus URL and cf-ray metadata, then asserts `to_string()` matches the friendly blocked-region message.

**Call relations**: This test covers the `friendly_message` branch in `UnexpectedResponseError::fmt`.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_non_html_is_unchanged`  (lines 424–440)

```
fn unexpected_status_non_html_is_unchanged()
```

**Purpose**: Verifies that a plain-text 403 body does not trigger Cloudflare simplification.

**Data flow**: It constructs an `UnexpectedResponseError` with status 403 and plain-text body, then asserts `to_string()` uses the generic `unexpected status ...: plain text error` format with URL.

**Call relations**: This test confirms the Cloudflare-friendly path is narrowly targeted and does not rewrite unrelated 403 responses.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_prefers_error_message_when_present`  (lines 443–461)

```
fn unexpected_status_prefers_error_message_when_present()
```

**Purpose**: Verifies that a nested JSON `error.message` is extracted and shown instead of the raw response body.

**Data flow**: It constructs an `UnexpectedResponseError` with a JSON body containing `{"error":{"message":...}}`, then asserts `to_string()` uses that extracted message and includes URL and request ID metadata.

**Call relations**: This test exercises `extract_error_message` via `display_body` inside the generic formatting path.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_truncates_long_body_with_ellipsis`  (lines 464–483)

```
fn unexpected_status_truncates_long_body_with_ellipsis()
```

**Purpose**: Verifies that very long response bodies are truncated to the configured byte limit with an ellipsis.

**Data flow**: It creates a body longer than `UNEXPECTED_RESPONSE_BODY_MAX_BYTES`, constructs an `UnexpectedResponseError`, computes the expected truncated body string, and asserts `to_string()` includes that truncated body plus URL and request ID.

**Call relations**: This test covers `truncate_with_ellipsis` through `UnexpectedResponseError::display_body`.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `unexpected_status_includes_cf_ray_and_request_id`  (lines 486–503)

```
fn unexpected_status_includes_cf_ray_and_request_id()
```

**Purpose**: Verifies that generic unexpected-status formatting appends both cf-ray and request ID metadata when present.

**Data flow**: It constructs an `UnexpectedResponseError` with plain-text body, URL, cf-ray, and request ID, then asserts the rendered string includes all of those fields in order.

**Call relations**: This test covers metadata appending in the generic branch of `UnexpectedResponseError::fmt`.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_includes_identity_auth_details`  (lines 506–523)

```
fn unexpected_status_includes_identity_auth_details()
```

**Purpose**: Verifies that identity authorization error details are appended to unexpected-status messages when present.

**Data flow**: It constructs an `UnexpectedResponseError` with URL, cf-ray, request ID, `identity_authorization_error`, and `identity_error_code`, then asserts the rendered string includes both auth detail fields.

**Call relations**: This test covers the final metadata fields appended by `UnexpectedResponseError::fmt`.

*Call graph*: 1 external calls (assert_eq!).


##### `usage_limit_reached_includes_hours_and_minutes`  (lines 526–543)

```
fn usage_limit_reached_includes_hours_and_minutes()
```

**Purpose**: Verifies retry timestamp formatting for a reset several hours and minutes in the future on the same day.

**Data flow**: It computes a base time and a reset 3 hours 32 minutes later, runs inside `with_now_override`, formats the expected timestamp, constructs a Plus-plan `UsageLimitReachedError`, and asserts the rendered string includes that timestamp.

**Call relations**: This test exercises same-day local-time formatting with both hour and minute components.

*Call graph*: calls 1 internal fn (with_now_override); 2 external calls (hours, minutes).


##### `usage_limit_reached_includes_days_hours_minutes`  (lines 546–562)

```
fn usage_limit_reached_includes_days_hours_minutes()
```

**Purpose**: Verifies retry timestamp formatting for a reset on a later calendar day.

**Data flow**: It computes a base time and a reset 2 days 3 hours 5 minutes later, runs inside `with_now_override`, formats the expected timestamp, constructs a generic `UsageLimitReachedError`, and asserts the rendered string includes the dated timestamp.

**Call relations**: This test covers the non-same-day branch in `format_retry_timestamp`, including ordinal day suffix formatting.

*Call graph*: calls 1 internal fn (with_now_override); 3 external calls (days, hours, minutes).


##### `usage_limit_reached_less_than_minute`  (lines 565–580)

```
fn usage_limit_reached_less_than_minute()
```

**Purpose**: Verifies retry messaging when the reset time is less than a minute away.

**Data flow**: It computes a base time and a reset 30 seconds later, runs inside `with_now_override`, formats the expected timestamp, constructs a generic `UsageLimitReachedError`, and asserts the rendered string includes `Try again at ...`.

**Call relations**: This test confirms that even very short future intervals still use the standard timestamp formatting path.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (seconds).


##### `usage_limit_reached_with_promo_message`  (lines 583–602)

```
fn usage_limit_reached_with_promo_message()
```

**Purpose**: Verifies that a promo message overrides plan-based default wording while still appending retry timing.

**Data flow**: It computes base and reset times, runs inside `with_now_override`, formats the expected timestamp, constructs a generic `UsageLimitReachedError` with `promo_message: Some(...)`, and asserts the rendered string uses the promo copy followed by `or try again at ...`.

**Call relations**: This test covers the promo-message branch in `UsageLimitReachedError::fmt`.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (seconds).


### `protocol/src/exec_output_tests.rs`

`test` · `test execution`

This test module exercises the byte-to-string conversion path used for shell command output. Every test funnels raw bytes through the local helper `decode_shell_output`, which constructs a `StreamOutput` with `text` set to the provided bytes and `truncated_after_lines` left as `None`, then invokes `from_utf8_lossy()` and extracts the decoded `.text`. The cases are intentionally concrete: valid UTF-8 Cyrillic should pass through unchanged; CP1251 and CP866 byte sequences for the Russian word "пример" must decode to the same Unicode string; Windows-1252 smart quotes and en dash bytes must become their proper Unicode punctuation; mixed ASCII plus legacy bytes such as `caf\xE9` must decode as expected; and completely undecodable bytes must still fall back to Rust’s standard lossy UTF-8 behavior. One regression test explicitly compares the smart decoder against `String::from_utf8_lossy()` to prove the old path would have inserted U+FFFD replacement characters where the new path preserves semantic punctuation. The file is narrowly scoped but important because it documents the intended heuristics and fallback invariant: prefer improved legacy-code-page decoding when recognizable, otherwise preserve the old lossy behavior.

#### Function details

##### `test_utf8_shell_output`  (lines 10–13)

```
fn test_utf8_shell_output()
```

**Purpose**: Checks the baseline case where already-valid UTF-8 shell output is returned unchanged. It guards against the smart decoder corrupting normal Unicode text.

**Data flow**: Uses the UTF-8 bytes of the literal `пример` as input to `decode_shell_output` and compares the returned `String` to the original Unicode text. It reads no shared state and writes no state beyond the assertion result.

**Call relations**: This test is invoked by the Rust test harness during protocol test runs. It does not delegate beyond the helper path and the assertion macro, serving as the simplest success case for the decoding pipeline.

*Call graph*: 1 external calls (assert_eq!).


##### `test_cp1251_shell_output`  (lines 16–19)

```
fn test_cp1251_shell_output()
```

**Purpose**: Verifies that a common Windows Cyrillic code page, CP1251, is recognized and decoded into Unicode text. This covers VS Code shell output observed on Windows.

**Data flow**: Passes the explicit byte sequence `\xEF\xF0\xE8\xEC\xE5\xF0` into `decode_shell_output` and asserts that the resulting string is `пример`. No persistent state is read or mutated.

**Call relations**: Run by the test harness as a regression case for issue-specific decoding behavior. It relies on the helper to exercise `StreamOutput::from_utf8_lossy()` rather than testing decoding logic inline.

*Call graph*: 1 external calls (assert_eq!).


##### `test_cp866_shell_output`  (lines 22–25)

```
fn test_cp866_shell_output()
```

**Purpose**: Confirms that CP866, the legacy cmd.exe default on Windows, is also detected correctly for Cyrillic output. This ensures compatibility with native Windows shells, not just VS Code’s common path.

**Data flow**: Feeds the CP866 bytes `\xAF\xE0\xA8\xAC\xA5\xE0` into `decode_shell_output` and checks that the returned string equals `пример`. It has no side effects beyond the assertion.

**Call relations**: Executed by the test harness as another targeted regression case. It complements the CP1251 test by covering a second legacy encoding branch in the decoder.

*Call graph*: 1 external calls (assert_eq!).


##### `test_windows_1252_smart_decoding`  (lines 28–34)

```
fn test_windows_1252_smart_decoding()
```

**Purpose**: Tests smart decoding of Windows-1252 punctuation bytes into curly quotes and an en dash. The goal is to preserve readable punctuation instead of replacement glyphs or mojibake.

**Data flow**: Supplies the byte slice `\x93\x94 test \x96 dash` to `decode_shell_output` and asserts that the output string contains Unicode left/right double quotation marks and an en dash around the ASCII text. No external state is involved.

**Call relations**: The test harness invokes this as a punctuation-focused regression. It exercises the same helper path as the Cyrillic tests but validates a different heuristic branch in the decoder.

*Call graph*: 1 external calls (assert_eq!).


##### `test_smart_decoding_improves_over_lossy_utf8`  (lines 37–49)

```
fn test_smart_decoding_improves_over_lossy_utf8()
```

**Purpose**: Demonstrates the exact regression being prevented: plain `String::from_utf8_lossy()` would inject replacement characters for Windows-1252 punctuation bytes, while the smart decoder should preserve them. It proves the new behavior is materially better, not just different.

**Data flow**: Creates a byte slice with Windows-1252 punctuation, first checks that `String::from_utf8_lossy(bytes)` contains U+FFFD, then runs `decode_shell_output(bytes)` and asserts the returned string contains the intended Unicode punctuation. It reads only local variables and produces assertion outcomes.

**Call relations**: Called by the test harness as a regression guard. Unlike the other tests, it explicitly compares the helper path against Rust’s standard lossy conversion to document why the custom decoding exists.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `test_mixed_ascii_and_legacy_encoding`  (lines 52–55)

```
fn test_mixed_ascii_and_legacy_encoding()
```

**Purpose**: Validates mixed-content decoding where mostly ASCII shell output contains a single legacy-encoded non-ASCII byte. This mirrors realistic command output such as status text plus a word like `café`.

**Data flow**: Passes `b"Output: caf\xE9"` into `decode_shell_output` and asserts the result is `Output: café`. It does not access or mutate shared state.

**Call relations**: Run by the test harness to ensure the decoder handles partial legacy encoding embedded in otherwise plain ASCII output. It complements the pure legacy-byte tests with a mixed-stream scenario.

*Call graph*: 1 external calls (assert_eq!).


##### `test_pure_latin1_shell_output`  (lines 58–61)

```
fn test_pure_latin1_shell_output()
```

**Purpose**: Provides regression coverage for plain Latin-1 decoding without surrounding ASCII context. It ensures older expectations around `caf\xE9` still hold after the smart-decoding changes.

**Data flow**: Feeds `b"caf\xE9"` into `decode_shell_output` and compares the returned string to `café`. No state is read or written outside the assertion.

**Call relations**: Executed by the test harness as a simpler Latin-1-only case. It reinforces that the decoder still handles straightforward single-byte Western encodings correctly.

*Call graph*: 1 external calls (assert_eq!).


##### `test_invalid_bytes_still_fall_back_to_lossy`  (lines 64–68)

```
fn test_invalid_bytes_still_fall_back_to_lossy()
```

**Purpose**: Checks the fallback invariant: when no smart decoding heuristic applies, users should still see lossy UTF-8 output with replacement characters rather than a failure or empty string. This preserves backward-compatible visibility into bad output.

**Data flow**: Uses the invalid byte sequence `\xFF\xFE\xFD`, runs it through `decode_shell_output`, and asserts equality with `String::from_utf8_lossy(bytes)`. It only computes local values and performs an assertion.

**Call relations**: The test harness invokes this as the negative-path counterpart to the smart-decoding tests. It verifies that the helper path ultimately degrades to the standard lossy conversion when detection fails.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_shell_output`  (lines 70–77)

```
fn decode_shell_output(bytes: &[u8]) -> String
```

**Purpose**: Builds a minimal `StreamOutput` from raw bytes and returns the decoded text produced by `from_utf8_lossy()`. It centralizes the exact conversion path all tests are meant to exercise.

**Data flow**: Accepts a `&[u8]`, clones it into `StreamOutput.text`, sets `truncated_after_lines` to `None`, invokes `from_utf8_lossy()` on that value, and returns the resulting `.text` `String`. It does not mutate external state.

**Call relations**: This helper is called by every test in the file so they all exercise the same production decoding entrypoint. It delegates the real work to `StreamOutput::from_utf8_lossy()` and strips away unrelated fields.


### `code-mode-protocol/src/session_tests.rs`

`test` · `test execution`

This test file exercises one very specific contract in the code-mode protocol layer: `StartedCell::from_result_receiver` must preserve an error payload already delivered by the remote/runtime side, rather than translating it into a channel-closed failure or otherwise rewriting it. The test constructs a Tokio `oneshot` channel, immediately sends `Err("remote runtime failed".to_string())` through the sender, then wraps the receiver together with a concrete `CellId` created from the string `"1"`. It finally awaits `started.initial_response()` and asserts exact equality with the original `Err(String)` value.

The important detail is that the receiver remains open long enough for the send to succeed, so the test isolates behavior after successful transport delivery rather than channel teardown. By using `pretty_assertions::assert_eq`, the test checks the full `Result` value, not just that an error occurred. This guards a subtle but important invariant for higher layers such as session orchestration: remote startup errors must remain semantically distinct from local plumbing failures, because callers may present or handle those two cases differently.

#### Function details

##### `started_cell_preserves_remote_initial_response_errors`  (lines 8–19)

```
async fn started_cell_preserves_remote_initial_response_errors()
```

**Purpose**: Builds a `StartedCell` from a pre-populated oneshot receiver carrying an error and verifies that awaiting the initial response returns that same error text unchanged.

**Data flow**: Creates a Tokio oneshot `(response_tx, response_rx)`, sends `Err("remote runtime failed".to_string())` into the sender, constructs a `CellId` from `"1"`, and passes both into `StartedCell::from_result_receiver`. It then awaits `started.initial_response()` and compares the returned `Result` against the original `Err(String)`.

**Call relations**: This is a standalone async test invoked by the Tokio test harness. Within the test body it constructs protocol objects via `CellId::new` and `StartedCell::from_result_receiver`, then uses `assert_eq!` to validate the externally observable behavior of `StartedCell` when its backing receiver already contains a remote error.

*Call graph*: calls 2 internal fn (new, from_result_receiver); 2 external calls (assert_eq!, channel).


### `code-mode/src/service_contract_tests.rs`

`test` · `request handling and shutdown edge cases`

This test file exercises the lifecycle of a code execution cell from both the high-level `CodeModeService` API and the lower-level `run_cell_control` loop. Two delegate test doubles model cancellation-sensitive callbacks: `BlockingDelegate` records when notification/tool futures start and only completes after cancellation, while `HeldNotificationDelegate` additionally blocks post-cancellation completion on a `Notify` so tests can hold teardown in the middle of callback cleanup. Delegate activity is reported through an unbounded Tokio channel as `DelegateEvent` values, letting tests assert exact sequencing such as notification start, cancellation, and final `cell_closed`.

The `spawn_cell_control_harness` helper constructs a real runtime via `spawn_runtime`, wires `RuntimeEvent` and `CellControlCommand` channels into `run_cell_control`, and returns handles for injecting runtime events, issuing termination, and awaiting the initial response. Small helpers create canonical `CellId`, `ExecuteRequest`, and a synthetic blocking tool definition.

The tests focus on subtle precedence rules: an immediate yield timer must beat already-buffered runtime output; a queued terminate command must beat an unobserved runtime completion; observed natural completion must beat later termination; termination must cancel pending delegate callbacks before replying; repeated termination is rejected while cleanup is still in progress; only one waiter may observe a live cell at a time; and both yielded and pending-frontier executions can later resume to completion. Assertions check not just returned `RuntimeResponse`/`WaitOutcome` values but also internal cleanup invariants such as callback cancellation flags and `CellClosed` delivery.

#### Function details

##### `HeldNotificationDelegate::new`  (lines 40–49)

```
fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<DelegateEvent>)
```

**Purpose**: Constructs a delegate whose notification callback can be held after cancellation, along with a receiver for observing emitted `DelegateEvent`s.

**Data flow**: Creates an unbounded MPSC channel, stores the sender and a fresh `Notify` inside an `Arc<HeldNotificationDelegate>`, and returns that shared delegate plus the receiver. No external state is read; the returned receiver becomes the test's observation point for callback sequencing.

**Call relations**: Used by `repeated_termination_is_rejected_while_callback_cleanup_is_pending` to create a delegate that lets the first termination enter callback cleanup and pause there, so the test can issue a second termination while the cell is still in the terminating state.

*Call graph*: called by 1 (repeated_termination_is_rejected_while_callback_cleanup_is_pending); 3 external calls (new, new, unbounded_channel).


##### `HeldNotificationDelegate::release_notification`  (lines 51–53)

```
fn release_notification(&self)
```

**Purpose**: Unblocks the held notification future after the test has observed the intermediate terminating state.

**Data flow**: Reads the delegate's internal `Notify` and calls `notify_one`, waking the suspended `notify` future so it can finish and allow cell teardown to complete. It returns no value and mutates only the synchronization primitive's wake state.

**Call relations**: Called directly by the repeated-termination test after it has confirmed the second terminate request is rejected, allowing the first termination task to finish and emit the final `CellClosed` event.

*Call graph*: 1 external calls (notify_one).


##### `HeldNotificationDelegate::invoke_tool`  (lines 57–66)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Implements the delegate tool hook as a cancellation-only future that never succeeds.

**Data flow**: Ignores the nested tool invocation payload, awaits the provided `CancellationToken`, and then returns `Err("cancelled")`. It does not emit events or mutate delegate state.

**Call relations**: This implementation satisfies the `CodeModeSessionDelegate` trait for tests that only care about notification cleanup; if the runtime were to invoke a tool through this delegate, the future would remain pending until the cell control logic cancels it.

*Call graph*: 2 external calls (pin, cancelled).


##### `HeldNotificationDelegate::notify`  (lines 68–82)

```
fn notify(
        &'a self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a>
```

**Purpose**: Simulates a notification callback that reports start, waits for cancellation, reports cancellation, and then stays blocked until the test explicitly releases it.

**Data flow**: Receives call metadata but ignores it, sends `DelegateEvent::NotificationStarted`, awaits `cancellation_token.cancelled()`, sends `NotificationCancelled`, then awaits `notification_release.notified()` before returning `Ok(())`. Its observable outputs are the two channel events and eventual completion after external release.

**Call relations**: Driven by the service when code executes `notify(...)`. In the repeated-termination test, termination cancels this future; the future emits the cancellation event immediately but does not complete until `release_notification` is called, exposing the window where the cell is already terminating but not yet fully cleaned up.

*Call graph*: 4 external calls (pin, cancelled, notified, send).


##### `HeldNotificationDelegate::cell_closed`  (lines 84–88)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Reports that the service has finished closing a cell.

**Data flow**: Clones the provided `CellId` and sends `DelegateEvent::CellClosed` through the delegate event channel. It returns nothing and does not maintain additional state.

**Call relations**: Invoked by the code-mode service/control path during final cleanup. Tests use the emitted event as the last observable proof that callback cleanup and cell removal completed.

*Call graph*: 3 external calls (send, clone, CellClosed).


##### `spawn_cell_control_harness`  (lines 99–144)

```
fn spawn_cell_control_harness(
    initial_yield_time_ms: Option<u64>,
    delegate: Arc<dyn CodeModeSessionDelegate>,
) -> CellControlHarness
```

**Purpose**: Builds a low-level test harness around `run_cell_control` with a real spawned runtime and injectable event/control channels.

**Data flow**: Allocates unbounded channels for runtime events and control commands, a oneshot for the initial response, and a runtime event sink. It starts a runtime with `spawn_runtime` using a never-resolving JavaScript request, constructs an `Inner` service state with empty `stored_values` and `cells`, the supplied delegate, shutdown flag false, and `next_cell_id` initialized to 1, then spawns `run_cell_control` for cell `1`. It returns a `CellControlHarness` containing senders, the initial-response receiver, the join handle, and the runtime event receiver retained only to keep the channel alive.

**Call relations**: Used by the three tests that need direct control over event ordering inside the cell-control loop rather than going through `CodeModeService`: yield-timer preemption, queued termination versus unobserved completion, and observed completion versus termination.

*Call graph*: calls 2 internal fn (cell_id, execute_request); called by 3 (observed_natural_completion_wins_over_termination, queued_termination_preempts_unobserved_runtime_completion, yield_timer_preempts_buffered_runtime_output); 10 external calls (new, new, new, new, new, new, Runtime, unbounded_channel, channel, spawn).


##### `BlockingDelegate::new`  (lines 147–157)

```
fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<DelegateEvent>)
```

**Purpose**: Constructs a delegate that records callback start/cancel events and flips atomic flags when cancellation cleanup has actually run.

**Data flow**: Creates an unbounded event channel and initializes `notification_finished` and `tool_finished` atomics to `false` inside an `Arc<BlockingDelegate>`. Returns the shared delegate and the receiver used by tests to observe callback sequencing.

**Call relations**: Used by tests that need to verify the service waits for callback cancellation cleanup before responding, both for notifications and nested tool invocations.

*Call graph*: called by 3 (natural_completion_cleans_up_callbacks_before_responding, observed_natural_completion_wins_over_termination, termination_cancels_pending_callbacks_before_responding); 3 external calls (new, new, unbounded_channel).


##### `BlockingDelegate::invoke_tool`  (lines 161–173)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Simulates a long-running tool callback that only finishes when the service cancels it, and records that cleanup happened.

**Data flow**: Sends `ToolStarted`, awaits the cancellation token, stores `true` into `tool_finished` with `Release` ordering, sends `ToolCancelled`, and returns `Err("cancelled")`. The atomic flag gives tests a non-channel way to verify cleanup completed before the service responded.

**Call relations**: Triggered when executed code calls the synthetic `block` tool. The natural-completion cleanup test relies on this future being cancelled during cell completion so it can assert the service does not answer until the delegate callback has observed cancellation and finished.

*Call graph*: 4 external calls (store, pin, cancelled, send).


##### `BlockingDelegate::notify`  (lines 175–189)

```
fn notify(
        &'a self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a>
```

**Purpose**: Simulates a notification callback that blocks until cancellation and records when cancellation cleanup has completed.

**Data flow**: Sends `NotificationStarted`, awaits cancellation, stores `true` into `notification_finished`, sends `NotificationCancelled`, and returns `Err("cancelled")`. Inputs such as call id, cell id, and text are ignored because the tests only care about lifecycle ordering.

**Call relations**: Used in termination and observed-completion tests where the runtime emits `Notify`. The service cancels this callback during teardown, and the tests assert that the response is not delivered until this future has run its cancellation path.

*Call graph*: 4 external calls (store, pin, cancelled, send).


##### `BlockingDelegate::cell_closed`  (lines 191–195)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Reports final cell closure for tests that assert teardown ordering.

**Data flow**: Clones the incoming `CellId` and sends `DelegateEvent::CellClosed` on the event channel. It has no return value and no persistent mutation beyond the sent event.

**Call relations**: Called by the service after callback cleanup. Tests consume this event after `NotificationCancelled` or `ToolCancelled` to verify closure happens last.

*Call graph*: 3 external calls (send, clone, CellClosed).


##### `cell_id`  (lines 198–200)

```
fn cell_id(value: &str) -> CellId
```

**Purpose**: Creates a `CellId` wrapper from a string literal used throughout the tests.

**Data flow**: Allocates a `String` from the input `&str` and passes it to `CellId::new`, returning the resulting identifier. It reads no shared state and writes none.

**Call relations**: Used by helpers and assertions to avoid repeating `CellId::new(value.to_string())`, ensuring all tests compare against the same canonical cell identifiers.

*Call graph*: calls 1 internal fn (new); called by 5 (queued_termination_preempts_unobserved_runtime_completion, repeated_termination_is_rejected_while_callback_cleanup_is_pending, returns_and_resumes_from_the_pending_frontier, second_observer_is_rejected_without_displacing_the_first, spawn_cell_control_harness).


##### `execute_request`  (lines 202–210)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: Builds a standard `ExecuteRequest` fixture with fixed metadata and caller-supplied source code.

**Data flow**: Takes source text and returns an `ExecuteRequest` with `tool_call_id` set to `call-1`, no enabled tools, `yield_time_ms` set to `Some(1)`, and `max_output_tokens` unset. The only varying field is the provided source string.

**Call relations**: Used by most tests and by the harness to create concise execution requests while keeping unrelated request fields stable.

*Call graph*: called by 6 (natural_completion_cleans_up_callbacks_before_responding, repeated_termination_is_rejected_while_callback_cleanup_is_pending, second_observer_is_rejected_without_displacing_the_first, spawn_cell_control_harness, termination_cancels_pending_callbacks_before_responding, yields_and_resumes); 1 external calls (new).


##### `blocking_tool`  (lines 212–221)

```
fn blocking_tool() -> ToolDefinition
```

**Purpose**: Defines a single function-style tool named `block` for tests that exercise nested tool invocation cleanup.

**Data flow**: Returns a `ToolDefinition` with both display name and protocol `ToolName` set to `block`, empty description, `CodeModeToolKind::Function`, and no input/output schemas. It is pure fixture construction.

**Call relations**: Consumed by `natural_completion_cleans_up_callbacks_before_responding` so executed code can call `tools.block({})` and trigger the delegate's `invoke_tool` path.

*Call graph*: calls 1 internal fn (plain); 1 external calls (new).


##### `next_event`  (lines 223–228)

```
async fn next_event(events_rx: &mut mpsc::UnboundedReceiver<DelegateEvent>) -> DelegateEvent
```

**Purpose**: Waits for the next delegate event with a hard timeout so tests fail quickly instead of hanging.

**Data flow**: Takes a mutable receiver reference, awaits `recv()` under a two-second Tokio timeout, unwraps both timeout and channel-closed cases into test failures, and returns the received `DelegateEvent`.

**Call relations**: Used by multiple tests to serialize assertions about delegate callback ordering without duplicating timeout boilerplate.

*Call graph*: 3 external calls (from_secs, recv, timeout).


##### `yield_timer_preempts_buffered_runtime_output`  (lines 231–272)

```
async fn yield_timer_preempts_buffered_runtime_output()
```

**Purpose**: Verifies that an immediate initial yield fires before already-buffered runtime output is surfaced in the initial response.

**Data flow**: Creates a harness with `initial_yield_time_ms = 0`, injects `RuntimeEvent::Started` and a queued `ContentItem`, then awaits the initial response and expects `RuntimeResponse::Yielded` with no content. It next sends a terminate command, drops the event sender to end the runtime stream, and asserts the termination response contains the previously buffered output.

**Call relations**: Exercises `run_cell_control` directly through the harness to prove the yield timer has higher priority than buffered output during the initial observation window, while termination later flushes accumulated content.

*Call graph*: calls 1 internal fn (spawn_cell_control_harness); 4 external calls (new, assert_eq!, ContentItem, channel).


##### `queued_termination_preempts_unobserved_runtime_completion`  (lines 275–302)

```
async fn queued_termination_preempts_unobserved_runtime_completion()
```

**Purpose**: Checks that a terminate command queued after runtime completion but before the completion is observed wins and becomes the visible outcome.

**Data flow**: Starts a harness with a very long initial yield timeout, injects a `RuntimeEvent::Result`, then immediately sends `CellControlCommand::Terminate`. It awaits both the termination oneshot and the initial response receiver and expects both to resolve to the same `RuntimeResponse::Terminated` with empty content.

**Call relations**: Uses the low-level harness to pin down a race in the cell-control loop: if completion has occurred internally but has not yet been surfaced to an observer, a queued terminate request should still control the externally visible result.

*Call graph*: calls 2 internal fn (cell_id, spawn_cell_control_harness); 5 external calls (new, new, new, assert_eq!, channel).


##### `yields_and_resumes`  (lines 305–339)

```
async fn yields_and_resumes()
```

**Purpose**: Validates the public service API for a cell that explicitly yields and is later resumed by `wait`.

**Data flow**: Creates a fresh `CodeModeService`, executes code that emits `before`, calls `yield_control()`, then emits `after`. It awaits the cell's initial response and expects a yielded response containing only `before`, then calls `service.wait` with a short yield timeout and expects a live-cell final `Result` containing `after` and no error.

**Call relations**: Exercises the normal high-level execute/wait flow rather than the internal harness, demonstrating the intended contract for explicit cooperative yielding.

*Call graph*: calls 2 internal fn (new, execute_request); 1 external calls (assert_eq!).


##### `returns_and_resumes_from_the_pending_frontier`  (lines 342–390)

```
async fn returns_and_resumes_from_the_pending_frontier()
```

**Purpose**: Tests the alternate pending-frontier API where execution pauses on unresolved async work and later resumes to completion.

**Data flow**: Creates a service, calls `execute_to_pending` on code awaiting a long timeout and then printing `after`, and expects `ExecuteToPendingOutcome::Pending` with no content and no pending tool calls. It then reaches into `service.inner.cells` to fetch the runtime sender for cell `1`, injects `RuntimeCommand::TimeoutFired { id: 1 }`, and calls `wait_to_pending`, expecting a live-cell completed result containing `after`.

**Call relations**: Uses the public pending APIs plus a direct runtime poke to simulate the async frontier becoming ready, proving that pending execution can be resumed from stored cell state.

*Call graph*: calls 2 internal fn (new, cell_id); 1 external calls (assert_eq!).


##### `observed_natural_completion_wins_over_termination`  (lines 393–460)

```
async fn observed_natural_completion_wins_over_termination()
```

**Purpose**: Ensures that once natural completion has been observed, a later terminate request returns the completed result rather than converting it into termination.

**Data flow**: Builds a harness with a `BlockingDelegate`, forces an initial yield via `RuntimeEvent::YieldRequested`, then injects output text, a successful `Result`, and a `Notify` event. After observing `NotificationStarted`, it sends a terminate command and expects the terminate response to be the completed `RuntimeResponse::Result` with `done`. Finally it awaits task completion, checks the delegate's notification-finished atomic, and asserts subsequent delegate events are `NotificationCancelled` then `CellClosed`.

**Call relations**: Targets a race where completion and termination overlap. By making completion observable before termination is requested, the test proves the control loop preserves the completed outcome while still cancelling and draining pending callbacks during cleanup.

*Call graph*: calls 2 internal fn (new, spawn_cell_control_harness); 5 external calls (new, assert!, assert_eq!, ContentItem, channel).


##### `termination_cancels_pending_callbacks_before_responding`  (lines 463–500)

```
async fn termination_cancels_pending_callbacks_before_responding()
```

**Purpose**: Verifies that terminating a yielded cell waits for in-flight notification callbacks to observe cancellation before returning the termination response.

**Data flow**: Creates a service with `BlockingDelegate`, executes code that calls `notify("pending")` and then waits forever, observes `NotificationStarted`, confirms the initial response is `Yielded`, then calls `service.terminate`. It expects a live-cell `Terminated` response with no content, checks the delegate's `notification_finished` atomic is true, and then asserts `NotificationCancelled` and `CellClosed` arrive in order.

**Call relations**: Exercises the public terminate path and proves that response delivery is sequenced after delegate callback cancellation/cleanup, not merely after issuing cancellation.

*Call graph*: calls 3 internal fn (with_delegate, new, execute_request); 2 external calls (assert!, assert_eq!).


##### `repeated_termination_is_rejected_while_callback_cleanup_is_pending`  (lines 503–551)

```
async fn repeated_termination_is_rejected_while_callback_cleanup_is_pending()
```

**Purpose**: Checks that a second terminate request is rejected while the first termination is still waiting for callback cleanup to finish.

**Data flow**: Creates a shared service with `HeldNotificationDelegate`, executes code that starts a notification and then blocks forever, observes `NotificationStarted`, and confirms the initial response is yielded. It spawns the first `terminate` call on another task, waits until the delegate reports `NotificationCancelled`, then issues a second `terminate` synchronously and expects the error `exec cell 1 is already terminating`. After releasing the held notification, it awaits the first termination and expects a normal terminated outcome, then observes final `CellClosed`.

**Call relations**: Uses the held delegate to widen the cleanup window between cancellation and final closure, proving the service tracks an intermediate terminating state and rejects duplicate termination attempts without displacing the original one.

*Call graph*: calls 4 internal fn (with_delegate, new, cell_id, execute_request); 4 external calls (clone, new, assert_eq!, spawn).


##### `second_observer_is_rejected_without_displacing_the_first`  (lines 554–598)

```
async fn second_observer_is_rejected_without_displacing_the_first()
```

**Purpose**: Ensures only one active waiter can observe a live cell, and a rejected second observer does not interfere with the first.

**Data flow**: Executes a never-resolving cell, awaits its initial yielded response, then starts a long-lived first observer with `begin_wait`. A second `wait` call is expected to fail with `exec cell 1 already has an active observer`. The test then terminates the cell and asserts both the direct terminate result and the first observer future resolve to the same `RuntimeResponse::Terminated`.

**Call relations**: Exercises observer registration logic in the public API, confirming exclusivity of active waiters and preservation of the original observer when a second one is rejected.

*Call graph*: calls 3 internal fn (new, cell_id, execute_request); 2 external calls (new, assert_eq!).


##### `natural_completion_cleans_up_callbacks_before_responding`  (lines 601–634)

```
async fn natural_completion_cleans_up_callbacks_before_responding()
```

**Purpose**: Verifies that even on successful natural completion, the service cancels and drains nested tool callbacks before returning the final result.

**Data flow**: Creates a service with `BlockingDelegate`, executes code with the synthetic `block` tool enabled and source `tools.block({}); text("done");`, and first observes `ToolStarted`. It then awaits the initial response and expects an immediate final `RuntimeResponse::Result` containing `done`, checks the delegate's `tool_finished` atomic is true, and asserts `ToolCancelled` then `CellClosed` events follow.

**Call relations**: Covers the completion path complementary to explicit termination: the runtime finishes successfully, but the service still must cancel outstanding delegate work and wait for that cleanup before exposing the result.

*Call graph*: calls 3 internal fn (with_delegate, new, execute_request); 3 external calls (assert!, assert_eq!, vec!).


### Transport, proxy, and socket support tests
These tests exercise lower-level transport helpers, retry/auth parsing, proxy inspection rules, socket utilities, and TLS provider initialization.

### `rmcp-client/src/executor_process_transport_tests.rs`

`test` · `test execution`

This test module focuses narrowly on `LineBuffer`, the internal byte accumulator that underpins stdout and stderr framing in `executor_process_transport.rs`. Because the transport relies on `LineBuffer.scanned_len` to avoid rescanning bytes already known not to contain a newline, these tests verify both returned values and internal buffer state after each operation. The first test appends a partial line in multiple chunks, confirms `take_line()` returns `None` until a newline arrives, and checks that `scanned_len` advances only across the bytes already searched. When the newline finally appears, it verifies that the complete line is returned and the remaining tail stays buffered with `scanned_len` reset.

The second test covers the common case where one append contains multiple newline-delimited records plus a partial tail. It confirms that successive `take_line()` calls return `first` and `second`, then leave `partial` buffered with the correct scanned length. The third test verifies EOF behavior: after a partial line with no newline, `take_remaining()` returns the buffered bytes and restores the buffer to its default empty state. Together these tests protect the transport's assumptions about efficient incremental scanning and final-fragment handling.

#### Function details

##### `searches_only_new_bytes_after_partial_line`  (lines 7–42)

```
fn searches_only_new_bytes_after_partial_line()
```

**Purpose**: Verifies that `LineBuffer` does not rescan previously checked bytes when a partial line is extended incrementally.

**Data flow**: It creates a default `LineBuffer`, appends `partial`, then ` line`, then `\nnext`, calling `take_line()` after each append and asserting both the returned value and the internal `bytes`/`scanned_len` state after each step.

**Call relations**: This test directly exercises `LineBuffer::extend_from_slice` and `LineBuffer::take_line` behavior that the transport depends on for efficient incremental framing.

*Call graph*: 2 external calls (assert_eq!, default).


##### `splits_multiple_lines_and_retains_partial_tail`  (lines 45–59)

```
fn splits_multiple_lines_and_retains_partial_tail()
```

**Purpose**: Verifies that one buffer containing multiple newline-delimited lines yields them in order and preserves an unterminated tail.

**Data flow**: It creates a default `LineBuffer`, appends `first\nsecond\npartial`, calls `take_line()` three times, and asserts that the first two calls return `first` and `second` while the third returns `None` and leaves `partial` buffered with `scanned_len` set to its length.

**Call relations**: This test covers the multi-record framing path used by the transport when one executor output chunk contains several MCP messages.

*Call graph*: 2 external calls (assert_eq!, default).


##### `takes_unterminated_remaining_bytes_at_eof`  (lines 62–72)

```
fn takes_unterminated_remaining_bytes_at_eof()
```

**Purpose**: Verifies that `take_remaining()` returns a final unterminated fragment and empties the buffer.

**Data flow**: It creates a default `LineBuffer`, appends `remaining`, confirms `take_line()` returns `None`, then asserts that `take_remaining()` returns the full bytes and that the buffer resets to `LineBuffer::default()`.

**Call relations**: This test protects the EOF path used by the transport when a process closes after emitting a final line without a trailing newline.

*Call graph*: 2 external calls (assert_eq!, default).


### `rmcp-client/src/http_client_adapter/www_authenticate_tests.rs`

`test` · `test execution`

This test module validates the narrow but security-sensitive parsing logic in `www_authenticate.rs`. The first test enumerates a range of accepted header encodings: quoted and unquoted scope values, mixed-case parameter names, reordered parameters, escaped spaces inside quoted strings, unrelated parameters containing `scope=` text, and Bearer challenges appearing after other auth schemes in the same field value. Each case must produce `Some(BearerInsufficientScope { required_scope: Some(...) })` with the expected decoded scope string.

The remaining tests focus on negative and edge behavior. One confirms that Bearer challenges with other `error` values are ignored entirely. Another verifies that malformed, ambiguous, or duplicate scope parameters still count as an insufficient-scope challenge but yield `required_scope: None`, preserving the distinction between “scope required but not reliably parseable” and “not an insufficient-scope challenge.” A separate test ensures stray `scope` text outside an actual `scope` parameter does not trigger false positives, including unterminated quoted strings. The final test checks the public multi-header helper: when multiple `WWW-Authenticate` field values are present, it should skip non-Bearer entries and return the later Bearer insufficient-scope challenge together with the original header string.

#### Function details

##### `extracts_scope_from_bearer_insufficient_scope_challenges`  (lines 10–52)

```
fn extracts_scope_from_bearer_insufficient_scope_challenges()
```

**Purpose**: Verifies that valid Bearer insufficient-scope challenges yield the expected decoded required scope across many syntactic variants.

**Data flow**: It defines a table of header strings and expected scope strings, iterates over the cases, calls `parse_bearer_insufficient_scope(header)`, and asserts that each result is `Some(BearerInsufficientScope { required_scope: Some(expected_scope.to_string()) })`.

**Call relations**: This test directly exercises the core parser's positive path, covering quoting, escaping, parameter order, case-insensitive names, and mixed auth-scheme field values.

*Call graph*: 1 external calls (assert_eq!).


##### `does_not_treat_other_bearer_errors_as_insufficient_scope`  (lines 55–60)

```
fn does_not_treat_other_bearer_errors_as_insufficient_scope()
```

**Purpose**: Verifies that Bearer challenges with non-`insufficient_scope` errors are ignored.

**Data flow**: It calls `parse_bearer_insufficient_scope` on a header containing `error="invalid_token"` and asserts that the result is `None`.

**Call relations**: This test protects the semantic filter implemented by `BearerChallenge::into_insufficient_scope`.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_invalid_or_ambiguous_scope_parameters`  (lines 63–84)

```
fn rejects_invalid_or_ambiguous_scope_parameters()
```

**Purpose**: Verifies that malformed or duplicate scope parameters do not produce a trusted required scope value.

**Data flow**: It defines several malformed header strings, iterates over them, calls `parse_bearer_insufficient_scope`, and asserts that each result is `Some(BearerInsufficientScope { required_scope: None })`.

**Call relations**: This test covers the parser's ambiguity-handling path, ensuring invalid scope syntax is distinguished from the absence of an insufficient-scope challenge.

*Call graph*: 1 external calls (assert_eq!).


##### `ignores_scope_text_outside_a_scope_parameter`  (lines 87–102)

```
fn ignores_scope_text_outside_a_scope_parameter()
```

**Purpose**: Verifies that incidental `scope` text in other parameters or malformed quoted strings does not trigger false insufficient-scope matches.

**Data flow**: It defines several header strings where `scope` appears only in unrelated contexts, iterates over them, calls `parse_bearer_insufficient_scope`, and asserts that each result is `None`.

**Call relations**: This test exercises the tokenizer and parameter parser to ensure they only recognize actual `scope=` auth parameters.

*Call graph*: 1 external calls (assert_eq!).


##### `selects_bearer_challenge_from_a_later_www_authenticate_field_value`  (lines 105–124)

```
fn selects_bearer_challenge_from_a_later_www_authenticate_field_value()
```

**Purpose**: Verifies that the public multi-header helper scans all `WWW-Authenticate` fields and returns a later matching Bearer challenge.

**Data flow**: It builds a `Vec<HttpHeader>` containing a non-Bearer `www-authenticate` header followed by a Bearer insufficient-scope header, calls `insufficient_scope_challenge(&headers)`, and asserts that the result contains the second header's original value and parsed required scope.

**Call relations**: This test covers the public helper used by `StreamableHttpClientAdapter::post_message`, ensuring it works across multiple header field values rather than only within one string.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `rmcp-client/src/streamable_http_retry_tests.rs`

`test` · `test`

This test file validates the retry policy encoded in `streamable_http_retry.rs` without needing live transports. The first test, `retryable_initialize_error_includes_initialized_notification_context`, constructs synthetic `ClientInitializeError::TransportError` values for three handshake contexts and verifies that only `send initialize request` and `send initialized notification` are considered retryable. That captures an important design choice: failures after the initialize response has been received are not retried.

The second test, `retryable_streamable_http_error_includes_remote_body_stream_failure`, exercises the lower-level streamable HTTP classifier across several concrete error shapes. It verifies that plain HTTP request failures, JSON-RPC internal errors wrapping `http/request failed: ...`, protocol errors indicating a failed HTTP response stream, and HTTP 502 unexpected responses are retryable, while a protocol sequencing error and HTTP 400 are not. This ensures the classifier distinguishes transient transport disruption from semantic or malformed-response failures.

The helper `retryable_initialize_error` builds the exact dynamic transport error shape rmcp uses by wrapping a `StreamableHttpError::Client(StreamableHttpClientAdapterError::HttpRequest(...))` inside `DynamicTransportError::from_parts`. That keeps the tests aligned with the downcasting logic used by the production retry code.

#### Function details

##### `retryable_initialize_error_includes_initialized_notification_context`  (lines 13–26)

```
fn retryable_initialize_error_includes_initialized_notification_context()
```

**Purpose**: Verifies which handshake contexts are treated as retryable by the initialize-error classifier. It documents that retryability applies to sending initialize and initialized, but not to receiving the initialize response.

**Data flow**: Builds an array of context strings, maps each through `RmcpClient::is_retryable_client_initialize_error(&retryable_initialize_error(context))`, and asserts the resulting boolean array equals `[true, true, false]`.

**Call relations**: Directly exercises `RmcpClient::is_retryable_client_initialize_error` using the synthetic error helper below.

*Call graph*: 1 external calls (assert_eq!).


##### `retryable_streamable_http_error_includes_remote_body_stream_failure`  (lines 29–59)

```
fn retryable_streamable_http_error_includes_remote_body_stream_failure()
```

**Purpose**: Checks the streamable HTTP retry classifier across several concrete transient and non-transient error variants. It specifically covers remote body-stream failure messages and HTTP status parsing.

**Data flow**: Constructs an array of `StreamableHttpError` values representing request failures, wrapped server/protocol failures, and unexpected HTTP responses, maps them through `RmcpClient::is_retryable_streamable_http_error`, and asserts the resulting booleans match the expected retryability pattern.

**Call relations**: Directly exercises the low-level classifier in `streamable_http_retry.rs`.

*Call graph*: 6 external calls (Client, UnexpectedServerResponse, assert_eq!, HttpRequest, Protocol, HttpRequest).


##### `retryable_initialize_error`  (lines 61–74)

```
fn retryable_initialize_error(context: &'static str) -> rmcp::service::ClientInitializeError
```

**Purpose**: Builds a synthetic `ClientInitializeError::TransportError` carrying a retryable streamable HTTP request failure. It mirrors the dynamic transport error shape used in production so downcasting logic is exercised realistically.

**Data flow**: Takes a handshake `context` string → constructs `StreamableHttpError::Client(StreamableHttpClientAdapterError::HttpRequest(ExecServerError::HttpRequest(...)))`, wraps it in `DynamicTransportError::from_parts("streamable_http", TypeId::of::<()>(), Box::new(...))`, and returns `rmcp::service::ClientInitializeError::TransportError { error, context: context.into() }`.

**Call relations**: Used by `retryable_initialize_error_includes_initialized_notification_context` to feed realistic synthetic errors into the classifier.

*Call graph*: 5 external calls (new, from_parts, Client, HttpRequest, HttpRequest).


### `rmcp-client/tests/streamable_http_oauth_startup.rs`

`test` · `integration test execution during HTTP client startup and auth probing`

This integration test file targets the Streamable HTTP transport's interaction with persisted OAuth credentials. It defines constants for server names, token values, and synthetic URLs, then uses two patterns to isolate credential storage side effects: helper child tests marked `#[ignore]`, and parent tests that spawn the current test binary with a temporary `CODEX_HOME`. That design avoids mutating the parent test runner's environment while still exercising the real credential-loading code path, which resolves storage location from process environment.

`refreshes_expired_persisted_token_before_initialize` stands up a `wiremock::MockServer` with three expectations: OAuth metadata discovery, a refresh-token exchange, and authenticated `/mcp` POSTs whose `Authorization` header must contain the refreshed access token. It then launches the ignored child test `oauth_startup_child`, passing `CODEX_HOME` and the mock server URL. The child persists an expired token plus refresh token, constructs a Streamable HTTP `RmcpClient` without a direct bearer token, and initializes it; success proves startup refreshed persisted credentials before sending `initialize`.

The second parent/child pair checks `determine_streamable_http_auth_status`. The child writes three credential variants to file storage: expired without refresh token (expected `NotLoggedIn`), unexpired access token (expected `OAuth`), and expired but refreshable token (also expected `OAuth`). The small `auth_status` helper centralizes the call to `determine_streamable_http_auth_status` with file-backed storage and default keyring backend.

#### Function details

##### `refreshes_expired_persisted_token_before_initialize`  (lines 47–122)

```
async fn refreshes_expired_persisted_token_before_initialize() -> anyhow::Result<()>
```

**Purpose**: Sets up a mock OAuth-capable MCP server and verifies, via a spawned child test process, that an expired persisted token is refreshed before the first `initialize` request is sent. The mock expectations ensure the refreshed bearer token is actually used on the MCP POSTs.

**Data flow**: It starts a `MockServer`, mounts a GET handler for OAuth metadata discovery, a POST handler for `/oauth/token` that expects a refresh-token grant and returns a new access token, and a POST handler for `/mcp` that requires `Authorization: Bearer refreshed-access-token` and returns valid JSON-RPC responses for `initialize` and `notifications/initialized`. It creates a temporary `CODEX_HOME`, computes the server URL, spawns the current test executable with arguments selecting the ignored `oauth_startup_child` test and environment variables `CODEX_HOME` and `MCP_TEST_OAUTH_STARTUP_SERVER_URL`, awaits its exit status, asserts success, and finally verifies the mock server expectations.

**Call relations**: This is the parent orchestration test for `oauth_startup_child`. It does not itself create an RMCP client; instead it prepares the external HTTP/OAuth environment and delegates the credential-writing and client-startup path to the child process.

*Call graph*: 13 external calls (given, start, new, new, assert!, new, format!, json!, current_exe, body_string_contains (+3 more)).


##### `reports_auth_status_for_persisted_credentials`  (lines 125–144)

```
async fn reports_auth_status_for_persisted_credentials() -> anyhow::Result<()>
```

**Purpose**: Runs the ignored child test that writes several persisted credential states and checks the reported auth status for each. It isolates file-backed credential storage under a temporary `CODEX_HOME`.

**Data flow**: It creates a `TempDir`, spawns the current test executable with arguments selecting `persisted_credentials_auth_status_child` plus `--ignored`, sets `CODEX_HOME` in the child environment, waits for completion, and asserts the child exited successfully.

**Call relations**: This is the parent wrapper around `persisted_credentials_auth_status_child`, used to keep credential-store side effects out of the main test process.

*Call graph*: 4 external calls (new, assert!, new, current_exe).


##### `persisted_credentials_auth_status_child`  (lines 148–220)

```
async fn persisted_credentials_auth_status_child() -> anyhow::Result<()>
```

**Purpose**: Writes three persisted OAuth token records representing unrefreshable expired, unexpired, and refreshable expired credentials, then checks the auth status returned for each server URL. It codifies the policy for when persisted credentials count as logged in.

**Data flow**: It first constructs an `OAuthTokenResponse` with an expired access token and no refresh token, wraps it in `StoredOAuthTokens` for `UNREFRESHABLE_SERVER_URL`, and persists it with `save_oauth_tokens`; then it calls `auth_status` and asserts `McpAuthStatus::NotLoggedIn`. Next it computes the current Unix time in milliseconds, creates an unexpired token record for `UNEXPIRED_SERVER_URL` with `expires_at` set 60 seconds in the future, saves it, calls `auth_status`, and asserts `McpAuthStatus::OAuth`. Finally it creates an expired token response with a refresh token for `REFRESHABLE_SERVER_URL`, saves it, calls `auth_status`, and again asserts `McpAuthStatus::OAuth`. It returns `Ok(())` after all three cases pass.

**Call relations**: This ignored child test is launched by `reports_auth_status_for_persisted_credentials`. It delegates the actual status computation to `auth_status`, while directly exercising `save_oauth_tokens` and the persisted-credential interpretation logic.

*Call graph*: calls 2 internal fn (default, auth_status); 8 external calls (new, new, new, now, default, assert_eq!, save_oauth_tokens, new).


##### `auth_status`  (lines 222–233)

```
async fn auth_status(server_url: &str) -> anyhow::Result<McpAuthStatus>
```

**Purpose**: Thin helper that queries Streamable HTTP auth status for a given server URL using file-backed OAuth credential storage. It standardizes the test inputs so the child test can focus on token-state setup.

**Data flow**: It takes `server_url: &str`, calls `determine_streamable_http_auth_status` with the fixed `SERVER_NAME`, no bearer-token env var, no static or env headers, `OAuthCredentialsStoreMode::File`, and `AuthKeyringBackendKind::default()`, then awaits and returns the resulting `McpAuthStatus`.

**Call relations**: Only `persisted_credentials_auth_status_child` calls this helper, using it repeatedly after writing different token records.

*Call graph*: calls 1 internal fn (default); called by 1 (persisted_credentials_auth_status_child); 1 external calls (determine_streamable_http_auth_status).


##### `oauth_startup_child`  (lines 237–281)

```
async fn oauth_startup_child() -> anyhow::Result<()>
```

**Purpose**: Persists an expired OAuth access token with a valid refresh token, creates a Streamable HTTP RMCP client without a direct bearer token, and initializes it. Success demonstrates that startup refreshes persisted credentials before the first MCP request.

**Data flow**: It reads the mock server URL from `MCP_TEST_OAUTH_STARTUP_SERVER_URL`, constructs an `OAuthTokenResponse` with the expired access token, attaches the refresh token and an `expires_in` duration, wraps it in `StoredOAuthTokens` with `expires_at: Some(0)`, and saves it via `save_oauth_tokens`. It then creates an `RmcpClient` using `RmcpClient::new_streamable_http_client` with `bearer_token` set to `None`, file-backed OAuth storage, default keyring backend, and `Environment::default_for_tests().get_http_client()`, and finally calls `initialize_client(&client).await`.

**Call relations**: This ignored child test is spawned by `refreshes_expired_persisted_token_before_initialize`. It relies on the shared `initialize_client` helper from `streamable_http_test_support` to perform the actual RMCP handshake after transport creation.

*Call graph*: calls 4 internal fn (default, default_for_tests, new_streamable_http_client, initialize_client); 8 external calls (new, from_secs, new, new, default, save_oauth_tokens, new, var).


### `rmcp-client/tests/streamable_http_recovery.rs`

`test` · `integration test execution during HTTP transport error handling`

This integration test suite validates the Streamable HTTP client's resilience rules. The custom `FailFirstInitializeHttpClient` wraps an underlying `HttpClient` and intercepts only streaming requests whose JSON body is a POST with method `initialize`. It tracks initialize attempts with `AtomicUsize`, can be configured to fail the next initialize once, and returns a synthetic `ExecServerError::Server` carrying a JSON-RPC internal error code and a 'simulated no response' message. Non-initialize requests and non-streaming requests are delegated unchanged.

The helper `is_initialize_post` identifies initialize traffic by checking the HTTP method and parsing the request body as JSON to inspect the `method` field. The tests then combine this wrapper with support helpers that arm the test HTTP server to fail specific control points: initialize POSTs, initialized notifications, or session POSTs, either with raw HTTP statuses or JSON-RPC error bodies.

Coverage is broad and concrete: initialize retries on simulated no-response and transient 502s; initialized-notification retries; list-tools retries after transient session failures; 404 session-expiry recovery that reinitializes and retries once; recovery paths where the reinitialize itself transiently fails once; and negative cases where 401, 403 insufficient-scope challenges, repeated 404s, or generic 500s must not trigger unlimited recovery. Assertions check both successful round-trip results and exact error-shape expectations such as presence of `401`, `500`, or 'Insufficient scope' in the surfaced error.

#### Function details

##### `FailFirstInitializeHttpClient::new`  (lines 42–48)

```
fn new(inner: Arc<dyn HttpClient>, failures_remaining: usize) -> Self
```

**Purpose**: Constructs a fault-injecting HTTP client wrapper around another `HttpClient`. It initializes shared counters for remaining forced failures and observed initialize attempts.

**Data flow**: It takes `inner: Arc<dyn HttpClient>` and `failures_remaining: usize`, stores the inner client, wraps the failure count in `Arc<AtomicUsize>`, initializes `initialize_attempts` to zero in another `Arc<AtomicUsize>`, and returns the new wrapper struct.

**Call relations**: Tests that need to simulate a dropped or failed initialize request create this wrapper before passing it into `create_client_with_http_client`.

*Call graph*: called by 2 (streamable_http_initialize_retries_remote_no_response_error, streamable_http_session_recovery_retries_initialize_failure); 2 external calls (new, new).


##### `FailFirstInitializeHttpClient::initialize_attempts`  (lines 50–52)

```
fn initialize_attempts(&self) -> usize
```

**Purpose**: Reports how many initialize POSTs the wrapper has observed so far. Tests use it to verify retry counts.

**Data flow**: It reads `self.initialize_attempts` with `load(Ordering::SeqCst)` and returns the resulting `usize`.

**Call relations**: The retry-focused tests call this after exercising the client to confirm whether initialization happened once, twice, or three times.


##### `FailFirstInitializeHttpClient::fail_next_initialize`  (lines 54–56)

```
fn fail_next_initialize(&self)
```

**Purpose**: Arms the wrapper to fail exactly the next initialize request. It is used after a successful warmup to simulate a transient failure during session recovery.

**Data flow**: It writes `1` into `self.failures_remaining` using `store(Ordering::SeqCst)`. It returns no value.

**Call relations**: The session-recovery test invokes this between a forced 404 session expiry and the next tool call so the recovery reinitialize path experiences one injected failure.


##### `FailFirstInitializeHttpClient::http_request`  (lines 60–65)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Pass-through implementation of the non-streaming HTTP request method for the wrapped client. It does not inject any failures on this path.

**Data flow**: It takes `HttpRequestParams`, forwards them directly to `self.inner.http_request(params)`, and returns the boxed future from the inner client unchanged.

**Call relations**: This satisfies the `HttpClient` trait while keeping fault injection limited to `http_request_stream`, where the Streamable HTTP transport performs initialize/session traffic.


##### `FailFirstInitializeHttpClient::http_request_stream`  (lines 67–89)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Intercepts streaming HTTP requests and injects a synthetic failure on initialize POSTs while delegating all other traffic to the wrapped client. It also counts initialize attempts for later assertions.

**Data flow**: It takes `HttpRequestParams`, clones the inner client and atomic counters into the async block, checks `is_initialize_post(&params)`, increments `initialize_attempts` when true, and if `failures_remaining.swap(0, Ordering::SeqCst) > 0` returns `Err(ExecServerError::Server { code: -32603, message: SIMULATED_NO_RESPONSE_MESSAGE.to_string() })`. Otherwise it awaits `inner.http_request_stream(params)` and returns that result.

**Call relations**: The wrapper's retry tests rely on this method to simulate a one-off initialize transport failure without modifying the server. It delegates request classification to `is_initialize_post`.

*Call graph*: calls 1 internal fn (is_initialize_post); 1 external calls (clone).


##### `is_initialize_post`  (lines 92–104)

```
fn is_initialize_post(params: &HttpRequestParams) -> bool
```

**Purpose**: Recognizes whether an HTTP request is a POST carrying a JSON-RPC `initialize` method call. This lets the fault-injecting client target only initialization traffic.

**Data flow**: It takes `&HttpRequestParams`, checks `params.method.eq_ignore_ascii_case("POST")`, then inspects `params.body`, attempts to parse the bytes as `serde_json::Value`, extracts `body["method"]` as a string, compares it to `"initialize"`, and returns a boolean. Any missing body or parse failure yields `false`.

**Call relations**: Only `FailFirstInitializeHttpClient::http_request_stream` calls this helper before deciding whether to increment counters and inject an error.

*Call graph*: called by 1 (http_request_stream).


##### `streamable_http_initialize_retries_remote_no_response_error`  (lines 107–121)

```
async fn streamable_http_initialize_retries_remote_no_response_error() -> anyhow::Result<()>
```

**Purpose**: Verifies that a simulated no-response initialize failure from the HTTP client causes the Streamable HTTP transport to retry initialization and still complete a tool call successfully.

**Data flow**: It spawns the test HTTP server, constructs `FailFirstInitializeHttpClient` around the default test HTTP client with one forced failure, creates an RMCP client using `create_client_with_http_client`, calls the echo tool with message `after-init-retry`, then asserts that `initialize_attempts()` is `2` and that the tool result matches `expected_echo_result("after-init-retry")`.

**Call relations**: This top-level test combines the custom wrapper with shared client/server helpers to validate retry-on-transport-failure during initial session establishment.

*Call graph*: calls 5 internal fn (default_for_tests, new, call_echo_tool, create_client_with_http_client, spawn_streamable_http_server); 2 external calls (new, assert_eq!).


##### `streamable_http_initialize_retries_transient_http_status`  (lines 124–135)

```
async fn streamable_http_initialize_retries_transient_http_status() -> anyhow::Result<()>
```

**Purpose**: Checks that a transient HTTP 502 on the initialize POST is retried automatically and does not prevent later tool calls.

**Data flow**: It spawns the test server, arms one initialize POST failure with status 502 via `arm_initialize_post_failure`, creates a client with `create_client`, calls the echo tool with `after-status-retry`, and asserts the returned `CallToolResult` equals the expected echo result.

**Call relations**: This test uses server-side fault injection rather than a custom HTTP client to exercise the initialize retry policy.

*Call graph*: calls 4 internal fn (arm_initialize_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_initialize_retries_json_rpc_transient_status`  (lines 138–149)

```
async fn streamable_http_initialize_retries_json_rpc_transient_status() -> anyhow::Result<()>
```

**Purpose**: Verifies retry behavior when the initialize POST receives a transient HTTP status carrying a JSON-RPC error body. The transport should still recover and proceed.

**Data flow**: It spawns the server, arms one initialize failure with status 502 and a JSON-RPC error body via `arm_initialize_post_json_rpc_failure`, creates a client, calls the echo tool with `after-json-status-retry`, and asserts the result matches the expected echo payload.

**Call relations**: This complements the plain-status initialize retry test by proving the retry logic is not confused by an application/json JSON-RPC error response.

*Call graph*: calls 4 internal fn (arm_initialize_post_json_rpc_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_retries_initialized_notification_status`  (lines 152–169)

```
async fn streamable_http_retries_initialized_notification_status() -> anyhow::Result<()>
```

**Purpose**: Checks that a transient failure on the post-initialize `notifications/initialized` request is retried and does not leave the session unusable.

**Data flow**: It spawns the server, arms one initialized-notification failure with status 502 and JSON-RPC body via `arm_initialized_notification_post_json_rpc_failure`, creates a client, calls the echo tool with `after-notification-status-retry`, and asserts the result equals the expected echo result.

**Call relations**: This test targets the second phase of startup after `initialize`, ensuring the transport retries notification delivery as part of session establishment.

*Call graph*: calls 4 internal fn (arm_initialized_notification_post_json_rpc_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_tools_list_retries_transient_http_status`  (lines 172–200)

```
async fn streamable_http_tools_list_retries_transient_http_status() -> anyhow::Result<()>
```

**Purpose**: Verifies that a transient HTTP 502 on a session POST during `list_tools` is retried and yields the same result as a healthy request.

**Data flow**: It spawns the server, creates a client, performs an initial `list_tools` call with a 5-second timeout to capture the expected result, arms one session POST failure with status 502 via `arm_session_post_failure`, performs `list_tools` again with the same timeout, and asserts the second result equals the first.

**Call relations**: This test exercises retry behavior on ordinary session traffic after initialization, using `list_tools` as a deterministic read operation.

*Call graph*: calls 3 internal fn (arm_session_post_failure, create_client, spawn_streamable_http_server); 2 external calls (from_secs, assert_eq!).


##### `streamable_http_tools_list_retries_json_rpc_transient_status`  (lines 203–225)

```
async fn streamable_http_tools_list_retries_json_rpc_transient_status() -> anyhow::Result<()>
```

**Purpose**: Checks that `list_tools` also retries when the transient session failure is returned as a JSON-RPC error body rather than a plain status-only response.

**Data flow**: It spawns the server, creates a client, captures the expected `list_tools` result, arms one session POST JSON-RPC failure with status 502 via `arm_session_post_json_rpc_failure`, repeats `list_tools`, and asserts equality with the expected result.

**Call relations**: This is the JSON-RPC-body counterpart to the previous `list_tools` retry test.

*Call graph*: calls 3 internal fn (arm_session_post_json_rpc_failure, create_client, spawn_streamable_http_server); 2 external calls (from_secs, assert_eq!).


##### `streamable_http_404_session_expiry_recovers_and_retries_once`  (lines 228–247)

```
async fn streamable_http_404_session_expiry_recovers_and_retries_once() -> anyhow::Result<()>
```

**Purpose**: Verifies that a single 404 on session traffic is treated as session expiry, causing recovery and one retry that succeeds. It proves the client can transparently re-establish the session.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call and asserts success, arms one session POST failure with status 404, performs another echo call with message `recovered`, and asserts the recovered result matches the expected echo payload.

**Call relations**: This test covers the positive session-expiry recovery path after a previously healthy session.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_session_recovery_retries_initialize_failure`  (lines 250–275)

```
async fn streamable_http_session_recovery_retries_initialize_failure() -> anyhow::Result<()>
```

**Purpose**: Checks the nested case where session-expiry recovery triggers reinitialization and that reinitialize itself fails once transiently before succeeding. The transport should still recover and complete the original tool call.

**Data flow**: It spawns the server, wraps the default HTTP client in `FailFirstInitializeHttpClient` with zero initial failures, creates a client with that wrapper, performs a warmup echo call, arms one session POST 404 failure, calls `fail_next_initialize()` on the wrapper, then performs another echo call with `recovered-after-retry`. It asserts `initialize_attempts()` is `3` total and that the recovered call returns the expected echo result.

**Call relations**: This test combines server-side 404 session-expiry injection with client-side initialize failure injection to validate retry behavior across both recovery layers.

*Call graph*: calls 6 internal fn (default_for_tests, new, arm_session_post_failure, call_echo_tool, create_client_with_http_client, spawn_streamable_http_server); 2 external calls (new, assert_eq!).


##### `streamable_http_401_does_not_trigger_recovery`  (lines 278–302)

```
async fn streamable_http_401_does_not_trigger_recovery() -> anyhow::Result<()>
```

**Purpose**: Ensures that unauthorized responses are surfaced as errors and do not trigger session recovery or hidden retries that would mask authentication problems.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call, arms two session POST failures with status 401, then performs two echo calls that each unwrap to errors. It asserts both error strings contain `401`.

**Call relations**: This negative test distinguishes authentication failures from recoverable session-expiry failures.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_403_scope_challenge_returns_insufficient_scope`  (lines 305–328)

```
async fn streamable_http_403_scope_challenge_returns_insufficient_scope() -> anyhow::Result<()>
```

**Purpose**: Verifies that a 403 response carrying a Bearer `insufficient_scope` challenge is translated into an insufficient-scope transport error rather than generic recovery behavior.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call, arms one session POST failure with status 403 and a `WWW-Authenticate` header containing `Bearer error="insufficient_scope"`, then performs an echo call expected to fail. It asserts the resulting error string contains `Insufficient scope`.

**Call relations**: This test targets the transport's parsing of Bearer challenges on forbidden responses.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_403_finds_bearer_challenge_in_later_header_value`  (lines 331–357)

```
async fn streamable_http_403_finds_bearer_challenge_in_later_header_value() -> anyhow::Result<()>
```

**Purpose**: Checks that Bearer insufficient-scope parsing works even when the relevant challenge is not the first `WWW-Authenticate` header value. This guards against simplistic first-header-only parsing.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call, arms one session POST failure with status 403 and two `WWW-Authenticate` values (`Basic ...` followed by `Bearer error="insufficient_scope" ...`), then performs an echo call expected to fail. It asserts the error string contains `Insufficient scope`.

**Call relations**: This complements the previous 403 test by covering multi-header ordering behavior.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_404_recovery_only_retries_once`  (lines 360–386)

```
async fn streamable_http_404_recovery_only_retries_once() -> anyhow::Result<()>
```

**Purpose**: Verifies that 404 session-expiry recovery is bounded to a single retry attempt. Repeated 404s should surface an error, but the client should remain usable for later requests.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call, arms two consecutive session POST failures with status 404, then performs an echo call expected to fail and asserts the error mentions `404` or `session expired`. After that failure, it performs another echo call with `after-double-404` and asserts it succeeds with the expected result.

**Call relations**: This test checks both the retry bound and the client's ability to recover on subsequent operations after a failed one-shot recovery.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_non_session_failure_does_not_trigger_recovery`  (lines 389–413)

```
async fn streamable_http_non_session_failure_does_not_trigger_recovery() -> anyhow::Result<()>
```

**Purpose**: Ensures generic server errors such as HTTP 500 are surfaced directly and do not trigger session recovery logic. This prevents inappropriate retries on non-session faults.

**Data flow**: It spawns the server, creates a client, performs a warmup echo call, arms two session POST failures with status 500, then performs two echo calls that each fail. It asserts both error strings contain `500`.

**Call relations**: This negative test complements the 404 recovery cases by showing that only recognized session-expiry conditions trigger reinitialization.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


### `network-proxy/src/mitm_tests.rs`

`test` · `test execution`

This test module targets the policy logic in `mitm.rs` without needing to stand up full TLS interception. It defines two small fixtures: `github_write_hook`, which mirrors a realistic GitHub write hook that strips and reinjects `authorization`, and `policy_ctx`, which constructs the internal `MitmPolicyContext` used by `evaluate_mitm_policy`. The async tests then call `mitm_blocking_response` directly to observe whether a decrypted HTTPS request would be blocked and what telemetry would be recorded.

The scenarios cover several subtle invariants. Limited mode still blocks disallowed methods even after CONNECT succeeds, and the blocked request record must include method, host, and port. Host mismatch between the CONNECT target and inner request is rejected as `400 Bad Request` but intentionally does not create blocked-request telemetry. Local/private target checks are re-run on inner HTTPS requests to defend against DNS rebinding after CONNECT. Hook behavior is also tested carefully: in full mode, a matching hooked write request is allowed; in limited mode, the same matching hook does not override the method clamp; and for a hooked host in full mode, a request that misses all hooks is blocked with `REASON_MITM_HOOK_DENIED` and recorded. The final unit test verifies that `apply_mitm_hook_actions` actually replaces an existing `authorization` header while preserving unrelated headers.

#### Function details

##### `github_write_hook`  (lines 19–37)

```
fn github_write_hook() -> crate::mitm_hook::MitmHookConfig
```

**Purpose**: Builds a reusable MITM hook fixture for GitHub write operations that strips and reinjects `authorization`.

**Data flow**: It returns a `crate::mitm_hook::MitmHookConfig` targeting `api.github.com`, matching `POST` and `PUT` under `/repos/openai/`, and configuring one injected `authorization` header sourced from `CODEX_GITHUB_TOKEN` with prefix `Bearer `.

**Call relations**: Several MITM policy tests call this fixture helper before customizing secret source or actions.

*Call graph*: called by 3 (mitm_policy_allows_matching_hooked_write_in_full_mode, mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode, mitm_policy_blocks_matching_hooked_write_in_limited_mode); 2 external calls (default, vec!).


##### `policy_ctx`  (lines 39–51)

```
fn policy_ctx(
    app_state: Arc<NetworkProxyState>,
    mode: NetworkMode,
    target_host: &str,
    target_port: u16,
) -> MitmPolicyContext
```

**Purpose**: Constructs the internal `MitmPolicyContext` fixture used to evaluate MITM policy in isolation.

**Data flow**: It takes shared `NetworkProxyState`, a `NetworkMode`, `target_host`, and `target_port`, then returns `MitmPolicyContext` populated with those values.

**Call relations**: All policy tests use this helper to avoid repeating context construction boilerplate.

*Call graph*: called by 6 (mitm_policy_allows_matching_hooked_write_in_full_mode, mitm_policy_blocks_disallowed_method_and_records_telemetry, mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode, mitm_policy_blocks_matching_hooked_write_in_limited_mode, mitm_policy_rechecks_local_private_target_after_connect, mitm_policy_rejects_host_mismatch).


##### `mitm_policy_blocks_disallowed_method_and_records_telemetry`  (lines 54–90)

```
async fn mitm_policy_blocks_disallowed_method_and_records_telemetry()
```

**Purpose**: Verifies that limited-mode MITM blocks a disallowed inner HTTPS method and records the blocked request details.

**Data flow**: It builds proxy state with `example.com` allowlisted, constructs a limited-mode policy context for `example.com:443`, builds a POST request with `Host: example.com`, calls `mitm_blocking_response`, unwraps the blocking response, asserts `403` and `blocked-by-method-policy`, drains blocked telemetry from state, and asserts one record with reason `REASON_METHOD_NOT_ALLOWED`, method `POST`, host `example.com`, and port `443`.

**Call relations**: This test exercises the method-policy branch in `evaluate_mitm_policy` and the associated telemetry recording.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_rejects_host_mismatch`  (lines 93–119)

```
async fn mitm_policy_rejects_host_mismatch()
```

**Purpose**: Verifies that an inner HTTPS request whose host differs from the CONNECT target is rejected as a bad request without recording blocked telemetry.

**Data flow**: It builds state with `example.com` allowlisted, constructs a full-mode policy context for `example.com:443`, builds a GET request with `Host: evil.example`, calls `mitm_blocking_response`, unwraps the blocking response, asserts `400 Bad Request`, and asserts the blocked snapshot remains empty.

**Call relations**: This covers the host-mismatch defense in `evaluate_mitm_policy` and confirms it is treated as malformed traffic rather than a policy block.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_rechecks_local_private_target_after_connect`  (lines 122–154)

```
async fn mitm_policy_rechecks_local_private_target_after_connect()
```

**Purpose**: Verifies that MITM rechecks local/private target policy after CONNECT and blocks such inner requests when local binding is disabled.

**Data flow**: It builds state with `allow_local_binding = false`, constructs a full-mode policy context for target `10.0.0.1:443`, builds a GET request with `Host: 10.0.0.1`, calls `mitm_blocking_response`, unwraps the blocking response, asserts `403`, drains blocked telemetry, and asserts one record with reason `REASON_NOT_ALLOWED_LOCAL`, host `10.0.0.1`, and port `443`.

**Call relations**: This test covers the DNS-rebinding defense branch in `evaluate_mitm_policy`.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_allows_matching_hooked_write_in_full_mode`  (lines 157–192)

```
async fn mitm_policy_allows_matching_hooked_write_in_full_mode()
```

**Purpose**: Verifies that in full mode, a request matching a configured MITM hook is allowed and does not produce blocked telemetry.

**Data flow**: It writes a temporary secret file, builds a GitHub hook using that file, constructs network settings with MITM enabled, the hook installed, mode `Full`, and `api.github.com` allowlisted, builds state and policy context, creates a matching POST request, calls `mitm_blocking_response`, and asserts the result is `None` and blocked telemetry is empty.

**Call relations**: This covers the successful hook-match path in `evaluate_mitm_policy` when method policy also allows the request.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 8 external calls (new, new, assert!, assert_eq!, builder, empty, write, vec!).


##### `mitm_policy_blocks_matching_hooked_write_in_limited_mode`  (lines 195–236)

```
async fn mitm_policy_blocks_matching_hooked_write_in_limited_mode()
```

**Purpose**: Verifies that a matching MITM hook does not override limited-mode method restrictions.

**Data flow**: It builds a GitHub hook with no injected headers, constructs limited-mode MITM-enabled state with `api.github.com` allowlisted, creates a matching POST request, calls `mitm_blocking_response`, unwraps the blocking response, asserts `403 blocked-by-method-policy`, drains blocked telemetry, and checks reason, method, host, and port.

**Call relations**: This test demonstrates the ordering in `evaluate_mitm_policy`: hook matching may succeed, but method policy still runs afterward and can block.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode`  (lines 239–285)

```
async fn mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode()
```

**Purpose**: Verifies that for a host with configured hooks, a request that misses all hooks is denied even in full mode and records MITM-hook telemetry.

**Data flow**: It writes a temporary secret file, builds a GitHub hook using that file, constructs full-mode MITM-enabled state with `api.github.com` allowlisted, creates a GET request that targets the hooked host but does not satisfy the hook matcher, calls `mitm_blocking_response`, unwraps the blocking response, asserts `403 blocked-by-mitm-hook`, drains blocked telemetry, and checks reason `REASON_MITM_HOOK_DENIED`, method `GET`, host, and port.

**Call relations**: This covers the `HookEvaluation::HookedHostNoMatch` branch in `evaluate_mitm_policy`.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 7 external calls (new, new, assert_eq!, builder, empty, write, vec!).


##### `apply_mitm_hook_actions_replaces_authorization_header`  (lines 288–320)

```
fn apply_mitm_hook_actions_replaces_authorization_header()
```

**Purpose**: Verifies that MITM hook actions remove an existing authorization header and replace it with the injected secret-backed value while leaving unrelated headers untouched.

**Data flow**: It builds a `HeaderMap` containing `authorization` and `x-request-id`, constructs `MitmHookActions` with `authorization` in `strip_request_headers` and one injected `authorization` header sourced from a file path, calls `apply_mitm_hook_actions`, and asserts the final `authorization` value is the injected secret token while `x-request-id` remains unchanged.

**Call relations**: This is a focused unit test for the header-mutation helper used by `forward_request`.

*Call graph*: 5 external calls (new, from_static, from_static, assert_eq!, vec!).


### `uds/src/lib_tests.rs`

`test` · `test execution`

This file is a focused async test suite for the UDS library exposed through `super::*`. It creates isolated temporary directories with `tempfile::TempDir` and then probes concrete filesystem and socket behavior rather than mocking anything. Two tests cover socket-directory setup: one confirms a missing directory is created, and on Unix another confirms an already-existing directory has its mode forced to `0o700`, even if it started as `0o755` or `0o600`. Two more tests validate stale-socket-path classification: a regular file must not be treated as stale, while a path currently occupied by a successfully bound `UnixListener` is expected to be recognized by `is_stale_socket_path`. Because some environments disallow Unix socket binding, those tests explicitly treat `PermissionDenied` as a skip and print a message instead of failing. The final test performs a real client/server round trip using `UnixListener::bind`, `accept`, `UnixStream::connect`, `AsyncReadExt::read_exact`, and `AsyncWriteExt::write_all`. It spawns a server task, verifies the exact request bytes `b"request"`, writes back `b"response"`, and then checks the client receives the exact response before joining the task. Together these tests pin down both filesystem invariants and transport correctness.

#### Function details

##### `prepare_private_socket_directory_creates_directory`  (lines 10–19)

```
async fn prepare_private_socket_directory_creates_directory()
```

**Purpose**: Verifies that preparing a private socket directory creates the target directory when it does not already exist. It checks the observable filesystem result rather than internal implementation details.

**Data flow**: Creates a temporary parent directory, derives a child path named `app-server-control`, passes that path to `prepare_private_socket_directory`, then reads filesystem state with `is_dir()`. It returns no value; success is expressed by the assertion that the directory now exists.

**Call relations**: This is a standalone Tokio test invoked by the test runner. It drives the parent module's directory-preparation API in the simplest creation case and does not delegate beyond standard tempdir setup and the final assertion.

*Call graph*: 2 external calls (assert!, new).


##### `prepare_private_socket_directory_sets_existing_permissions_to_owner_only`  (lines 23–43)

```
async fn prepare_private_socket_directory_sets_existing_permissions_to_owner_only()
```

**Purpose**: Checks that an existing socket directory is normalized to owner-only permissions on Unix. It specifically proves the function overwrites both permissive and non-directory-like starting modes with exact `0o700` bits.

**Data flow**: For each initial mode in `[0o755, 0o600]`, it creates a directory, applies that mode via `PermissionsExt::from_mode`, calls `prepare_private_socket_directory`, then reads metadata back and masks permission bits with `0o777`. It returns no value; the assertion requires the resulting mode to equal `0o700`.

**Call relations**: The test runner invokes this Unix-only test. It exercises the branch where the target already exists and confirms the parent module's function performs permission correction rather than leaving prior permissions untouched.

*Call graph*: 7 external calls (assert_eq!, from_mode, format!, create_dir, metadata, set_permissions, new).


##### `regular_file_path_is_not_stale_socket_path`  (lines 47–57)

```
async fn regular_file_path_is_not_stale_socket_path()
```

**Purpose**: Confirms that stale-socket detection does not misclassify an ordinary file as a stale socket endpoint. This protects cleanup logic from deleting unrelated files.

**Data flow**: Creates a temp directory, writes byte content to a regular file path, passes that path to `is_stale_socket_path`, and asserts the returned boolean is false. It writes the file to disk first, then reads only the boolean result from the async check.

**Call relations**: This standalone async test is called by the test harness. It targets the negative classification path of `is_stale_socket_path`, contrasting with the listener-bound positive case in the neighboring test.

*Call graph*: 3 external calls (assert!, write, new).


##### `bound_listener_path_is_stale_socket_path`  (lines 60–77)

```
async fn bound_listener_path_is_stale_socket_path()
```

**Purpose**: Verifies that a path occupied by a successfully bound Unix listener is recognized by `is_stale_socket_path`. It also tolerates environments where socket binding is forbidden by skipping on permission errors.

**Data flow**: Builds a temp socket path, attempts `UnixListener::bind`, branches on the result, and either returns early after printing a skip message for `PermissionDenied`, panics for other bind failures, or keeps the listener alive while calling `is_stale_socket_path` on the same path. The test returns no value; success is the asserted true result.

**Call relations**: The test harness invokes this Tokio test. It drives real socket binding before calling the stale-path checker so the checker sees an actual socket filesystem entry, and its early-return skip path prevents false negatives in restricted CI environments.

*Call graph*: calls 1 internal fn (bind); 4 external calls (assert!, eprintln!, panic!, new).


##### `stream_round_trips_data_between_listener_and_client`  (lines 80–121)

```
async fn stream_round_trips_data_between_listener_and_client()
```

**Purpose**: Performs an end-to-end transport test proving that the library's exported `UnixListener` and `UnixStream` types can exchange exact byte sequences over a socket path. It validates both connection establishment and bidirectional I/O.

**Data flow**: Creates a temp socket path, binds a listener, and on success spawns a server task that accepts one connection, reads exactly 7 bytes into `request`, asserts they equal `b"request"`, and writes `b"response"`. The client side connects to the same path, writes `b"request"`, reads exactly 8 bytes into `response`, asserts equality with `b"response"`, then awaits the server task. On `PermissionDenied` during bind it prints and returns early; other bind errors panic.

**Call relations**: This Tokio test is run by the test framework and is the most integrated test in the file. It orchestrates both sides of the socket conversation, using a spawned server future and a client in the main test body to prove the exported stream/listener API works under realistic sequencing.

*Call graph*: calls 2 internal fn (bind, connect); 5 external calls (assert_eq!, eprintln!, panic!, new, spawn).


### `utils/rustls-provider/tests/provider.rs`

`test` · `test execution`

This file contains a single integration test for the normal initialization case. It calls `ensure_rustls_crypto_provider`, then retrieves the process-global rustls `CryptoProvider` and asserts that the provider's `signature_verification_algorithms.supported_schemes()` includes `rustls::SignatureScheme::ECDSA_NISTP521_SHA512`.

The test is intentionally direct: it checks the externally visible postcondition of the library rather than internal implementation details. That makes it a regression test for the motivating compatibility issue described in the library—mixed rustls backend feature sets where deterministic provider installation is required and enterprise TLS proxies may present P-521/SHA-512 certificates. If the initializer ever stopped installing aws-lc-rs or stopped validating the required scheme, this test would fail.

#### Function details

##### `ensure_provider_installs_ecdsa_p521_sha512_support`  (lines 4–16)

```
fn ensure_provider_installs_ecdsa_p521_sha512_support()
```

**Purpose**: Checks that the library installs a rustls provider whose supported verification schemes include ECDSA P-521/SHA-512. It validates the expected capability after initialization.

**Data flow**: It calls `ensure_rustls_crypto_provider()`, fetches the default provider with `CryptoProvider::get_default()`, panics if none is installed, and asserts that `supported_schemes()` contains `rustls::SignatureScheme::ECDSA_NISTP521_SHA512`.

**Call relations**: This test exercises the normal installation path of `ensure_rustls_crypto_provider`, contrasting with the separate preinstalled-provider test that covers the no-op preservation branch.

*Call graph*: 4 external calls (assert!, ensure_rustls_crypto_provider, panic!, get_default).


### `utils/rustls-provider/tests/preinstalled.rs`

`test` · `test execution`

This test file exercises the best-effort behavior of `ensure_rustls_crypto_provider` when a default rustls provider already exists. It defines `EMPTY_ALGORITHMS`, a `WebPkiSupportedAlgorithms` value with empty `all` and `mapping` slices, then mutates an aws-lc-rs default provider to use that empty algorithm set before installing it as the process default. After calling `ensure_rustls_crypto_provider`, the test fetches the active default provider and asserts that it still lacks support for `ECDSA_NISTP521_SHA512`.

The key point is not that the provider is functional, but that the initializer respects prior global installation and returns early when `install_default()` fails because a provider is already present. This guards embedded or host-managed environments where Codex should not replace process-wide TLS configuration. Because rustls default providers are global, this test is narrowly focused and intentionally checks the exact capability that the library would otherwise enforce when it performs the installation itself.

#### Function details

##### `ensure_provider_preserves_preinstalled_provider`  (lines 10–26)

```
fn ensure_provider_preserves_preinstalled_provider()
```

**Purpose**: Verifies that calling the library initializer leaves an already-installed rustls provider untouched. It uses a provider with empty signature algorithms to make preservation observable.

**Data flow**: The test creates an aws-lc-rs default provider, overwrites its `signature_verification_algorithms` with `EMPTY_ALGORITHMS`, installs it as the default, then calls `ensure_rustls_crypto_provider()`. It reads back `CryptoProvider::get_default()`, panics if absent, and asserts that the provider's supported schemes do not contain `ECDSA_NISTP521_SHA512`.

**Call relations**: This test invokes the public initializer under the condition that a provider is already globally installed, exercising the early-return branch in `ensure_rustls_crypto_provider`.

*Call graph*: 5 external calls (assert!, ensure_rustls_crypto_provider, panic!, get_default, default_provider).
