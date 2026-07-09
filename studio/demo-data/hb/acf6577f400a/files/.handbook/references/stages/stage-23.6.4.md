# API clients, models, protocol, prompts, and transport support tests  `stage-23.6.4`

This stage is a behind-the-scenes test bench for the parts of the system that talk to services, choose AI models, build prompts, and move data over the network. It is not the main user workflow; it is the safety lab that keeps that workflow reliable.

The model tests check provider settings, built-in defaults, user overrides, collaboration presets, model caching, and offline test model data. Together they make sure the app picks and describes models without stale data or unsafe limits. The client and login tests check HTTP requests, authentication tokens, headers, error translation, certificates, rate-limit calls, and model-list fetching, using fake servers instead of real ones. Streaming tests cover server-sent events and realtime WebSocket sessions, including retries, audio flow, and clean shutdowns.

Prompt and tool tests protect the exact text and schemas sent to AI models, including reviews, goals, memory prompts, image detail, and JSON Schema cleanup. Protocol, code-mode, RMCP, proxy, socket, TLS, and mock-cloud-task tests check error messages, streamed output, retries, authorization recovery, blocked requests, local sockets, security setup, and fake service behavior.

## Files in this stage

### Model registry and cache tests
These tests build from provider and preset definitions through model-info overrides into full model-manager orchestration and cache behavior.

### `model-provider-info/src/model_provider_info_tests.rs`

`test` · `test run`

This test file protects the part of the project that describes how Codex talks to different AI model services, such as OpenAI, Azure OpenAI, Ollama, and Amazon Bedrock. A model provider record includes things like the service name, base web address, API key environment variable, extra HTTP headers, retry settings, authentication commands, and cloud-specific settings. If these rules were wrong, users could write a valid-looking config file and still connect to the wrong endpoint, miss required headers, or get confusing failures.

The tests work mostly by building small TOML snippets, reading them into `ModelProviderInfo`, and comparing the result with the exact provider structure expected. This is like checking that a form filled out by a user is translated into the right internal checklist.

The file also checks important behavior beyond basic reading. It verifies that the removed `chat` wire API gives a helpful error, that websocket timeouts are preserved, and that only OpenAI and Azure-style providers support remote compaction. It confirms special cases for authentication, including command-based token fetching and Amazon Bedrock AWS settings. Finally, it tests how custom providers are merged with built-in providers, especially the restricted override rules for Amazon Bedrock, where only AWS profile and region may be changed.

#### Function details

##### `test_deserialize_ollama_model_provider_toml`  (lines 9–36)

```
fn test_deserialize_ollama_model_provider_toml()
```

**Purpose**: Checks that a minimal Ollama provider written in TOML becomes the expected `ModelProviderInfo`. This protects the default values used when optional fields are not present.

**Data flow**: A short TOML string with a name and base URL goes in. The test parses it into a provider object, then compares that object to an explicitly written expected provider where missing fields are `None` or default values. The output is a passing test if the parsed object matches exactly.

**Call relations**: During the test run, this test exercises the TOML deserialization path for a simple local provider. It relies on the shared provider type and the TOML parser, then uses an equality check to prove the parser filled in defaults correctly.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_deserialize_azure_model_provider_toml`  (lines 39–70)

```
fn test_deserialize_azure_model_provider_toml()
```

**Purpose**: Checks that an Azure provider config can include an API key environment variable and query parameters. This matters because Azure OpenAI commonly needs an `api-version` query value on requests.

**Data flow**: A TOML string naming Azure, its base URL, its API key variable, and one query parameter goes in. The test parses it and compares the result to an expected provider containing the same URL, environment key, and query parameter map. A match means Azure-style TOML is translated correctly.

**Call relations**: This test covers the provider-loading path for Azure-specific configuration. It hands TOML text to deserialization and verifies that the resulting provider record can carry request query details needed later by API setup code.

*Call graph*: 3 external calls (assert_eq!, hashmap!, from_str).


##### `test_deserialize_example_model_provider_toml`  (lines 73–107)

```
fn test_deserialize_example_model_provider_toml()
```

**Purpose**: Checks that provider TOML can define fixed HTTP headers and headers whose values come from environment variables. This lets custom providers describe extra request information without hard-coding secrets.

**Data flow**: The test starts with TOML containing a provider name, base URL, API key variable, one literal header, and one environment-backed header. Parsing turns that into a provider object. The test then compares it to an expected object with the same header maps.

**Call relations**: This test exercises the part of provider configuration that later becomes outgoing HTTP request metadata. It confirms that both plain header values and environment-variable header references survive the parsing step.

*Call graph*: 3 external calls (assert_eq!, hashmap!, from_str).


##### `test_deserialize_chat_wire_api_shows_helpful_error`  (lines 110–120)

```
fn test_deserialize_chat_wire_api_shows_helpful_error()
```

**Purpose**: Checks that using the removed `chat` wire API fails with a clear message. A wire API means the request-and-response format used to talk to a model service.

**Data flow**: A TOML string asks for `wire_api = "chat"`. The parser is expected to reject it, producing an error instead of a provider. The test then checks that the error text contains the project’s intended removal message.

**Call relations**: This test covers a user-facing failure path in provider loading. Instead of letting an obsolete setting fail later in a confusing way, it verifies that deserialization itself points users toward the problem.

*Call graph*: 1 external calls (assert!).


##### `test_deserialize_websocket_connect_timeout`  (lines 123–133)

```
fn test_deserialize_websocket_connect_timeout()
```

**Purpose**: Checks that a websocket connection timeout in TOML is preserved. Websockets are long-lived network connections, and this timeout controls how long the system waits while opening one.

**Data flow**: TOML with `websocket_connect_timeout_ms = 15000` and websocket support enabled goes in. Parsing produces a provider object. The test checks that the timeout field contains 15000 milliseconds.

**Call relations**: This test feeds websocket-related provider settings through the same config-reading path used in real runs. It confirms that later networking code would receive the intended timeout value.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_supports_remote_compaction_for_openai`  (lines 136–140)

```
fn test_supports_remote_compaction_for_openai()
```

**Purpose**: Checks that the built-in OpenAI provider reports support for remote compaction. Remote compaction means asking the provider service to shrink or summarize conversation context instead of doing it locally.

**Data flow**: The test creates the standard OpenAI provider. It then asks the provider whether remote compaction is supported and expects `true`. Nothing else is changed.

**Call relations**: This test calls into the built-in OpenAI provider constructor, then exercises the provider capability check. It protects behavior that higher-level conversation code may use when choosing a compaction strategy.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert!).


##### `test_personal_access_token_uses_chatgpt_codex_base_url`  (lines 143–149)

```
fn test_personal_access_token_uses_chatgpt_codex_base_url()
```

**Purpose**: Checks that OpenAI configured with a personal access token uses the ChatGPT Codex service URL, not the normal API URL. This prevents that authentication mode from being sent to the wrong service.

**Data flow**: The test creates the standard OpenAI provider, converts it into an API-ready provider using personal access token authentication, and reads the resulting base URL. It expects that URL to equal the special ChatGPT Codex base URL.

**Call relations**: This test follows the path from a general provider description to the concrete API provider used for requests. It verifies that authentication choice can influence the endpoint selected during that conversion.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_supports_remote_compaction_for_azure_name`  (lines 152–174)

```
fn test_supports_remote_compaction_for_azure_name()
```

**Purpose**: Checks that a provider named Azure reports support for remote compaction. This keeps Azure OpenAI aligned with OpenAI for that capability.

**Data flow**: The test manually builds an Azure-looking provider object. It asks whether remote compaction is supported and expects `true`. The provider object itself is not modified.

**Call relations**: This test exercises the capability decision using the provider’s name rather than the built-in constructor. It protects the rule that Azure-named providers are treated as eligible for remote compaction.

*Call graph*: 1 external calls (assert!).


##### `test_supports_remote_compaction_for_non_openai_non_azure_provider`  (lines 177–199)

```
fn test_supports_remote_compaction_for_non_openai_non_azure_provider()
```

**Purpose**: Checks that an unrelated custom provider does not claim remote compaction support. This avoids assuming that every OpenAI-compatible endpoint has the same extra features.

**Data flow**: The test builds a provider named Example with a normal-looking API URL. It asks the provider whether remote compaction is supported and expects `false`. No data is written anywhere.

**Call relations**: This is the negative counterpart to the OpenAI and Azure compaction tests. It makes sure the capability check stays selective, so later code does not call unsupported provider features.

*Call graph*: 1 external calls (assert!).


##### `test_deserialize_provider_auth_config_defaults`  (lines 202–227)

```
fn test_deserialize_provider_auth_config_defaults()
```

**Purpose**: Checks the defaults for command-based provider authentication. In this mode, Codex runs a local command to print a token instead of reading one directly from an environment variable.

**Data flow**: The test creates a temporary directory and makes it the base for resolving relative paths. It parses TOML with an auth command and one argument, then expects default timeout, default refresh interval, and a current working directory resolved against the temporary base. The result is a provider whose `auth` section matches those expectations.

**Call relations**: This test combines path resolution with TOML deserialization. It verifies that when provider-loading code sees an `[auth]` section with only required fields, it fills in safe defaults for later token-fetching code.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, tempdir, from_str).


##### `test_deserialize_provider_aws_config`  (lines 230–249)

```
fn test_deserialize_provider_aws_config()
```

**Purpose**: Checks that AWS authentication settings for a provider can be read from TOML. This is needed for services such as Amazon Bedrock, where cloud profile and region may guide request signing.

**Data flow**: A TOML provider with an `[aws]` section goes in. Parsing produces a provider object. The test checks that the AWS profile and region fields contain the expected strings.

**Call relations**: This test covers the AWS-specific branch of provider configuration loading. It ensures those values are available later when the system prepares authenticated Bedrock requests.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_create_amazon_bedrock_provider`  (lines 252–281)

```
fn test_create_amazon_bedrock_provider()
```

**Purpose**: Checks the exact default definition of the built-in Amazon Bedrock provider. This includes its name, base URL, AWS auth placeholder, and required Mantle client-agent header.

**Data flow**: The test calls the Amazon Bedrock provider constructor with no AWS override. It compares the returned provider to a fully written expected provider. A passing result means the built-in provider starts with the intended defaults.

**Call relations**: This test protects the built-in provider factory. Other code can rely on this constructor to supply all the special Bedrock settings without users having to write them by hand.

*Call graph*: 1 external calls (assert_eq!).


##### `test_amazon_bedrock_provider_adds_mantle_client_agent_header`  (lines 284–296)

```
fn test_amazon_bedrock_provider_adds_mantle_client_agent_header()
```

**Purpose**: Checks that the Amazon Bedrock provider’s special client-agent header appears in the API-ready provider. This header identifies the client to the Bedrock Mantle service.

**Data flow**: The test creates the built-in Bedrock provider, converts it into an API provider, then reads the header collection from that API provider. It expects the Mantle client-agent header to be present with the exact built-in value.

**Call relations**: This test follows Bedrock configuration from provider construction into request-ready form. It ensures the header is not lost during conversion to the structure used by HTTP request code.

*Call graph*: calls 1 internal fn (create_amazon_bedrock_provider); 1 external calls (assert_eq!).


##### `test_built_in_model_providers_include_amazon_bedrock`  (lines 299–308)

```
fn test_built_in_model_providers_include_amazon_bedrock()
```

**Purpose**: Checks that Amazon Bedrock is included in the map of built-in providers. Without this, users could not select the built-in Bedrock provider by its standard ID.

**Data flow**: The test asks for all built-in model providers. It looks up the Amazon Bedrock provider ID and checks that the found provider identifies itself as Bedrock. The test passes only if the provider is present and correct.

**Call relations**: This test exercises the registry of built-in providers. It protects the handoff from user-facing provider IDs to the provider definitions used by the rest of the system.

*Call graph*: 1 external calls (assert_eq!).


##### `test_merge_configured_model_providers_adds_custom_provider`  (lines 311–330)

```
fn test_merge_configured_model_providers_adds_custom_provider()
```

**Purpose**: Checks that a user-defined custom provider is added alongside the built-in providers. This lets users connect Codex to services that are not built in.

**Data flow**: The test creates a custom provider and a configured-provider map containing it. It also builds the expected result by starting with built-ins and inserting the custom entry. The merge function should return that combined map.

**Call relations**: This test covers the normal merge path where user configuration extends, rather than changes, built-in providers. It verifies that configured providers are handed into the provider registry without dropping existing defaults.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_applies_amazon_bedrock_profile_override`  (lines 333–361)

```
fn test_merge_configured_model_providers_applies_amazon_bedrock_profile_override()
```

**Purpose**: Checks that user config may override only the AWS profile and region of the built-in Amazon Bedrock provider. This gives users the needed AWS customization while keeping the rest of the built-in definition stable.

**Data flow**: The test creates a configured provider entry under the Bedrock ID with only AWS profile and region set. It builds the expected built-in provider map, then updates Bedrock’s AWS fields in that expected map. The merge result must match the expected map.

**Call relations**: This test exercises the special-case merge rule for Amazon Bedrock. It confirms that configuration can flow into the built-in Bedrock provider, but only through the approved AWS fields.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_rejects_amazon_bedrock_non_default_fields`  (lines 364–387)

```
fn test_merge_configured_model_providers_rejects_amazon_bedrock_non_default_fields()
```

**Purpose**: Checks that users cannot redefine unsupported fields of the built-in Amazon Bedrock provider. This prevents accidental or partial rewrites of a provider that needs carefully controlled defaults.

**Data flow**: The test creates a configured Bedrock entry that changes the provider name and sets an AWS profile. The merge attempt should fail instead of producing a provider map. The expected output is a specific error message explaining that only AWS profile and region may change.

**Call relations**: This test covers the guarded failure path in provider merging. It makes sure the special Bedrock override rules are enforced at configuration-merge time, before any request code uses a bad provider definition.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_merge_configured_model_providers_allows_amazon_bedrock_default_fields`  (lines 390–410)

```
fn test_merge_configured_model_providers_allows_amazon_bedrock_default_fields()
```

**Purpose**: Checks that harmless default-valued fields in an Amazon Bedrock override do not cause rejection. This avoids punishing config shapes that include defaults without actually changing behavior.

**Data flow**: The test creates a configured Bedrock entry with AWS fields set to empty values and the wire API left at its normal default. Merging should return the unchanged built-in provider map. The result is compared with a fresh built-in map.

**Call relations**: This test refines the Bedrock merge rule by showing what is allowed. It ensures the merge code distinguishes between real unsupported changes and fields that merely repeat default values.

*Call graph*: 3 external calls (assert_eq!, default, from).


##### `test_validate_provider_aws_rejects_conflicting_auth`  (lines 413–428)

```
fn test_validate_provider_aws_rejects_conflicting_auth()
```

**Purpose**: Checks that a provider using AWS authentication cannot also use an API-key environment variable or OpenAI-style authentication requirements. Mixing these would make it unclear which authentication method should be used.

**Data flow**: The test starts from an OpenAI provider, adds AWS settings, and also sets an API key environment variable. It runs provider validation and expects an error saying AWS cannot be combined with those other auth settings.

**Call relations**: This test exercises provider validation after a provider object has been built. It protects later API setup code by catching incompatible authentication choices before requests are attempted.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_validate_provider_aws_rejects_websockets`  (lines 431–446)

```
fn test_validate_provider_aws_rejects_websockets()
```

**Purpose**: Checks that AWS-authenticated providers cannot enable websocket support. This prevents a provider from advertising a connection style that the AWS path does not support.

**Data flow**: The test creates a provider with AWS settings and turns on websocket support. It validates the provider and expects a specific error. The provider is not converted into an API provider because validation stops it.

**Call relations**: This test covers another validation failure path for AWS-backed providers. It ensures incompatible websocket settings are rejected early, before networking code tries to open an unsupported connection.

*Call graph*: calls 1 internal fn (create_openai_provider); 1 external calls (assert_eq!).


##### `test_deserialize_provider_auth_config_allows_zero_refresh_interval`  (lines 449–467)

```
fn test_deserialize_provider_auth_config_allows_zero_refresh_interval()
```

**Purpose**: Checks that command-based authentication may set `refresh_interval_ms` to zero. A zero refresh interval means there is no automatic refresh schedule.

**Data flow**: The test creates a temporary base directory, parses TOML with an auth command and `refresh_interval_ms = 0`, and extracts the auth settings. It checks that the raw interval is zero and that the computed refresh interval is `None`.

**Call relations**: This test uses the same auth deserialization path as the default-auth test, but focuses on an explicit edge case. It verifies that later token-refresh scheduling code can tell the difference between a real interval and disabled refresh.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, tempdir, from_str).


### `models-manager/src/collaboration_mode_presets_tests.rs`

`test` · `test run`

This is a small test file for the collaboration mode preset definitions. A preset is a ready-made bundle of settings for how the assistant should behave, such as a normal default mode or a planning mode. These presets are user-facing, so their names and instructions need to stay clear and accurate.

The first test checks that each preset gets its visible name from the same source as the mode itself. This matters because otherwise one part of the app could say “Plan” while another says something different. It also checks a few important default fields: the plan preset does not force a specific model, but it does set a medium reasoning effort; the default preset does not force either a model or reasoning effort.

The second test checks the text instructions for the default mode. Those instructions appear to be written from a template containing a placeholder for known mode names. The test makes sure that placeholder has been replaced with the real list of visible collaboration modes. It also checks that important guidance about asking the user questions is present. In everyday terms, this file is like a proofreader for built-in labels and instruction text before users ever see them.

#### Function details

##### `preset_names_use_mode_display_names`  (lines 5–15)

```
fn preset_names_use_mode_display_names()
```

**Purpose**: This test makes sure the plan and default presets use the same display names as their matching collaboration modes. It also verifies a few key preset defaults, such as whether they choose a model or set a reasoning effort.

**Data flow**: It reads the plan preset, the default preset, and the display names from the mode definitions. It compares those values against the expected names and option settings. If everything matches, the test passes; if a preset drifts away from the shared mode definition or changes an expected default, the test fails.

**Call relations**: During the test run, the test framework calls this function. Inside it, the assertions compare preset values with expected values, so a mismatch is reported immediately as a failed test.

*Call graph*: 1 external calls (assert_eq!).


##### `default_mode_instructions_replace_mode_names_placeholder`  (lines 18–36)

```
fn default_mode_instructions_replace_mode_names_placeholder()
```

**Purpose**: This test checks that the default mode's instruction text is complete and ready for use. In particular, it makes sure a template placeholder for known mode names has been replaced with the real mode names, and that important user-question guidance is included.

**Data flow**: It starts by getting the default preset's developer instructions. It then checks that the raw placeholder text is gone, builds the expected sentence using the current visible collaboration mode names, and confirms that sentence appears in the instructions. Finally, it checks for two specific guidance phrases about when and how to ask the user for input.

**Call relations**: The test framework calls this function as part of the test suite. The function uses formatting to build the expected mode-name sentence, then uses assertions to confirm the generated instruction text contains the right final wording.

*Call graph*: 2 external calls (assert!, format!).


### `models-manager/src/test_support.rs`

`test` · `test setup`

In normal use, the models manager may learn about available AI models from remote services or cached catalog data. Tests need something more predictable. This file provides two test-only helper functions that create the same kind of model choices, but using only local information.

Think of it like giving a classroom a printed menu instead of asking every student to phone the restaurant. The tests can pick from the bundled model list, or from the test configuration, and they get repeatable answers every time.

The first helper chooses a model identifier. If the caller already named a model, it simply returns that. If not, it reads the bundled model response, sorts the bundled models by priority, converts them into presets, and picks the first model meant to be shown in a model picker. If none are marked that way, it falls back to the first available preset, and finally to an empty string if there is nothing at all.

The second helper builds a full `ModelInfo` record, which is the structured description of a model. It looks for a model catalog inside the provided test configuration and passes those candidate models into the normal model-construction logic. This keeps tests close to production behavior while still avoiding remote lookups.

#### Function details

##### `get_model_offline_for_tests`  (lines 12–25)

```
fn get_model_offline_for_tests(model: Option<&str>) -> String
```

**Purpose**: This function chooses a model name for tests without contacting any remote service or reading a cache. It is useful when a test needs a valid default model but should stay fast, repeatable, and offline.

**Data flow**: It receives an optional model name. If a name is provided, that exact name is returned. If no name is provided, it reads the bundled model list, sorts the models by priority, converts them into picker-style presets, and chooses the first preset marked as visible in the picker. If there is no visible preset, it chooses the first preset at all; if there are no presets, it returns an empty string.

**Call relations**: Many test setup helpers call this when they are building sessions, session configurations, telemetry tests, or rate-limit tests and need a model name. Its only outside handoff is to `bundled_models_response`, which supplies the local built-in model data used instead of live model state.

*Call graph*: called by 38 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, session_telemetry, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, get_model_offline (+15 more)); 1 external calls (bundled_models_response).


##### `construct_model_info_offline_for_tests`  (lines 28–38)

```
fn construct_model_info_offline_for_tests(
    model: &str,
    config: &ModelsManagerConfig,
) -> ModelInfo
```

**Purpose**: This function builds a `ModelInfo` description for a named model during tests, using only the model catalog already present in the test configuration. It lets tests exercise the normal model-building rules without making remote or cached lookups.

**Data flow**: It receives a model name and a `ModelsManagerConfig`. It checks whether the configuration contains a model catalog. If it does, it uses that catalog's models as possible matches; if not, it uses an empty list. It then passes the model name, the candidate list, and the configuration into the normal constructor, which returns the final `ModelInfo`.

**Call relations**: Test session-building helpers call this after choosing or receiving a model name, so they can attach full model details to a test session. It delegates the real construction work to `construct_model_info_from_candidates`, meaning tests share the same interpretation rules as production code while keeping the source of model data local.

*Call graph*: calls 1 internal fn (construct_model_info_from_candidates); called by 12 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present, construct_model_info_offline, test_session_telemetry (+2 more)).


### `models-manager/src/model_info_tests.rs`

`test` · `test run`

This is a test file for the models manager. The models manager keeps facts about AI models, such as whether a model supports reasoning summaries and how large its context window is. A context window is the amount of text a model can consider at once. The tests here focus on what happens when configuration values override the built-in model information.

The main idea is safety. A configuration value may add support for reasoning summaries, but it must not turn that support off if the model already has it. In everyday terms, the config can put a helpful sticker on a model saying “supports summaries,” but it cannot peel off a sticker that was already known to be true.

The file also checks context window overrides. If a user asks for a context window larger than the model’s maximum allowed window, the code should clamp it down to the maximum. That is like setting a thermostat higher than the heater can go: the system should stop at the heater’s real limit, not pretend it can exceed it.

Without these tests, a small change in override behavior could silently make models appear less capable than they are, or allow impossible context sizes that later parts of the system cannot actually use.

#### Function details

##### `reasoning_summaries_override_true_enables_support`  (lines 6–18)

```
fn reasoning_summaries_override_true_enables_support()
```

**Purpose**: This test proves that a configuration setting of `true` can mark a model as supporting reasoning summaries. It checks the case where the model starts out unknown or unsupported, and the config explicitly enables the feature.

**Data flow**: It starts with a model made from an unknown model name, then builds a default configuration with only `model_supports_reasoning_summaries` set to `true`. The model and config are passed through the override logic. The test then builds the expected result by turning on `supports_reasoning_summaries` and compares the actual updated model to that expected model.

**Call relations**: During the test run, this function creates mostly default configuration data, then uses an equality assertion to confirm the override behavior. It is one of the tests that guards the rule that configuration may add reasoning-summary support.

*Call graph*: 2 external calls (default, assert_eq!).


##### `reasoning_summaries_override_false_does_not_disable_support`  (lines 21–32)

```
fn reasoning_summaries_override_false_does_not_disable_support()
```

**Purpose**: This test makes sure a `false` configuration value does not remove reasoning-summary support from a model that already has it. It protects the idea that known model capabilities should not be downgraded by this override.

**Data flow**: It starts with an unknown model, manually marks that model as supporting reasoning summaries, and creates a mostly default configuration where the override is set to `false`. After applying the override logic, it expects the model to be unchanged. The output is checked by comparing the updated model with the original model.

**Call relations**: This test is run by the test framework along with the others in this file. It relies on default configuration filling for all unrelated settings, then uses an assertion to catch any change that would wrongly turn off an existing capability.

*Call graph*: 2 external calls (default, assert_eq!).


##### `reasoning_summaries_override_false_is_noop_when_model_is_false`  (lines 35–45)

```
fn reasoning_summaries_override_false_is_noop_when_model_is_false()
```

**Purpose**: This test checks that setting the reasoning-summary override to `false` does nothing when the model already does not support reasoning summaries. It confirms that `false` is treated as no extra permission, not as a destructive instruction.

**Data flow**: It creates a model from an unknown name, leaving reasoning-summary support at its normal false value. It then creates a default configuration with `model_supports_reasoning_summaries` set to `false`, applies the override logic, and checks that the result is exactly the same as the starting model.

**Call relations**: As part of the test suite, this function covers the quiet no-change path. It uses default configuration values for everything except the one flag under test, and the final assertion verifies that no hidden fields were changed.

*Call graph*: 2 external calls (default, assert_eq!).


##### `model_context_window_override_clamps_to_max_context_window`  (lines 48–62)

```
fn model_context_window_override_clamps_to_max_context_window()
```

**Purpose**: This test proves that a requested context window cannot exceed the model’s maximum allowed context window. It protects later code from being given a size the model cannot actually support.

**Data flow**: It starts with a model whose current context window is 273,000 and whose maximum is 400,000. The configuration requests a larger context window of 500,000. After applying overrides, the expected result is not 500,000 but 400,000, because the value is clamped down to the maximum. The test compares the updated model to that expected safe result.

**Call relations**: This test checks the boundary-protection behavior of the override logic. It creates a mostly default configuration, changes only the context-window request, and uses an equality assertion to ensure the result respects the model’s maximum.

*Call graph*: 2 external calls (default, assert_eq!).


##### `model_context_window_uses_model_value_without_override`  (lines 65–74)

```
fn model_context_window_uses_model_value_without_override()
```

**Purpose**: This test confirms that if the configuration does not request a context-window override, the model’s own context-window value is left alone. It protects normal model metadata from being changed unnecessarily.

**Data flow**: It builds a model with a context window of 273,000 and a maximum of 400,000, then uses a completely default configuration with no override. After the override step, the returned model should match the original model exactly. The assertion checks that nothing changed.

**Call relations**: This is the baseline test for context-window behavior. It is run by the test framework to make sure the override code only acts when there is an actual override value, and the equality assertion catches accidental changes.

*Call graph*: 2 external calls (assert_eq!, default).


### `models-manager/src/manager_tests.rs`

`test` · `test run`

The models manager is responsible for answering questions like “which models can this user use?” and “what do we know about this model name?” This test file checks that those answers stay correct across many situations: online refreshes, cached data, missing models, hidden models, ChatGPT login, API key login, and bundled fallback data.

The file builds small fake models with realistic fields, then feeds them through fake endpoint clients. These fake endpoints act like a test waiter: each time the manager asks for the menu of models, the endpoint hands back the next prepared list and counts the request. That lets the tests prove when network fetching should happen and when cached data should be reused.

A second set of fakes simulates authentication. Some tests pretend the user has ChatGPT tokens, some use an API key, and some use an external API key that either resolves or fails. This matters because the manager treats ChatGPT-backed model lists differently from API-key-backed lists.

Together, the tests protect the project from subtle regressions: accidentally showing removed models, refreshing too often, ignoring cache freshness, treating hidden models as defaults, or using fallback metadata without marking it.

#### Function details

##### `remote_model`  (lines 27–29)

```
fn remote_model(slug: &str, display: &str, priority: i32) -> ModelInfo
```

**Purpose**: Creates a realistic test model that is visible in normal model lists. Tests use it when they do not care about special visibility rules.

**Data flow**: It receives a model slug, display name, and priority number. It passes those values to the more detailed builder with visibility set to "list", and returns the finished ModelInfo test object.

**Call relations**: Several tests call this as their quick model factory. It delegates the actual object construction to remote_model_with_visibility so all fake models share the same shape.

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

**Purpose**: Builds a complete fake ModelInfo value, including whether the model should be listed or hidden. This keeps tests short while still using model data that looks like real server data.

**Data flow**: It receives a slug, display name, priority, and visibility string. It creates JSON with all required model fields, converts that JSON into a ModelInfo, and returns it or fails the test if the fake data is invalid.

**Call relations**: remote_model calls this for the common visible case. Tests that need hidden models call it directly to check filtering and default-model behavior.

*Call graph*: called by 3 (build_available_models_picks_default_after_hiding_hidden_models, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, remote_model); 2 external calls (json!, from_value).


##### `assert_models_contain`  (lines 64–72)

```
fn assert_models_contain(actual: &[ModelInfo], expected: &[ModelInfo])
```

**Purpose**: Checks that a model list includes certain expected models by slug. It is a small test helper that makes cache and refresh assertions easier to read.

**Data flow**: It receives the actual list and the expected list. For each expected model, it searches the actual list for the same slug and fails the test with a clear message if one is missing.

**Call relations**: Refresh and cache tests call this after asking the manager for remote models. It does not call into the manager; it only verifies the result those tests already collected.

*Call graph*: called by 4 (refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority, refresh_available_models_uses_cache_when_fresh); 1 external calls (assert!).


##### `TestModelsEndpoint::new`  (lines 83–90)

```
fn new(responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Creates a fake endpoint that behaves like a Codex-backed model service and can refresh models. Tests use it to simulate successful online model fetches.

**Data flow**: It receives a sequence of model-list responses. It stores them in a queue protected by a mutex, starts the fetch counter at zero, marks the endpoint as Codex-backed, and returns it inside a shared pointer.

**Call relations**: Most online-refresh tests create this endpoint and pass it into openai_manager_for_tests. When the manager later lists models, the endpoint returns the next queued response.

*Call graph*: called by 15 (get_model_info_rejects_multi_segment_namespace_suffix_matching, get_model_info_tracks_fallback_usage, get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative, refresh_available_models_drops_removed_remote_models, refresh_available_models_fetches_with_chatgpt_auth_tokens, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote, refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority (+5 more)); 3 external calls (new, new, new).


##### `TestModelsEndpoint::without_refresh`  (lines 92–99)

```
fn without_refresh(responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Creates a fake endpoint that should not be used for remote refreshes. It is used to prove the manager skips network access when refresh is not allowed by the current authentication setup.

**Data flow**: It receives queued responses, stores them like the normal fake endpoint, but marks the endpoint as not using the Codex backend. It returns the shared fake endpoint.

**Call relations**: refresh_available_models_skips_network_without_chatgpt_auth uses this helper. The manager consults the endpoint capability and should avoid calling its model-list method.

*Call graph*: called by 1 (refresh_available_models_skips_network_without_chatgpt_auth); 3 external calls (new, new, new).


##### `TestModelsEndpoint::fetch_count`  (lines 101–103)

```
fn fetch_count(&self) -> usize
```

**Purpose**: Reports how many times the fake endpoint has been asked for models. Tests use this to prove caching or auth decisions avoided unnecessary network work.

**Data flow**: It reads the atomic counter, which is a thread-safe number, and returns its current value as a plain integer. It does not change anything.

**Call relations**: Many tests check this after refresh calls. The counter is increased by TestModelsEndpoint::list_models whenever the manager actually fetches.

*Call graph*: 1 external calls (load).


##### `TestExternalApiKeyAuth::auth_mode`  (lines 121–123)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Tells the authentication system that this fake external auth source represents an API key. This lets tests check how API-key auth changes model visibility and refresh behavior.

**Data flow**: It takes no input beyond the fake auth object and returns AuthMode::ApiKey. It does not read or change stored state.

**Call relations**: AuthManager calls this through the ExternalAuth trait when deciding what kind of credentials are active. Tests use that decision indirectly through model listing and refresh.


##### `TestExternalApiKeyAuth::resolve`  (lines 125–131)

```
fn resolve(&self) -> codex_login::ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Pretends an external API key can be found immediately. This simulates a tool or environment providing API-key credentials to override ChatGPT login.

**Data flow**: It returns an asynchronous result containing an access-token-only credential with the fixed value "test-external-api-key". Nothing is written or mutated.

**Call relations**: The auth manager may call this when external auth is installed. Tests then verify the models manager treats the resolved external API key as active API-key auth.

*Call graph*: calls 1 internal fn (access_token_only); 1 external calls (pin).


##### `TestExternalApiKeyAuth::refresh`  (lines 133–142)

```
fn refresh(
        &self,
        _context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Pretends refreshing the external API key succeeds. It gives the same fixed token as resolve, enough for tests that only need the auth mode and success path.

**Data flow**: It receives a refresh context but ignores it. It returns an asynchronous successful token result containing the fixed test API key.

**Call relations**: The authentication layer can call this through the ExternalAuth trait. The model manager sees the resulting API-key auth state and should skip ChatGPT-only refresh behavior.

*Call graph*: calls 1 internal fn (access_token_only); 1 external calls (pin).


##### `TestUnresolvedExternalApiKeyAuth::auth_mode`  (lines 149–151)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Identifies this fake external auth source as an API-key source even though it cannot actually provide a key. This sets up tests for fallback behavior.

**Data flow**: It returns AuthMode::ApiKey without reading any data. The fake object has no stored state to update.

**Call relations**: The auth manager uses this trait method while trying to apply external authentication. The paired refresh method then fails, letting tests check fallback to cached ChatGPT auth.


##### `TestUnresolvedExternalApiKeyAuth::refresh`  (lines 153–158)

```
fn refresh(
        &self,
        _context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Simulates an external API key source that fails to produce credentials. Tests use this to ensure a failed override does not block use of existing ChatGPT credentials.

**Data flow**: It receives a refresh context but ignores it. It returns an asynchronous error saying the test auth is unresolved, and changes no state.

**Call relations**: The auth manager may call this when trying external auth. refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved relies on this failure so the manager falls back to ChatGPT auth and fetches models.

*Call graph*: 2 external calls (pin, other).


##### `TestModelsEndpoint::has_command_auth`  (lines 162–164)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Reports whether the fake endpoint has command-style authentication. Tests set this flag to mimic API-key-style endpoint behavior.

**Data flow**: It reads the stored has_command_auth boolean and returns it. No data is changed.

**Call relations**: The models manager calls this through the ModelsEndpointClient trait while deciding how to combine bundled and remote model catalogs.


##### `TestModelsEndpoint::uses_codex_backend`  (lines 166–168)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Reports whether this fake endpoint should be treated as using the Codex backend. That distinction affects whether remote model lists are authoritative.

**Data flow**: It reads the stored uses_codex_backend boolean and wraps it in an asynchronous result. It does not fetch models or mutate anything.

**Call relations**: The models manager asks this before deciding whether it should fetch online models. Tests choose the flag through TestModelsEndpoint::new or TestModelsEndpoint::without_refresh.

*Call graph*: 1 external calls (pin).


##### `TestModelsEndpoint::list_models`  (lines 170–175)

```
fn list_models(
        &'a self,
        _client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Implements the endpoint call that returns the next prepared fake model list. It mimics a server response while tracking how often the manager asks.

**Data flow**: It ignores the client version input. It increments the fetch counter, removes the next model list from the queued responses, and returns that list with no extra metadata; if the queue is empty it returns an empty list.

**Call relations**: The models manager calls this through ModelsEndpointClient when it decides to refresh online. Many tests then inspect fetch_count to confirm the call happened exactly as expected.

*Call graph*: 2 external calls (fetch_add, pin).


##### `openai_manager_for_tests`  (lines 178–189)

```
fn openai_manager_for_tests(
    codex_home: std::path::PathBuf,
    endpoint_client: Arc<dyn ModelsEndpointClient>,
) -> OpenAiModelsManager
```

**Purpose**: Creates an OpenAiModelsManager with default fake ChatGPT authentication. This is the common setup for tests that want normal Codex-backed behavior.

**Data flow**: It receives a temporary Codex home path and an endpoint client. It creates dummy ChatGPT auth, wraps it in an AuthManager, and passes everything to openai_manager_for_tests_with_auth.

**Call relations**: Most tests call this rather than constructing the manager directly. It funnels setup through openai_manager_for_tests_with_auth so customized-auth tests can share the same construction path.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, openai_manager_for_tests_with_auth); called by 12 (get_model_info_rejects_multi_segment_namespace_suffix_matching, get_model_info_tracks_fallback_usage, get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative, refresh_available_models_drops_removed_remote_models, refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog, refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote, refresh_available_models_refetches_when_cache_stale, refresh_available_models_refetches_when_version_mismatch, refresh_available_models_sorts_by_priority, refresh_available_models_uses_cache_when_fresh (+2 more)).


##### `openai_manager_for_tests_with_auth`  (lines 191–197)

```
fn openai_manager_for_tests_with_auth(
    codex_home: std::path::PathBuf,
    endpoint_client: Arc<dyn ModelsEndpointClient>,
    auth_manager: Option<Arc<AuthManager>>,
) -> OpenAiModelsManager
```

**Purpose**: Creates an OpenAiModelsManager with a caller-chosen authentication manager. Tests use it when they need no auth, API-key auth, external auth, or token-file auth.

**Data flow**: It receives the Codex home path, endpoint client, and optional AuthManager. It calls the real OpenAiModelsManager constructor and returns the manager.

**Call relations**: openai_manager_for_tests calls this for the default case. Auth-focused tests call it directly to control the manager’s view of the current login state.

*Call graph*: calls 1 internal fn (new); called by 6 (openai_manager_for_tests, refresh_available_models_fetches_with_chatgpt_auth_tokens, refresh_available_models_keeps_merging_for_api_auth, refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth, refresh_available_models_skips_network_without_chatgpt_auth, refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved).


##### `static_manager_for_tests`  (lines 199–201)

```
fn static_manager_for_tests(model_catalog: ModelsResponse) -> StaticModelsManager
```

**Purpose**: Creates a StaticModelsManager from a fixed catalog. Tests use it when they want model lookup behavior without network refresh or disk cache complications.

**Data flow**: It receives a ModelsResponse catalog, constructs a StaticModelsManager with no auth manager, and returns it. The catalog becomes the manager’s source of model information.

**Call relations**: Model-info and default-selection tests call this with hand-built catalogs. It avoids the fake endpoint path entirely.

*Call graph*: calls 1 internal fn (new); called by 4 (build_available_models_picks_default_after_hiding_hidden_models, get_model_info_matches_hyphenated_provider_namespace_suffix, get_model_info_matches_namespaced_suffix, get_model_info_uses_custom_catalog).


##### `chatgpt_auth_tokens_for_tests`  (lines 203–239)

```
async fn chatgpt_auth_tokens_for_tests(codex_home: &Path) -> CodexAuth
```

**Purpose**: Writes a realistic-looking auth.json file and loads it as ChatGPT token authentication. This tests the path where credentials come from disk rather than a dummy in-memory auth object.

**Data flow**: It receives a Codex home directory path. It builds an auth.json structure with a fake parsed JWT, access token, refresh token, and timestamp; writes it to disk; then asks CodexAuth to load it back and returns the loaded auth.

**Call relations**: refresh_available_models_fetches_with_chatgpt_auth_tokens calls this before building the manager. The returned CodexAuth is wrapped in an AuthManager so the refresh path sees token-based ChatGPT auth.

*Call graph*: calls 3 internal fn (default, from_auth_storage, parse_chatgpt_jwt_claims); called by 1 (refresh_available_models_fetches_with_chatgpt_auth_tokens); 5 external calls (join, now, to_string, create_dir_all, write).


##### `get_model_info_tracks_fallback_usage`  (lines 242–266)

```
async fn get_model_info_tracks_fallback_usage()
```

**Purpose**: Checks that model lookup marks whether it used real catalog metadata or fallback metadata. This prevents callers from mistaking guessed information for known information.

**Data flow**: It creates a manager, reads a known bundled model slug, and asks for model info for both that slug and a made-up slug. It expects the known model to be marked as not fallback, and the unknown model to keep its requested slug but be marked as fallback.

**Call relations**: The test uses TestModelsEndpoint::new and openai_manager_for_tests for setup. It exercises the manager’s get_model_info path directly.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `get_model_info_uses_custom_catalog`  (lines 269–288)

```
async fn get_model_info_uses_custom_catalog()
```

**Purpose**: Verifies that a static custom catalog can provide metadata for a requested model variant. This matters for custom or experimental model names that should inherit known properties.

**Data flow**: It creates a catalog model named gpt-overlay, changes one capability flag, and asks for info about gpt-overlay-experiment. It expects the returned info to use the requested slug while copying the catalog metadata and not marking it as fallback.

**Call relations**: The test builds data with remote_model and creates a StaticModelsManager through static_manager_for_tests. It then calls get_model_info on that static manager.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_matches_namespaced_suffix`  (lines 291–305)

```
async fn get_model_info_matches_namespaced_suffix()
```

**Purpose**: Checks that a one-part provider namespace, such as custom/gpt-image, can still match catalog metadata for gpt-image. This supports providers that prefix model names.

**Data flow**: It creates a catalog with gpt-image, asks for custom/gpt-image, and verifies the returned slug remains namespaced while the image-detail capability comes from the catalog model.

**Call relations**: The test uses remote_model and static_manager_for_tests. It exercises the suffix-matching behavior inside get_model_info.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_matches_hyphenated_provider_namespace_suffix`  (lines 308–320)

```
async fn get_model_info_matches_hyphenated_provider_namespace_suffix()
```

**Purpose**: Checks that namespace suffix matching also works when the provider name contains a hyphen. This avoids rejecting valid names like openai-codex/gpt-image.

**Data flow**: It creates a catalog model called gpt-image, asks for openai-codex/gpt-image, and expects a non-fallback result with the original requested slug.

**Call relations**: The test follows the same static-manager path as the simpler namespace test, using remote_model and static_manager_for_tests before calling get_model_info.

*Call graph*: calls 2 internal fn (remote_model, static_manager_for_tests); 4 external calls (assert!, assert_eq!, default, vec!).


##### `get_model_info_rejects_multi_segment_namespace_suffix_matching`  (lines 323–343)

```
async fn get_model_info_rejects_multi_segment_namespace_suffix_matching()
```

**Purpose**: Ensures only simple one-segment namespaces are suffix-matched. A name like ns1/ns2/model should not accidentally inherit metadata for model.

**Data flow**: It creates a normal manager, finds a known bundled model slug, prefixes it with two namespace segments, and asks for model info. It expects the returned slug to be the full namespaced string and the metadata to be marked as fallback.

**Call relations**: The test uses TestModelsEndpoint::new and openai_manager_for_tests for setup. It protects get_model_info from overly broad matching.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 6 external calls (new, assert!, assert_eq!, format!, default, tempdir).


##### `refresh_available_models_sorts_by_priority`  (lines 346–376)

```
async fn refresh_available_models_sorts_by_priority()
```

**Purpose**: Checks that models with higher priority are listed before lower-priority ones after refresh. This keeps the user-facing model list in the intended order.

**Data flow**: It prepares two remote models with different priorities, refreshes the manager, then lists available models. It confirms both models are cached, that the higher-priority model appears first, and that only one fetch happened.

**Call relations**: The test uses TestModelsEndpoint::new to provide the remote list and assert_models_contain to verify the cache. It exercises refresh_available_models and list_models together.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_remote_only_catalog_for_chatgpt_auth`  (lines 379–396)

```
async fn refresh_available_models_uses_remote_only_catalog_for_chatgpt_auth()
```

**Purpose**: Verifies that for ChatGPT-backed auth, a non-empty visible remote catalog becomes the source of truth. Bundled models should not be mixed in unnecessarily.

**Data flow**: It prepares one remote model, refreshes with a default ChatGPT-auth manager, and checks that the manager’s remote models equal exactly that remote list. It also confirms one fetch occurred.

**Call relations**: The test builds its manager through openai_manager_for_tests, which supplies dummy ChatGPT auth. It targets the refresh path’s catalog-selection rule.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cached_remote_only_catalog_for_chatgpt_auth`  (lines 399–430)

```
async fn refresh_available_models_uses_cached_remote_only_catalog_for_chatgpt_auth()
```

**Purpose**: Checks that a fresh cached ChatGPT remote catalog is reused without another endpoint call. This protects startup and repeated listing from needless network traffic.

**Data flow**: It first refreshes one manager to write a cache. Then it creates a new manager pointing at the same home directory but with no queued endpoint responses, refreshes again, and expects the cached remote models to be loaded without fetching.

**Call relations**: Both managers are created with openai_manager_for_tests. The second endpoint’s fetch count proves the cache path was used instead of TestModelsEndpoint::list_models.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 4 external calls (new, assert_eq!, tempdir, vec!).


##### `get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative`  (lines 433–460)

```
async fn get_model_info_uses_fallback_for_bundled_models_when_chatgpt_remote_is_authoritative()
```

**Purpose**: Ensures that once a ChatGPT remote catalog is authoritative, bundled-only models are not treated as known catalog entries. They should fall back instead.

**Data flow**: It refreshes from a remote catalog containing a specific model, then asks for info about a bundled model slug. It expects the requested slug to be preserved but the metadata to be marked as fallback.

**Call relations**: The test uses openai_manager_for_tests and the bundled model loader. It checks the interaction between refresh_available_models and later get_model_info calls.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 5 external calls (assert!, assert_eq!, default, tempdir, vec!).


##### `refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote`  (lines 463–475)

```
async fn refresh_available_models_preserves_bundled_catalog_for_empty_chatgpt_remote()
```

**Purpose**: Checks that an empty remote response does not erase the bundled catalog. This prevents users from losing all model choices if the server returns no visible models.

**Data flow**: It sets the endpoint to return an empty list, refreshes, and compares the manager’s remote models to the bundled models loaded from file.

**Call relations**: The test uses TestModelsEndpoint::new and openai_manager_for_tests. It exercises the refresh fallback rule for empty ChatGPT responses.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog`  (lines 478–497)

```
async fn refresh_available_models_merges_hidden_only_chatgpt_remote_with_bundled_catalog()
```

**Purpose**: Verifies that a remote response containing only hidden models is merged with bundled models instead of replacing them. Hidden models may still be needed for direct selection, but should not wipe visible defaults.

**Data flow**: It creates one hidden remote model, appends it to the expected bundled list, refreshes, and checks the manager’s remote models match that combined list.

**Call relations**: The test builds the hidden model with remote_model_with_visibility and the manager with openai_manager_for_tests. It checks a special branch of the ChatGPT refresh merge logic.

*Call graph*: calls 3 internal fn (new, openai_manager_for_tests, remote_model_with_visibility); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_keeps_merging_for_api_auth`  (lines 500–530)

```
async fn refresh_available_models_keeps_merging_for_api_auth()
```

**Purpose**: Checks that API-key-style authentication still merges remote models with bundled models. API auth does not make the remote catalog the only source of truth in this test.

**Data flow**: It creates a fake endpoint that has command auth and is not Codex-backed, plus an AuthManager from an API key. After refresh, it expects bundled models plus the remote model, and exactly one fetch.

**Call relations**: The test calls openai_manager_for_tests_with_auth directly so it can supply API-key auth. It proves the refresh logic differs from ChatGPT-auth remote-only behavior.

*Call graph*: calls 3 internal fn (from_auth_for_testing, from_api_key, openai_manager_for_tests_with_auth); 6 external calls (new, new, new, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cache_when_fresh`  (lines 533–556)

```
async fn refresh_available_models_uses_cache_when_fresh()
```

**Purpose**: Ensures a fresh cache prevents a second remote fetch. This is important for speed and for avoiding unnecessary server calls.

**Data flow**: It refreshes once with a remote model, verifies that model is present, then refreshes again with the same strategy. It expects the model to remain present and the endpoint fetch count to stay at one.

**Call relations**: The test uses TestModelsEndpoint::new, openai_manager_for_tests, and assert_models_contain. It focuses on the cache hit path inside refresh_available_models.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_refetches_when_cache_stale`  (lines 559–590)

```
async fn refresh_available_models_refetches_when_cache_stale()
```

**Purpose**: Checks that old cached model data is refreshed from the endpoint. This keeps the model list from becoming permanently outdated.

**Data flow**: It fetches an initial model list, then edits the cache timestamp to make it look an hour old. On the next refresh, it expects the updated model list and a second endpoint fetch.

**Call relations**: The test uses the manager’s test-only cache manipulation hook, then verifies the result with assert_models_contain. It exercises the stale-cache branch.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_refetches_when_version_mismatch`  (lines 593–624)

```
async fn refresh_available_models_refetches_when_version_mismatch()
```

**Purpose**: Checks that cached model data is ignored when it was created for a different client version. This prevents old clients’ assumptions from leaking into a newer client.

**Data flow**: It refreshes once, mutates the cache’s stored client version to a mismatched value, then refreshes again. It expects the second queued response to replace the old data and the endpoint to have been called twice.

**Call relations**: The test uses a test-only cache mutation hook and assert_models_contain. It protects the version-checking part of refresh_available_models.

*Call graph*: calls 3 internal fn (new, assert_models_contain, openai_manager_for_tests); 3 external calls (assert_eq!, tempdir, vec!).


##### `refresh_available_models_drops_removed_remote_models`  (lines 627–669)

```
async fn refresh_available_models_drops_removed_remote_models()
```

**Purpose**: Ensures a later remote refresh replaces old remote models instead of keeping models the server no longer reports. This avoids showing stale or removed models.

**Data flow**: It prepares two endpoint responses: one with remote-old and one with remote-new. It sets the cache time-to-live to zero so the second refresh must fetch, then checks that remote-new is listed and remote-old is gone.

**Call relations**: The test uses openai_manager_for_tests and TestModelsEndpoint::new. It exercises refresh, cache expiry, and try_list_models together.

*Call graph*: calls 2 internal fn (new, openai_manager_for_tests); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_skips_network_without_chatgpt_auth`  (lines 672–702)

```
async fn refresh_available_models_skips_network_without_chatgpt_auth()
```

**Purpose**: Verifies that the manager does not fetch remote Codex models when no ChatGPT auth is available and the endpoint cannot refresh. This prevents unauthenticated network work.

**Data flow**: It builds a manager with no auth manager and an endpoint marked as not refresh-capable. After an online refresh request, it checks the dynamic remote model was not added and the endpoint was never fetched.

**Call relations**: The test uses TestModelsEndpoint::without_refresh and openai_manager_for_tests_with_auth. It checks the manager’s auth gate before network fetching.

*Call graph*: calls 2 internal fn (without_refresh, openai_manager_for_tests_with_auth); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `TestAuthAwareModelsEndpoint::new`  (lines 712–718)

```
fn new(auth_manager: Option<Arc<AuthManager>>, responses: Vec<Vec<ModelInfo>>) -> Arc<Self>
```

**Purpose**: Creates a fake endpoint whose Codex-backend answer depends on the current AuthManager. This lets tests check behavior when external auth changes the effective login mode.

**Data flow**: It receives an optional AuthManager and queued model responses. It stores them, initializes the fetch counter to zero, and returns the endpoint in a shared pointer.

**Call relations**: External-auth tests use this endpoint instead of TestModelsEndpoint. Its uses_codex_backend method asks the AuthManager what auth is active at call time.

*Call graph*: called by 2 (refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth, refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved); 3 external calls (new, new, new).


##### `TestAuthAwareModelsEndpoint::fetch_count`  (lines 720–722)

```
fn fetch_count(&self) -> usize
```

**Purpose**: Reports how many model fetches happened through the auth-aware fake endpoint. Tests use it to confirm whether external auth caused a fetch to be skipped or allowed.

**Data flow**: It reads the endpoint’s atomic fetch counter and returns the number. It does not modify the endpoint.

**Call relations**: The two external-auth refresh tests inspect this after calling refresh_available_models. The number is incremented only by TestAuthAwareModelsEndpoint::list_models.

*Call graph*: 1 external calls (load).


##### `TestAuthAwareModelsEndpoint::has_command_auth`  (lines 748–750)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Reports that this auth-aware fake endpoint does not have command auth. The tests here are focused on the active AuthManager state instead.

**Data flow**: It returns false every time and changes nothing.

**Call relations**: The models manager may ask this through ModelsEndpointClient. In these tests, the more important decision comes from uses_codex_backend.


##### `TestAuthAwareModelsEndpoint::uses_codex_backend`  (lines 752–754)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Adapts the endpoint trait to the endpoint’s async auth-aware check. It lets the models manager ask, in its normal way, whether Codex backend behavior is active.

**Data flow**: It takes the current endpoint, starts the internal async uses_codex_backend check, and returns it as the trait’s boxed future. The final answer depends on the AuthManager stored in the endpoint.

**Call relations**: The models manager calls this during refresh decisions. It hands off to the endpoint’s own auth-reading logic so external auth changes are reflected.

*Call graph*: 1 external calls (pin).


##### `TestAuthAwareModelsEndpoint::list_models`  (lines 756–761)

```
fn list_models(
        &'a self,
        _client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Returns the next prepared model list for the auth-aware fake endpoint. It is the simulated network fetch used when auth rules allow refreshing.

**Data flow**: It ignores the client version, increments the fetch counter, pops the next queued response, and returns it with no extra metadata. If no response is queued, it returns an empty list.

**Call relations**: External-auth refresh tests indirectly trigger this through the manager. Whether it is called depends on the result of uses_codex_backend and the active auth mode.

*Call graph*: 2 external calls (fetch_add, pin).


##### `refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth`  (lines 765–802)

```
async fn refresh_available_models_skips_network_when_external_api_key_overrides_chatgpt_auth()
```

**Purpose**: Checks that a resolved external API key overrides existing ChatGPT auth and prevents ChatGPT-style remote refresh. This matters when a user intentionally supplies API-key credentials.

**Data flow**: It creates dummy ChatGPT auth, installs a resolving external API-key auth source, and refreshes. It then checks that the dynamic remote model was not added and the endpoint fetch count stayed at zero.

**Call relations**: The test uses TestExternalApiKeyAuth, TestAuthAwareModelsEndpoint::new, and openai_manager_for_tests_with_auth. It proves external auth can change the manager’s refresh decision.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, openai_manager_for_tests_with_auth); 6 external calls (clone, new, assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved`  (lines 805–843)

```
async fn refresh_available_models_uses_cached_chatgpt_when_external_api_key_is_unresolved()
```

**Purpose**: Verifies that if an external API-key source fails, the manager can still use the existing ChatGPT auth. This avoids breaking model refresh because of an unavailable override.

**Data flow**: It starts with dummy ChatGPT auth, installs an external API-key auth source that errors, and refreshes online. It expects the remote model to appear and the endpoint to be fetched once.

**Call relations**: The test uses TestUnresolvedExternalApiKeyAuth and the auth-aware endpoint. It checks the fallback path from failed external auth back to cached ChatGPT credentials.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, openai_manager_for_tests_with_auth); 6 external calls (clone, new, assert!, assert_eq!, tempdir, vec!).


##### `refresh_available_models_fetches_with_chatgpt_auth_tokens`  (lines 846–879)

```
async fn refresh_available_models_fetches_with_chatgpt_auth_tokens()
```

**Purpose**: Checks that ChatGPT tokens loaded from auth.json are accepted for model refresh. This covers the real disk-backed credential path rather than only dummy auth.

**Data flow**: It writes and loads fake ChatGPT token auth, builds a manager with it, refreshes online, and verifies the dynamic model was added and the endpoint fetched once.

**Call relations**: The test calls chatgpt_auth_tokens_for_tests for setup, then openai_manager_for_tests_with_auth. It exercises the same refresh path a real logged-in user would use.

*Call graph*: calls 4 internal fn (from_auth_for_testing, new, chatgpt_auth_tokens_for_tests, openai_manager_for_tests_with_auth); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `build_available_models_picks_default_after_hiding_hidden_models`  (lines 882–897)

```
fn build_available_models_picks_default_after_hiding_hidden_models()
```

**Purpose**: Checks that the default visible model is chosen after hidden models are considered. A hidden model should not steal the default marker from the first visible model.

**Data flow**: It creates one hidden and one visible model, builds the available model presets, and expects the hidden preset plus the visible preset marked as default.

**Call relations**: The test uses remote_model_with_visibility and static_manager_for_tests. It targets StaticModelsManager::build_available_models directly.

*Call graph*: calls 3 internal fn (remote_model_with_visibility, static_manager_for_tests, from); 3 external calls (new, assert_eq!, vec!).


##### `static_manager_reads_latest_auth_mode`  (lines 900–935)

```
async fn static_manager_reads_latest_auth_mode()
```

**Purpose**: Verifies that StaticModelsManager checks the current auth mode each time it lists models. This matters because external auth can be added after the manager is created.

**Data flow**: It creates a static catalog with a ChatGPT-only model and an API-supported model. First, with ChatGPT auth, both are listed; after installing external API-key auth, only the API-supported model remains.

**Call relations**: The test uses TestExternalApiKeyAuth with a shared AuthManager. It proves list_models does not cache an outdated auth decision.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, new, remote_model); 4 external calls (clone, new, assert_eq!, vec!).


##### `bundled_models_json_roundtrips`  (lines 938–955)

```
fn bundled_models_json_roundtrips()
```

**Purpose**: Checks that the bundled models.json file can be parsed and serialized back without changing meaning. This protects the built-in catalog format.

**Data flow**: It loads the bundled response, serializes it to a JSON string, deserializes it back into ModelsResponse, and compares the two. It also checks the catalog is not empty.

**Call relations**: This test calls the crate’s bundled_models_response helper and serde JSON conversion functions. It does not use the fake endpoints or managers.

*Call graph*: 5 external calls (assert!, assert_eq!, bundled_models_response, from_str, to_string).


### `models-manager/src/model_info_overrides_tests.rs`

`test` · `test run`

The models manager needs to know how much text from tool output can be kept before it must be shortened. That shortening rule is called a truncation policy: it may be based on raw bytes, or on tokens, which are chunks of text used by language models. This test file checks that the manager picks the right policy even when no model data is fetched from an online endpoint.

Each test creates a temporary Codex home folder, so it can run without touching a real user’s files. It also creates a fake models endpoint with no models in it. That means the manager must fall back to its built-in offline knowledge about a model name.

The first test uses the default configuration and asks about a model. It expects the manager to use the built-in byte limit of 10,000. The second test sets `tool_output_token_limit` to 123 in the configuration. It then expects the manager to ignore the offline byte-style default and instead use a token-based limit of 123. In everyday terms, this file checks the “house rule versus user override” behavior: the house rule applies unless the user explicitly writes their own rule.

#### Function details

##### `offline_model_info_without_tool_output_override`  (lines 11–25)

```
async fn offline_model_info_without_tool_output_override()
```

**Purpose**: This test checks the normal offline fallback behavior when the user has not set a tool output limit. It verifies that model information for `gpt-5.2` uses the built-in truncation policy of 10,000 bytes.

**Data flow**: The test starts with a fresh temporary folder, the default models manager configuration, and a fake models endpoint that returns no online model data. It builds a test manager from those pieces, asks the manager for information about `gpt-5.2`, and then compares the returned truncation policy with the expected 10,000-byte policy. Nothing permanent is changed; the result is simply pass or fail.

**Call relations**: During the test, it calls helper constructors to create the temporary folder and fake endpoint, then uses `openai_manager_for_tests` to build a manager suitable for testing. The important handoff is to the manager’s `get_model_info` behavior, which must fall back to offline model information because the fake endpoint has no data. The final assertion checks that this fallback chose the expected default policy.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert_eq!, default, openai_manager_for_tests).


##### `offline_model_info_with_tool_output_override`  (lines 28–45)

```
async fn offline_model_info_with_tool_output_override()
```

**Purpose**: This test checks that a user-provided tool output token limit overrides the offline model default. It verifies that model information for `gpt-5.4` uses a token limit of 123 instead of the built-in byte limit.

**Data flow**: The test creates a fresh temporary folder and a configuration where `tool_output_token_limit` is set to 123. It also creates a fake empty models endpoint and builds a test manager. It asks for model information for `gpt-5.4`, then checks that the returned truncation policy is token-based with limit 123. The test only observes the returned value and does not write lasting state.

**Call relations**: This follows the same testing path as the no-override case: setup a fake environment, build the manager through `openai_manager_for_tests`, ask for model information, and assert the result. The key difference is the configuration passed into the manager lookup; that configuration should take priority when the manager decides the final truncation policy.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, new, assert_eq!, openai_manager_for_tests).


### `core/tests/suite/models_cache_ttl.rs`

`test` · `test run`

Codex keeps a local file, `models_cache.json`, with model information downloaded from the server. This is like keeping a restaurant menu at home: it saves a trip, but only if the menu is still current. These tests check the rules for deciding when that saved menu can be trusted.

The file uses a fake HTTP server so tests can control exactly what the remote `/models` endpoint and response API return. It also writes and edits cache files directly inside a temporary Codex home directory. That lets the tests simulate real situations: a cache whose timestamp is old, a cache written by the current client version, a cache with no version, and a cache from a different version.

One important behavior tested here is ETag renewal. An ETag is a server-provided label meaning “this content version.” If a normal response says the model ETag still matches, Codex should renew the cache’s time-to-live without downloading `/models` again. The other tests check client-version safety: a cache from the same client version is reused, but missing or different version metadata causes Codex to fetch fresh models. Without these checks, Codex could either waste network requests or use model data that no longer matches the running program.

#### Function details

##### `renews_cache_ttl_on_matching_models_etag`  (lines 47–148)

```
async fn renews_cache_ttl_on_matching_models_etag() -> Result<()>
```

**Purpose**: This test proves that when the server reports the same model ETag during a normal chat response, Codex refreshes the cache timestamp instead of calling `/models` again. It protects the intended behavior: keep the cache alive when the server says it is still valid.

**Data flow**: It starts a fake server with one remote model and a known ETag, then builds a test Codex instance. It first asks the models manager to populate the cache, rewrites the cache timestamp to an old date, then sends a user message whose fake response includes the same ETag. After the turn completes, it reads the cache file back and checks that the timestamp is newer, that `/models` was called only once, and that the cached model can still be listed while offline.

**Call relations**: This is the main end-to-end test for ETag-based cache renewal. It uses `test_remote_model` to create fake model data, `rewrite_cache_timestamp` to make the cache look stale, and `read_cache` to verify the final file. It also drives a full Codex turn through the test harness and fake response helpers so the renewal happens through the same path a real response would use.

*Call graph*: calls 11 internal fn (mount_models_once_with_etag, mount_response_once, sse, sse_response, local_selections, test_codex, turn_permission_fields, read_cache, rewrite_cache_timestamp, test_remote_model (+1 more)); 7 external calls (clone, default, start, assert!, assert_eq!, wait_for_event, vec!).


##### `uses_cache_when_version_matches`  (lines 151–195)

```
async fn uses_cache_when_version_matches() -> Result<()>
```

**Purpose**: This test checks that Codex trusts a model cache when it was written by the same client version that is currently running. The goal is to avoid an unnecessary `/models` network request.

**Data flow**: Before Codex is built, the test writes a cache file containing a fake model and the current client version. It also prepares a fake `/models` response that should not be needed. When the models manager lists models with the “online if uncached” strategy, the cached model comes out, and the fake server shows that `/models` was not contacted.

**Call relations**: This test uses `test_remote_model` to create the cached model and `write_cache_sync` inside the setup hook to place the cache on disk before startup. It then asks the models manager for models, proving that version-aware cache loading happens before any network refresh is attempted.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, assert!, assert_eq!, vec!).


##### `refreshes_when_cache_version_missing`  (lines 198–242)

```
async fn refreshes_when_cache_version_missing() -> Result<()>
```

**Purpose**: This test checks that Codex does not trust an old-style cache file that has no client version recorded. That matters because the meaning or shape of model data may have changed between client releases.

**Data flow**: The test writes a cache file with a fake cached model but leaves `client_version` empty. It prepares the fake server to return a different model. When the models manager lists models with the “online if uncached” strategy, Codex ignores the unversioned cache, fetches from `/models`, and returns the fresh remote model instead.

**Call relations**: This test again uses `test_remote_model` to build both cached and remote model entries, and uses `write_cache_sync` during setup to create the invalid cache. It fits beside the matching-version test by proving the opposite case: if the version marker is absent, the models manager must hand off to the network refresh path.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, assert!, assert_eq!, vec!).


##### `refreshes_when_cache_version_differs`  (lines 245–292)

```
async fn refreshes_when_cache_version_differs() -> Result<()>
```

**Purpose**: This test checks that Codex refreshes model data when the cache was written by a different client version. It prevents newer or older cached model metadata from being reused when it may no longer be compatible.

**Data flow**: The test writes a cache file containing a fake model and a deliberately altered client version string. It mounts fake `/models` responses that return a different model. When the models manager asks for models, Codex fetches from the server and returns the remote model, then the test confirms at least one `/models` request happened.

**Call relations**: This test uses `test_remote_model` to make both the stale cached model and the refreshed remote model. It complements the missing-version test by covering the case where a version exists but does not match, showing that the models manager treats it as stale and goes to the server.

*Call graph*: calls 4 internal fn (mount_models_once, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 4 external calls (start, new, assert!, vec!).


##### `rewrite_cache_timestamp`  (lines 294–299)

```
async fn rewrite_cache_timestamp(path: &Path, fetched_at: DateTime<Utc>) -> Result<()>
```

**Purpose**: This helper changes only the `fetched_at` time inside an existing cache file. The tests use it to make a fresh cache look old without changing the model data inside it.

**Data flow**: It receives a path to a cache file and the replacement timestamp. It reads the cache from disk, swaps the `fetched_at` value, writes the updated cache back to the same path, and returns success or an error.

**Call relations**: The ETag renewal test calls this helper after the cache has been populated. Internally it relies on `read_cache` to load the file and `write_cache` to save the edited version, keeping the test setup simple and focused.

*Call graph*: calls 2 internal fn (read_cache, write_cache); called by 1 (renews_cache_ttl_on_matching_models_etag).


##### `read_cache`  (lines 301–305)

```
async fn read_cache(path: &Path) -> Result<ModelsCache>
```

**Purpose**: This helper loads a `models_cache.json` file and turns it into a `ModelsCache` value the test can inspect. It lets tests check the cache contents directly instead of guessing from outside behavior.

**Data flow**: It takes a file path, reads the raw bytes from disk, parses those bytes as JSON, and returns the structured cache data. If the file cannot be read or the JSON is invalid, it returns an error.

**Call relations**: The ETag renewal test uses this after a Codex turn to verify the timestamp. `rewrite_cache_timestamp` also uses it as the first step before editing and writing the cache back.

*Call graph*: called by 2 (renews_cache_ttl_on_matching_models_etag, rewrite_cache_timestamp); 2 external calls (from_slice, read).


##### `write_cache`  (lines 307–311)

```
async fn write_cache(path: &Path, cache: &ModelsCache) -> Result<()>
```

**Purpose**: This helper saves a `ModelsCache` value to disk using readable JSON formatting. It is the asynchronous writer used when a test is already running inside async code.

**Data flow**: It takes a file path and a cache object, converts the cache into pretty JSON bytes, writes those bytes to the path, and returns success or an error.

**Call relations**: `rewrite_cache_timestamp` calls this after changing the timestamp. Together, `read_cache` and `write_cache` form a small edit cycle: load the cache, change one field, and save it again.

*Call graph*: called by 1 (rewrite_cache_timestamp); 2 external calls (to_vec_pretty, write).


##### `write_cache_sync`  (lines 313–317)

```
fn write_cache_sync(path: &Path, cache: &ModelsCache) -> Result<()>
```

**Purpose**: This helper writes a `ModelsCache` file using normal blocking file I/O. It is useful during early test setup, before the async Codex test instance has been built.

**Data flow**: It receives a path and cache object, converts the cache to pretty JSON, writes it to disk immediately, and returns success or an error.

**Call relations**: The version-related tests use this in pre-build setup hooks to place a prepared cache file into the temporary Codex home directory. That means Codex starts up as if a cache already existed from an earlier run.

*Call graph*: 2 external calls (to_vec_pretty, write).


##### `test_remote_model`  (lines 329–379)

```
fn test_remote_model(slug: &str, priority: i32) -> ModelInfo
```

**Purpose**: This helper builds a complete fake `ModelInfo` record for tests. It hides the many required fields so each test only has to choose the model name and priority.

**Data flow**: It takes a model slug, which is the model’s identifier, and a priority number used for ordering. It fills in the rest of the model metadata with realistic test defaults, such as reasoning options, visibility, context-window size, tool support flags, and input modalities, then returns the finished model object.

**Call relations**: All four tests call this when they need model data for either a fake server response or a prewritten cache file. By centralizing the model shape here, the tests stay focused on cache behavior rather than on constructing every model field by hand.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); called by 4 (refreshes_when_cache_version_differs, refreshes_when_cache_version_missing, renews_cache_ttl_on_matching_models_etag, uses_cache_when_version_matches); 3 external calls (default, new, vec!).


### API client and authentication tests
These files verify client-side HTTP/WebSocket contracts, auth/token handling, transport shaping, and backend-facing support behavior across the API stack.

### `backend-client/src/client/rate_limit_resets_tests.rs`

`test` · `test run`

This test file protects a small but important part of the client-server agreement: how the CLI asks about rate limits and how it spends a “rate-limit reset credit.” A rate-limit reset credit is a server-side allowance that can reset usage windows; if the client sends the wrong path or the wrong JSON field names, the feature would fail even if the rest of the program works.

The test checks two URL styles. One is the Codex API style, where paths are under `/api/codex`. The other is the ChatGPT backend style, where paths are under `/wham`. This matters because the same client code can talk to different backend layouts, and each layout expects different endpoint paths.

The test also checks JSON serialization and deserialization. Serialization means turning a Rust value into JSON to send over the network. Deserialization means reading JSON from the server back into Rust values. It confirms that the request contains `redeem_request_id`, that rate-limit reset credit counts are read correctly from a usage response, and that an extra `credit` object in the consume response is safely ignored by the CLI. In other words, this file is a smoke alarm for accidental API contract changes.

#### Function details

##### `rate_limit_reset_contract_uses_expected_paths_and_payloads`  (lines 7–59)

```
fn rate_limit_reset_contract_uses_expected_paths_and_payloads()
```

**Purpose**: This test verifies the exact URLs and JSON formats used for rate-limit reset credits. It helps catch breaking changes before they reach users, such as a renamed JSON field or a wrong API path.

**Data flow**: The test starts by building temporary clients with known base URLs and path styles. It asks those clients for their rate-limit status and credit-consume URLs, then compares the results to the expected strings. Next, it turns a request value into JSON and checks the JSON field name. Finally, it reads sample JSON responses into Rust values and checks that the important fields, such as available credit count and windows reset, come out correctly.

**Call relations**: The Rust test runner calls this function during automated tests. Inside the test, it calls `test_client` to make lightweight client objects, uses JSON conversion helpers to simulate what would be sent to or received from the server, and uses assertions to fail the test if the client no longer matches the expected API contract.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `test_client`  (lines 61–71)

```
fn test_client(base_url: &str, path_style: PathStyle) -> Client
```

**Purpose**: This helper builds a simple `Client` configured for tests. It lets the main test focus on URL and JSON behavior without needing real authentication or a live server.

**Data flow**: It receives a base URL string and a path style. It creates a `Client` with that base URL, a fresh HTTP client, an unauthenticated authentication provider, no user-agent override, no ChatGPT account information, and the supplied path style. The finished client is returned to the test.

**Call relations**: The contract test calls this helper whenever it needs a client with a specific backend layout. The helper uses `reqwest::Client::new` to create the underlying web client and `unauthenticated_auth_provider` so the test can construct a client without real login credentials.

*Call graph*: calls 1 internal fn (new); 1 external calls (unauthenticated_auth_provider).


### `login/src/token_data_tests.rs`

`test` · `test run`

This is a test file for the login token code. The project receives identity tokens in JWT form, where JWT means “JSON Web Token”: a string made of three dot-separated parts that contains account information in the middle. These tests build small fake tokens and then ask the real parsing code to read them, much like giving a scanner sample tickets to make sure it reads the name, date, and ticket type correctly.

The helper `fake_jwt` creates simple unsigned test tokens. The tests then cover the main things the login system depends on: extracting an email, turning raw plan codes like `pro`, `go`, or `hc` into user-facing plan names, recognizing workspace-style accounts, reading FedRAMP account flags, and finding the token expiration time. They also check safe behavior when fields are missing and when the token is not shaped like a JWT at all.

This matters because login token data can affect what account the user appears to have and what environment rules apply. If this parsing broke, a user might be shown the wrong plan, a workspace account might be treated like a personal account, or an invalid token might be accepted too far into the flow.

#### Function details

##### `fake_jwt`  (lines 8–27)

```
fn fake_jwt(payload: serde_json::Value) -> String
```

**Purpose**: Builds a small fake JWT string for the tests. It lets each test focus on the token contents it cares about without needing a real login service or real cryptographic signing.

**Data flow**: It takes a JSON payload chosen by the test. It creates a fixed JWT header, turns both the header and payload into JSON bytes, base64-url encodes them without padding, adds a dummy signature, and returns one dot-separated token string.

**Call relations**: The token-specific tests call this helper before they exercise the real parsing code. It uses JSON serialization and string formatting so the rest of the file can work with realistic-looking tokens instead of hand-written encoded strings.

*Call graph*: called by 8 (id_token_info_handles_missing_fields, id_token_info_parses_email_and_plan, id_token_info_parses_fedramp_account_claim, id_token_info_parses_go_plan, id_token_info_parses_hc_plan_as_enterprise, id_token_info_parses_usage_based_business_plans, jwt_expiration_handles_missing_exp, jwt_expiration_parses_exp_claim); 2 external calls (format!, to_vec).


##### `id_token_info_parses_email_and_plan`  (lines 30–41)

```
fn id_token_info_parses_email_and_plan()
```

**Purpose**: Checks that a token containing an email and a `pro` plan is read correctly. This confirms that the parser can find normal account details inside the nested authentication claim.

**Data flow**: It starts with JSON containing an email and a raw plan code of `pro`. That JSON becomes a fake JWT, the parser reads it into token information, and the test verifies that the email is present and the plan is reported as `Pro`.

**Call relations**: This test uses `fake_jwt` to prepare the input token, then relies on assertions to compare the parser’s output with the expected email and plan name.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_go_plan`  (lines 44–55)

```
fn id_token_info_parses_go_plan()
```

**Purpose**: Checks that the raw `go` plan code is recognized and displayed as `Go`. This protects support for that specific subscription plan.

**Data flow**: It builds a fake token with an email and a `chatgpt_plan_type` value of `go`. After parsing, the test checks that the email is still available and that the plan name has been converted to `Go`.

**Call relations**: This follows the same pattern as the other plan tests: create JSON with `json!`, wrap it with `fake_jwt`, then use equality assertions to confirm the production parser’s result.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_hc_plan_as_enterprise`  (lines 58–70)

```
fn id_token_info_parses_hc_plan_as_enterprise()
```

**Purpose**: Checks that the raw `hc` plan code is treated as an Enterprise plan and also counted as a workspace account. This is important because workspace accounts may follow different rules from personal accounts.

**Data flow**: It puts the raw plan code `hc` into a fake token. After parsing, it checks three outcomes: the email is read, the visible plan name is `Enterprise`, and the workspace-account check returns true.

**Call relations**: The test depends on `fake_jwt` for the token shape and uses assertions to pin down both the displayed plan mapping and the workspace classification.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_parses_usage_based_business_plans`  (lines 73–108)

```
fn id_token_info_parses_usage_based_business_plans()
```

**Purpose**: Checks two usage-based business plan codes and makes sure both their friendly names and raw values are preserved. It also verifies that these plans count as workspace accounts.

**Data flow**: It first builds a token for `self_serve_business_usage_based`, parses it, and checks the friendly name, original raw plan string, and workspace status. It then repeats the same flow for `enterprise_cbp_usage_based`.

**Call relations**: This test calls `fake_jwt` twice because it covers two related plan types. Its assertions make sure the parser both translates the plan for display and keeps the original code available for logic that may need the exact source value.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `id_token_info_handles_missing_fields`  (lines 111–118)

```
fn id_token_info_handles_missing_fields()
```

**Purpose**: Checks that the parser behaves calmly when optional token fields are absent. Missing email, plan, or FedRAMP information should not make parsing fail.

**Data flow**: It creates a fake token with only a basic subject field and no email or authentication details. After parsing, the test confirms that email and plan are empty and that FedRAMP status defaults to false.

**Call relations**: This test uses `fake_jwt` to create a minimal token and then uses assertions to confirm the parser returns sensible empty/default values instead of inventing data or crashing.

*Call graph*: calls 1 internal fn (fake_jwt); 3 external calls (assert!, assert_eq!, json!).


##### `id_token_info_parses_fedramp_account_claim`  (lines 121–133)

```
fn id_token_info_parses_fedramp_account_claim()
```

**Purpose**: Checks that FedRAMP account information is read from the token. FedRAMP is a U.S. government security compliance program, so this flag can affect how an account should be treated.

**Data flow**: It builds a fake token whose nested authentication claim contains an account ID and a true FedRAMP flag. After parsing, it checks that the account ID is present and that the FedRAMP check returns true.

**Call relations**: This test prepares its input with `fake_jwt` and uses equality assertions to verify that the production token parser exposes both the account identifier and the FedRAMP boolean correctly.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_parses_exp_claim`  (lines 136–143)

```
fn jwt_expiration_parses_exp_claim()
```

**Purpose**: Checks that the expiration time in a JWT is converted into a real timestamp. This matters because login code needs to know when a token should stop being trusted.

**Data flow**: It creates a fake token with an `exp` value, which is the standard JWT expiration time expressed as seconds since 1970-01-01 UTC. The expiration parser reads that number and returns the matching UTC timestamp.

**Call relations**: The test uses `fake_jwt` for the token and then compares the parser’s result with a timestamp built by the time library, ensuring both sides refer to the same instant.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_handles_missing_exp`  (lines 146–151)

```
fn jwt_expiration_handles_missing_exp()
```

**Purpose**: Checks that a token without an expiration claim is still parsed successfully, but returns no expiration time. This distinguishes “field not present” from “token is malformed.”

**Data flow**: It creates a fake token with no `exp` field. The expiration parser reads the token and returns `None`, meaning there was no expiration value to report.

**Call relations**: This test uses `fake_jwt` to make a valid JWT-shaped token, then uses an equality assertion to confirm the expiration parser treats the missing field as an empty result rather than an error.

*Call graph*: calls 1 internal fn (fake_jwt); 2 external calls (assert_eq!, json!).


##### `jwt_expiration_rejects_malformed_jwt`  (lines 154–157)

```
fn jwt_expiration_rejects_malformed_jwt()
```

**Purpose**: Checks that the expiration parser rejects a string that is not shaped like a JWT. This prevents later code from treating random text as a valid login token.

**Data flow**: It passes the plain string `not-a-jwt` into the expiration parser. The parser returns an error, and the test checks that the error message says the ID token format is invalid.

**Call relations**: Unlike the other expiration tests, this one deliberately does not use `fake_jwt`. It goes straight to the failure case and uses an assertion to lock in the expected error behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `workspace_account_detection_matches_workspace_plans`  (lines 160–178)

```
fn workspace_account_detection_matches_workspace_plans()
```

**Purpose**: Checks the rule that decides whether an account plan is a workspace account. It confirms that Business is treated as workspace, while Pro and Pro Lite are treated as personal plans.

**Data flow**: It creates three `IdTokenInfo` values directly, each with a different known plan and default values for everything else. It calls the workspace check on each one and verifies the expected true or false result.

**Call relations**: This test does not need fake JWTs because it is testing the account-classification rule directly. It constructs token-info objects, using default values for unrelated fields, and then asserts the workspace decision for each plan.

*Call graph*: 3 external calls (assert_eq!, Known, default).


### `login/src/auth/default_client_tests.rs`

`test` · `test run`

This is a test file. Its job is to catch mistakes in the default authentication client before they reach users or services. When Codex sends web requests, it includes headers such as an originator, a User-Agent, and sometimes a residency requirement. These are like labels on a package: they tell the receiving service who sent it, what app version sent it, and whether the request must stay in a certain region.

The tests cover three main ideas. First, they make sure the User-Agent starts with the expected Codex originator name, so services can recognize the client. Second, they check which originator strings count as official first-party Codex clients, including a separate category for chat-related clients. Third, they create a real HTTP client and send a request to a local mock server, then inspect the received headers to confirm the client actually attaches the expected values.

The file also tests safety around User-Agent text. Some characters, such as carriage returns or null bytes, are unsafe inside HTTP headers because they can confuse parsers or even create security problems. The sanitizing tests confirm those characters are replaced with safe underscores. On macOS, there is an extra platform-specific test that checks the User-Agent includes the expected operating system and CPU information.

#### Function details

##### `test_get_codex_user_agent`  (lines 7–12)

```
fn test_get_codex_user_agent()
```

**Purpose**: This test checks that the generated Codex User-Agent begins with the current originator name followed by a slash. Someone would use this test to make sure requests can still be recognized as coming from the expected Codex client.

**Data flow**: It asks the auth code for the User-Agent string and separately asks for the current originator value. It builds the expected beginning of the string, then checks that the User-Agent starts with that prefix. Nothing is changed; the result is simply pass or fail.

**Call relations**: The Rust test runner calls this during the test suite. Inside the test, it relies on the normal User-Agent-building path and uses a basic assertion to confirm the visible output has the right shape.

*Call graph*: 2 external calls (assert!, format!).


##### `is_first_party_originator_matches_known_values`  (lines 15–22)

```
fn is_first_party_originator_matches_known_values()
```

**Purpose**: This test confirms which originator names are treated as official Codex clients. It protects the rule that some names are trusted first-party names while similar-looking names are not.

**Data flow**: It feeds several known originator strings into the first-party originator check. For each one, it compares the answer with the expected true or false value. It produces no stored data; it only succeeds if all classifications match the expected list.

**Call relations**: The test runner calls this as part of the auth client tests. It focuses on the originator classification helper and uses equality assertions to make the intended boundary clear.

*Call graph*: 1 external calls (assert_eq!).


##### `is_first_party_chat_originator_matches_known_values`  (lines 25–33)

```
fn is_first_party_chat_originator_matches_known_values()
```

**Purpose**: This test checks the narrower rule for first-party chat originators. It makes sure chat-specific Codex clients are recognized without accidentally treating other Codex clients as chat clients.

**Data flow**: It passes known chat and non-chat originator strings into the chat-originator check. Each returned answer is compared with the expected result. The only output is whether the test passes.

**Call relations**: The test runner invokes this test during the suite. It complements the broader originator test by checking the chat-specific branch of the same kind of identification logic.

*Call graph*: 1 external calls (assert_eq!).


##### `test_create_client_sets_default_headers`  (lines 36–90)

```
async fn test_create_client_sets_default_headers()
```

**Purpose**: This async test verifies that the default HTTP client really sends the headers the auth system promises to send. It checks the behavior over an actual local request rather than only inspecting configuration in memory.

**Data flow**: It first skips itself if the environment should not run network-style tests. It sets a default residency requirement to the United States, creates the client, starts a local mock web server, and sends a GET request to it. After the server receives the request, the test reads the request headers and checks that the originator, User-Agent, and residency header contain the expected values. At the end, it clears the residency setting so later tests do not inherit it.

**Call relations**: The async test runner calls this test. The test sets up a mock server, sends a request through the real client-building path, then uses assertions to compare what arrived at the server with what the auth client should have attached.

*Call graph*: 6 external calls (given, start, new, assert!, assert_eq!, skip_if_no_network!).


##### `test_invalid_suffix_is_sanitized`  (lines 93–101)

```
fn test_invalid_suffix_is_sanitized()
```

**Purpose**: This test makes sure a carriage return character in a User-Agent suffix is made safe. That matters because unsafe header characters can break HTTP formatting or create security risks.

**Data flow**: It starts with a normal User-Agent prefix and a suffix containing a carriage return. It passes the combined string through the sanitizing function. The expected output is the same text with the unsafe character replaced by an underscore.

**Call relations**: The test runner calls this test with the rest of the file. It exercises the User-Agent cleanup path and uses an equality assertion to show the exact safe string expected afterward.

*Call graph*: 1 external calls (assert_eq!).


##### `test_invalid_suffix_is_sanitized2`  (lines 104–112)

```
fn test_invalid_suffix_is_sanitized2()
```

**Purpose**: This test makes sure a null byte in a User-Agent suffix is made safe. It covers a different unsafe character from the previous test so the sanitizing rule is not too narrow.

**Data flow**: It creates a User-Agent-like string whose suffix contains a null byte. It sends that string through the sanitizer along with the expected safe prefix. The returned string should replace the null byte with an underscore and leave the rest readable.

**Call relations**: The test runner invokes this alongside the other sanitizing test. Together, they show that multiple kinds of invalid header characters are cleaned before the User-Agent is used.

*Call graph*: 1 external calls (assert_eq!).


##### `test_macos`  (lines 116–125)

```
fn test_macos()
```

**Purpose**: This macOS-only test checks that the generated User-Agent has the expected Mac-specific format. It verifies that the string includes the originator, version, macOS version, CPU type, and a final non-space detail.

**Data flow**: On macOS, it gets the current User-Agent and escapes the originator text so it can be safely used in a regular expression, which is a pattern used to match text. It builds a pattern for the expected User-Agent shape and checks that the generated string matches it. It does not change state; it only passes or fails.

**Call relations**: The test runner includes this test only when the code is built on macOS. It relies on a regular-expression check because the exact OS version and CPU can vary from machine to machine, while the overall format must stay stable.

*Call graph*: 4 external calls (new, assert!, format!, escape).


### `chatgpt/src/workspace_settings_tests.rs`

`test` · `test run`

This is a small test file for `encode_path_segment`, a helper that turns one piece of a path into a safe encoded form. A path segment is like one label in an address: if the label itself contains a slash, that slash must not accidentally become a new folder or URL level. These tests make sure the helper keeps safe characters unchanged, while escaping characters that would change the meaning of the path.

The first test uses ordinary letters, numbers, and common safe symbols such as `-`, `_`, `.`, and `~`. It confirms they pass through exactly as they are. The second test uses a slash and a space. It confirms the slash becomes `%2F` and the space becomes `%20`, which are percent-encoded forms commonly used in URLs. In everyday terms, this is like putting a fragile label inside protective wrapping before sending it through a sorting machine: the machine should not mistake part of the label for routing instructions.

Without tests like these, a future change could accidentally make workspace identifiers or account names unsafe when placed into paths, causing broken requests, wrong lookups, or confusing security-sensitive behavior.

#### Function details

##### `encode_path_segment_leaves_unreserved_ascii_unchanged`  (lines 4–9)

```
fn encode_path_segment_leaves_unreserved_ascii_unchanged()
```

**Purpose**: This test proves that already-safe ASCII characters are not changed by `encode_path_segment`. It matters because encoding should not make clean, readable path pieces unnecessarily different.

**Data flow**: The test starts with the text `account-123_ABC.~`. It passes that text into `encode_path_segment`, then compares the result with the exact same text. If the two strings match, the test succeeds; if the helper changes any safe character, the test fails.

**Call relations**: During the test run, the Rust test framework calls this function. Inside it, the `assert_eq!` check acts as the judge: it compares the encoded output with the expected unchanged value and reports a failure if they differ.

*Call graph*: 1 external calls (assert_eq!).


##### `encode_path_segment_escapes_path_separators_and_spaces`  (lines 12–17)

```
fn encode_path_segment_escapes_path_separators_and_spaces()
```

**Purpose**: This test proves that characters with special meaning in paths, specifically a slash and a space, are escaped by `encode_path_segment`. This prevents one intended path piece from being accidentally split or misread.

**Data flow**: The test starts with the text `account/123 with space`. It sends that text to `encode_path_segment`, expecting the slash to become `%2F` and the spaces to become `%20`. The output is compared with `account%2F123%20with%20space`; matching means the helper protected those characters correctly.

**Call relations**: The Rust test framework calls this function as part of the test suite. The function then uses `assert_eq!` to hand the actual and expected strings to Rust's built-in comparison check, which decides whether this behavior still works as intended.

*Call graph*: 1 external calls (assert_eq!).


### `codex-api/src/api_bridge_tests.rs`

`test` · `test suite`

This is a test file for the API bridge, the layer that turns lower-level API failures into errors the rest of Codex can understand. Think of it like checking a translator: when the server says “too busy,” “policy blocked,” or “you are out of quota,” Codex should hear the correct meaning and react properly.

Each test builds a fake API failure. Some failures are plain error values, while others look like real HTTP responses with a status code, headers, and a JSON body. JSON is the common text format used by web APIs to send structured data. The tests then call `map_api_error`, which is the real conversion function being protected here, and check the result.

The cases cover several important edge conditions. A 503 response with a special body should become `ServerOverloaded`. A 400 response with `cyber_policy` should become a cyber-policy error, including a helpful message or a safe fallback if the message is missing. Unknown 400 errors should stay generic instead of being misread. Usage-limit responses should read specific rate-limit headers carefully, without inventing missing values. Authentication failures should preserve request IDs and identity-related details from headers so debugging remains possible.

#### Function details

##### `map_api_error_maps_server_overloaded`  (lines 6–9)

```
fn map_api_error_maps_server_overloaded()
```

**Purpose**: This test checks the simplest overload case: when the API error is already marked as “server overloaded,” the bridge should keep that meaning. It makes sure Codex can recognize a busy server instead of treating it like an unknown failure.

**Data flow**: It starts with an `ApiError::ServerOverloaded` value. It sends that value into `map_api_error`, then checks that the result is `CodexErr::ServerOverloaded`. Nothing outside the test is changed.

**Call relations**: The Rust test runner calls this test during the test suite. Inside the test, the main handoff is to `map_api_error`; the final `assert!` verifies that the returned error has the expected shape.

*Call graph*: 1 external calls (assert!).


##### `map_api_error_maps_server_overloaded_from_503_body`  (lines 12–27)

```
fn map_api_error_maps_server_overloaded_from_503_body()
```

**Purpose**: This test checks that an HTTP 503 response can still be recognized as server overload when the response body says so. A 503 status means “service unavailable,” and here the body gives the more specific reason.

**Data flow**: It builds a small JSON body containing the code `server_is_overloaded`, wraps it in a fake HTTP transport error with status 503, and passes that into `map_api_error`. The expected output is `CodexErr::ServerOverloaded`.

**Call relations**: The test runner invokes this test. The test uses JSON construction and a transport-error wrapper to imitate a real server response, then relies on `map_api_error` to interpret it and `assert!` to confirm the result.

*Call graph*: 3 external calls (assert!, Transport, json!).


##### `map_api_error_maps_cyber_policy_from_400_body`  (lines 30–54)

```
fn map_api_error_maps_cyber_policy_from_400_body()
```

**Purpose**: This test checks that a bad-request response marked with `cyber_policy` becomes a specific cyber-policy error. That matters because this kind of block should be explained clearly, not hidden inside a generic invalid request.

**Data flow**: It creates a fake HTTP 400 response with a JSON error body that includes a cyber-policy code and a human-readable message. After `map_api_error` converts it, the test extracts the cyber-policy message and checks that it matches the message from the server.

**Call relations**: The test runner calls this test. The test builds realistic response data with the JSON helper, passes it through the transport-error path into `map_api_error`, and uses `panic!` only if the returned error is not the expected cyber-policy kind.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_maps_wrapped_websocket_cyber_policy_from_400_body`  (lines 57–79)

```
fn map_api_error_maps_wrapped_websocket_cyber_policy_from_400_body()
```

**Purpose**: This test checks a websocket-style error format. A websocket is a long-lived network connection, and its errors may be wrapped differently from normal HTTP errors, so this ensures cyber-policy blocks are still understood.

**Data flow**: It creates a fake HTTP 400 response whose JSON body has an outer `type: error` wrapper and an inner cyber-policy error. It passes that response to `map_api_error`, then checks that the output is a cyber-policy error with the message from the inner error.

**Call relations**: The test runner runs this case alongside the other bridge tests. The test hands a websocket-looking transport error to `map_api_error`; if the bridge does not unwrap it correctly, the pattern check fails and the test panics.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_uses_cyber_policy_fallback_for_missing_message`  (lines 82–103)

```
fn map_api_error_uses_cyber_policy_fallback_for_missing_message()
```

**Purpose**: This test makes sure Codex still gives users a useful cyber-policy message when the server provides only the policy code and no message. It prevents an empty or confusing error from reaching the user.

**Data flow**: It builds a fake HTTP 400 response whose JSON body contains `code: cyber_policy` but no message. After conversion through `map_api_error`, the test expects a cyber-policy error with Codex’s built-in fallback text.

**Call relations**: The test runner calls this test. The test creates the response body with the JSON helper, sends it through `map_api_error`, and checks the final message with `assert_eq!`.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_keeps_unknown_400_errors_generic`  (lines 106–125)

```
fn map_api_error_keeps_unknown_400_errors_generic()
```

**Purpose**: This test checks that Codex does not over-interpret every bad request as a special policy error. Unknown 400 errors should remain generic so the bridge does not give users the wrong explanation.

**Data flow**: It creates a fake HTTP 400 response with an unfamiliar error code. It passes that response into `map_api_error`, then verifies that the output is a generic invalid-request error containing the original response body.

**Call relations**: The test runner invokes this test. The test uses a transport-error wrapper to mimic the API response, then depends on `map_api_error` to choose the conservative generic path rather than the cyber-policy path.

*Call graph*: 4 external calls (assert_eq!, Transport, panic!, json!).


##### `map_api_error_maps_usage_limit_limit_name_header`  (lines 128–162)

```
fn map_api_error_maps_usage_limit_limit_name_header()
```

**Purpose**: This test checks that usage-limit errors can include the friendly limit name from HTTP headers. Headers are small pieces of metadata attached to a web response, and here they help Codex explain which limit was hit.

**Data flow**: It creates response headers that identify an active limit and provide a matching limit name. It also creates a fake 429 response, where 429 means “too many requests.” After `map_api_error` converts the response, the test checks that the usage-limit result contains the expected limit name.

**Call relations**: The test runner calls this test. The test builds a header map, wraps it in a transport error, hands it to `map_api_error`, and then inspects the returned usage-limit details with `assert_eq!`.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, panic!, json!).


##### `map_api_error_does_not_fallback_limit_name_to_limit_id`  (lines 165–195)

```
fn map_api_error_does_not_fallback_limit_name_to_limit_id()
```

**Purpose**: This test checks a subtle safety rule: if the response gives a limit ID but not a separate limit name, Codex should not pretend the ID is the name. This keeps displayed usage-limit details accurate.

**Data flow**: It creates a fake 429 usage-limit response with an active-limit header but without the matching limit-name header. After conversion through `map_api_error`, the test verifies that the stored limit name is missing rather than filled in from the ID.

**Call relations**: The test runner runs this case to guard against an easy mistake in the error translator. The test prepares headers, calls `map_api_error`, and checks the returned usage-limit snapshot for an absent name.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, panic!, json!).


##### `map_api_error_ignores_unparseable_rate_limit_reached_type_headers`  (lines 198–226)

```
fn map_api_error_ignores_unparseable_rate_limit_reached_type_headers()
```

**Purpose**: This test checks that strange or future rate-limit header values do not break error conversion. If the bridge cannot understand a header, it should ignore that one detail rather than failing or guessing.

**Data flow**: It tries two invalid header values: one text value the current code does not know, and one byte value that is not readable text. For each value, it builds a fake 429 usage-limit response, passes it to `map_api_error`, and checks that the returned usage-limit error has no parsed rate-limit type.

**Call relations**: The test runner calls this test, and the test loops through the invalid header examples. Each loop sends a transport error to `map_api_error`; the assertions confirm that unrecognized header data is dropped safely.

*Call graph*: 7 external calls (new, assert_eq!, Transport, from_bytes, from_static, panic!, json!).


##### `map_api_error_extracts_identity_auth_details_from_headers`  (lines 229–261)

```
fn map_api_error_extracts_identity_auth_details_from_headers()
```

**Purpose**: This test checks that authentication failures keep useful debugging details from the response headers. That includes request tracking IDs and identity-service error codes, which help explain why a login or token check failed.

**Data flow**: It builds a fake 401 unauthorized response with several headers: a request ID, a Cloudflare ray ID, an authorization error, and a base64-encoded JSON error. Base64 is a way to safely store text as header-friendly characters. After `map_api_error` converts the response, the test checks that the resulting unexpected-status error contains all those extracted details.

**Call relations**: The test runner invokes this test. The test assembles realistic headers, including an encoded error payload, sends the fake transport error into `map_api_error`, and uses equality checks to confirm that the bridge preserved the diagnostic information.

*Call graph*: 6 external calls (new, assert_eq!, Transport, from_static, from_str, panic!).


### `codex-api/tests/clients.rs`

`test` · `test suite`

This is a test file for the code that sends streaming requests to the Responses API. Instead of contacting a real server, it builds pretend network layers. One fake transport simply records the outgoing request, like a clipboard that lets the test inspect what would have been sent. Another fake transport fails the first time and succeeds the second time, so the tests can prove retry behavior works.

The tests focus on details that matter when talking to an API: the client must use the right URL path, preserve the exact JSON body, add authentication headers, set streaming headers, retry safe failures, and avoid retrying configuration mistakes. There are also checks for Azure-style request metadata, such as session and thread IDs.

The helper authentication types let the tests cover different real-world situations: no authentication, fixed bearer-token authentication, and authentication that fails once. The overall goal is to protect the client’s contract with external services. If this file were missing, bugs such as sending requests to the wrong endpoint, losing request data during retries, or retrying the wrong kind of authentication failure could slip through unnoticed.

#### Function details

##### `assert_path_ends_with`  (lines 31–38)

```
fn assert_path_ends_with(requests: &[Request], suffix: &str)
```

**Purpose**: Checks that exactly one request was recorded and that its URL ends with the expected path. It is used to make sure the client sends Responses API calls to the correct endpoint.

**Data flow**: It receives a list of recorded requests and an expected URL ending. It verifies there is one request, reads that request’s URL, and fails the test if the URL does not end with the expected text.

**Call relations**: The endpoint-path test calls this helper after the fake transport records a request. The helper turns the recorded request into a simple pass-or-fail check about the final URL.

*Call graph*: called by 1 (responses_client_uses_responses_path); 2 external calls (assert!, assert_eq!).


##### `request_body_bytes`  (lines 40–45)

```
fn request_body_bytes(request: &Request) -> &[u8]
```

**Purpose**: Extracts the raw JSON bytes from a prepared test request. It exists so tests can inspect the exact body the client planned to send.

**Data flow**: It receives a request, looks for a JSON body stored in the expected prepared form, and returns the body as bytes. If the request has no such body, it stops the test with a clear failure.

**Call relations**: The Azure metadata test uses this after the request has been captured. It lets that test parse the outgoing JSON and confirm that message IDs were preserved.

*Call graph*: called by 1 (azure_default_store_attaches_ids_and_headers); 1 external calls (panic!).


##### `RecordingState::record`  (lines 53–59)

```
fn record(&self, req: Request)
```

**Purpose**: Saves one outgoing request into shared test state. This gives tests a way to inspect requests after the client has tried to stream them.

**Data flow**: It receives a request, locks the shared request list so only one task edits it at a time, and appends the request to that list. It does not return a value; the stored request is the result.

**Call relations**: The recording transport calls this whenever its stream method is used. Later, individual tests retrieve the saved request list to make assertions about URLs, headers, and bodies.

*Call graph*: called by 1 (stream).


##### `RecordingState::take_stream_requests`  (lines 61–67)

```
fn take_stream_requests(&self) -> Vec<Request>
```

**Purpose**: Returns all recorded streaming requests and clears the stored list. This keeps each test assertion focused on the requests made during that test step.

**Data flow**: It locks the shared request list, removes the whole list from the state, replaces it with an empty one, and returns the removed requests.

**Call relations**: Tests call this after exercising the client. It is the handoff point from the fake transport’s recording work to the test’s inspection work.

*Call graph*: 1 external calls (take).


##### `RecordingTransport::new`  (lines 76–78)

```
fn new(state: RecordingState) -> Self
```

**Purpose**: Builds a fake transport that records streaming requests into a given shared state object. Tests use it when they care about what the client sends, not about receiving real data.

**Data flow**: It receives a RecordingState value and wraps it inside a RecordingTransport. The returned transport will write future stream requests into that same state.

**Call relations**: Most tests create this transport before creating a ResponsesClient. When the client streams, this transport captures the request for later checking.

*Call graph*: called by 6 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error).


##### `RecordingTransport::execute`  (lines 82–84)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Rejects non-streaming execution in these tests. It protects the tests from accidentally using the wrong request path.

**Data flow**: It receives a request but ignores it, then returns a build-style transport error saying this method should not run.

**Call relations**: The ResponsesClient tests are about streaming, so this method should not be part of the normal test flow. If something calls it, the test fails quickly instead of silently doing the wrong thing.

*Call graph*: 1 external calls (Build).


##### `RecordingTransport::stream`  (lines 86–95)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Records a streaming request and returns an empty successful stream. This lets tests inspect the outgoing request without depending on a real server response.

**Data flow**: It receives a request, stores it through RecordingState, then creates an empty stream of bytes with an OK HTTP status and no headers. The returned stream represents a successful but content-free response.

**Call relations**: ResponsesClient calls this when tests ask it to stream. The method records the request, then hands back just enough fake response data for the client call to complete.

*Call graph*: calls 1 internal fn (record); 4 external calls (pin, new, new, iter).


##### `NoAuth::add_auth_headers`  (lines 102–102)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Adds no authentication headers at all. Tests use it when they want authentication to stay out of the scenario.

**Data flow**: It receives the mutable header map for a request and leaves it unchanged. Nothing is returned.

**Call relations**: Several client tests use NoAuth so they can focus on paths, bodies, retries, or Azure metadata without extra authorization headers affecting the result.


##### `StaticAuth::new`  (lines 112–117)

```
fn new(token: &str, account_id: &str) -> Self
```

**Purpose**: Creates a fixed authentication provider with a bearer token and account ID. Tests use it to prove the client includes authentication data in outgoing headers.

**Data flow**: It receives a token string and an account ID string, copies them into owned strings, and returns a StaticAuth value containing both.

**Call relations**: The authentication-header test creates StaticAuth and passes it into ResponsesClient. Later, the provider adds those exact values to the captured request.

*Call graph*: called by 1 (streaming_client_adds_auth_headers).


##### `StaticAuth::add_auth_headers`  (lines 121–129)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds fixed authorization and account headers to a request. This mimics the headers a real authenticated API call would need.

**Data flow**: It reads the stored token and account ID, formats the token as a bearer authorization value, converts both pieces into HTTP header values, and inserts them into the request header map when valid.

**Call relations**: ResponsesClient invokes this authentication provider while preparing a stream request. The authentication-header test then reads the recorded request and confirms these headers were added.

*Call graph*: 3 external calls (insert, from_str, format!).


##### `provider`  (lines 132–147)

```
fn provider(name: &str) -> Provider
```

**Purpose**: Creates a small Provider configuration for tests. It supplies the base URL, retry settings, and timeout values that a ResponsesClient needs.

**Data flow**: It receives a provider name, builds a Provider pointing at https://example.com/v1, gives it empty headers and no query parameters, sets short retry and timeout values, and returns it.

**Call relations**: Every test that builds a ResponsesClient uses this helper as its starting configuration. Some tests then adjust the retry count or use the provider name to trigger provider-specific behavior.

*Call graph*: called by 7 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error, streaming_client_retries_on_transport_error); 2 external calls (from_millis, new).


##### `FlakyTransport::default`  (lines 161–163)

```
fn default() -> Self
```

**Purpose**: Creates a default flaky transport. This supports normal Rust default construction for the fake transport.

**Data flow**: It takes no input and returns a new FlakyTransport with fresh shared state.

**Call relations**: It delegates to the transport’s constructor. The retry test uses the explicit constructor, while this default implementation keeps the type convenient and complete.

*Call graph*: 1 external calls (new).


##### `FlakyTransport::new`  (lines 167–171)

```
fn new() -> Self
```

**Purpose**: Builds a fake transport that fails the first streaming attempt and succeeds after that. Tests use it to check retry behavior.

**Data flow**: It creates shared state with zero attempts and no saved requests, wraps that state in a thread-safe shared pointer and lock, and returns the transport.

**Call relations**: The transport-error retry test creates this transport, gives it to the ResponsesClient, and then inspects its attempt count and saved requests after the client retries.

*Call graph*: called by 1 (streaming_client_retries_on_transport_error); 3 external calls (new, new, default).


##### `FlakyTransport::attempts`  (lines 173–178)

```
fn attempts(&self) -> i64
```

**Purpose**: Reports how many times the flaky transport’s stream method was called. It lets a test verify that retrying really happened.

**Data flow**: It locks the shared state, reads the attempt counter, and returns that number.

**Call relations**: After the retry test runs the client, it calls this method to confirm the failed first attempt was followed by a second attempt.


##### `FlakyTransport::requests`  (lines 180–186)

```
fn requests(&self) -> Vec<(RequestBody, HeaderMap, codex_client::RequestCompression)>
```

**Purpose**: Returns the request bodies, headers, and compression settings captured by the flaky transport. This lets tests compare what was sent on each retry.

**Data flow**: It locks the shared state, clones the saved request records, and returns the clone so the test can inspect it safely.

**Call relations**: The transport retry test calls this after streaming. It checks that both attempts used the same prepared body and the expected compression-related headers.


##### `FailsOnceAuth::transient`  (lines 196–203)

```
fn transient() -> Self
```

**Purpose**: Creates an authentication provider that fails once with a temporary error, then succeeds. This models a short-lived service problem that should be retried.

**Data flow**: It starts an attempt counter at zero, stores a transient authentication error message, and returns the configured FailsOnceAuth provider.

**Call relations**: The transient-auth retry test passes this provider into the client. The first authentication attempt fails, the retry path runs, and the second attempt is allowed through.

*Call graph*: called by 1 (streaming_client_retries_on_transient_auth_error); 3 external calls (new, new, Transient).


##### `FailsOnceAuth::build`  (lines 205–210)

```
fn build() -> Self
```

**Purpose**: Creates an authentication provider that fails once with a configuration or setup error. This models a mistake that retrying should not fix.

**Data flow**: It starts an attempt counter at zero, stores a build-style authentication error message, and returns the configured FailsOnceAuth provider.

**Call relations**: The non-retry authentication test uses this provider. When the client sees this kind of error, the test expects it to stop immediately rather than trying again.

*Call graph*: called by 1 (streaming_client_does_not_retry_auth_build_error); 3 external calls (new, new, Build).


##### `FailsOnceAuth::attempts`  (lines 212–217)

```
fn attempts(&self) -> i64
```

**Purpose**: Reports how many times authentication was attempted. Tests use it to distinguish between retried and non-retried authentication failures.

**Data flow**: It locks the shared attempt counter, reads its current value, and returns it.

**Call relations**: Both authentication retry tests call this after the client finishes or fails. The count proves whether the retry policy treated the error correctly.


##### `FailsOnceAuth::add_auth_headers`  (lines 238–238)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Adds no synchronous headers for this fake authentication provider. Its important behavior happens in the later asynchronous authentication step.

**Data flow**: It receives the request header map and leaves it unchanged. Nothing is returned.

**Call relations**: ResponsesClient may call this while preparing headers, but this test provider intentionally does nothing there. The later apply_auth step is where it simulates failure or success.


##### `FailsOnceAuth::apply_auth`  (lines 240–242)

```
fn apply_auth(&self, request: Request) -> codex_api::AuthProviderFuture<'_>
```

**Purpose**: Applies fake asynchronous authentication that fails on the first attempt and succeeds afterward. This is how the tests check whether the client retries the right authentication failures.

**Data flow**: It receives a prepared request, increments the shared attempt counter, and if this is the first attempt returns the stored authentication error. On later attempts it returns the original request unchanged.

**Call relations**: ResponsesClient calls this while preparing a stream request. The transient-error test expects the client to try again, while the build-error test expects the client to stop and convert the problem into a transport build error.

*Call graph*: 3 external calls (pin, Build, Transient).


##### `FlakyTransport::execute`  (lines 246–248)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Rejects non-streaming execution for the flaky transport. This ensures the retry test exercises the streaming path only.

**Data flow**: It receives a request but ignores it, then returns a build-style transport error saying execute should not run.

**Call relations**: The retry test should drive ResponsesClient through the stream method. If the client accidentally calls execute, this method makes that mistake visible.

*Call graph*: 1 external calls (Build).


##### `FlakyTransport::stream`  (lines 250–279)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Simulates a network stream that fails once and then returns a small successful server-sent event. It lets the retry test prove the client can resend a streaming request safely.

**Data flow**: It receives a request, requires that it has a body, records the body, headers, and compression setting, and increments the attempt count. On the first attempt it returns a network error; on later attempts it returns an OK streaming response containing one assistant message.

**Call relations**: The ResponsesClient calls this during the transport-error retry test. Its first failure triggers the client’s retry logic, and its second success lets the test inspect whether both attempts were prepared consistently.

*Call graph*: 6 external calls (pin, new, Network, iter, panic!, vec!).


##### `responses_client_uses_responses_path`  (lines 283–301)

```
async fn responses_client_uses_responses_path() -> Result<()>
```

**Purpose**: Tests that the streaming client sends requests to the /responses endpoint. This protects the basic API routing contract.

**Data flow**: It builds a recording transport, a test provider, and a client, then asks the client to stream a small JSON body. Afterward it retrieves the recorded request and checks that the URL ends with /responses.

**Call relations**: This test drives ResponsesClient through RecordingTransport. It then hands the captured request to assert_path_ends_with for the final endpoint check.

*Call graph*: calls 4 internal fn (new, new, assert_path_ends_with, provider); 4 external calls (new, new, default, json!).


##### `responses_client_stream_request_preserves_exact_json_body`  (lines 304–347)

```
async fn responses_client_stream_request_preserves_exact_json_body() -> Result<()>
```

**Purpose**: Tests that a structured Responses API request is serialized into the exact JSON bytes expected. It also checks that the content type is set to application/json.

**Data flow**: It creates a detailed ResponsesApiRequest, separately serializes that request into expected JSON bytes, and then sends the request through the client. It prepares the recorded outgoing body and compares its bytes and content-type header with the expected values.

**Call relations**: The test uses RecordingTransport to capture the request built by ResponsesClient. It checks that stream_request does not subtly rewrite or lose request data before sending.

*Call graph*: calls 3 internal fn (new, new, provider); 7 external calls (new, new, assert_eq!, default, default, to_vec, vec!).


##### `streaming_client_adds_auth_headers`  (lines 350–388)

```
async fn streaming_client_adds_auth_headers() -> Result<()>
```

**Purpose**: Tests that streaming requests include authentication headers and the header that asks for a streaming response. This confirms the client sends the information the server expects.

**Data flow**: It creates a client with StaticAuth, streams a simple JSON body, retrieves the captured request, and reads its headers. It checks for the bearer token, account ID, and Accept: text/event-stream.

**Call relations**: StaticAuth supplies the token and account ID when ResponsesClient prepares the request. RecordingTransport captures the final request so the test can verify the headers.

*Call graph*: calls 4 internal fn (new, new, new, provider); 6 external calls (new, new, assert!, assert_eq!, default, json!).


##### `streaming_client_retries_on_transport_error`  (lines 391–444)

```
async fn streaming_client_retries_on_transport_error() -> Result<()>
```

**Purpose**: Tests that the streaming client retries when the network transport fails and retry settings allow it. It also confirms the retry reuses the same encoded body safely.

**Data flow**: It builds a FlakyTransport, configures the provider for two attempts, sends a ResponsesApiRequest with zstd compression requested, and waits for the eventual success. Then it checks there were two attempts, compares both saved requests, and verifies the encoded JSON body and compression headers stayed consistent.

**Call relations**: FlakyTransport deliberately returns a network error on the first stream call. ResponsesClient responds by retrying, and the test inspects FlakyTransport’s recorded state to prove the retry was correct.

*Call graph*: calls 3 internal fn (new, new, provider); 5 external calls (new, default, new, assert_eq!, panic!).


##### `streaming_client_retries_on_transient_auth_error`  (lines 447–469)

```
async fn streaming_client_retries_on_transient_auth_error() -> Result<()>
```

**Purpose**: Tests that a temporary authentication failure is retried. This matters because short outages in a token service should not make the whole request fail immediately.

**Data flow**: It creates an authentication provider that fails once with a transient error, allows two retry attempts, and streams a simple request. After success, it checks that authentication was attempted twice but the network stream was sent only once.

**Call relations**: FailsOnceAuth simulates the first authentication failure. ResponsesClient retries authentication before reaching RecordingTransport, so only the successful authenticated request is recorded.

*Call graph*: calls 4 internal fn (new, transient, new, provider); 5 external calls (new, new, assert_eq!, default, json!).


##### `streaming_client_does_not_retry_auth_build_error`  (lines 472–502)

```
async fn streaming_client_does_not_retry_auth_build_error() -> Result<()>
```

**Purpose**: Tests that an authentication setup error is not retried. Retrying a bad configuration would waste time and could hide the real problem.

**Data flow**: It creates an authentication provider that fails with a build-style error, configures two possible attempts, and tries to stream a request. It expects an error, checks the error message, confirms only one authentication attempt happened, and confirms no network request was sent.

**Call relations**: FailsOnceAuth produces the build error before the request reaches RecordingTransport. ResponsesClient should stop there, and the test proves that no retry or stream call happened.

*Call graph*: calls 4 internal fn (new, build, new, provider); 6 external calls (new, new, assert!, assert_eq!, default, json!).


##### `azure_default_store_attaches_ids_and_headers`  (lines 505–589)

```
async fn azure_default_store_attaches_ids_and_headers() -> Result<()>
```

**Purpose**: Tests Azure-specific request decoration when stored responses and session information are used. It checks that important tracing and conversation IDs are sent in headers and that message IDs remain in the JSON body.

**Data flow**: It builds an Azure-named provider, creates a ResponsesApiRequest with store enabled and a message ID, adds extra headers plus session, thread, and sub-agent options, and sends the request. It then inspects the recorded headers and parses the recorded JSON body to confirm all expected IDs and metadata are present.

**Call relations**: ResponsesClient prepares the Azure-style request, RecordingTransport captures it, and request_body_bytes helps the test read the outgoing JSON. This test ties together provider-specific behavior, caller-supplied options, and body preservation.

*Call graph*: calls 4 internal fn (new, new, provider, request_body_bytes); 9 external calls (new, new, from_static, new, SubAgent, assert_eq!, default, from_slice, vec!).


### `codex-api/tests/models_integration.rs`

`test` · `test run`

This is an integration test for the part of the API client that lists available models. In plain terms, it sets up a small pretend server, tells that server what answer to return, then asks the real client code to fetch models from it. This matters because a models client can look correct in isolation but still fail if it builds the wrong URL, uses the wrong HTTP method, or cannot decode the server’s response.

The file uses `wiremock`, a testing tool that acts like a fake web server. The test server is configured to expect a GET request to `/api/codex/models` and return a JSON document containing one model named `gpt-test`. A simple `DummyAuth` authentication provider is used because this test is not about login or tokens; it deliberately adds no headers.

The helper `provider` builds a test `Provider`, which is the client’s description of where the API lives and how retries should work. The main test then creates a `ReqwestTransport`, which is the HTTP layer backed by the `reqwest` library, and passes it into `ModelsClient`. After calling `list_models`, the test checks two things: the decoded model list contains the expected model, and the fake server actually received exactly one GET request at the expected path. Together, these checks prove both the outgoing request and incoming response path work.

#### Function details

##### `DummyAuth::add_auth_headers`  (lines 28–28)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: This is a no-op authentication hook used only for the test. It satisfies the client’s need for an authentication provider while intentionally adding no authentication information, because the fake server does not require any.

**Data flow**: It receives a mutable set of HTTP headers. It ignores those headers and leaves them unchanged. Nothing is returned, and the request continues without any added auth headers.

**Call relations**: The `ModelsClient` is built with `DummyAuth` during the test. When the client prepares its request, it can call this method as it would with a real authentication provider, but here the method quietly does nothing so the test stays focused on the models endpoint.


##### `provider`  (lines 31–46)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: This helper builds a test `Provider`, which tells the API client where the fake server is and what basic request settings to use. It keeps the main test easier to read by hiding the repeated provider setup details.

**Data flow**: It receives a base URL string for the fake server. It turns that into a `Provider` with the name `test`, no extra query parameters, an empty header map, short retry settings, and a short stream idle timeout. It returns that ready-to-use provider to the caller.

**Call relations**: The main integration test calls this helper after starting the fake server and constructing the server’s base URL. The returned provider is then handed to `ModelsClient::new`, so the client sends its request to the mock server rather than to a real API.

*Call graph*: called by 1 (models_client_hits_models_endpoint); 3 external calls (new, from_millis, from_secs).


##### `models_client_hits_models_endpoint`  (lines 49–137)

```
async fn models_client_hits_models_endpoint()
```

**Purpose**: This asynchronous test proves that `ModelsClient::list_models` contacts the expected models endpoint and turns the JSON response into usable model data. It checks both sides of the exchange: what the client receives and what it actually sent.

**Data flow**: The test starts with no real API service. It launches a fake server, prepares a sample `ModelsResponse` containing one model, and configures the server to return that JSON when `/api/codex/models` is requested with GET. It then creates the real models client pointed at the fake server and calls `list_models`. The result is checked to make sure one model comes back with slug `gpt-test`; the fake server’s recorded requests are also inspected to confirm there was exactly one GET request to the correct path.

**Call relations**: This is the top-level test flow in the file. It uses `provider` to build the client configuration, uses `DummyAuth` so authentication does not affect the test, and relies on the real `ModelsClient` and HTTP transport to perform the request. The fake server stands in for the external API and lets the test verify that the client and endpoint wiring work together.

*Call graph*: calls 4 internal fn (new, new, provider, new); 10 external calls (new, new, given, start, new, assert_eq!, format!, vec!, method, path).


### `codex-api/tests/sse_end_to_end.rs`

`test` · `test run`

This is an end-to-end style test for streaming responses. The real API sends updates as server-sent events, often called SSE: a simple text format where each event has lines like “event:” and “data:” and events are separated by blank lines. This test builds a small fake SSE response containing two assistant message items and one final “completed” event. Then it feeds that text into the real ResponsesClient streaming code.

The file avoids the internet by using FixtureSseTransport, a pretend HTTP transport. Its normal request method deliberately fails, because this test should only use the streaming path. Its stream method returns the prepared SSE text as if it came from a server. NoAuth is another small test helper that adds no authentication headers, because credentials are irrelevant here.

The main test creates the fake body, creates a client with simple provider settings, starts the stream, collects every parsed event, ignores rate-limit metadata events, and checks the three meaningful events. It verifies that both output items are assistant messages and that the final completed event has the expected response id. Without this test, changes to the SSE parser or response client could silently break streamed responses while ordinary non-streaming requests still looked fine.

#### Function details

##### `FixtureSseTransport::new`  (lines 30–32)

```
fn new(body: String) -> Self
```

**Purpose**: Creates a fake streaming transport loaded with the exact text that the test wants the client to receive. It is a small convenience constructor so the test can clearly say, “use this body as the server response.”

**Data flow**: It takes a String containing the full fake SSE response body. It stores that string inside a FixtureSseTransport. The result is a reusable fake transport object that will later return that same body from its streaming method.

**Call relations**: The main test calls this after building the SSE fixture text. The returned transport is then passed into ResponsesClient::new, so the real client code reads from this controlled in-memory response instead of the network.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end).


##### `FixtureSseTransport::execute`  (lines 36–38)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Rejects ordinary, non-streaming HTTP requests during this test. It acts like a tripwire: if the client accidentally uses the wrong request path, the test fails immediately.

**Data flow**: It receives a request but ignores it. Instead of returning a successful response, it returns a TransportError saying that execute should not run. Nothing else is changed.

**Call relations**: This method is part of the HttpTransport interface, so it must exist. In this test’s intended flow it is never used; the client should call FixtureSseTransport::stream instead. Its only handoff is to the transport error constructor that builds the failure message.

*Call graph*: 1 external calls (Build).


##### `FixtureSseTransport::stream`  (lines 40–49)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Pretends to be a server streaming bytes back to the client. It gives the ResponsesClient the fake SSE text in the same shape as a real streaming HTTP response.

**Data flow**: It receives a request but does not inspect it. It clones the stored body string, turns it into bytes, wraps those bytes in a one-item asynchronous stream, and returns a StreamResponse with HTTP status OK, empty headers, and that byte stream. The client then consumes those bytes as if they arrived from a real server.

**Call relations**: ResponsesClient uses this method when the main test calls its stream operation. This fake stream feeds the real parsing code, which is the behavior the test wants to exercise.

*Call graph*: 4 external calls (pin, new, iter, vec!).


##### `NoAuth::add_auth_headers`  (lines 56–56)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Supplies an authentication provider that deliberately adds nothing. The test does not need API keys or authorization headers, because no real service is contacted.

**Data flow**: It receives a mutable header map and leaves it unchanged. There is no return value and no side effect beyond intentionally doing nothing.

**Call relations**: ResponsesClient expects an AuthProvider, so the test passes NoAuth when constructing the client. If the client asks for authentication headers, this method quietly keeps the request simple.


##### `provider`  (lines 59–74)

```
fn provider(name: &str) -> Provider
```

**Purpose**: Builds a minimal Provider configuration for the test client. It gives the client a fake base URL, simple retry settings, and a short stream timeout so the client can be created normally without using production configuration.

**Data flow**: It takes a provider name as text. It builds and returns a Provider value with that name, an example API URL, no query parameters, empty headers, one retry attempt, tiny retry delay, selected retry flags, and a short idle timeout for streaming.

**Call relations**: The main test calls this while creating the ResponsesClient. The resulting Provider is not about reaching a real server; it supplies the configuration shape the client needs before it can run the streaming code.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end); 2 external calls (from_millis, new).


##### `build_responses_body`  (lines 76–90)

```
fn build_responses_body(events: Vec<Value>) -> String
```

**Purpose**: Turns a list of JSON event objects into one SSE-formatted text body. This lets the test describe events as structured JSON first, then convert them into the wire format the client parser expects.

**Data flow**: It receives a vector of JSON values. For each event, it reads the event’s “type” field to decide the SSE event name. If the JSON object contains only that type field, it writes just an “event:” line and a blank line; otherwise it writes both an “event:” line and a “data:” line containing the JSON. It returns the complete SSE body string.

**Call relations**: The main test uses this helper to build the fake response body before creating FixtureSseTransport. The formatted text is then handed to the transport, which hands it to the client’s streaming parser.

*Call graph*: called by 1 (responses_stream_parses_items_and_completed_end_to_end); 2 external calls (new, format!).


##### `responses_stream_parses_items_and_completed_end_to_end`  (lines 93–170)

```
async fn responses_stream_parses_items_and_completed_end_to_end() -> Result<()>
```

**Purpose**: Checks the whole streaming path from raw SSE text to typed ResponseEvent values. It proves that assistant output item events and the final completed event are recognized correctly.

**Data flow**: It creates three JSON fixtures: two output-item events containing assistant messages and one completed event with response id “resp1”. It converts them into an SSE body, places that body in the fake transport, builds a ResponsesClient, and starts a stream request with a small JSON payload and no compression. It collects all parsed events, removes rate-limit metadata events, and then asserts that exactly three meaningful events remain with the expected shapes and values. The test returns success if all checks pass, or an error/panic if streaming or parsing is wrong.

**Call relations**: This is the test driver. It calls build_responses_body to make the fake server text, FixtureSseTransport::new to create the fake network layer, provider to create client configuration, and then the real ResponsesClient streaming API. As the client reads, FixtureSseTransport::stream supplies the bytes. The final assertions connect the raw input fixture to the parsed events the rest of the application would rely on.

*Call graph*: calls 4 internal fn (new, new, build_responses_body, provider); 8 external calls (new, new, new, assert!, assert_eq!, panic!, json!, vec!).


### `codex-api/tests/realtime_websocket_e2e.rs`

`test` · `test run`

The realtime client talks to an outside service over a WebSocket, which is a long-lived two-way network connection. This test file builds a small local pretend server so the client can be tested without calling a real provider. The fake server behaves like the remote service: it accepts a connection, reads the client’s first messages, sends back JSON events, and sometimes closes the connection or sends unfamiliar events.

The tests focus on behavior that would be painful to discover only in production. They verify that the client sends the right initial session setup, turns incoming JSON into clear RealtimeEvent values, sends audio frames in the expected format, and does not get stuck when sending audio while another task is waiting for the next event. They also check edge cases: a delayed server for WebRTC sideband joining, an orderly close that should simply end the event stream, and unknown provider messages that should be ignored rather than crashing the client.

One important test uses the newer RealtimeV2 event parser. It feeds the client transcript and function-call messages, then checks that the client recognizes a handoff request and includes the right conversation context. In plain terms, these tests act like a rehearsal stage for the realtime connection: the client gets realistic cues, and the test confirms it says and hears the right things.

#### Function details

##### `spawn_realtime_ws_server`  (lines 31–58)

```
async fn spawn_realtime_ws_server(
    handler: Handler,
) -> (String, tokio::task::JoinHandle<()>)
```

**Purpose**: Starts a one-connection local WebSocket server for a test. Each test gives it a small script that says what the fake server should read from and write to the client.

**Data flow**: It receives a handler function that knows how the fake server should behave. It binds a temporary local TCP port, starts an asynchronous background task, accepts one incoming connection, upgrades it to a WebSocket, then runs the handler with that WebSocket. It returns the server address for the client to connect to and a task handle so the test can wait for the fake server to finish.

**Call relations**: Most tests call this before creating the realtime client. The returned address is passed into test_provider, so the client talks to the local fake server instead of a real provider. The background server then exchanges messages with the client while the test checks the client-side results.

*Call graph*: called by 5 (realtime_ws_e2e_disconnected_emitted_once, realtime_ws_e2e_ignores_unknown_text_events, realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested, realtime_ws_e2e_send_while_next_event_waits, realtime_ws_e2e_session_create_and_event_flow); 3 external calls (bind, spawn, accept_async).


##### `test_provider`  (lines 60–75)

```
fn test_provider(base_url: String) -> Provider
```

**Purpose**: Builds a Provider configuration pointed at the fake local server. This lets each test create a normal RealtimeWebsocketClient without using real network settings or real retry behavior.

**Data flow**: It receives a base URL string, then creates a Provider named "test" with empty query parameters, empty headers, short timeouts, and mostly disabled retries. The output is a ready-to-use provider configuration for the realtime client.

**Call relations**: Each test uses this helper when constructing RealtimeWebsocketClient. In the WebRTC sideband retry test, the test modifies the returned retry settings to simulate a delayed server becoming available.

*Call graph*: called by 6 (realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available, realtime_ws_e2e_disconnected_emitted_once, realtime_ws_e2e_ignores_unknown_text_events, realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested, realtime_ws_e2e_send_while_next_event_waits, realtime_ws_e2e_session_create_and_event_flow); 4 external calls (from_millis, from_secs, new, new).


##### `realtime_ws_e2e_session_create_and_event_flow`  (lines 78–202)

```
async fn realtime_ws_e2e_session_create_and_event_flow()
```

**Purpose**: Checks the basic happy path for a realtime WebSocket session. It proves the client sends session setup, can send audio to the server, and can receive both a session update and an audio output event.

**Data flow**: The fake server first receives the client’s session.update message and checks important fields such as instructions and audio format. It then sends a session.updated event, waits for the client’s input_audio_buffer.append audio message, and sends an audio delta back. On the client side, the test connects, reads the session-updated event, sends an audio frame, reads the returned audio frame, then closes the connection.

**Call relations**: This test uses spawn_realtime_ws_server to create the scripted server and test_provider to aim the client at it. It exercises the public RealtimeWebsocketClient connection, next_event, send_audio_frame, and close flow as one complete conversation.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available`  (lines 205–280)

```
async fn realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available()
```

**Purpose**: Checks that WebRTC sideband connection setup can tolerate the server not being ready immediately. A sideband connection is an extra realtime control connection attached to an existing WebRTC session.

**Data flow**: The test first reserves a local address, releases it, and starts a server only after a short delay. The client tries to join using connect_webrtc_sideband. After the delayed server accepts the connection, it checks the session.update message and sends back session.updated. The test expects the client to succeed and produce a SessionUpdated event instead of failing too early.

**Call relations**: This test builds on test_provider but adjusts retry timing for the scenario. Unlike the other server setup helper, it creates the delayed listener inline so it can test the timing gap before the server exists.

*Call graph*: calls 2 internal fn (new, test_provider); 11 external calls (from_millis, new, bind, assert_eq!, format!, json!, from_str, spawn, sleep, accept_async (+1 more)).


##### `realtime_ws_e2e_send_while_next_event_waits`  (lines 283–367)

```
async fn realtime_ws_e2e_send_while_next_event_waits()
```

**Purpose**: Checks that sending audio does not get blocked just because another part of the client is waiting for the next incoming event. This matters because realtime audio systems need to send and receive at the same time.

**Data flow**: The fake server receives the initial session setup, then waits for an audio append message before sending a session.updated event. The client connects and runs two actions at once: one task sends an audio frame with a short timeout, while another waits for the next event. The test passes only if the send finishes promptly and the later incoming event is still delivered correctly.

**Call relations**: This test uses spawn_realtime_ws_server and test_provider like the basic flow test, but it stresses concurrency. It confirms that send_audio_frame and next_event can be used together, rather than one operation holding up the other.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 4 external calls (new, assert_eq!, format!, join!).


##### `realtime_ws_e2e_disconnected_emitted_once`  (lines 370–411)

```
async fn realtime_ws_e2e_disconnected_emitted_once()
```

**Purpose**: Checks what the client reports when the WebSocket server closes the connection. The desired behavior is simple: future event reads should return no event, consistently, without inventing repeated disconnect events or errors.

**Data flow**: The fake server receives the initial session.update message and then sends a WebSocket close frame. The client connects and calls next_event twice. Both calls should return None, meaning the stream is finished, and nothing extra is emitted after the close.

**Call relations**: This test uses the standard fake server helper and provider helper. It focuses only on connection shutdown behavior after the initial setup message has been sent.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_e2e_ignores_unknown_text_events`  (lines 414–483)

```
async fn realtime_ws_e2e_ignores_unknown_text_events()
```

**Purpose**: Checks that the client safely skips text events it does not understand. This is important because providers may add new event types before the client knows how to use them.

**Data flow**: The fake server receives the setup message, sends an unknown response.created event, then sends a known session.updated event. The client connects and asks for the next meaningful event. The test expects the unknown message to be ignored and the known SessionUpdated event to come through.

**Call relations**: This test uses the same local server and provider setup as the main flow test. It specifically exercises the event parser’s filtering behavior before normal event delivery.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 3 external calls (new, assert_eq!, format!).


##### `realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested`  (lines 486–632)

```
async fn realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested()
```

**Purpose**: Checks that the RealtimeV2 parser turns a sequence of newer provider events into useful internal events, especially a handoff request. A handoff request means the realtime conversation is asking another agent or background worker to take over some work.

**Data flow**: The fake server sends four messages after setup: a completed user input transcript, an assistant output transcript delta, a conversation item containing a collaboration control message, and a function-call item named background_agent. The client reads these as an input transcript event, an output transcript event, a conversation item event, and finally a HandoffRequested event. The final event must include the handoff ID, item ID, user transcript, and active transcript context.

**Call relations**: This test uses spawn_realtime_ws_server and test_provider, but selects the RealtimeV2 parser in the session configuration. It proves that lower-level provider JSON is not merely received, but combined into higher-level RealtimeEvent values that the rest of the system can act on.

*Call graph*: calls 3 internal fn (new, spawn_realtime_ws_server, test_provider); 4 external calls (new, assert!, assert_eq!, format!).


### `core/src/client_tests.rs`

`test` · `test run`

The tests in this file act like a checklist for the model client’s most important promises. They build small fake clients and fake model streams, then check that the client adds the right headers, records the right trace data, and avoids unnecessary work. Several helpers create realistic test objects, such as a model client, model information, session telemetry, and response metadata. This keeps each test focused on the behavior being checked rather than on setup details.

A big theme is metadata: every model request needs enough labels to say where it came from, such as the session, thread, window, turn, or subagent. Without these labels, server-side systems and debugging tools could lose the story of a request. Another theme is stream behavior. Model responses arrive as a stream of events, like a live radio broadcast. These tests make sure that if the listener hangs up early, the trace still records that the run was cancelled and keeps any answer pieces already received.

The file also checks authentication-related telemetry and attestation. Attestation is a special proof header used only for certain ChatGPT Codex endpoints. The tests make sure it is included when required and not generated for ordinary non-ChatGPT endpoints.

#### Function details

##### `test_model_client`  (lines 67–81)

```
fn test_model_client(session_source: SessionSource) -> ModelClient
```

**Purpose**: Creates a simple ModelClient for tests. It uses a fake provider URL and lets the caller choose what kind of session the client should pretend to be running in.

**Data flow**: It receives a session source, builds a test model provider, creates a fresh thread identifier, and passes those into ModelClient::new with most optional features turned off. The result is a ready-to-use client that will not make real production requests.

**Call relations**: Several header and memory-summary tests call this helper first, so they can focus on one behavior instead of repeating client setup. It hands the finished client to tests that inspect subagent headers, websocket metadata, and empty memory summarization.

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

**Purpose**: Builds the metadata object that a test client would attach to a Responses API request. This metadata describes the request’s identity, such as installation, thread, turn, window, and parent thread.

**Data flow**: It reads the client’s thread id and session source, combines them with the supplied turn id, window id, parent thread id, and request kind, then calls the shared test metadata builder. The output is a CodexResponsesMetadata value shaped like a real request’s metadata.

**Call relations**: Tests use this after constructing a ModelClient when they need realistic request metadata. It feeds metadata into websocket metadata and websocket header-building checks.

*Call graph*: calls 1 internal fn (responses_metadata); called by 2 (build_ws_client_metadata_includes_window_lineage_and_turn_metadata, websocket_handshake_includes_attestation_for_chatgpt_codex_responses).


##### `test_model_info`  (lines 103–131)

```
fn test_model_info() -> ModelInfo
```

**Purpose**: Creates a realistic but small ModelInfo object for tests. This lets tests call model-client features that require model details without depending on a live model catalog.

**Data flow**: It starts with hard-coded JSON describing a fake model named gpt-test, then deserializes that JSON into the ModelInfo type. If the JSON shape stops matching the expected model schema, the test setup fails immediately.

**Call relations**: The empty memory-summary test uses this helper to give summarize_memories the model description it expects. The helper depends on JSON construction and deserialization, but no outside service.

*Call graph*: called by 1 (summarize_memories_returns_empty_for_empty_input); 2 external calls (json!, from_value).


##### `test_session_telemetry`  (lines 133–146)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Creates a small SessionTelemetry record for tests. Session telemetry is the information used to label activity from one run of the client, such as the model name, terminal, and source.

**Data flow**: It creates a fresh thread id and fills in fixed test values for model name, originator, terminal, and session source. It leaves account and authentication details empty, then returns the telemetry object.

**Call relations**: Stream and memory tests call this when exercising code that expects telemetry to be present. It supplies harmless test labels to map_response_events and summarize_memories.

*Call graph*: calls 2 internal fn (new, new); called by 4 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output, response_stream_records_last_model_feedback_ids, summarize_memories_returns_empty_for_empty_input).


##### `TagCollectorVisitor::record_str`  (lines 154–157)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: Collects a string field from a tracing event. It is part of a tiny test-only recorder that captures feedback tags emitted by the code under test.

**Data flow**: It receives a tracing field and its string value, converts the field name into text, and stores the name-value pair in the visitor’s map. The visitor’s stored tags grow by one entry or update an existing one.

**Call relations**: TagCollectorLayer::on_event asks tracing events to record themselves into this visitor. This method is used when the event field is already a plain string.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_debug`  (lines 159–162)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Collects a non-string tracing field by formatting it as readable debug text. This lets the test capture fields even when tracing did not provide them as plain strings.

**Data flow**: It receives a field and a debuggable value, turns the value into formatted text, and stores it under the field name in the visitor’s map. The output is not returned directly; it is saved inside the visitor.

**Call relations**: TagCollectorLayer::on_event uses the visitor for feedback-tag events. This method is the fallback path for values such as quoted identifiers that tracing exposes through debug formatting.

*Call graph*: 2 external calls (name, format!).


##### `TagCollectorLayer::on_event`  (lines 174–181)

```
fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>)
```

**Purpose**: Listens for tracing events from the special feedback_tags target and saves their fields for assertions. In plain terms, it is a test microphone that only records one named channel.

**Data flow**: It receives a tracing event, ignores it unless its target is feedback_tags, then records the event fields into a TagCollectorVisitor. It locks the shared tag map and merges the newly collected fields into it.

**Call relations**: The feedback-id stream test installs this layer before running map_response_events. When the code emits feedback tags, this layer captures them so the test can check the last request and response ids.

*Call graph*: 3 external calls (default, metadata, record).


##### `started_inference_attempt`  (lines 184–218)

```
fn started_inference_attempt(temp: &TempDir) -> anyhow::Result<InferenceTraceAttempt>
```

**Purpose**: Sets up a temporary rollout trace with an inference attempt already started. This gives cancellation tests a realistic trace file to inspect later.

**Data flow**: It receives a temporary directory, creates a trace writer there, records that a thread and turn started, creates an enabled inference trace context, starts an attempt, and records the fake request body. It returns the started attempt or an error if writing fails.

**Call relations**: The two stream-cancellation tests call this before mapping response events. The returned attempt is passed into map_response_events so that dropping the stream can be written into the trace.

*Call graph*: calls 2 internal fn (enabled, create); called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 3 external calls (new, path, json!).


##### `output_message`  (lines 220–230)

```
fn output_message(id: &str, text: &str) -> ResponseItem
```

**Purpose**: Builds a fake assistant output message event item for tests. It represents a completed piece of model output with an id and text.

**Data flow**: It receives an id and message text, copies them into a ResponseItem::Message with assistant role and one output-text content item, and returns that response item.

**Call relations**: Cancellation tests use this helper to place one partial assistant answer into a fake stream. That item is later expected to survive in the trace even though the overall stream is cancelled.

*Call graph*: called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 1 external calls (vec!).


##### `replay_until_cancelled`  (lines 232–247)

```
async fn replay_until_cancelled(temp: &TempDir) -> anyhow::Result<RolloutTrace>
```

**Purpose**: Repeatedly reloads a rollout trace until it sees that an inference was marked cancelled. This accounts for the fact that cancellation is written by another asynchronous task and may not appear immediately.

**Data flow**: It receives a temporary directory, replays the trace bundle from disk, checks the first inference call’s execution status, and waits briefly between retries. It returns the rollout once cancelled is seen, or the latest rollout after the retry loop ends.

**Call relations**: Both cancellation tests call this after dropping the mapped response stream. It bridges the timing gap between triggering cancellation and reading the trace result from disk.

*Call graph*: called by 2 (dropped_backpressured_response_stream_traces_cancelled_partial_output, dropped_response_stream_traces_cancelled_partial_output); 4 external calls (from_millis, path, replay_bundle, sleep).


##### `NotifyAfterEventStream::poll_next`  (lines 259–268)

```
fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements a fake response stream that notifies the test after a chosen number of events have been yielded. It is used to create a controlled backpressure situation.

**Data flow**: When polled, it removes the next event from its queue. If there is no event, it stays pending; if there is an event, it increments a counter, sends a notification when the chosen count is reached, and returns the event as a successful stream item.

**Call relations**: The backpressure cancellation test uses this stream instead of a simple iterator. It lets the test know exactly when the mapper has seen the important output item but is blocked trying to pass it downstream.

*Call graph*: 2 external calls (Ready, pop_front).


##### `build_subagent_headers_sets_other_subagent_label`  (lines 272–281)

```
fn build_subagent_headers_sets_other_subagent_label()
```

**Purpose**: Checks that a subagent session with a custom label sends that label in the expected request header. This keeps server-side routing and analysis aware of which subagent made the request.

**Data flow**: It creates a test client whose session source is a subagent labeled memory_consolidation, asks the client to build subagent headers, extracts the subagent header value, and compares it with the expected label.

**Call relations**: This test relies on test_model_client for setup, then exercises ModelClient’s subagent header builder directly. It proves that custom SubAgentSource::Other labels are not lost.

*Call graph*: calls 1 internal fn (test_model_client); 3 external calls (SubAgent, assert_eq!, Other).


##### `build_subagent_headers_sets_internal_memory_consolidation_label`  (lines 284–293)

```
fn build_subagent_headers_sets_internal_memory_consolidation_label()
```

**Purpose**: Checks that the internal memory-consolidation session is also labeled as memory_consolidation in request headers. This keeps internal background work identifiable in the same way as named subagents.

**Data flow**: It creates a test client with an internal memory-consolidation session source, builds the subagent headers, reads the relevant header, and asserts that it contains the expected label.

**Call relations**: Like the custom subagent test, it uses test_model_client and then directly checks header construction. Together, the two tests cover both public subagent labeling and internal-session labeling.

*Call graph*: calls 1 internal fn (test_model_client); 2 external calls (Internal, assert_eq!).


##### `build_ws_client_metadata_includes_window_lineage_and_turn_metadata`  (lines 296–356)

```
fn build_ws_client_metadata_includes_window_lineage_and_turn_metadata()
```

**Purpose**: Verifies that websocket client metadata includes the full request family tree: installation, session, thread, turn, window, parent thread, and subagent label. Without this, websocket requests could become hard to trace back to the user action that created them.

**Data flow**: It creates a parent thread id and a client for a spawned subagent, builds expected metadata for a turn, asks the client to convert that into websocket metadata, then checks both top-level fields and the embedded turn-metadata JSON. It also checks the subagent header value.

**Call relations**: This test combines test_model_client and test_responses_metadata_for_client, then calls the client’s websocket metadata builder. It is the main test here for preserving lineage when a subagent is spawned from another thread.

*Call graph*: calls 3 internal fn (test_model_client, test_responses_metadata_for_client, new); 4 external calls (SubAgent, assert_eq!, format!, from_str).


##### `summarize_memories_returns_empty_for_empty_input`  (lines 359–374)

```
async fn summarize_memories_returns_empty_for_empty_input()
```

**Purpose**: Checks a simple edge case: asking to summarize no memories should succeed and return no summaries. This prevents empty input from causing unnecessary model calls or errors.

**Data flow**: It builds a test client, fake model info, and session telemetry, then calls summarize_memories with an empty list. The returned list is expected to be empty.

**Call relations**: The test uses the setup helpers test_model_client, test_model_info, and test_session_telemetry. It exercises the client’s memory-summary path at its simplest boundary.

*Call graph*: calls 3 internal fn (test_model_client, test_model_info, test_session_telemetry); 2 external calls (new, assert_eq!).


##### `dropped_response_stream_traces_cancelled_partial_output`  (lines 377–420)

```
async fn dropped_response_stream_traces_cancelled_partial_output() -> anyhow::Result<()>
```

**Purpose**: Checks that if a response stream is abandoned after one output item arrives, the trace records the inference as cancelled and keeps the partial output. This matters for interruptions, where the system stops listening before the provider sends a normal completed event.

**Data flow**: It creates a trace attempt, builds a fake stream that yields one output item and then never finishes, maps the stream through the client’s response-event mapper, consumes the first item, and then drops the stream. It replays the trace until cancellation appears and asserts that the cancelled status and one response item id were saved.

**Call relations**: The test uses started_inference_attempt, output_message, test_session_telemetry, and replay_until_cancelled around a call to map_response_events. It covers the normal consumer-dropped path: the downstream listener disappears after receiving a partial answer.

*Call graph*: calls 4 internal fn (output_message, replay_until_cancelled, started_inference_attempt, test_session_telemetry); 7 external calls (new, assert!, assert_eq!, OutputItemDone, iter, pending, map_response_events).


##### `response_stream_records_last_model_feedback_ids`  (lines 423–455)

```
async fn response_stream_records_last_model_feedback_ids()
```

**Purpose**: Checks that model request and response identifiers are recorded as feedback tags. These ids help connect user feedback with the exact model call that produced an answer.

**Data flow**: It installs a TagCollectorLayer, creates a fake stream with a created event and a completed event containing response id resp-123, then maps and drains the stream with upstream request id req-123. After the stream ends, it reads the collected tags and checks that both ids were recorded.

**Call relations**: This test depends on TagCollectorLayer and TagCollectorVisitor to capture tracing output from map_response_events. It uses test_session_telemetry and a disabled trace attempt because the focus is feedback tagging, not rollout tracing.

*Call graph*: calls 2 internal fn (test_session_telemetry, disabled); 7 external calls (new, new, new, assert_eq!, iter, map_response_events, registry).


##### `dropped_backpressured_response_stream_traces_cancelled_partial_output`  (lines 458–504)

```
async fn dropped_backpressured_response_stream_traces_cancelled_partial_output() -> anyhow::Result<()>
```

**Purpose**: Checks a harder cancellation case: the mapper has seen an output item but cannot deliver it because its output channel is full, and then the consumer is dropped. The trace should still record cancellation and preserve that output item.

**Data flow**: It fills a fake event queue with enough non-terminal events to occupy the mapper’s channel, then adds one output item. The custom stream notifies the test when that output item has been yielded upstream. The test drops the downstream stream, replays the trace, and verifies cancelled status plus one saved response item id.

**Call relations**: This test uses NotifyAfterEventStream to create precise backpressure, plus started_inference_attempt, output_message, test_session_telemetry, and replay_until_cancelled. It complements the simpler dropped-stream test by covering the send-failure path.

*Call graph*: calls 4 internal fn (output_message, replay_until_cancelled, started_inference_attempt, test_session_telemetry); 8 external calls (clone, new, new, new, new, assert_eq!, OutputItemDone, map_response_events).


##### `auth_request_telemetry_context_tracks_attached_auth_and_retry_phase`  (lines 507–523)

```
fn auth_request_telemetry_context_tracks_attached_auth_and_retry_phase()
```

**Purpose**: Checks that authentication telemetry correctly reports when an authorization header was attached and when a retry follows an unauthorized response. This makes auth debugging more transparent without exposing the token itself.

**Data flow**: It creates an AuthRequestTelemetryContext using ChatGPT auth mode, a test bearer auth provider with a token, and a pending unauthorized-retry description. It then checks that the context records the auth mode, header presence and name, retry flag, recovery mode, and recovery phase.

**Call relations**: This test directly exercises AuthRequestTelemetryContext::new together with PendingUnauthorizedRetry::from_recovery and a test bearer provider. It does not depend on the broader stream or websocket helpers.

*Call graph*: calls 3 internal fn (new, from_recovery, for_test); 2 external calls (assert!, assert_eq!).


##### `model_client_with_counting_attestation`  (lines 525–574)

```
fn model_client_with_counting_attestation(
    include_attestation: bool,
) -> (ModelClient, Arc<AtomicUsize>)
```

**Purpose**: Builds a ModelClient with a fake attestation provider that counts how many times it is asked for an attestation header. This makes it easy to test both required and skipped attestation behavior.

**Data flow**: It receives a boolean saying whether to create a ChatGPT Codex-style client. If true, it creates test ChatGPT auth and an OpenAI provider; if false, it creates a plain OSS provider. It attaches a counting attestation provider and returns both the client and the shared counter.

**Call relations**: The two attestation tests call this helper with opposite settings. The returned counter tells those tests whether the client actually attempted attestation generation.

*Call graph*: calls 5 internal fn (new, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_openai_provider, new); called by 2 (non_chatgpt_codex_endpoints_omit_attestation_generation, websocket_handshake_includes_attestation_for_chatgpt_codex_responses); 3 external calls (new, new, create_oss_provider_with_base_url).


##### `websocket_handshake_includes_attestation_for_chatgpt_codex_responses`  (lines 577–599)

```
async fn websocket_handshake_includes_attestation_for_chatgpt_codex_responses()
```

**Purpose**: Checks that websocket handshakes to ChatGPT Codex Responses include an attestation header. This proves that the client supplies the special proof required by that endpoint.

**Data flow**: It creates a ChatGPT Codex-style test client with counting attestation enabled, builds websocket-connection metadata, asks the client to build websocket headers, then checks that the attestation header contains the fake generated value and that generation happened exactly once.

**Call relations**: This test uses model_client_with_counting_attestation for the client and counter, and test_responses_metadata_for_client for realistic websocket metadata. It exercises build_websocket_headers, where the attestation should be attached.

*Call graph*: calls 2 internal fn (model_client_with_counting_attestation, test_responses_metadata_for_client); 2 external calls (assert_eq!, format!).


##### `non_chatgpt_codex_endpoints_omit_attestation_generation`  (lines 602–632)

```
async fn non_chatgpt_codex_endpoints_omit_attestation_generation()
```

**Purpose**: Checks that ordinary non-ChatGPT Codex endpoints do not generate or attach attestation headers. This avoids unnecessary work and prevents sending special proof headers where they do not belong.

**Data flow**: It creates a non-ChatGPT test client with the counting attestation provider attached, then asks three times whether an attestation header should be generated. Each result is absent, no headers are inserted, and the counter remains at zero.

**Call relations**: This test uses model_client_with_counting_attestation with attestation disabled by endpoint choice. It exercises generate_attestation_header_for directly for several request-like paths to confirm the same omission behavior.

*Call graph*: calls 1 internal fn (model_client_with_counting_attestation); 2 external calls (assert_eq!, new).


### `cloud-tasks-mock-client/src/mock.rs`

`test` · `tests and local mock backend use`

The project has code that expects to talk to a cloud task service: list tasks, fetch their diffs, read messages, apply changes, and create new tasks. This file supplies a stand-in version of that service. It is like a practice cash register in a training store: it looks and responds enough like the real thing, but no money or outside system is involved.

The central type is `MockClient`. It implements the same `CloudBackend` interface as a real backend, so other code can use it without caring whether the data is real or fake. When asked for tasks, it returns a small set of hard-coded examples. It slightly changes the returned tasks when an environment such as `env-A` or `env-B` is requested, which helps tests check environment filtering. Each task includes a made-up diff, a status, a timestamp, and a short summary of added and removed lines.

The mock can also return task text, assistant messages, sibling attempts, and successful apply or preflight results. These are deliberately simple and optimistic: applying always succeeds, preflight always passes, and creating a task just makes a local timestamp-based id. The helper functions at the bottom provide fake diff text and count changed lines in that diff.

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

**Purpose**: Returns a fake page of cloud tasks. It is used when callers need task-list data but should not contact the real cloud service.

**Data flow**: It receives an optional environment name, an optional limit, and an optional cursor. The mock ignores paging details, chooses a small hard-coded task list based on the environment, attaches labels and timestamps, creates a fake diff for each task, counts added and removed lines, and returns one page of task summaries with no next cursor.

**Call relations**: This is the main source of fake task summaries. `MockClient::get_task_summary` calls it to find one task by id, and while building each summary it asks `mock_diff_for` for sample patch text and `count_from_unified` for the line-change counts.

*Call graph*: calls 2 internal fn (count_from_unified, mock_diff_for); called by 1 (get_task_summary); 5 external calls (pin, now, new, new, vec!).


##### `MockClient::get_task_summary`  (lines 173–175)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Looks up one fake task summary by task id. It lets code exercise the same single-task lookup path it would use with the real backend.

**Data flow**: It receives a `TaskId`. It first asks the mock list operation for the default task list, searches that list for a matching id, and returns the matching summary. If no task matches, it returns a mock error saying the task was not found.

**Call relations**: Rather than keeping a separate database of tasks, this function reuses `MockClient::list_tasks` as its source of truth. Callers use it when they already know a task id and want the short metadata for that task.

*Call graph*: calls 1 internal fn (list_tasks); 1 external calls (pin).


##### `MockClient::get_task_diff`  (lines 177–179)

```
fn get_task_diff(&self, id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Returns the fake code diff for a task. This lets diff-viewing or apply-preview code run without needing a real task from the cloud.

**Data flow**: It receives a `TaskId`, passes that id to `mock_diff_for`, wraps the resulting diff text in `Some`, and returns it as a successful result.

**Call relations**: This is the direct path for callers that ask the backend for a task's patch. It relies on `mock_diff_for`, the shared helper that keeps the sample diff text consistent with the task summaries made by `MockClient::list_tasks`.

*Call graph*: calls 1 internal fn (mock_diff_for); 1 external calls (pin).


##### `MockClient::get_task_messages`  (lines 181–183)

```
fn get_task_messages(&self, id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Returns a small fake list of assistant messages for a task. It is useful for screens or commands that display conversation output.

**Data flow**: It receives a task id but does not inspect it. It returns a vector containing one fixed message that says the mock task contains no diff.

**Call relations**: Callers use this when they want only the message list rather than the richer task text object. It does not hand off to other project functions because the mock message is fixed.

*Call graph*: 2 external calls (pin, vec!).


##### `MockClient::get_task_text`  (lines 185–187)

```
fn get_task_text(&self, id: TaskId) -> CloudBackendFuture<'_, TaskText>
```

**Purpose**: Returns a richer fake text record for a task, including a prompt, messages, turn id, and attempt status. This supports code paths that need conversation details, not just a diff.

**Data flow**: It receives a task id but ignores the specific value. It builds a `TaskText` object with a fixed prompt, one fixed assistant message, a mock turn id, no sibling ids, placement zero, and a completed attempt status, then returns it.

**Call relations**: This is used by callers that need the complete task text shape expected from a cloud backend. It stands alone because all of the returned conversation data is hard-coded.

*Call graph*: 3 external calls (pin, new, vec!).


##### `MockClient::apply_task`  (lines 189–195)

```
fn apply_task(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Pretends to apply a task locally and reports success. It lets apply-related flows be tested without changing files through a real cloud operation.

**Data flow**: It receives a task id and an optional replacement diff. The replacement diff is ignored. It creates an `ApplyOutcome` saying the task was applied, the status is success, and there were no skipped or conflicting paths.

**Call relations**: Callers use this when they want the same response shape as a real apply operation. It does not call diff parsing or file-changing code; it simply returns a successful mock outcome.

*Call graph*: 3 external calls (pin, new, format!).


##### `MockClient::apply_task_preflight`  (lines 197–203)

```
fn apply_task_preflight(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Pretends to check whether a task can be applied and reports that the check passed. A preflight is a dry run: it answers 'would this work?' without doing the actual apply.

**Data flow**: It receives a task id and an optional replacement diff, ignores the replacement diff, and returns an `ApplyOutcome` with `applied` set to false. The status is success, and there are no skipped or conflicting files.

**Call relations**: Callers use this before applying a task when they want to test the dry-run path. Like `MockClient::apply_task`, it deliberately avoids real patch or file work and returns a simple success response.

*Call graph*: 3 external calls (pin, new, format!).


##### `MockClient::list_sibling_attempts`  (lines 205–211)

```
fn list_sibling_attempts(
        &self,
        task: TaskId,
        turn_id: String,
    ) -> CloudBackendFuture<'_, Vec<TurnAttempt>>
```

**Purpose**: Returns alternate mock attempts for a task. This helps test user interfaces that compare multiple tries at solving the same task.

**Data flow**: It receives a task id and a turn id. If the task id is `T-1000`, it returns one completed alternate attempt with a timestamp, a fake diff, and a short message. For any other task, it returns an empty list.

**Call relations**: Callers use this after loading task text or task details when they want to show related attempts. For the special task `T-1000`, it uses the same kind of fake diff data as the rest of the mock backend.

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

**Purpose**: Pretends to create a new cloud task and returns a fresh-looking local id. This allows task-creation flows to run in tests or demos without sending anything to a real service.

**Data flow**: It receives an environment id, prompt, git reference, QA-mode flag, and best-of-N count. The mock records none of that information; it only uses the current time in milliseconds to build an id like `task_local_...`, then returns that id in a `CreatedTask`.

**Call relations**: Callers use this where they would normally submit a new task to the backend. In the mock, the function stops at id creation and does not store the task for later listing.

*Call graph*: 3 external calls (pin, new, format!).


##### `mock_diff_for`  (lines 227–239)

```
fn mock_diff_for(id: &TaskId) -> String
```

**Purpose**: Provides sample unified diff text for a task id. A unified diff is the common patch format that shows removed lines with `-` and added lines with `+`.

**Data flow**: It receives a `TaskId`, checks the id string, and returns one of three hard-coded patch texts. `T-1000` gets a README change, `T-1001` gets a Rust file cleanup, and all other ids get a new contributing guide.

**Call relations**: This helper feeds fake patch data to `MockClient::list_tasks`, which summarizes the diff, and to `MockClient::get_task_diff`, which returns the full diff. Keeping the samples here means the mock uses consistent diffs in several places.

*Call graph*: called by 2 (get_task_diff, list_tasks).


##### `count_from_unified`  (lines 241–267)

```
fn count_from_unified(diff: &str) -> (usize, usize)
```

**Purpose**: Counts how many lines a diff adds and removes. This gives fake tasks realistic summary numbers such as '2 added, 1 removed.'

**Data flow**: It receives diff text. First it tries to parse the text as a proper patch using the `diffy` library. If parsing works, it walks through the patch lines and counts inserts and deletes. If parsing fails, it falls back to a simpler line-by-line scan that counts leading `+` and `-` characters while skipping diff header lines. It returns a pair: added lines and removed lines.

**Call relations**: This helper is used by `MockClient::list_tasks` while building each task summary. It turns the sample text from `mock_diff_for` into the small numeric summary that callers expect from a cloud task list.

*Call graph*: called by 1 (list_tasks); 1 external calls (from_str).


### `codex-client/tests/ca_env.rs`

`test` · `test run`

HTTPS clients need a trusted certificate authority list so they can decide whether a server is genuine. This file checks that Codex honors its custom CA settings correctly: it should read CODEX_CA_CERTIFICATE first, fall back to SSL_CERT_FILE when needed, parse normal certificate bundles, reject broken files with useful messages, and still work when a proxy is intercepting TLS traffic.

The tests deliberately launch a separate binary called custom_ca_probe instead of calling the certificate-loading code directly. That matters because environment variables are part of the feature. A subprocess is like asking a fresh worker to do the job with only the instructions you hand it; the test first removes inherited CA and proxy variables so the worker cannot quietly use settings from the outside world.

Most tests create temporary PEM files, which are text files containing certificates, then run the probe with different environment variables. The more realistic tests create local servers with freshly generated TLS 1.3 certificates, run the probe against them, and confirm that an OAuth token POST request actually arrives. One test also creates a local CONNECT proxy that pretends to be the target TLS server, like a corporate inspection proxy, and verifies the custom CA lets the client trust that proxy certificate.

#### Function details

##### `write_cert_file`  (lines 84–88)

```
fn write_cert_file(temp_dir: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes a test certificate or certificate bundle into a temporary directory and returns the path to that file. Tests use it to give the subprocess a real file path, just like a user would.

**Data flow**: It receives a temporary directory, a file name, and text contents. It joins the directory and name into a path, writes the contents there, and returns that path for later use in an environment variable.

**Call relations**: Most certificate-selection tests call this first to prepare the input file. The returned path is then passed into run_probe or one of the POST-style probe runners so the custom_ca_probe subprocess can try to read it.

*Call graph*: called by 10 (accepts_bundle_with_crl, accepts_openssl_trusted_certificate, falls_back_to_ssl_cert_file, handles_multi_certificate_bundle, posts_to_tls13_server_using_custom_ca_bundle, posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle, prefers_codex_ca_cert_over_ssl_cert_file, rejects_empty_pem_file_with_hint, rejects_malformed_pem_with_hint, uses_codex_ca_cert_env); 2 external calls (path, write).


##### `probe_command`  (lines 90–105)

```
fn probe_command() -> Command
```

**Purpose**: Builds the command used to run the custom_ca_probe test binary with a clean environment. This prevents local shell or CI certificate and proxy settings from changing the test result.

**Data flow**: It finds the custom_ca_probe executable, creates a command for it, then removes Codex CA variables, SSL_CERT_FILE, probe control variables, and common proxy variables. It returns a Command that callers can add only the settings they want to test.

**Call relations**: The helper runner functions all start here. They call probe_command, add their specific environment variables, and then execute the subprocess.

*Call graph*: called by 3 (run_probe, run_probe_posting_through_tls_intercepting_proxy, run_probe_posting_to_tls13_server); 2 external calls (new, cargo_bin).


##### `run_probe`  (lines 107–113)

```
fn run_probe(envs: &[(&str, &Path)]) -> std::process::Output
```

**Purpose**: Runs custom_ca_probe with a chosen set of file-path environment variables. It is the common helper for tests that only need to check certificate loading and error reporting.

**Data flow**: It receives pairs of environment variable names and paths. It creates a clean probe command, adds those variables, runs the subprocess, and returns the process output, including exit status, stdout, and stderr.

**Call relations**: The simpler tests call this after writing certificate files. It relies on probe_command for the clean baseline and gives each test the finished subprocess result to assert on.

*Call graph*: calls 1 internal fn (probe_command); called by 8 (accepts_bundle_with_crl, accepts_openssl_trusted_certificate, falls_back_to_ssl_cert_file, handles_multi_certificate_bundle, prefers_codex_ca_cert_over_ssl_cert_file, rejects_empty_pem_file_with_hint, rejects_malformed_pem_with_hint, uses_codex_ca_cert_env).


##### `run_probe_posting_to_tls13_server`  (lines 115–123)

```
fn run_probe_posting_to_tls13_server(envs: &[(&str, &Path)], url: &str) -> std::process::Output
```

**Purpose**: Runs custom_ca_probe in a mode where it makes a real HTTPS POST to a local TLS 1.3 server. This proves the custom CA is not just parsed, but actually used by the HTTP client.

**Data flow**: It receives environment variable path pairs and a target URL. It creates a clean command, adds the certificate settings, enables the probe’s TLS 1.3 POST mode, sets the URL, runs the subprocess, and returns the process output.

**Call relations**: The TLS server integration test calls this after starting a local TLS server. It uses probe_command for isolation and hands the output back so the test can compare it with what the server received.

*Call graph*: calls 1 internal fn (probe_command); called by 1 (posts_to_tls13_server_using_custom_ca_bundle).


##### `run_probe_posting_through_tls_intercepting_proxy`  (lines 125–138)

```
fn run_probe_posting_through_tls_intercepting_proxy(
    envs: &[(&str, &Path)],
    url: &str,
    proxy_url: &str,
) -> std::process::Output
```

**Purpose**: Runs custom_ca_probe in a mode where it posts through a local TLS-intercepting proxy. This checks the case where a proxy presents its own certificate and the client must trust the custom CA that signed it.

**Data flow**: It receives certificate-related environment variables, a destination URL, and a proxy URL. It builds a clean command, adds those values plus probe flags for TLS 1.3 and proxy use, runs the subprocess, and returns the subprocess output.

**Call relations**: The proxy integration test calls this after starting both a plain origin server and a TLS-intercepting proxy. It uses probe_command for a clean environment, while the servers later report whether the expected POST arrived.

*Call graph*: calls 1 internal fn (probe_command); called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle).


##### `spawn_tls13_test_server`  (lines 140–169)

```
fn spawn_tls13_test_server() -> Tls13TestServer
```

**Purpose**: Starts a one-request local HTTPS server using TLS 1.3 and a test certificate signed by a freshly made test CA. It gives the test both the server URL and the CA certificate needed to trust it.

**Data flow**: It generates certificate material, binds a local TCP port, builds a TLS 1.3 server configuration, creates a channel for the request result, and starts a background thread to accept one request. It returns the CA certificate text, the URL, and a receiver the test can use to learn what request arrived.

**Call relations**: The direct HTTPS POST test calls this before running the probe. Internally, the server thread hands off to accept_tls13_request, and the test later reads the channel to verify the request.

*Call graph*: calls 1 internal fn (generate_tls13_material); called by 1 (posts_to_tls13_server_using_custom_ca_bundle); 8 external calls (new, bind, ensure_rustls_crypto_provider, format!, channel, builder_with_protocol_versions, spawn, vec!).


##### `spawn_plain_http_origin`  (lines 171–191)

```
fn spawn_plain_http_origin() -> PlainHttpOrigin
```

**Purpose**: Starts a simple local origin server that accepts one plain HTTP request. It is used behind the intercepting proxy so the test can confirm the proxy forwarded the token request all the way through.

**Data flow**: It binds a local TCP port, creates a channel for the received request, and starts a background thread to accept and answer one HTTP request. It returns the server URL and the receiver for the captured request.

**Call relations**: The proxy test starts this as the final destination. The background thread uses accept_plain_http_origin_request, while the test reads the receiver after the probe runs.

*Call graph*: called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 4 external calls (bind, format!, channel, spawn).


##### `spawn_tls_intercepting_proxy`  (lines 193–222)

```
fn spawn_tls_intercepting_proxy() -> TlsInterceptingProxy
```

**Purpose**: Starts a local proxy that accepts an HTTP CONNECT request, then speaks TLS to the client using a certificate signed by a test CA. This mimics a network proxy that inspects HTTPS traffic.

**Data flow**: It generates CA and server certificate material, binds a local port, creates a TLS 1.3 server configuration, starts a background thread for one proxied request, and returns the proxy URL, CA certificate text, and a receiver for the request observed inside the tunnel.

**Call relations**: The proxy integration test calls this alongside spawn_plain_http_origin. Its background thread delegates the actual proxy conversation to accept_tls_intercepting_proxy_request.

*Call graph*: calls 1 internal fn (generate_tls13_material); called by 1 (posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 8 external calls (new, bind, ensure_rustls_crypto_provider, format!, channel, builder_with_protocol_versions, spawn, vec!).


##### `generate_tls13_material`  (lines 224–255)

```
fn generate_tls13_material() -> Tls13Material
```

**Purpose**: Creates throwaway certificate material for local TLS tests. It makes a test CA certificate and a server certificate signed by that CA, so the test can control exactly what should be trusted.

**Data flow**: It builds CA certificate settings, generates a CA key pair, self-signs the CA, then builds and signs a server certificate for localhost and 127.0.0.1. It returns the CA certificate in PEM text form plus the server certificate and private key for rustls to use.

**Call relations**: Both TLS server setup helpers call this before binding their local ports. The generated CA text is written to a file for the probe, and the server certificate/key are installed into the local TLS server or proxy.

*Call graph*: called by 2 (spawn_tls13_test_server, spawn_tls_intercepting_proxy); 8 external calls (default, new, self_signed, new, Ca, generate_for, from, vec!).


##### `accept_plain_http_origin_request`  (lines 257–267)

```
fn accept_plain_http_origin_request(listener: TcpListener) -> io::Result<String>
```

**Purpose**: Accepts one plain HTTP request from the local origin server and replies with a small success response. It captures the request so the test can check what the client sent.

**Data flow**: It receives a listening socket, waits for one connection with a timeout, switches the connection to blocking reads and writes with time limits, reads one HTTP message, writes a 200 OK response, and returns the request text.

**Call relations**: A background thread started by spawn_plain_http_origin runs this. The returned request is sent back through a channel to the proxy integration test.

*Call graph*: calls 2 internal fn (accept_with_timeout, read_http_message); 1 external calls (from_secs).


##### `accept_tls13_request`  (lines 269–284)

```
fn accept_tls13_request(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
) -> io::Result<String>
```

**Purpose**: Accepts one HTTPS request using TLS 1.3 and replies with a small success response. It is the server-side half of the direct custom-CA HTTPS test.

**Data flow**: It receives a listening socket and TLS server configuration. It waits for a client, wraps the TCP stream in a TLS server connection, reads an HTTP message through that encrypted stream, sends a 200 OK response, and returns the request text.

**Call relations**: A background thread started by spawn_tls13_test_server runs this. It uses accept_with_timeout to avoid hanging forever and read_http_message to capture the POST.

*Call graph*: calls 2 internal fn (accept_with_timeout, read_http_message); 3 external calls (from_secs, new, new).


##### `accept_tls_intercepting_proxy_request`  (lines 286–314)

```
fn accept_tls_intercepting_proxy_request(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
) -> io::Result<String>
```

**Purpose**: Performs one full proxy interaction: accept CONNECT, establish a TLS tunnel with the client, read the client’s request, forward it to the origin, and send the origin response back. This simulates a TLS-inspecting proxy in a controlled local test.

**Data flow**: It accepts a TCP connection, reads the CONNECT request, extracts the target host and port, replies that the tunnel is established, then upgrades the client side to TLS. It reads the tunneled HTTP request, opens a TCP connection to the origin, forwards the request, reads the origin response, sends that response back through TLS, and returns the tunneled request text.

**Call relations**: A background thread started by spawn_tls_intercepting_proxy runs this. It depends on connect_authority_from_request to find the origin and on read_http_message for both client and origin messages.

*Call graph*: calls 3 internal fn (accept_with_timeout, connect_authority_from_request, read_http_message); 4 external calls (from_secs, connect, new, new).


##### `connect_authority_from_request`  (lines 316–329)

```
fn connect_authority_from_request(request: &str) -> io::Result<String>
```

**Purpose**: Pulls the target host and port out of an HTTP CONNECT request line. A proxy needs this value to know where to forward the tunneled traffic.

**Data flow**: It receives the raw CONNECT request text, reads the first line, splits it into words, and checks that it looks like CONNECT target HTTP-version. If valid, it returns the target authority string; otherwise it returns an input-data error.

**Call relations**: accept_tls_intercepting_proxy_request calls this right after reading the proxy CONNECT request. Its result tells the proxy which origin address to open.

*Call graph*: called by 1 (accept_tls_intercepting_proxy_request); 2 external calls (new, format!).


##### `accept_with_timeout`  (lines 331–348)

```
fn accept_with_timeout(listener: TcpListener, timeout: Duration) -> io::Result<TcpStream>
```

**Purpose**: Waits for one incoming TCP connection, but only for a limited time. This keeps a failed test from hanging forever.

**Data flow**: It receives a nonblocking listener and a timeout duration. It repeatedly tries to accept a connection, sleeps briefly when none is ready, and returns either the accepted stream, a timeout error, or another socket error.

**Call relations**: All three local server accept functions use this at the start of their work. It is the shared guardrail that makes the background server threads fail quickly and clearly if the probe never connects.

*Call graph*: called by 3 (accept_plain_http_origin_request, accept_tls13_request, accept_tls_intercepting_proxy_request); 5 external calls (from_millis, now, accept, new, sleep).


##### `read_http_message`  (lines 350–377)

```
fn read_http_message(stream: &mut impl Read) -> io::Result<String>
```

**Purpose**: Reads one complete HTTP message from a stream, including the body when a Content-Length header is present. It gives the tests a simple string they can inspect.

**Data flow**: It receives any readable stream, reads bytes into a buffer, watches for the blank line that ends HTTP headers, then uses Content-Length if present to know how many body bytes to wait for. It returns the collected bytes as text.

**Call relations**: The plain server, TLS server, and proxy all call this when they need to capture requests or responses. It is the common reader that lets the tests assert on the actual HTTP text.

*Call graph*: called by 3 (accept_plain_http_origin_request, accept_tls13_request, accept_tls_intercepting_proxy_request); 3 external calls (read, from_utf8_lossy, new).


##### `assert_token_exchange_request`  (lines 379–388)

```
fn assert_token_exchange_request(request: &str)
```

**Purpose**: Checks that a captured HTTP request is the expected OAuth token exchange POST. This confirms the probe reached the intended endpoint and sent the expected form body.

**Data flow**: It receives request text and asserts that it starts with POST /oauth/token HTTP/1.1 and contains the expected authorization-code form data. It returns nothing, but fails the test if either check is false.

**Call relations**: The direct TLS test and the proxy test call this after receiving captured requests from their local servers. It turns raw request text into a clear pass-or-fail check.

*Call graph*: called by 2 (posts_to_tls13_server_using_custom_ca_bundle, posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle); 1 external calls (assert!).


##### `uses_codex_ca_cert_env`  (lines 391–398)

```
fn uses_codex_ca_cert_env()
```

**Purpose**: Verifies that CODEX_CA_CERTIFICATE is accepted as the main custom CA environment variable. This protects the user-facing setting that tells Codex where to find extra trusted certificates.

**Data flow**: It creates a temporary CA file, runs the probe with CODEX_CA_CERTIFICATE pointing to that file, and checks that the subprocess exits successfully.

**Call relations**: This is one of the simple subprocess tests. It uses write_cert_file to prepare input and run_probe to execute the isolated custom_ca_probe binary.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `falls_back_to_ssl_cert_file`  (lines 401–408)

```
fn falls_back_to_ssl_cert_file()
```

**Purpose**: Verifies that SSL_CERT_FILE is used when the Codex-specific CA variable is not set. This supports users and environments that already rely on the common SSL_CERT_FILE convention.

**Data flow**: It writes a valid certificate file, runs the probe with SSL_CERT_FILE pointing to it, and checks that the probe succeeds.

**Call relations**: Like the other environment-selection tests, it prepares a file with write_cert_file and runs the clean subprocess through run_probe.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `prefers_codex_ca_cert_over_ssl_cert_file`  (lines 411–422)

```
fn prefers_codex_ca_cert_over_ssl_cert_file()
```

**Purpose**: Checks that CODEX_CA_CERTIFICATE wins when both it and SSL_CERT_FILE are set. This makes the Codex-specific setting predictable and prevents a bad fallback file from overriding it.

**Data flow**: It writes one valid CA file and one empty bad file. It runs the probe with CODEX_CA_CERTIFICATE pointing to the good file and SSL_CERT_FILE pointing to the bad file, then expects success.

**Call relations**: This test uses write_cert_file twice and run_probe once. Its success shows that the selection logic in the subprocess chose the Codex-specific file first.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `handles_multi_certificate_bundle`  (lines 425–433)

```
fn handles_multi_certificate_bundle()
```

**Purpose**: Verifies that a PEM file containing more than one certificate is accepted. Real CA bundles often contain several certificates in one file.

**Data flow**: It combines two certificate fixture strings, writes them as one bundle file, runs the probe with CODEX_CA_CERTIFICATE pointing to that bundle, and expects success.

**Call relations**: This test follows the simple write-and-run pattern using write_cert_file and run_probe. It focuses on parsing multiple certificates from one file.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (new, assert!, format!).


##### `posts_to_tls13_server_using_custom_ca_bundle`  (lines 436–455)

```
fn posts_to_tls13_server_using_custom_ca_bundle()
```

**Purpose**: Proves that a custom CA bundle can be used for a real HTTPS request to a TLS 1.3 server. This is stronger than only checking that the file parses.

**Data flow**: It starts a local TLS 1.3 server with a generated certificate, writes that server’s CA certificate to a file, runs the probe against the server URL using that CA file, waits for the server to report the request, then checks both process success and request contents.

**Call relations**: This test ties together spawn_tls13_test_server, write_cert_file, run_probe_posting_to_tls13_server, and assert_token_exchange_request. The subprocess sends the request, the server thread captures it, and the test compares both sides.

*Call graph*: calls 4 internal fn (assert_token_exchange_request, run_probe_posting_to_tls13_server, spawn_tls13_test_server, write_cert_file); 3 external calls (from_secs, new, assert!).


##### `posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle`  (lines 458–486)

```
fn posts_to_token_origin_through_tls_intercepting_proxy_with_custom_ca_bundle()
```

**Purpose**: Proves that the client can use a custom CA when an HTTPS request goes through a TLS-intercepting proxy. This covers environments where company proxies replace server certificates with their own.

**Data flow**: It starts a plain origin server and a TLS-intercepting proxy, writes the proxy CA certificate to a file, runs the probe through the proxy toward the origin URL, then waits for both proxy and origin to report requests. It checks that the subprocess succeeded and that both captured requests look like the expected token exchange.

**Call relations**: This is the broadest integration test in the file. It combines the origin server, proxy server, proxy-mode probe runner, and token-request assertion to confirm the full path works.

*Call graph*: calls 5 internal fn (assert_token_exchange_request, run_probe_posting_through_tls_intercepting_proxy, spawn_plain_http_origin, spawn_tls_intercepting_proxy, write_cert_file); 3 external calls (from_secs, new, assert!).


##### `rejects_empty_pem_file_with_hint`  (lines 489–500)

```
fn rejects_empty_pem_file_with_hint()
```

**Purpose**: Checks that an empty certificate file is rejected with a helpful error message. The message should point users toward the relevant environment variables.

**Data flow**: It writes an empty PEM file, runs the probe with CODEX_CA_CERTIFICATE pointing to it, expects the process to fail, reads stderr, and checks for text saying no certificates were found plus mentions of CODEX_CA_CERTIFICATE and SSL_CERT_FILE.

**Call relations**: This test uses the normal subprocess path through write_cert_file and run_probe, but asserts on failure output instead of success.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (from_utf8_lossy, new, assert!).


##### `rejects_malformed_pem_with_hint`  (lines 503–518)

```
fn rejects_malformed_pem_with_hint()
```

**Purpose**: Checks that a broken PEM certificate file is rejected with a clear parsing error and useful guidance. This helps users diagnose bad certificate files instead of seeing a vague HTTPS failure.

**Data flow**: It writes an intentionally incomplete certificate block, runs the probe with CODEX_CA_CERTIFICATE pointing to it, expects failure, reads stderr, and checks that it mentions PEM parsing and the relevant CA environment variables.

**Call relations**: This is the malformed-file partner to rejects_empty_pem_file_with_hint. It uses write_cert_file and run_probe, then inspects the subprocess error text.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (from_utf8_lossy, new, assert!).


##### `accepts_openssl_trusted_certificate`  (lines 521–528)

```
fn accepts_openssl_trusted_certificate()
```

**Purpose**: Verifies that a certificate file in OpenSSL’s trusted-certificate PEM style is accepted. This matters because users may provide files produced by OpenSSL tools, not only plain certificate blocks.

**Data flow**: It writes the trusted-certificate fixture to a temporary file, runs the probe with CODEX_CA_CERTIFICATE pointing to it, and expects the subprocess to succeed.

**Call relations**: This test uses the shared write_cert_file and run_probe helpers. It broadens the parser coverage to a common certificate-file variant.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 2 external calls (new, assert!).


##### `accepts_bundle_with_crl`  (lines 531–540)

```
fn accepts_bundle_with_crl()
```

**Purpose**: Verifies that a certificate bundle can include a CRL block without failing. A CRL, or certificate revocation list, is a list of certificates that should no longer be trusted; this test ensures such extra PEM blocks do not stop valid certificates from being loaded.

**Data flow**: It builds a bundle containing a valid certificate plus a small CRL-looking PEM block, writes it to a temporary file, runs the probe with CODEX_CA_CERTIFICATE pointing to the bundle, and expects success.

**Call relations**: This test follows the same helper path as the other parsing tests. It confirms the subprocess can ignore or tolerate non-certificate PEM material while still finding the certificate.

*Call graph*: calls 2 internal fn (run_probe, write_cert_file); 3 external calls (new, assert!, format!).


### Prompt and tool rendering tests
These tests lock down prompt/template output and tool-side normalization helpers used when preparing model-facing inputs and outputs.

### `prompts/src/goals_tests.rs`

`test` · `test run`

This is a test file, so it does not build the prompts itself. Instead, it checks that the prompt-building code produces messages with the right guidance for different goal situations. A “thread goal” is the task the assistant is supposed to keep working toward across turns, such as “finish the stack.” These tests create sample goals, ask the prompt functions to turn those goals into instruction text, and then check that important phrases are present or absent.

The file covers three main situations. First, when a goal is still active, the continuation prompt should remind the assistant of the objective and explain when it may mark the goal complete or blocked. Second, when the token budget is exceeded, the budget-limit prompt should push the assistant to wrap up soon, not pause. Third, when a user edits the objective, the updated-objective prompt should clearly say the new goal replaces the old one.

The last test is especially important for safety. It checks that goal text containing XML-like tags is escaped before being placed inside prompt delimiters. In everyday terms, it makes sure a user’s goal is treated like a note inside an envelope, not like new instructions printed on the envelope itself.

#### Function details

##### `continuation_prompt_allows_complete_and_strict_blocked_updates`  (lines 6–30)

```
fn continuation_prompt_allows_complete_and_strict_blocked_updates()
```

**Purpose**: This test checks the prompt used when an assistant should continue working on an active goal. It verifies that the prompt includes the goal and budget details, allows marking the goal complete, and only allows marking it blocked under strict conditions.

**Data flow**: The test starts by creating a sample active thread goal with an objective, token budget, and usage numbers. It passes that goal into the continuation prompt builder, normalizes line endings, and then inspects the resulting text. The expected result is a prompt that includes the objective and completion/blocking rules, while leaving out unrelated statuses such as budget-limited or paused.

**Call relations**: During the test run, the Rust test framework calls this function. Inside it, a fresh thread identifier is created with `new`, then the generated prompt is checked with assertions. Those assertions act like a checklist for the prompt text that other parts of the system will later show to the assistant.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `budget_limit_prompt_steers_model_to_wrap_up_without_pausing`  (lines 33–52)

```
fn budget_limit_prompt_steers_model_to_wrap_up_without_pausing()
```

**Purpose**: This test checks the prompt used when a goal has gone past its token budget. It makes sure the assistant is told to finish or summarize soon, rather than being invited to pause the goal.

**Data flow**: The test creates a sample goal whose status is budget-limited and whose tokens used are higher than the budget. It sends that goal to the budget-limit prompt builder and examines the resulting text. The prompt must include the objective, the budget, the amount used, and wording that tells the assistant to wrap up soon; it must not mention a paused status.

**Call relations**: The test framework calls this function as part of the prompt test suite. The function creates a new thread identifier, builds one prompt, and uses assertions to confirm that the prompt gives the right end-of-budget guidance before the prompt is trusted elsewhere.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `objective_updated_prompt_supersedes_previous_goal_context`  (lines 55–78)

```
fn objective_updated_prompt_supersedes_previous_goal_context()
```

**Purpose**: This test checks the prompt used after a user edits the thread goal. It verifies that the assistant is clearly told the new objective replaces any earlier one.

**Data flow**: The test builds a sample active goal with a revised objective and some token usage. It feeds that goal into the updated-objective prompt builder, then checks the output text. The prompt must say the goal was edited by the user, must wrap the new objective in the expected untrusted-objective markers, must show budget information, and must warn not to mark the goal complete unless it truly is complete.

**Call relations**: The test framework runs this function when validating goal prompts. The function creates a fresh thread identifier, asks for the updated-objective prompt, and then uses assertions to make sure the resulting instructions prevent the assistant from accidentally following stale goal context.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `goal_prompts_escape_objective_delimiters`  (lines 81–120)

```
fn goal_prompts_escape_objective_delimiters()
```

**Purpose**: This test checks that user-written objective text is safely escaped before it is placed into any goal prompt. This matters because the objective may contain text that looks like prompt markup or instructions, and it must not be allowed to break out of its intended container.

**Data flow**: The test begins with a deliberately tricky objective containing XML-like closing tags and a fake developer instruction. It computes the safely escaped version of that text, then builds all three kinds of goal prompt using the same objective. For each prompt, it checks that the escaped text is present and the raw dangerous-looking text is not present.

**Call relations**: The test framework calls this function along with the other goal prompt tests. It creates new thread identifiers for the sample goals and uses assertions to verify a cross-cutting safety rule: every goal prompt must quote objective text safely, no matter which prompt path produced it.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### `prompts/src/review_request_tests.rs`

`test` · `test suite`

This is a test file. Its job is to make sure the prompt-building code produces clear, stable instructions for code review requests. In this project, a “prompt” is the text sent to a reviewer or AI assistant telling it what code changes to inspect. If this text changes by accident, the review flow could become confusing, compare the wrong code, or lose useful context.

The tests cover two main review targets. First, they check branch-based reviews, where the system asks for changes compared with a base branch such as `main`. One test covers the normal case, where the merge base commit is already known. Another covers a backup wording that tells the user how to find that merge base. A merge base is the shared commit where two branches last had the same history.

Second, the tests cover commit-based reviews. They verify the prompt for a commit identified by its SHA, both with and without a human-readable title. Each test compares the rendered prompt with one exact expected string, like checking that a printed form has every sentence in the right place.

#### Function details

##### `review_prompt_template_renders_base_branch_backup_variant`  (lines 5–10)

```
fn review_prompt_template_renders_base_branch_backup_variant()
```

**Purpose**: This test verifies the fallback branch-review prompt. It makes sure that when only a branch name is inserted, the prompt tells the reviewer how to find the merge base and then inspect the diff.

**Data flow**: The test starts with the backup branch prompt template and the value `branch = main`. The prompt renderer fills that value into the template. The result is compared with the full expected sentence, and the test passes only if the text matches exactly.

**Call relations**: When the Rust test runner reaches this test, it exercises the prompt-rendering code for the backup branch path. It then uses `assert_eq!` to compare the actual rendered text with the expected text, so any accidental wording or placeholder change is caught.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_base_branch_variant`  (lines 13–21)

```
fn review_prompt_template_renders_base_branch_variant()
```

**Purpose**: This test verifies the normal branch-review prompt. It checks that the base branch name and already-known merge base commit are inserted into the review instructions correctly.

**Data flow**: The test gives the renderer a branch prompt template plus `base_branch = main` and `merge_base_sha = abc123`. The renderer turns that into one prompt string. The test compares that string with the exact expected output.

**Call relations**: The test runner calls this during the test suite to cover the main branch-comparison wording. It relies on `assert_eq!` to flag any mismatch between the generated prompt and the required prompt.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_commit_variant`  (lines 24–36)

```
fn review_prompt_template_renders_commit_variant()
```

**Purpose**: This test verifies the prompt for reviewing a single commit when no commit title is available. It makes sure the prompt names the commit SHA and does not add extra title text.

**Data flow**: The test builds a commit review target with SHA `deadbeef` and no title, and it also supplies the current working directory as the repository path. The prompt builder produces the review text. The test compares that text with the exact expected commit-review sentence.

**Call relations**: The Rust test runner invokes this test to cover commit-review prompt generation without optional title information. After `review_prompt` creates the string, `assert_eq!` checks that the output is exactly right.

*Call graph*: 1 external calls (assert_eq!).


##### `review_prompt_template_renders_commit_variant_with_title`  (lines 39–51)

```
fn review_prompt_template_renders_commit_variant_with_title()
```

**Purpose**: This test verifies the prompt for reviewing a single commit when a commit title is available. It makes sure the title is included in parentheses after the commit SHA.

**Data flow**: The test creates a commit review target with SHA `deadbeef` and title `Fix bug`, then passes it along with the current working directory to the prompt builder. The builder returns a prompt string. The test checks that the string includes both the SHA and the quoted title in the expected format.

**Call relations**: The test runner calls this test as part of the prompt test suite. It exercises the title-aware path in `review_prompt`, then hands the result to `assert_eq!` so formatting mistakes are caught immediately.

*Call graph*: 1 external calls (assert_eq!).


### `prompts/src/review_exit_tests.rs`

`test` · `test suite`

This is a small test file for the prompt-building code used when a user finishes or exits a review task. In this project, prompt text is not just decoration: it is structured input that another model or part of the system may read. That means line breaks, indentation, tags, and inserted review results all matter.

The first test makes sure that review findings are placed into the review-exit template exactly where the results belong. It is like checking that a form letter puts the customer’s name in the name slot, not somewhere else. The expected output includes the surrounding XML-like tags, the review action, and the full results text.

The second test checks line ending cleanup. Different operating systems write new lines differently: Unix-style uses `\n`, while Windows-style uses `\r\n`. This test confirms that the template normalizer rewrites Windows-style endings into the consistent form the rest of the prompt code expects.

Together, these tests act as tripwires. If someone edits the review prompt template or its cleanup behavior in a way that changes the final text, the tests fail and show the difference clearly.

#### Function details

##### `render_review_exit_success_replaces_results_placeholder`  (lines 5–10)

```
fn render_review_exit_success_replaces_results_placeholder()
```

**Purpose**: This test verifies that the review-exit success prompt correctly inserts the reviewer’s findings into the results section. It exists so a future template change does not accidentally drop, move, or misformat the review output.

**Data flow**: It starts with a sample review result containing two findings. It passes that text into `render_review_exit_success`, then compares the returned prompt against the exact full prompt string that should be produced. Nothing is changed outside the test; the outcome is simply pass or fail.

**Call relations**: During the test run, the test framework calls this function. Inside it, the generated prompt is checked with an equality assertion, so any mismatch in tags, spacing, line breaks, or inserted text is reported immediately.

*Call graph*: 1 external calls (assert_eq!).


##### `normalize_review_template_line_endings_rewrites_crlf`  (lines 13–18)

```
fn normalize_review_template_line_endings_rewrites_crlf()
```

**Purpose**: This test verifies that review prompt templates using Windows-style line endings are converted to the project’s standard newline format. This keeps prompt text consistent no matter which operating system edited or generated it.

**Data flow**: It starts with a short template string containing `\r\n` line endings. It sends that string into `normalize_review_template_line_endings`, then compares the result with the same text using only `\n` line endings. The test does not write files or change shared state; it only checks the returned string.

**Call relations**: The test framework calls this function as part of the test suite. The function relies on an equality assertion to confirm that the normalizer produced the expected cleaned-up text.

*Call graph*: 1 external calls (assert_eq!).


### `memories/write/src/prompts_tests.rs`

`test` · `test run`

This is a test file for the code that builds text prompts used by the memory-writing system. A prompt is the instruction and context sent to an AI model. Because models can only read a limited amount of text at once, these tests make sure huge rollout files are shortened before they are placed into a prompt. Think of it like packing a suitcase with a weight limit: the test checks that the packing code uses the suitcase size printed on the ticket, and falls back to a standard size when that information is missing.

The first two tests create an intentionally enormous string, then compare the prompt builder’s output with the expected shortened version. One test uses a model with a known context window, meaning the model’s maximum reading capacity. The other removes that capacity information and checks that a default limit is used instead.

The last test checks the consolidation prompt, which is the instruction used when turning temporary memory workspace changes into lasting memory files. It creates a temporary memory folder and verifies that the prompt points the reader to the workspace diff file and to the extensions folder, including guidance about deleted extension resources.

#### Function details

##### `build_stage_one_input_message_truncates_rollout_using_model_context_window`  (lines 6–32)

```
fn build_stage_one_input_message_truncates_rollout_using_model_context_window()
```

**Purpose**: This test proves that the stage-one prompt builder shortens a very large rollout using the selected model’s own reading limit. It matters because sending too much text to a model can fail or push out important instructions.

**Data flow**: It starts with a huge text string made of many repeated letters with a small middle marker. It loads model information, sets a specific context window, calculates the expected token limit, and creates the same shortened text the prompt builder should use. Then it builds the actual stage-one input message and checks that the prompt contains the shortened rollout, including the truncation notice while preserving text from both the start and end.

**Call relations**: During the test, it asks the model-info helper for details about a known model, then uses the truncation policy to calculate what should fit. It then exercises the stage-one prompt builder and compares the result against that expected shortened text, so future changes cannot accidentally ignore the model’s context window.

*Call graph*: calls 1 internal fn (model_info_from_slug); 5 external calls (new, assert!, format!, Tokens, try_from).


##### `build_stage_one_input_message_uses_default_limit_when_model_context_window_missing`  (lines 35–53)

```
fn build_stage_one_input_message_uses_default_limit_when_model_context_window_missing()
```

**Purpose**: This test checks the fallback path for models that do not report a usable reading limit. It makes sure the prompt builder still keeps rollout text under a safe default size instead of leaving it unbounded.

**Data flow**: It creates the same kind of oversized rollout text, loads model information, then deliberately removes both the normal and maximum context-window values. It shortens the input using the project’s default rollout token limit, builds the stage-one message, and checks that the message contains that expected shortened text.

**Call relations**: This test covers the case where model metadata is incomplete. It calls into the same stage-one prompt-building path as the model-window test, but verifies that the code hands off to the default limit rather than depending on missing model data.

*Call graph*: calls 1 internal fn (model_info_from_slug); 4 external calls (new, assert!, format!, Tokens).


##### `build_consolidation_prompt_points_to_workspace_diff_and_extension_tree`  (lines 56–71)

```
fn build_consolidation_prompt_points_to_workspace_diff_and_extension_tree()
```

**Purpose**: This test verifies that the consolidation prompt tells the model where to find the memory workspace diff and the memory extensions folder. That is important because consolidation depends on seeing what changed, including deleted extension files.

**Data flow**: It creates a temporary directory, builds a memory root and an extensions subfolder inside it, and creates that folder on disk. It then builds the consolidation prompt from the memory root and checks that the prompt text mentions the workspace diff file, the extensions directory path, and guidance about deleted extension resource files.

**Call relations**: This test sets up a small fake memory workspace before calling the consolidation prompt builder. The assertions act like a checklist: if the prompt stops pointing to the diff or the extension tree, the test fails before that missing instruction can affect real consolidation work.

*Call graph*: 3 external calls (assert!, create_dir_all, tempdir).


### `tools/src/image_detail_tests.rs`

`test` · `test run`

This is a test file. It protects a small but important compatibility rule: not every model can accept an image detail setting of “original,” which likely means sending or requesting the image at its original resolution or quality. If the program asked an unsupported model for that setting, the request could fail or behave unexpectedly.

The tests build a fake `ModelInfo` record that looks like a real model description. That record includes whether the model supports `ImageDetail::Original`. The tests then check two kinds of behavior. First, they check how a requested output image detail is normalized: “original” is kept only when the model supports it, while ordinary choices like “auto,” “low,” and “high” are left alone. Second, they check how a list of tool-output content items is cleaned before use. If an image asks for “original” but the model cannot accept it, the code replaces that request with the default image detail instead. Text items and already-safe image detail settings are not changed.

An everyday analogy: this file checks that the system does not order a restaurant item that is not on the menu. If “original image detail” is unavailable, it quietly chooses the safe default instead.

#### Function details

##### `model_info`  (lines 9–42)

```
fn model_info() -> ModelInfo
```

**Purpose**: Creates a realistic test `ModelInfo` object, which describes the abilities of a model. The tests use it as a standard starting point so they do not have to repeat a large model description each time.

**Data flow**: It starts with hard-coded JSON-like test data, including a model name, supported input types, and the flag saying the model supports original image detail. It turns that JSON data into a `ModelInfo` value. The result is returned to each test that needs a model description.

**Call relations**: The image-detail tests call this helper when they need a fresh model setup. Some tests use it unchanged to represent a model that supports original image detail; another test changes one field to represent a model that does not.

*Call graph*: called by 3 (explicit_non_original_detail_is_preserved, explicit_original_is_allowed_when_model_supports_it, explicit_original_is_dropped_without_model_support); 2 external calls (json!, from_value).


##### `explicit_original_is_allowed_when_model_supports_it`  (lines 45–57)

```
fn explicit_original_is_allowed_when_model_supports_it()
```

**Purpose**: Checks the happy path: when a model says it supports original image detail, the system is allowed to request it. It also confirms that leaving the detail unspecified stays unspecified.

**Data flow**: It gets a test model from `model_info`. It asks whether original image detail can be requested, then checks that normalizing an explicit `Original` request keeps it as `Original`. It also checks that normalizing a missing detail value produces no detail value.

**Call relations**: This test exercises the image-detail normalization behavior for a capable model. It relies on `model_info` for setup, then verifies the result with test assertions.

*Call graph*: calls 1 internal fn (model_info); 2 external calls (assert!, assert_eq!).


##### `explicit_original_is_dropped_without_model_support`  (lines 60–67)

```
fn explicit_original_is_dropped_without_model_support()
```

**Purpose**: Checks the safety rule for unsupported models: an explicit request for original image detail must be removed if the model cannot handle it.

**Data flow**: It creates a test model, then changes its support flag to say original image detail is not supported. It passes an explicit `Original` request into the normalization function. The expected output is `None`, meaning the request has been dropped.

**Call relations**: This test covers the opposite case from the supported-model test. It uses the shared `model_info` helper, tweaks the model capability, and then confirms that normalization refuses the unsupported setting.

*Call graph*: calls 1 internal fn (model_info); 1 external calls (assert_eq!).


##### `explicit_non_original_detail_is_preserved`  (lines 70–85)

```
fn explicit_non_original_detail_is_preserved()
```

**Purpose**: Makes sure ordinary image detail choices are not accidentally changed. The special restriction only applies to `Original`, not to `Auto`, `Low`, or `High`.

**Data flow**: It builds a test model with `model_info`. It sends three different non-original detail requests through the normalization function. Each one is expected to come back exactly as it went in.

**Call relations**: This test guards against an overbroad cleanup rule. It shows that the normalization logic is narrow: it filters unsupported `Original` requests but leaves standard detail choices alone.

*Call graph*: calls 1 internal fn (model_info); 1 external calls (assert_eq!).


##### `sanitize_original_falls_back_to_high_without_support`  (lines 88–121)

```
fn sanitize_original_falls_back_to_high_without_support()
```

**Purpose**: Checks cleanup of a mixed list of tool-output content. If an image asks for original detail but original is not allowed, the image is changed to the default detail while unrelated content is preserved.

**Data flow**: It starts with a list containing one text item and two image items. One image asks for `Original`; the other asks for `Low`. It runs the sanitizer with permission for original detail set to false. Afterward, the original-detail image has been changed to the default image detail, while the text item and low-detail image are unchanged.

**Call relations**: This test checks the bulk-cleanup step used when content items are prepared for a model. Instead of testing one detail value by itself, it verifies that the sanitizer walks through real mixed content and only changes the unsafe image entry.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tools/src/json_schema_tests.rs`

`test` · `test run`

A tool input schema is a JSON description of what arguments a tool accepts, like a form that says which fields exist and what kind of value each field should contain. In the real world these schemas can be incomplete, too large, or written in slightly different JSON Schema styles. This test file documents the rules the project expects when those schemas are parsed and normalized.

The tests feed small example schemas into `parse_tool_input_schema`, then compare the result with the exact `JsonSchema` structure the project wants. They cover basic cleanup, such as treating missing object properties as empty, giving arrays default item types, preserving integer versus number, and rejecting a schema that is only `null`. They also check more advanced shapes, such as `anyOf`, `oneOf`, and `allOf`, which mean “one of these possible schema forms.”

A large section checks size reduction. If a schema is too big, the normal parser strips descriptions, drops unused definitions, and eventually prunes complex alternatives, while a special parser path keeps descriptions. Another section checks `$ref` references, which are like shortcuts pointing to reusable schema definitions. These tests make sure useful definitions stay, unused ones disappear, and unusual references do not crash the parser.

#### Function details

##### `parse_tool_input_schema_coerces_boolean_schemas`  (lines 14–25)

```
fn parse_tool_input_schema_coerces_boolean_schemas()
```

**Purpose**: Checks that a bare boolean JSON Schema, such as `true`, is accepted and converted into a simple string schema. This matters because the internal schema model cannot directly express every meaning of boolean schemas.

**Data flow**: The test starts with the JSON value `true`. It sends that value into `parse_tool_input_schema`, then expects the output to be the same as `JsonSchema::string(None)`. Nothing outside the test is changed.

**Call relations**: During the test run, this function calls the parser being tested and then uses `assert_eq!` to compare the parser's result with the expected fallback schema.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `json_schema_serializes_encrypted_marker`  (lines 28–39)

```
fn json_schema_serializes_encrypted_marker()
```

**Purpose**: Checks that a schema marked as encrypted is written out with an `encrypted: true` field. This protects the contract used when secret tool inputs need to be labeled in JSON.

**Data flow**: The test builds a string schema with a description, adds the encrypted marker, serializes it to JSON, and compares that JSON with the expected object. The output is only the pass or failure of the assertion.

**Call relations**: This test exercises the `JsonSchema` builder methods and serialization path, then hands the serialized value to `assert_eq!` for verification.

*Call graph*: calls 1 internal fn (string); 1 external calls (assert_eq!).


##### `parse_tool_input_schema_infers_object_shape_and_defaults_properties`  (lines 42–69)

```
fn parse_tool_input_schema_infers_object_shape_and_defaults_properties()
```

**Purpose**: Checks that a schema with `properties` but no explicit `type` is treated as an object. It also checks that an unclear child property becomes a permissive empty schema.

**Data flow**: The input JSON contains a `properties` table with one field. The parser reads that as an object schema, normalizes the child field, and returns a `JsonSchema::object` with that property set to the default empty schema.

**Call relations**: The test builds example JSON, calls `parse_tool_input_schema`, and compares the normalized result with the object shape expected by later API calls.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_coerces_unrecognized_object_schema_to_empty_schema`  (lines 72–89)

```
fn parse_tool_input_schema_coerces_unrecognized_object_schema_to_empty_schema()
```

**Purpose**: Checks that a schema containing only descriptive metadata, with no usable type hints, becomes an empty permissive schema. This avoids pretending the parser knows more than it does.

**Data flow**: The input has `description` and `title`, but no recognized schema structure. The parser removes or ignores those hints for shape purposes and returns `JsonSchema::default()`.

**Call relations**: This test calls the parser on a malformed-but-common schema shape and uses `assert_eq!` to lock in the fallback behavior.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_integer_and_defaults_array_items`  (lines 92–134)

```
fn parse_tool_input_schema_preserves_integer_and_defaults_array_items()
```

**Purpose**: Checks two basic normalization rules: `integer` remains different from `number`, and an array with no `items` gets a default item schema. This keeps important type details while filling in missing required pieces.

**Data flow**: The input is an object with `page` as an integer and `tags` as an array without item details. The parser returns an object where `page` is an integer schema and `tags` is an array of strings.

**Call relations**: The test calls the parser and compares the parsed object to the hand-built expected schema, proving the parser both preserves and fills schema details correctly.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_sanitizes_additional_properties_schema`  (lines 137–189)

```
fn parse_tool_input_schema_sanitizes_additional_properties_schema()
```

**Purpose**: Checks that schemas inside `additionalProperties` are cleaned up recursively. `additionalProperties` describes extra object fields not listed by name, so those rules need the same cleanup as ordinary properties.

**Data flow**: The input object allows extra fields described by another object schema. The parser normalizes that nested schema, including its required field and `anyOf` choice, and returns it inside `AdditionalProperties::Schema`.

**Call relations**: This test drives the parser through a nested path and verifies that cleanup is not limited to named fields.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_object_shape_from_boolean_additional_properties_only`  (lines 192–210)

```
fn parse_tool_input_schema_infers_object_shape_from_boolean_additional_properties_only()
```

**Purpose**: Checks that `additionalProperties` by itself is enough to mean “this is an object.” It also ensures a boolean value such as `false` is preserved.

**Data flow**: The input contains only `additionalProperties: false`. The parser infers an object with no named properties and records that extra properties are not allowed.

**Call relations**: The test calls the parser and confirms the inferred object shape with `assert_eq!`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_number_from_numeric_keywords`  (lines 213–228)

```
fn parse_tool_input_schema_infers_number_from_numeric_keywords()
```

**Purpose**: Checks that numeric constraints, such as `minimum`, imply a number schema when `type` is missing. This lets incomplete but understandable schemas still work.

**Data flow**: The input has `minimum: 1` and no type. The parser treats that as a number-related hint and returns a number schema.

**Call relations**: The test exercises the parser's type-inference path and verifies the result with an equality assertion.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_number_from_multiple_of`  (lines 231–246)

```
fn parse_tool_input_schema_infers_number_from_multiple_of()
```

**Purpose**: Checks that `multipleOf` is treated like other numeric keywords and implies a number schema. This keeps numeric validation hints consistent.

**Data flow**: The test sends a schema with `multipleOf: 5` into the parser. The parser recognizes the numeric keyword and returns a plain number schema.

**Call relations**: This test is another targeted parser check, using `assert_eq!` to make sure the numeric inference rule stays in place.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_string_from_enum_const_and_format_keywords`  (lines 249–283)

```
fn parse_tool_input_schema_infers_string_from_enum_const_and_format_keywords()
```

**Purpose**: Checks how string-like hints are normalized when `type` is missing. Enums and constants become string enum schemas, while `format` alone becomes a plain string schema.

**Data flow**: The test parses three inputs: one with `enum`, one with `const`, and one with `format`. The parser returns a string enum for the first two and a string schema for the third.

**Call relations**: This test calls `parse_tool_input_schema` three times and compares each result to the matching expected `JsonSchema` shape.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_empty_schema`  (lines 286–296)

```
fn parse_tool_input_schema_preserves_empty_schema()
```

**Purpose**: Checks that an empty JSON Schema object stays empty. An empty schema is valid and means “allow anything,” so rewriting it would change its meaning.

**Data flow**: The input is `{}`. The parser reads it and returns the default permissive `JsonSchema` without adding object or type fields.

**Call relations**: The test calls the parser and uses `assert_eq!` to confirm the empty schema is preserved.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_empty_schema`  (lines 299–342)

```
fn parse_tool_input_schema_preserves_nested_empty_schema()
```

**Purpose**: Checks that empty schemas nested inside object properties also stay empty. This prevents the cleanup process from becoming more aggressive as it goes deeper.

**Data flow**: The input is an object containing a nested property whose value is `{}`. The parser walks through the object structure and leaves the innermost field as `JsonSchema::default()`.

**Call relations**: This test exercises recursive parsing through nested `properties` and verifies the final nested object structure.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_array_from_prefix_items`  (lines 345–371)

```
fn parse_tool_input_schema_infers_array_from_prefix_items()
```

**Purpose**: Checks that `prefixItems`, a JSON Schema way to describe array entries by position, implies an array when `type` is missing. The normalized result uses the simpler regular array form.

**Data flow**: The input contains `prefixItems` with a string schema. The parser infers an array schema and uses the string schema as the array item type.

**Call relations**: The test calls the parser and compares its simplified array output against the expected `JsonSchema::array`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_boolean_additional_properties_on_inferred_object`  (lines 374–410)

```
fn parse_tool_input_schema_preserves_boolean_additional_properties_on_inferred_object()
```

**Purpose**: Checks that a nested schema with only `additionalProperties: true` becomes an object and keeps that setting. This matters for map-like fields that can contain arbitrary keys.

**Data flow**: The input has an object property named `metadata`; inside it, only `additionalProperties` is present. The parser infers that `metadata` is an object and records that extra fields are allowed.

**Call relations**: The test sends the nested schema through the parser and checks that inference and preservation both happen.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_infers_object_shape_from_schema_additional_properties_only`  (lines 413–441)

```
fn parse_tool_input_schema_infers_object_shape_from_schema_additional_properties_only()
```

**Purpose**: Checks that schema-valued `additionalProperties` also implies an object. This covers objects whose extra keys all share the same value type.

**Data flow**: The input says additional properties should be strings, but does not explicitly say the root is an object. The parser returns an object schema whose `additionalProperties` points to a string schema.

**Call relations**: This test calls the parser and verifies the normalized object form with `assert_eq!`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_rewrites_const_to_single_value_enum`  (lines 444–462)

```
fn parse_tool_input_schema_rewrites_const_to_single_value_enum()
```

**Purpose**: Checks that `const`, meaning “this exact value only,” is rewritten as an enum with one allowed value. This fits the internal model's way of representing fixed choices.

**Data flow**: The input has `const: "tagged"`. The parser removes that form and returns a string enum containing only `"tagged"`.

**Call relations**: The test focuses on the parser's const-to-enum cleanup path and compares the output to the expected enum schema.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_rejects_singleton_null_type`  (lines 465–476)

```
fn parse_tool_input_schema_rejects_singleton_null_type()
```

**Purpose**: Checks that a schema whose only type is `null` is rejected. A tool input that can only be null is not useful as an input schema.

**Data flow**: The test sends `{ "type": "null" }` to the parser. Instead of a schema, it expects an error whose message explains that singleton null input schemas are not allowed.

**Call relations**: Unlike most tests in this file, this one expects failure and uses `assert!` to check the error text.

*Call graph*: 3 external calls (assert!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_fills_default_properties_for_nullable_object_union`  (lines 479–504)

```
fn parse_tool_input_schema_fills_default_properties_for_nullable_object_union()
```

**Purpose**: Checks that a union such as `object` or `null` keeps both choices while still giving the object side default properties. A union means a value may be one of several listed types.

**Data flow**: The input has `type: ["object", "null"]`. The parser returns a schema with both primitive types recorded and an empty `properties` map added for the object case.

**Call relations**: The test calls the parser and verifies that union preservation and object defaulting happen together.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_fills_default_items_for_nullable_array_union`  (lines 507–532)

```
fn parse_tool_input_schema_fills_default_items_for_nullable_array_union()
```

**Purpose**: Checks that a union such as `array` or `null` keeps both choices while still giving the array side default items. This makes incomplete nullable arrays usable.

**Data flow**: The input has `type: ["array", "null"]`. The parser records both types and adds a default string item schema for the array case.

**Call relations**: The test drives the parser through the nullable array path and compares the full `JsonSchema` result.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_nullable_any_of_shape`  (lines 538–628)

```
fn parse_tool_input_schema_preserves_nested_nullable_any_of_shape()
```

**Purpose**: Checks that deeply nested `anyOf` choices involving `null` are preserved. This protects complex optional structures from being flattened or simplified incorrectly.

**Data flow**: The input is an object with a property that may be an array of objects or null, and one nested field may be integer or null. The parser normalizes the children but keeps the `anyOf` layout all the way down.

**Call relations**: The test calls the parser on a realistic nested schema and verifies the exact nested `JsonSchema::any_of` structure.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_nullable_type_union`  (lines 631–679)

```
fn parse_tool_input_schema_preserves_nested_nullable_type_union()
```

**Purpose**: Checks that a nested property with `type: ["string", "null"]` keeps that explicit union. It also verifies that object-level `required` and `additionalProperties` settings are not lost.

**Data flow**: The input is an object with a required nullable string property. The parser returns an object schema with that property as a multiple-type schema, plus the original required list and extra-property rule.

**Call relations**: This test ensures the parser preserves important validation rules while normalizing nested fields.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_any_of_property`  (lines 682–729)

```
fn parse_tool_input_schema_preserves_nested_any_of_property()
```

**Purpose**: Checks that a nested `anyOf` property remains an `anyOf` instead of becoming a generic fallback type. This keeps the model of allowed alternatives precise.

**Data flow**: The input property may be a string or a number. The parser returns an object where that property contains two alternatives: string and number.

**Call relations**: The test calls the parser and verifies that the parser hands through the composition structure in normalized form.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_one_of_property`  (lines 732–782)

```
fn parse_tool_input_schema_preserves_nested_one_of_property()
```

**Purpose**: Checks that a nested `oneOf` property is preserved and that its child schemas are still cleaned up. `oneOf` means exactly one listed schema should match.

**Data flow**: The input property has one variant using `const` and one using `number`. The parser keeps `oneOf`, rewrites the const variant into a one-value enum, and preserves the number variant.

**Call relations**: The test calls the parser and compares the result to an expected `JsonSchema::one_of` value.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_all_of_property`  (lines 785–832)

```
fn parse_tool_input_schema_preserves_nested_all_of_property()
```

**Purpose**: Checks that a nested `allOf` property is preserved structurally. `allOf` means all listed schema rules apply together.

**Data flow**: The input property has an `allOf` list with a string schema and an unrecognized schema. The parser keeps the list, normalizes the string, and turns the unrecognized item into an empty permissive schema.

**Call relations**: The test makes sure composition cleanup happens inside `allOf` without removing the composition itself.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_type_unions_without_rewriting_to_any_of`  (lines 835–862)

```
fn parse_tool_input_schema_preserves_type_unions_without_rewriting_to_any_of()
```

**Purpose**: Checks that explicit type lists stay as type lists rather than being rewritten as `anyOf`. This preserves the original compact schema style.

**Data flow**: The input has `type: ["string", "null"]` plus a description. The parser returns a multiple-type schema with the same description.

**Call relations**: The test calls the parser and checks that normalization does not unnecessarily change the schema's shape.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_explicit_enum_type_union`  (lines 865–898)

```
fn parse_tool_input_schema_preserves_explicit_enum_type_union()
```

**Purpose**: Checks that a string-or-null type union can keep its enum values. This matters for optional fields that may either be null or one of a fixed set of strings.

**Data flow**: The input has a string/null type list, an enum of response lengths, and a description. The parser returns a multiple-type schema with the enum values and description still attached.

**Call relations**: The test calls the schema parser through `super::parse_tool_input_schema` and verifies that enum constraints survive normalization.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `many_string_properties`  (lines 900–909)

```
fn many_string_properties(count: usize) -> serde_json::Map<String, serde_json::Value>
```

**Purpose**: Builds a large table of numbered string properties for tests that need an oversized schema. It is a small helper so those tests can create bulk data without writing hundreds of fields by hand.

**Data flow**: The input is a count. The function creates property names like `field_000`, `field_001`, and so on, assigns each one a JSON schema of `{ "type": "string" }`, and returns them in a JSON map.

**Call relations**: This helper is used by the large-schema pruning test to create enough definition content to exceed the size budget.


##### `parse_large_tool_input_schema_compacts_descriptions_only_on_default_path`  (lines 912–966)

```
fn parse_large_tool_input_schema_compacts_descriptions_only_on_default_path()
```

**Purpose**: Checks that the normal parser strips descriptions from large schemas, while the no-compaction parser keeps them. This proves the project has both a compact API-safe path and a full-detail path.

**Data flow**: The test builds a schema with long descriptions and a referenced definition. The normal parser returns JSON without descriptions, then `parse_tool_input_schema_without_compaction` returns JSON with descriptions preserved.

**Call relations**: This test calls both parsing entry points and compares their serialized outputs to show the difference between compacting and non-compacting behavior.

*Call graph*: 4 external calls (assert_eq!, json!, parse_tool_input_schema, parse_tool_input_schema_without_compaction).


##### `parse_large_tool_input_schema_ignores_dropped_metadata_for_budget`  (lines 969–1018)

```
fn parse_large_tool_input_schema_ignores_dropped_metadata_for_budget()
```

**Purpose**: Checks that metadata fields such as titles and examples are dropped before judging whether a schema is still too large. This prevents throwaway documentation from consuming the size budget.

**Data flow**: The input contains large example metadata and titles inside nested objects. The parser removes those metadata fields and returns a smaller schema that keeps only meaningful type and property structure.

**Call relations**: The test calls the normal parser and verifies the serialized schema no longer contains the dropped metadata.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_stops_after_dropping_root_definitions_when_under_budget`  (lines 1021–1078)

```
fn parse_large_tool_input_schema_stops_after_dropping_root_definitions_when_under_budget()
```

**Purpose**: Checks that compaction stops once the schema is small enough. In this case, dropping bulky root definitions and descriptions should be enough, so the remaining useful structure should stay.

**Data flow**: The input has long descriptions, nested properties, and a large `$defs` table made with many string properties. The parser removes descriptions and replaces the referenced metadata property with an empty schema after dropping definitions, producing a compact object.

**Call relations**: This test uses the `many_string_properties` helper to create bulk, then calls the parser and checks the final compact JSON.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_strips_descriptions_without_removing_description_property`  (lines 1081–1174)

```
fn parse_large_tool_input_schema_strips_descriptions_without_removing_description_property()
```

**Purpose**: Checks that compaction removes schema descriptions but does not delete a user field named `description`. This distinction matters because one is metadata and the other is real input data.

**Data flow**: The input has many `description` metadata fields and also a property literally called `description`. The parser strips metadata descriptions throughout the schema while keeping the `description` property as a string field.

**Call relations**: The test calls the parser and verifies the serialized output, including nested arrays, maps, and `anyOf` choices after description stripping.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_prunes_compositions_as_last_resort`  (lines 1177–1217)

```
fn parse_large_tool_input_schema_prunes_compositions_as_last_resort()
```

**Purpose**: Checks that if a schema is still too large, composition blocks such as `anyOf`, `oneOf`, and `allOf` can be replaced with an empty schema. This is a last-resort size-saving step.

**Data flow**: For each composition keyword, the test builds a property with several huge enum alternatives. The parser compacts the schema enough to replace that property's composition with `{}`.

**Call relations**: The test loops over the shared composition-key list, builds JSON dynamically, calls the parser, and checks each compacted result.

*Call graph*: 6 external calls (assert_eq!, new, Array, json!, parse_tool_input_schema, vec!).


##### `parse_large_tool_input_schema_prunes_single_composition_variant_if_still_over_budget`  (lines 1220–1245)

```
fn parse_large_tool_input_schema_prunes_single_composition_variant_if_still_over_budget()
```

**Purpose**: Checks that even a composition with only one huge variant can be pruned if it remains too large. The number of variants does not protect an oversized composition from last-resort cleanup.

**Data flow**: The input has an `anyOf` list with one string enum containing a very long value. The parser replaces the whole choice property with an empty schema.

**Call relations**: The test calls the parser and verifies that the compacted output drops the oversized composition.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_large_tool_input_schema_preserves_object_enum_literal_descriptions`  (lines 1248–1290)

```
fn parse_large_tool_input_schema_preserves_object_enum_literal_descriptions()
```

**Purpose**: Checks that descriptions inside enum literal values are not mistaken for schema descriptions. If an allowed enum value is an object containing a `description` field, that field is part of the value and must remain.

**Data flow**: The input has a long root description and an enum whose allowed values are objects with their own `description` fields. The parser removes the root description but keeps the descriptions inside the enum values.

**Call relations**: The test calls the parser and compares the serialized output to make sure compaction does not alter literal enum data.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `collapse_deep_schema_objects_traverses_schema_children`  (lines 1293–1416)

```
fn collapse_deep_schema_objects_traverses_schema_children()
```

**Purpose**: Checks that deep-object collapsing walks through all important child schema locations. Collapsing means replacing objects that are too deeply nested with `{}` to keep schemas manageable.

**Data flow**: The test starts with a mutable JSON schema containing nested objects under properties, array items, additional properties, and `anyOf`. It calls `collapse_deep_schema_objects`, which replaces the deepest nested object schemas with empty objects, then compares the changed JSON to the expected result.

**Call relations**: This test calls the lower-level `collapse_deep_schema_objects` helper directly instead of going through the full parser, isolating the depth-pruning behavior.

*Call graph*: 3 external calls (assert_eq!, json!, collapse_deep_schema_objects).


##### `parse_tool_input_schema_preserves_string_enum_constraints`  (lines 1419–1486)

```
fn parse_tool_input_schema_preserves_string_enum_constraints()
```

**Purpose**: Checks that older schema styles using `type: "enum"` or `type: "const"` are normalized into current string enum schemas. This keeps backward compatibility with legacy tool definitions.

**Data flow**: The input object has three properties using legacy enum and const forms. The parser returns an object whose properties are all represented as string enum schemas with the expected allowed values.

**Call relations**: The test calls the parser and verifies that legacy inputs are converted rather than rejected or treated as unknown.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_refs_and_prunes_unreachable_defs`  (lines 1489–1546)

```
fn parse_tool_input_schema_preserves_refs_and_prunes_unreachable_defs()
```

**Purpose**: Checks that local `$ref` references are preserved and that only referenced root `$defs` entries are kept. A `$ref` is like a pointer to a reusable definition elsewhere in the schema.

**Data flow**: The input has a property pointing to `#/$defs/User`, plus `User` and `Unused` definitions. The parser keeps the reference, keeps and normalizes `User`, and drops `Unused`.

**Call relations**: The test calls the parser and verifies both reference preservation and definition pruning in the returned `JsonSchema`.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_refs_from_properties_named_def_tables`  (lines 1549–1594)

```
fn parse_tool_input_schema_preserves_refs_from_properties_named_def_tables()
```

**Purpose**: Checks that a user property named `$defs` is treated as an ordinary property, not confused with the schema definition table. References inside that property still count as real references.

**Data flow**: The input has a property literally named `$defs` that points to `#/$defs/User`, and a root `$defs` table with `User` and `Unused`. The parser keeps the property reference, keeps `User`, and drops `Unused`.

**Call relations**: The test calls the parser to make sure traversal behaves differently inside `properties` than at the root definition-table level.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_collects_refs_from_schema_child_keywords`  (lines 1597–1681)

```
fn parse_tool_input_schema_collects_refs_from_schema_child_keywords()
```

**Purpose**: Checks that references are discovered inside arrays, maps, and composition keywords. Without this, useful definitions could be pruned just because the reference is not in a direct property.

**Data flow**: The input contains `$ref` values under `items`, `additionalProperties`, `anyOf`, `oneOf`, and `allOf`, plus one unused definition. The parser preserves those references, keeps the referenced definitions, normalizes reachable schemas, and drops the unused definition.

**Call relations**: The test calls the parser and compares serialized JSON to confirm reference collection across all child-schema locations.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_handles_cyclic_local_refs`  (lines 1684–1745)

```
fn parse_tool_input_schema_handles_cyclic_local_refs()
```

**Purpose**: Checks that recursive local references do not make pruning loop forever. A recursive schema can describe structures like linked lists, where a node points to another node of the same kind.

**Data flow**: The input has a `Node` definition whose `next` property points back to `Node`. The parser preserves the cycle and keeps the `Node` definition after visiting it safely.

**Call relations**: The test calls the parser and verifies that cyclic references are retained without crashing or endlessly walking the schema.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_legacy_definitions`  (lines 1748–1827)

```
fn parse_tool_input_schema_preserves_legacy_definitions()
```

**Purpose**: Checks support for the older `definitions` table as well as the newer `$defs` table. This keeps schemas written for older JSON Schema versions working.

**Data flow**: The input points to `#/definitions/User`; `User` points to `Profile`; another definition is unused. The parser follows the legacy references, keeps `User` and `Profile`, normalizes them, and drops the unused entry.

**Call relations**: The test calls the parser and verifies legacy definition reachability and pruning.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_unresolved_and_external_refs`  (lines 1830–1880)

```
fn parse_tool_input_schema_preserves_unresolved_and_external_refs()
```

**Purpose**: Checks that missing local references and external URL references are not deleted. Even if the parser cannot resolve them locally, downstream validation may still understand them.

**Data flow**: The input has one reference to a missing local definition and one reference to an external URL, plus an unused local definition. The parser preserves both references and removes the unused definition table.

**Call relations**: The test calls the parser and confirms unresolved references remain visible in the normalized schema.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_nested_defs_ref_parent`  (lines 1883–1942)

```
fn parse_tool_input_schema_preserves_nested_defs_ref_parent()
```

**Purpose**: Checks that a reference to a nested path inside a definition keeps the parent root definition. This prevents a valid nested reference from dangling after pruning.

**Data flow**: The input points to `#/$defs/User/properties/name`. The parser keeps the original reference string, retains the `User` definition because it is the parent target, and drops unrelated definitions.

**Call relations**: The test calls the parser and verifies that definition reachability works for nested JSON Pointer references, not only whole-definition references.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_preserves_percent_encoded_definition_refs`  (lines 1945–2012)

```
fn parse_tool_input_schema_preserves_percent_encoded_definition_refs()
```

**Purpose**: Checks that percent-encoded reference paths are decoded correctly when deciding which definitions are reachable. Percent encoding is the URL-style form where spaces and special characters are written as codes.

**Data flow**: The input references definitions whose names include a space and a tilde, using encoded `$ref` strings. The parser preserves the original `$ref` text but decodes it for lookup, keeping the matching definitions and dropping the unused one.

**Call relations**: The test calls the parser and verifies both reference preservation and correct reachable-definition detection for encoded names.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


##### `parse_tool_input_schema_drops_malformed_definition_tables`  (lines 2015–2049)

```
fn parse_tool_input_schema_drops_malformed_definition_tables()
```

**Purpose**: Checks that a malformed `$defs` table is dropped instead of causing the whole schema to fail. This makes the parser tolerant of bad definition metadata while still preserving visible references.

**Data flow**: The input has a property pointing to `#/$defs/User`, but `$defs` is an array instead of an object table. The parser removes the malformed table and keeps the unresolved reference in the property schema.

**Call relations**: The test calls the parser and verifies that bad definition tables are handled gently rather than rejecting the full schema.

*Call graph*: 3 external calls (assert_eq!, json!, parse_tool_input_schema).


### Protocol and execution semantics tests
These files cover protocol error/output encoding plus code-mode session and service-contract behavior around execution lifecycle and failure propagation.

### `protocol/src/error_tests.rs`

`test` · `test run`

This is a test file. Its job is to make sure errors are explained clearly and consistently, both for users and for other parts of the program. Without these tests, a change to error formatting could accidentally remove helpful advice, hide request IDs needed for debugging, or show noisy server HTML instead of a simple message.

Most tests build a specific error value, turn it into text or an error event, and compare the result with the exact message expected. A large group focuses on usage-limit messages. These vary depending on the user’s plan, whether the limit will reset soon, whether a workspace owner needs to act, and whether the server supplied a promotion message. The tests use fixed times so the expected retry text is stable, like setting a clock on the wall before checking a schedule.

Other tests cover sandbox command failures. A sandbox is a restricted place where commands run safely. These checks confirm that the user sees the best available output: error stream first, then output stream, then combined output, and finally just an exit code if nothing else exists.

The file also tests server and HTTP error formatting. It confirms that overloaded-server errors map to the right protocol value, response stream failures include status and request ID, Cloudflare block pages are simplified, long bodies are shortened, and authentication/debug headers are preserved.

#### Function details

##### `rate_limit_snapshot`  (lines 15–42)

```
fn rate_limit_snapshot() -> RateLimitSnapshot
```

**Purpose**: Creates a reusable sample rate-limit record for tests. It gives tests realistic limit data without repeating the same setup everywhere.

**Data flow**: It takes no input. It builds fixed reset timestamps and puts them into a RateLimitSnapshot with primary and secondary limit windows. It returns that snapshot so tests can attach it to usage-limit errors.

**Call relations**: Many usage-limit tests call this helper before formatting an error. It supplies the shared background limit data, while each test changes the plan type, reset time, or limit name to focus on one behavior.

*Call graph*: called by 9 (usage_limit_reached_error_formats_business_plan_without_reset, usage_limit_reached_error_formats_default_for_other_plans, usage_limit_reached_error_formats_default_when_none, usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan, usage_limit_reached_error_formats_free_plan, usage_limit_reached_error_formats_go_plan, usage_limit_reached_error_formats_plus_plan, usage_limit_reached_error_formats_rate_limit_reached_types, usage_limit_reached_error_formats_self_serve_business_usage_based_plan).


##### `with_now_override`  (lines 44–51)

```
fn with_now_override(now: DateTime<Utc>, f: impl FnOnce() -> T) -> T
```

**Purpose**: Runs a test while pretending the current time is a specific fixed moment. This keeps messages involving retry times predictable.

**Data flow**: It receives a chosen UTC time and a piece of test code to run. It stores that time in the test-only current-time override, runs the provided code, then clears the override. It returns whatever the provided code returns.

**Call relations**: Tests that check reset-time wording call this helper before building the expected message. During that short block, the production formatting code sees the fixed clock instead of the real clock.

*Call graph*: called by 8 (usage_limit_reached_error_formats_pro_plan_with_reset, usage_limit_reached_error_formats_team_plan, usage_limit_reached_error_hides_upsell_for_non_codex_limit_name, usage_limit_reached_includes_days_hours_minutes, usage_limit_reached_includes_hours_and_minutes, usage_limit_reached_includes_minutes_when_available, usage_limit_reached_less_than_minute, usage_limit_reached_with_promo_message).


##### `usage_limit_reached_error_formats_plus_plan`  (lines 54–66)

```
fn usage_limit_reached_error_formats_plus_plan()
```

**Purpose**: Checks the message shown when a Plus user hits a usage limit. It makes sure the message suggests upgrading to Pro, buying more credits, or trying again later.

**Data flow**: The test builds a UsageLimitReachedError with the Plus plan and sample rate-limit data. It converts the error to a string and compares it with the exact expected sentence. Nothing is returned; the test passes or fails.

**Call relations**: This test calls rate_limit_snapshot for standard limit details, then relies on the error’s string formatting. It guards the Plus-plan branch of the usage-limit message logic.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_rate_limit_reached_types`  (lines 69–104)

```
fn usage_limit_reached_error_formats_rate_limit_reached_types()
```

**Purpose**: Checks the special messages used for different kinds of usage-limit failures. These include workspace credits being depleted and workspace spend caps being reached.

**Data flow**: The test loops over several rate-limit-reached types and their expected messages. For each one, it builds a usage-limit error, converts it to text, and checks that the text matches. The result is only the test outcome.

**Call relations**: It uses rate_limit_snapshot for common limit data and then varies only the reached-type field. This proves that the reached-type takes priority when choosing the user-facing message.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `server_overloaded_maps_to_protocol`  (lines 107–113)

```
fn server_overloaded_maps_to_protocol()
```

**Purpose**: Checks that an internal server-overloaded error becomes the correct protocol-level error information. This matters because clients need a structured signal, not just text.

**Data flow**: The test starts with CodexErr::ServerOverloaded. It converts it to protocol error information and compares the result with CodexErrorInfo::ServerOverloaded. It changes no outside state.

**Call relations**: This test exercises the conversion path from internal error to protocol error. It protects the contract between error creation and the event or response sent to callers.

*Call graph*: 1 external calls (assert_eq!).


##### `sandbox_denied_uses_aggregated_output_when_stderr_empty`  (lines 116–130)

```
fn sandbox_denied_uses_aggregated_output_when_stderr_empty()
```

**Purpose**: Checks that a sandbox-denied error uses combined command output when the normal error and output streams are empty. This keeps useful failure details visible.

**Data flow**: The test builds command output with only aggregated output filled in, wraps it in a sandbox-denied error, and asks for the UI message. The expected result is the aggregated detail text.

**Call relations**: It creates the sandbox error directly, then calls the UI-message helper through the assertion. It covers the fallback path used when separate stdout and stderr streams have no content.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `sandbox_denied_reports_both_streams_when_available`  (lines 133–147)

```
fn sandbox_denied_reports_both_streams_when_available()
```

**Purpose**: Checks that sandbox-denied messages include both stderr and stdout when both contain useful text. Stderr is shown first because it usually explains the failure.

**Data flow**: The test builds command output with separate stdout and stderr strings. It wraps that output in a sandbox-denied error and asks for the UI message. The produced message is expected to contain stderr, then stdout, separated by a newline.

**Call relations**: This test drives the sandbox error display path with both streams present. It confirms the ordering and avoids losing either piece of command output.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `sandbox_denied_reports_stdout_when_no_stderr`  (lines 150–164)

```
fn sandbox_denied_reports_stdout_when_no_stderr()
```

**Purpose**: Checks that stdout is still shown when a sandbox-denied command has no stderr. Some tools report useful failure information on normal output.

**Data flow**: The test builds command output where stdout has text and stderr is empty. It wraps it in a sandbox-denied error, requests the UI message, and expects the stdout text. The test has no return value beyond pass or fail.

**Call relations**: It exercises the fallback step after stderr is checked. Together with the other sandbox tests, it documents the priority order for choosing a useful command-failure message.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `to_error_event_handles_response_stream_failed`  (lines 167–191)

```
fn to_error_event_handles_response_stream_failed()
```

**Purpose**: Checks that a failure while reading a server response becomes a clear error event. It verifies both the readable message and the structured HTTP status code.

**Data flow**: The test builds a fake HTTP 429 response, turns it into a request error, wraps it in a response-stream-failed error with a request ID, and converts it to an error event with a prefix. It then checks the event message and its structured error info.

**Call relations**: This test follows the path from a lower-level HTTP response problem to the protocol error event sent upward. It confirms that request IDs and status codes survive that handoff.

*Call graph*: 5 external calls (builder, parse, assert_eq!, from, ResponseStreamFailed).


##### `sandbox_denied_reports_exit_code_when_no_output_available`  (lines 194–211)

```
fn sandbox_denied_reports_exit_code_when_no_output_available()
```

**Purpose**: Checks the last-resort sandbox-denied message when there is no output at all. The user should still learn that the command failed and see the exit code.

**Data flow**: The test builds command output with empty stderr, stdout, and aggregated output, plus an exit code. It wraps that in a sandbox-denied error and asks for the UI message. The expected message mentions the exit code.

**Call relations**: It covers the final fallback in the sandbox error display chain. This prevents completely blank error messages when a command fails silently.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, from_millis, new, assert_eq!, Sandbox).


##### `usage_limit_reached_error_formats_free_plan`  (lines 214–226)

```
fn usage_limit_reached_error_formats_free_plan()
```

**Purpose**: Checks the usage-limit message for a Free plan user. It ensures the message points them toward upgrading to Plus or trying again later.

**Data flow**: The test builds a usage-limit error with the Free plan and sample rate-limit data. It converts the error to a string and compares it with the expected upgrade-to-Plus message.

**Call relations**: It uses rate_limit_snapshot for common limit data and exercises the Free-plan branch of the formatter. This protects product-specific wording for free users.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_go_plan`  (lines 229–241)

```
fn usage_limit_reached_error_formats_go_plan()
```

**Purpose**: Checks that Go plan users get the same upgrade-to-Plus usage-limit guidance as expected. This keeps plan-specific messaging consistent.

**Data flow**: The test builds a usage-limit error with the Go plan, formats it as text, and compares it to the expected message. It does not produce data outside the assertion.

**Call relations**: It calls rate_limit_snapshot for shared limit details. It verifies that the Go-plan branch follows the intended Free-like upgrade path.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_default_when_none`  (lines 244–256)

```
fn usage_limit_reached_error_formats_default_when_none()
```

**Purpose**: Checks the fallback usage-limit message when the plan is unknown. The system should avoid giving plan-specific advice it cannot justify.

**Data flow**: The test creates a usage-limit error with no plan type and sample rate-limit data. It converts the error to text and expects the simple message to try again later.

**Call relations**: It uses rate_limit_snapshot but leaves plan information absent. This guards the default message path for incomplete server data.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 2 external calls (new, assert_eq!).


##### `usage_limit_reached_error_formats_team_plan`  (lines 259–276)

```
fn usage_limit_reached_error_formats_team_plan()
```

**Purpose**: Checks the usage-limit message for Team plan users when a reset time is known. It should tell them to ask an admin or try again at the formatted time.

**Data flow**: The test fixes the current time, chooses a reset time one hour later, builds the expected retry timestamp, then formats a Team-plan usage-limit error. The output must match the admin-request message with that retry time.

**Call relations**: It calls with_now_override so the retry-time wording is deterministic. Inside that fixed-time block, it exercises the Team-plan formatting path.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_error_formats_business_plan_without_reset`  (lines 279–291)

```
fn usage_limit_reached_error_formats_business_plan_without_reset()
```

**Purpose**: Checks the Business plan usage-limit message when no reset time is available. The message should suggest contacting an admin or trying again later.

**Data flow**: The test builds a Business-plan usage-limit error with no reset timestamp. It formats the error and compares it to the expected admin-request message ending in 'try again later.'

**Call relations**: It uses rate_limit_snapshot for standard limit context. It covers the Business-plan branch when there is no known retry time to show.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_self_serve_business_usage_based_plan`  (lines 294–306)

```
fn usage_limit_reached_error_formats_self_serve_business_usage_based_plan()
```

**Purpose**: Checks the usage-limit wording for the self-serve business usage-based plan. It should match the admin-request style message.

**Data flow**: The test creates a usage-limit error for that plan with no reset time. It turns the error into text and checks the exact expected sentence.

**Call relations**: It calls rate_limit_snapshot for reusable limit information. It protects one of the business-plan variants from drifting away from the intended shared message.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan`  (lines 309–321)

```
fn usage_limit_reached_error_formats_enterprise_cbp_usage_based_plan()
```

**Purpose**: Checks the usage-limit wording for an enterprise usage-based plan variant. It should also tell the user to request more access from an admin or try later.

**Data flow**: The test builds a usage-limit error for the EnterpriseCbpUsageBased plan and no reset time. It formats the error and verifies the exact text.

**Call relations**: It uses rate_limit_snapshot and targets another plan-specific branch. This helps ensure related business and enterprise plans stay aligned in user guidance.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_default_for_other_plans`  (lines 324–336)

```
fn usage_limit_reached_error_formats_default_for_other_plans()
```

**Purpose**: Checks that plans without special wording use the plain default usage-limit message. This avoids showing upgrade or admin advice for plans that do not support it.

**Data flow**: The test builds a usage-limit error for an Enterprise plan with no reset time. It converts it to text and expects the simple 'Try again later' message.

**Call relations**: It uses rate_limit_snapshot for common data, then selects a plan that should fall through to the default branch. This documents what happens for unsupported or non-special plan types.

*Call graph*: calls 1 internal fn (rate_limit_snapshot); 3 external calls (new, assert_eq!, Known).


##### `usage_limit_reached_error_formats_pro_plan_with_reset`  (lines 339–356)

```
fn usage_limit_reached_error_formats_pro_plan_with_reset()
```

**Purpose**: Checks the Pro plan usage-limit message when a reset time is known. It should mention buying more credits or trying again at the formatted time.

**Data flow**: The test fixes the current time, sets a reset time one hour later, builds the expected retry timestamp, then formats a Pro-plan usage-limit error. The final string must include the purchase link and retry time.

**Call relations**: It uses with_now_override to make time-based formatting stable. It covers the Pro-plan path where retry timing is available.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_error_hides_upsell_for_non_codex_limit_name`  (lines 359–383)

```
fn usage_limit_reached_error_hides_upsell_for_non_codex_limit_name()
```

**Purpose**: Checks that an upsell message is hidden when the limit name is for a different Codex limit. Instead, the user is told which limit was hit and when to retry.

**Data flow**: The test fixes the current time, creates a usage-limit error with a custom limit name, a reset time, and a promo message. It formats the error and expects a message that names the limit, suggests switching models, and omits the promo text.

**Call relations**: It calls with_now_override for stable retry text and reuses rate_limit_snapshot while overriding the limit ID and name. This verifies that limit-specific wording can suppress generic upgrade prompts.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (hours).


##### `usage_limit_reached_includes_minutes_when_available`  (lines 386–401)

```
fn usage_limit_reached_includes_minutes_when_available()
```

**Purpose**: Checks that usage-limit messages include a retry time when the reset is only a few minutes away. This gives users a more useful answer than simply 'later.'

**Data flow**: The test fixes the current time, sets the reset time five minutes ahead, formats a usage-limit error with no plan, and compares it with a message containing the formatted retry timestamp.

**Call relations**: It uses with_now_override to control the clock. It exercises the default usage-limit message path with a known near-term reset.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (minutes).


##### `unexpected_status_cloudflare_html_is_simplified`  (lines 404–421)

```
fn unexpected_status_cloudflare_html_is_simplified()
```

**Purpose**: Checks that a Cloudflare block page is replaced with a simpler, friendlier message. This avoids showing raw HTML to the user.

**Data flow**: The test builds an unexpected-response error with forbidden status, Cloudflare-like HTML, a URL, and a Cloudflare ray ID. It formats the error and expects a simplified blocked message with status, URL, and ray ID.

**Call relations**: This test goes straight through the UnexpectedResponseError string formatter. It guards the special case that recognizes noisy Cloudflare HTML and turns it into cleaner text.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_non_html_is_unchanged`  (lines 424–440)

```
fn unexpected_status_non_html_is_unchanged()
```

**Purpose**: Checks that a plain-text unexpected response body is shown as-is. Simple server messages should not be over-simplified.

**Data flow**: The test creates an unexpected-response error with forbidden status, a plain text body, and a URL. It formats the error and checks that the body appears unchanged in the final message.

**Call relations**: It exercises the normal UnexpectedResponseError formatting path, in contrast to the Cloudflare HTML special case.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_prefers_error_message_when_present`  (lines 443–461)

```
fn unexpected_status_prefers_error_message_when_present()
```

**Purpose**: Checks that, when a JSON error body contains a clear error message, that message is used instead of dumping the whole JSON body. This makes server errors easier to read.

**Data flow**: The test builds an unauthorized unexpected-response error whose body is JSON containing an error message. It formats the error and expects the extracted message plus URL and request ID.

**Call relations**: It tests the formatter’s JSON-message extraction path. This ensures structured server error bodies are turned into readable text while still keeping debugging details.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_truncates_long_body_with_ellipsis`  (lines 464–483)

```
fn unexpected_status_truncates_long_body_with_ellipsis()
```

**Purpose**: Checks that very long unexpected-response bodies are shortened. This keeps logs and user messages from being flooded by huge server responses.

**Data flow**: The test creates a body longer than the allowed maximum, builds an unexpected-response error, and formats it. It expects only the maximum number of characters followed by an ellipsis, plus URL and request ID.

**Call relations**: It directly tests the length-limiting behavior in UnexpectedResponseError formatting. This protects the formatter from producing overly large messages.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `unexpected_status_includes_cf_ray_and_request_id`  (lines 486–503)

```
fn unexpected_status_includes_cf_ray_and_request_id()
```

**Purpose**: Checks that unexpected-response messages include both Cloudflare ray ID and request ID when available. These IDs help operators trace a failing request.

**Data flow**: The test builds an unauthorized unexpected-response error with plain text, URL, Cloudflare ray ID, and request ID. It formats the error and checks that all those details appear.

**Call relations**: It exercises the formatter’s optional-debug-details path. This ensures useful tracing information is not dropped from error text.

*Call graph*: 1 external calls (assert_eq!).


##### `unexpected_status_includes_identity_auth_details`  (lines 506–523)

```
fn unexpected_status_includes_identity_auth_details()
```

**Purpose**: Checks that identity and authorization details are included when an authentication-related unexpected response provides them. These details help diagnose login or token problems.

**Data flow**: The test builds an unauthorized unexpected-response error with URL, Cloudflare ray ID, request ID, authorization error, and identity error code. It formats the error and expects every detail in the final string.

**Call relations**: It tests the formatter path that appends authentication-specific diagnostic fields. This complements the more general request-ID and Cloudflare-ray checks.

*Call graph*: 1 external calls (assert_eq!).


##### `usage_limit_reached_includes_hours_and_minutes`  (lines 526–543)

```
fn usage_limit_reached_includes_hours_and_minutes()
```

**Purpose**: Checks usage-limit wording when the reset time is several hours and minutes away. The final message should include the formatted retry time.

**Data flow**: The test fixes the current time, sets a reset time three hours and thirty-two minutes later, builds a Plus-plan usage-limit error, and compares the formatted text with the expected upgrade and retry-time message.

**Call relations**: It uses with_now_override so the computed retry time is predictable. It covers a time-based Plus-plan message where the wait is longer than just minutes.

*Call graph*: calls 1 internal fn (with_now_override); 2 external calls (hours, minutes).


##### `usage_limit_reached_includes_days_hours_minutes`  (lines 546–562)

```
fn usage_limit_reached_includes_days_hours_minutes()
```

**Purpose**: Checks usage-limit wording when the reset time is days away. The user should still get a clear retry time rather than vague wording.

**Data flow**: The test fixes the current time, sets a reset time two days, three hours, and five minutes later, builds a usage-limit error with no plan, and checks the formatted message.

**Call relations**: It uses with_now_override to stabilize the time calculation. It protects the default usage-limit path for longer reset windows.

*Call graph*: calls 1 internal fn (with_now_override); 3 external calls (days, hours, minutes).


##### `usage_limit_reached_less_than_minute`  (lines 565–580)

```
fn usage_limit_reached_less_than_minute()
```

**Purpose**: Checks usage-limit wording when the reset is less than a minute away. Even a very short wait should still be represented correctly in the retry message.

**Data flow**: The test fixes the current time, sets the reset time thirty seconds later, builds a usage-limit error with no plan, and verifies the final message includes the formatted retry timestamp.

**Call relations**: It calls with_now_override so the short time gap is exact and repeatable. It covers the edge case where the reset time is very close.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (seconds).


##### `usage_limit_reached_with_promo_message`  (lines 583–602)

```
fn usage_limit_reached_with_promo_message()
```

**Purpose**: Checks that a server-provided promotion message is included in a usage-limit error. The message should combine the promotion with the retry time in a natural sentence.

**Data flow**: The test fixes the current time, sets a reset time thirty seconds later, builds a usage-limit error with a promo message, formats it, and compares it with the expected combined sentence.

**Call relations**: It uses with_now_override for stable retry-time text. It verifies the formatter path that accepts custom promotional wording from the error data.

*Call graph*: calls 1 internal fn (with_now_override); 1 external calls (seconds).


### `protocol/src/exec_output_tests.rs`

`test` · `test run`

This is a test file for a very practical problem: terminal output is not always UTF-8, even though most modern software expects UTF-8. On Windows, shells and tools can still emit bytes using older “code pages,” which are numbering systems for characters. For example, the same byte can mean one thing in Cyrillic CP1251, another in CP866, and something else in Latin-1. If Codex guessed wrong, a user might see nonsense instead of the command’s real output.

The tests build small byte sequences that mimic what a shell might send. They then pass those bytes through a helper called `decode_shell_output`, which wraps them in a `StreamOutput` value and asks the production decoding code to convert them into text. Each test checks one important case: normal UTF-8, Cyrillic encodings common on Windows, Western European accents, Windows “smart quotes,” and invalid bytes that cannot be confidently decoded.

The important behavior is that the decoder should be smart, but not reckless. When it recognizes a legacy encoding, it should produce proper Unicode text. When it cannot make sense of the bytes, it should fall back to Rust’s lossy UTF-8 behavior, which preserves visibility by inserting replacement characters rather than crashing or hiding output.

#### Function details

##### `test_utf8_shell_output`  (lines 10–13)

```
fn test_utf8_shell_output()
```

**Purpose**: This test checks the simplest case: shell output that is already valid UTF-8 should stay exactly the same. It guards against the decoder accidentally changing good text while trying to be clever.

**Data flow**: It starts with the UTF-8 bytes for the Russian word “пример”. Those bytes are decoded through the shell-output helper, and the result is compared with the original readable word. Nothing outside the test is changed.

**Call relations**: During the test run, the Rust test framework calls this test. The test uses an equality assertion to confirm that the decoding path leaves valid UTF-8 untouched.

*Call graph*: 1 external calls (assert_eq!).


##### `test_cp1251_shell_output`  (lines 16–19)

```
fn test_cp1251_shell_output()
```

**Purpose**: This test checks that Cyrillic text encoded as Windows CP1251 is decoded correctly. CP1251 is an older Windows character set often used for Russian text.

**Data flow**: It starts with raw bytes that spell “пример” in CP1251, not UTF-8. The helper sends those bytes through the same decoding path used for shell output, and the test expects the readable Unicode string “пример” to come out.

**Call relations**: The test framework runs this as a regression check for Windows-style shell output. The test finishes by using an equality assertion to prove that CP1251 bytes are recognized instead of being shown as broken text.

*Call graph*: 1 external calls (assert_eq!).


##### `test_cp866_shell_output`  (lines 22–25)

```
fn test_cp866_shell_output()
```

**Purpose**: This test checks another Cyrillic encoding, CP866, which is commonly associated with the classic Windows command prompt. It makes sure older console output is still readable.

**Data flow**: It begins with bytes that represent “пример” in CP866. The helper feeds them into the shell-output decoder, and the expected result is the normal Unicode string “пример”.

**Call relations**: The Rust test runner calls this test alongside the other encoding checks. Its assertion confirms that the decoder covers native command-prompt output, not just newer Windows shell behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `test_windows_1252_smart_decoding`  (lines 28–34)

```
fn test_windows_1252_smart_decoding()
```

**Purpose**: This test checks that Windows-1252 punctuation, such as curly quotes and an en dash, is decoded into the correct Unicode characters. This matters because those bytes often look invalid if treated as plain UTF-8.

**Data flow**: It starts with bytes for Windows-1252 smart punctuation mixed with ASCII text. The helper decodes them, and the test expects proper curly quote characters and a proper dash in the final string.

**Call relations**: The test runner invokes this case to exercise the decoder’s smarter legacy-encoding detection. The equality assertion verifies that the output is not merely readable, but preserves the intended punctuation.

*Call graph*: 1 external calls (assert_eq!).


##### `test_smart_decoding_improves_over_lossy_utf8`  (lines 37–49)

```
fn test_smart_decoding_improves_over_lossy_utf8()
```

**Purpose**: This test proves that the custom decoding behavior is better than simply using lossy UTF-8 conversion. Lossy conversion is a fallback that replaces unknown bytes with the replacement character �.

**Data flow**: It takes Windows-1252 bytes for curly quotes and a dash. First it confirms that ordinary lossy UTF-8 would insert replacement characters. Then it sends the same bytes through the shell-output helper and expects the real punctuation to be preserved.

**Call relations**: The test framework runs this as a regression guard for the original bug. It uses one assertion to show the old behavior was imperfect, then an equality assertion to show the smarter decoder fixes that case.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `test_mixed_ascii_and_legacy_encoding`  (lines 52–55)

```
fn test_mixed_ascii_and_legacy_encoding()
```

**Purpose**: This test checks a realistic mixed-output case: ordinary ASCII text combined with a legacy-encoded accented character. Command output often looks like this, with mostly simple English text plus occasional non-ASCII characters.

**Data flow**: It starts with the bytes for “Output: caf\xE9”, where most bytes are plain ASCII and the final accented “é” is a legacy byte. The helper decodes the whole byte string, and the expected result is “Output: café”.

**Call relations**: The test runner calls this during the encoding test suite. Its equality assertion confirms that the decoder can handle mixed text instead of only pure examples from one character set.

*Call graph*: 1 external calls (assert_eq!).


##### `test_pure_latin1_shell_output`  (lines 58–61)

```
fn test_pure_latin1_shell_output()
```

**Purpose**: This test checks that plain Latin-1 encoded text still decodes correctly. Latin-1 is an older Western European character encoding that includes letters like “é”.

**Data flow**: It begins with the bytes for “café” where “é” is represented as a Latin-1 byte. The helper decodes those bytes and the test expects the proper Unicode word “café”.

**Call relations**: The Rust test framework runs this as coverage for older behavior that should keep working. The equality assertion confirms that support for Latin-1 was not broken by newer smart decoding changes.

*Call graph*: 1 external calls (assert_eq!).


##### `test_invalid_bytes_still_fall_back_to_lossy`  (lines 64–68)

```
fn test_invalid_bytes_still_fall_back_to_lossy()
```

**Purpose**: This test checks the safety net: if the decoder cannot confidently recognize the bytes, the user should still see something instead of losing the output. The fallback is lossy UTF-8, which inserts replacement characters for invalid data.

**Data flow**: It starts with a short sequence of bytes that should not be treated as a successfully detected legacy encoding. The helper decodes them, and the result is compared with Rust’s standard lossy UTF-8 conversion for the same bytes.

**Call relations**: The test runner invokes this to make sure the smart decoder fails gracefully. Its equality assertion ties the fallback behavior to the standard lossy conversion so unexpected bytes remain visible to the user.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_shell_output`  (lines 70–77)

```
fn decode_shell_output(bytes: &[u8]) -> String
```

**Purpose**: This helper gives all the tests a small, realistic way to run bytes through the actual `StreamOutput` decoding path. It avoids repeating the same setup in every test.

**Data flow**: It receives a borrowed slice of raw bytes. It copies those bytes into a `StreamOutput` object, leaves the truncation marker empty, asks that object to convert its text using the production lossy-decoding method, and returns the decoded `String`.

**Call relations**: The test cases use this helper whenever they need to turn sample shell bytes into text. It acts like a small doorway into the real decoding behavior, so each test can focus on the input bytes and expected visible output.


### `code-mode-protocol/src/session_tests.rs`

`test` · `test run`

This is a small automated test for the code that represents a started remote “cell.” A cell is likely a unit of work or execution in the protocol, and it has an initial response that arrives asynchronously, meaning the answer may come later rather than immediately. The test checks the failure path, which is easy to break by accident.

The test creates a one-time message channel, called a oneshot channel, which is like handing someone a single-use envelope: one side can send exactly one message, and the other side can receive it once. It sends an error message through that channel: “remote runtime failed.” Then it builds a StartedCell using that receiving side, as if the cell were waiting for its startup result from the remote runtime.

Finally, the test asks the StartedCell for its initial response and confirms that the same error comes back unchanged. This matters because callers need the real reason startup failed. If this code swallowed the error, changed its wording, or turned it into a generic failure, users and higher-level code would have a much harder time understanding what went wrong.

#### Function details

##### `started_cell_preserves_remote_initial_response_errors`  (lines 8–19)

```
async fn started_cell_preserves_remote_initial_response_errors()
```

**Purpose**: This asynchronous test verifies that a StartedCell keeps and returns the original error it receives from the remote runtime during startup. Someone would rely on this behavior when they need clear failure messages instead of vague or rewritten ones.

**Data flow**: The test starts by creating a one-use channel for a startup response. It sends an error string into the channel, then gives the receiving end to StartedCell::from_result_receiver along with a new CellId. When the test awaits started.initial_response(), the error comes back, and the assertion checks that it is exactly the same text that was sent.

**Call relations**: During the test, the function uses CellId::new to make an identifier for the cell and StartedCell::from_result_receiver to build the cell from a pending response channel. It uses the external oneshot channel as a stand-in for the remote runtime’s reply, then uses the assertion macro to prove that the StartedCell passes the remote error through unchanged.

*Call graph*: calls 2 internal fn (new, from_result_receiver); 2 external calls (assert_eq!, channel).


### `code-mode/src/service_contract_tests.rs`

`test` · `test run`

This is a test file, but it is important because it documents the service’s contract: what callers can rely on when they execute a piece of code in a “cell.” A cell can produce output, pause and yield control, resume later, call tools, send notifications, finish normally, or be terminated. Many bugs in systems like this happen at the edges, when two things happen almost at once. For example, output may be waiting in a buffer while a yield timer fires, or a cell may finish naturally just as someone asks to terminate it.

To test those edges, the file builds small fake delegates. A delegate is the outside helper the service calls when code asks to use a tool or send a notification. `BlockingDelegate` and `HeldNotificationDelegate` deliberately pause until they are cancelled, so the tests can check that cleanup happens before responses are returned. This is like putting a slow cashier in a checkout lane to verify the store closes the lane in the right order.

The tests use channels, which are message pipes between asynchronous tasks, to inject runtime events and observe results. They check that only one observer can wait on a live cell, that repeated termination is rejected while shutdown is already in progress, and that callbacks are cancelled and `cell_closed` is reported before the service considers a cell fully closed.

#### Function details

##### `HeldNotificationDelegate::new`  (lines 40–49)

```
fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<DelegateEvent>)
```

**Purpose**: Creates a fake delegate whose notification callback can be kept stuck until the test explicitly releases it. This lets a test simulate shutdown that is waiting for notification cleanup to finish.

**Data flow**: It starts with no inputs. It creates a message channel for reporting delegate events, creates a notification release signal, wraps the delegate in shared ownership so async tasks can hold it, and returns both the delegate and the receiving side of the event channel.

**Call relations**: The repeated-termination test calls this when it needs a delegate that can pause in the middle of cleanup. The returned receiver is then used by the test to watch for notification start and cancellation events.

*Call graph*: called by 1 (repeated_termination_is_rejected_while_callback_cleanup_is_pending); 3 external calls (new, new, unbounded_channel).


##### `HeldNotificationDelegate::release_notification`  (lines 51–53)

```
fn release_notification(&self)
```

**Purpose**: Lets the test unblock a held notification after it has verified the service is waiting in the expected state.

**Data flow**: It reads the delegate’s internal release signal and sends one wake-up. Any notification task waiting on that signal can then continue and finish.

**Call relations**: The repeated-termination test calls this after it has tried a second termination request. This allows the first termination request to complete so the test can check the final result.

*Call graph*: 1 external calls (notify_one).


##### `HeldNotificationDelegate::invoke_tool`  (lines 57–66)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Implements the tool-call part of the delegate in the simplest possible way: it waits until cancelled and then returns an error. This delegate is focused on notification behavior, so tool calls are only present to satisfy the service interface.

**Data flow**: It receives a tool invocation and a cancellation token, ignores the invocation details, waits until the token is cancelled, and then returns a cancellation error string.

**Call relations**: The service could call this if a test cell invoked a nested tool through this delegate. In this file’s main use of `HeldNotificationDelegate`, the important callback is `notify`, while this method keeps the delegate complete.

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

**Purpose**: Simulates a notification callback that notices cancellation but does not finish until the test releases it. This is used to prove that the service rejects another termination while the first termination is still cleaning up callbacks.

**Data flow**: It receives notification details and a cancellation token. It reports that the notification started, waits for cancellation, reports that cancellation happened, then waits for the test-controlled release signal before returning success.

**Call relations**: The service calls this when executed code runs `notify(...)`. The repeated-termination test watches the events this method sends, then calls `release_notification` so the first termination can finish.

*Call graph*: 4 external calls (pin, cancelled, notified, send).


##### `HeldNotificationDelegate::cell_closed`  (lines 84–88)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Records that the service says a cell has fully closed. Tests use this to confirm that closure is announced after callback cleanup, not before.

**Data flow**: It receives a cell id, clones it so the event can own its copy, and sends a `CellClosed` event through the delegate event channel.

**Call relations**: The service calls this as part of cell shutdown. The repeated-termination test expects to see this only after the held notification is released and the first termination completes.

*Call graph*: 3 external calls (send, clone, CellClosed).


##### `spawn_cell_control_harness`  (lines 99–144)

```
fn spawn_cell_control_harness(
    initial_yield_time_ms: Option<u64>,
    delegate: Arc<dyn CodeModeSessionDelegate>,
) -> CellControlHarness
```

**Purpose**: Builds a small test rig around the lower-level cell-control loop. It lets tests feed fake runtime events and control commands directly, without going through the full service API.

**Data flow**: It receives an optional initial yield timeout and a delegate. It creates several channels, starts a runtime with a never-ending request, builds the shared service state, spawns the cell-control task, and returns a harness containing senders, the first-response receiver, the spawned task, and a runtime-event receiver kept alive for the test.

**Call relations**: Several timing-sensitive tests call this when they need exact control over event ordering. The harness hands runtime events into `run_cell_control` and sends termination commands so the tests can observe which outcome wins.

*Call graph*: calls 2 internal fn (cell_id, execute_request); called by 3 (observed_natural_completion_wins_over_termination, queued_termination_preempts_unobserved_runtime_completion, yield_timer_preempts_buffered_runtime_output); 10 external calls (new, new, new, new, new, new, Runtime, unbounded_channel, channel, spawn).


##### `BlockingDelegate::new`  (lines 147–157)

```
fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<DelegateEvent>)
```

**Purpose**: Creates a fake delegate whose tool and notification callbacks wait for cancellation. It also records whether those callbacks actually finished after being cancelled.

**Data flow**: It starts with no inputs. It creates an event channel, creates two atomic boolean flags set to false, wraps the delegate for shared use, and returns it with the receiver used to observe its events.

**Call relations**: Tests that need to prove callback cleanup happens call this before creating a service or harness. The tests later read its flags and event stream to confirm the expected shutdown order.

*Call graph*: called by 3 (natural_completion_cleans_up_callbacks_before_responding, observed_natural_completion_wins_over_termination, termination_cancels_pending_callbacks_before_responding); 3 external calls (new, new, unbounded_channel).


##### `BlockingDelegate::invoke_tool`  (lines 161–173)

```
fn invoke_tool(
        &'a self,
        _invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a>
```

**Purpose**: Simulates a tool call that starts, blocks until cancelled, marks itself as finished, and reports cancellation. This verifies that natural completion or termination cancels pending tool callbacks before the cell is considered closed.

**Data flow**: It receives a tool invocation and a cancellation token. It reports `ToolStarted`, waits for cancellation, sets the `tool_finished` flag, reports `ToolCancelled`, and returns a cancellation error.

**Call relations**: The service calls this when code invokes the fake blocking tool. The natural-completion cleanup test uses the emitted events and flag to verify that pending tool work is cancelled before the final cell-closed notification.

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

**Purpose**: Simulates a notification callback that blocks until the service cancels it. This helps tests confirm that termination waits for notification cleanup instead of returning too early.

**Data flow**: It receives notification details and a cancellation token. It reports `NotificationStarted`, waits for cancellation, sets the `notification_finished` flag, reports `NotificationCancelled`, and returns a cancellation error.

**Call relations**: The service calls this when code sends a notification. Termination and natural-completion tests watch the events from this method to prove cancellation happens before the response and before `cell_closed`.

*Call graph*: 4 external calls (store, pin, cancelled, send).


##### `BlockingDelegate::cell_closed`  (lines 191–195)

```
fn cell_closed(&self, cell_id: &CellId)
```

**Purpose**: Records the service’s final cell-closed signal. This gives tests a clear marker that all cleanup for a cell is supposed to be done.

**Data flow**: It receives a cell id, clones it into an event, and sends that event through the delegate’s event channel.

**Call relations**: The service calls this after a cell finishes or is terminated. Tests compare this event with earlier cancellation events to ensure shutdown happens in the right order.

*Call graph*: 3 external calls (send, clone, CellClosed).


##### `cell_id`  (lines 198–200)

```
fn cell_id(value: &str) -> CellId
```

**Purpose**: Creates a `CellId` from a short string so tests can write expected results clearly. It avoids repeating the same wrapper construction throughout the file.

**Data flow**: It takes a string slice such as `"1"`, turns it into an owned string, wraps it as a `CellId`, and returns that id.

**Call relations**: Many tests and the cell-control harness use this helper when building expected responses or referring to the first test cell. It keeps those expectations readable.

*Call graph*: calls 1 internal fn (new); called by 5 (queued_termination_preempts_unobserved_runtime_completion, repeated_termination_is_rejected_while_callback_cleanup_is_pending, returns_and_resumes_from_the_pending_frontier, second_observer_is_rejected_without_displacing_the_first, spawn_cell_control_harness).


##### `execute_request`  (lines 202–210)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: Builds a standard execute request for tests from a source-code string. It supplies common defaults so each test only has to state the code it cares about.

**Data flow**: It receives source text. It returns an `ExecuteRequest` with a fixed tool call id, no enabled tools, the given source, a small yield time, and no maximum output limit.

**Call relations**: Service-level tests and the harness use this helper to start execution with consistent defaults. Some tests override selected fields, such as enabled tools or yield timing, when they need special behavior.

*Call graph*: called by 6 (natural_completion_cleans_up_callbacks_before_responding, repeated_termination_is_rejected_while_callback_cleanup_is_pending, second_observer_is_rejected_without_displacing_the_first, spawn_cell_control_harness, termination_cancels_pending_callbacks_before_responding, yields_and_resumes); 1 external calls (new).


##### `blocking_tool`  (lines 212–221)

```
fn blocking_tool() -> ToolDefinition
```

**Purpose**: Defines a fake tool named `block` for tests. It is used when test code needs to trigger the delegate’s blocking tool callback.

**Data flow**: It takes no inputs. It returns a tool definition with the name `block`, plain protocol tool name, function kind, empty description, and no input or output schema.

**Call relations**: The natural-completion cleanup test includes this tool in an execute request. That allows the executed code to call `tools.block({})`, which then reaches `BlockingDelegate::invoke_tool`.

*Call graph*: calls 1 internal fn (plain); 1 external calls (new).


##### `next_event`  (lines 223–228)

```
async fn next_event(events_rx: &mut mpsc::UnboundedReceiver<DelegateEvent>) -> DelegateEvent
```

**Purpose**: Waits for the next delegate event, but fails the test if no event arrives soon. This prevents tests from hanging forever when expected cleanup does not happen.

**Data flow**: It receives the receiving side of a delegate-event channel. It waits up to two seconds for a message, then returns the event; if the wait times out or the channel closes, it fails with a clear test error.

**Call relations**: Tests call this whenever they need to observe callback start, callback cancellation, or cell closure. It turns asynchronous event watching into simple step-by-step assertions.

*Call graph*: 3 external calls (from_secs, recv, timeout).


##### `yield_timer_preempts_buffered_runtime_output`  (lines 231–272)

```
async fn yield_timer_preempts_buffered_runtime_output()
```

**Purpose**: Checks that an immediate yield timer can return control before already-buffered runtime output is delivered. The buffered output must not disappear; it should be returned later when the cell is terminated.

**Data flow**: The test starts a cell-control harness with a zero initial yield time, sends a runtime-started event and a queued output item, and then waits for the initial response. It expects a yielded response with no output, then sends a terminate command and expects the earlier queued output in the termination response.

**Call relations**: This test drives `run_cell_control` through the harness. It uses the harness channels to create a precise race: timer first, output later in the externally visible response.

*Call graph*: calls 1 internal fn (spawn_cell_control_harness); 4 external calls (new, assert_eq!, ContentItem, channel).


##### `queued_termination_preempts_unobserved_runtime_completion`  (lines 275–302)

```
async fn queued_termination_preempts_unobserved_runtime_completion()
```

**Purpose**: Checks that if termination is queued before the caller has observed a natural runtime completion, termination wins. Both the termination request and the original initial response should report the same terminated outcome.

**Data flow**: The test starts the harness with a long yield timer, sends a runtime result event, then immediately sends a terminate command. It expects the termination receiver and the initial response receiver to both produce a terminated response with no content.

**Call relations**: This test uses `spawn_cell_control_harness` to control event order tightly. It verifies how the cell-control task chooses between an unobserved completion event and a queued termination command.

*Call graph*: calls 2 internal fn (cell_id, spawn_cell_control_harness); 5 external calls (new, new, new, assert_eq!, channel).


##### `yields_and_resumes`  (lines 305–339)

```
async fn yields_and_resumes()
```

**Purpose**: Checks the normal user flow where code yields partway through and later resumes. Output before the yield should come in the first response, and output after the yield should come from waiting.

**Data flow**: The test creates a service, executes code that writes `before`, calls `yield_control`, then writes `after`. It reads the cell’s initial response and expects a yielded response containing `before`, then waits on the same cell and expects a final result containing `after`.

**Call relations**: This is a service-level contract test for `execute` followed by `wait`. It shows the ordinary way a caller pauses and resumes a live cell.

*Call graph*: calls 2 internal fn (new, execute_request); 1 external calls (assert_eq!).


##### `returns_and_resumes_from_the_pending_frontier`  (lines 342–390)

```
async fn returns_and_resumes_from_the_pending_frontier()
```

**Purpose**: Checks the “pending” mode, where execution returns when the runtime reaches a waiting point and can later resume from exactly there. It proves delayed work continues after the pending timer is fired.

**Data flow**: The test executes code that waits on a long timeout and then writes `after`. It expects an initial pending outcome with no output, manually sends a timeout-fired command into the cell’s runtime, then waits to pending again and expects completed output containing `after`.

**Call relations**: This test uses the full service but reaches into the stored cell to trigger the runtime timeout. It verifies `execute_to_pending` and `wait_to_pending` cooperate across a pause point.

*Call graph*: calls 2 internal fn (new, cell_id); 1 external calls (assert_eq!).


##### `observed_natural_completion_wins_over_termination`  (lines 393–460)

```
async fn observed_natural_completion_wins_over_termination()
```

**Purpose**: Checks that once natural completion has been observed by the cell-control loop, a later termination request should return the completed result, not convert it into a termination. It also verifies notification cleanup still happens.

**Data flow**: The test starts a harness with a blocking delegate, forces an initial yield, then sends output, a successful result, and a notification event. After confirming the notification started, it sends a terminate command. It expects the termination response to be the successful result, then checks the notification was cancelled and the cell was closed.

**Call relations**: This test uses the harness for exact sequencing and `BlockingDelegate` to make notification cleanup visible. It proves natural completion can win over termination, but cleanup is still required before the task exits.

*Call graph*: calls 2 internal fn (new, spawn_cell_control_harness); 5 external calls (new, assert!, assert_eq!, ContentItem, channel).


##### `termination_cancels_pending_callbacks_before_responding`  (lines 463–500)

```
async fn termination_cancels_pending_callbacks_before_responding()
```

**Purpose**: Checks that terminating a cell cancels any pending notification callback before reporting that termination is complete. This prevents callers from thinking a cell is gone while its callback is still running.

**Data flow**: The test creates a service with a blocking delegate and executes code that sends a notification and then waits forever. It observes notification start, reads the yielded initial response, calls terminate, then expects a terminated response. Finally it checks the notification finished cancellation and the cell-closed event arrived.

**Call relations**: This is a service-level test for `terminate`. It relies on `BlockingDelegate::notify` to expose whether callback cleanup really happened before the service returned.

*Call graph*: calls 3 internal fn (with_delegate, new, execute_request); 2 external calls (assert!, assert_eq!).


##### `repeated_termination_is_rejected_while_callback_cleanup_is_pending`  (lines 503–551)

```
async fn repeated_termination_is_rejected_while_callback_cleanup_is_pending()
```

**Purpose**: Checks that a second termination request is rejected while the first termination is still cleaning up callbacks. This avoids two callers both trying to close the same live cell at the same time.

**Data flow**: The test creates a service with a held-notification delegate, runs code that starts a notification and waits forever, and begins the first termination in a spawned task. After the delegate reports notification cancellation but before it is released, the test calls terminate again and expects an “already terminating” error. It then releases the notification and expects the first termination to succeed and the cell to close.

**Call relations**: This test uses `HeldNotificationDelegate::notify` to pause cleanup deliberately and `release_notification` to resume it. It verifies the service marks a cell as terminating during cleanup, not only after cleanup finishes.

*Call graph*: calls 4 internal fn (with_delegate, new, cell_id, execute_request); 4 external calls (clone, new, assert_eq!, spawn).


##### `second_observer_is_rejected_without_displacing_the_first`  (lines 554–598)

```
async fn second_observer_is_rejected_without_displacing_the_first()
```

**Purpose**: Checks that only one wait observer can be active for a live cell. A second wait request should fail without stealing the first observer’s place.

**Data flow**: The test starts a service and executes code that waits forever. After the initial yielded response, it begins one wait observer with a long yield time, then tries a second wait and expects an error. It terminates the cell and expects both the termination call and the original first observer to receive the same terminated result.

**Call relations**: This test uses `begin_wait` to keep the first observer active while calling `wait` again. It proves the service protects the existing observer rather than replacing it.

*Call graph*: calls 3 internal fn (new, cell_id, execute_request); 2 external calls (new, assert_eq!).


##### `natural_completion_cleans_up_callbacks_before_responding`  (lines 601–634)

```
async fn natural_completion_cleans_up_callbacks_before_responding()
```

**Purpose**: Checks that even when the runtime finishes normally, pending tool callbacks are cancelled and cleaned up before the result is returned and the cell is closed. Natural success still has to tidy up background work.

**Data flow**: The test creates a service with a blocking delegate and enables the fake blocking tool. It runs code that calls the tool and then writes `done`. After seeing the tool start, it waits for the initial response and expects a successful result containing `done`. It then verifies the tool callback was cancelled and the cell-closed event was sent.

**Call relations**: This test connects `blocking_tool` with `BlockingDelegate::invoke_tool`. It confirms that normal completion uses the same careful cleanup discipline as termination.

*Call graph*: calls 3 internal fn (with_delegate, new, execute_request); 3 external calls (assert!, assert_eq!, vec!).


### Transport, proxy, and socket support tests
These tests exercise lower-level transport helpers, retry/auth parsing, proxy inspection rules, socket utilities, and TLS provider initialization.

### `rmcp-client/src/executor_process_transport_tests.rs`

`test` · `test run`

When a program reads from another process, the data does not always arrive neatly one line at a time. It may get half a line now, the rest later, or several lines at once. This file checks that `LineBuffer` behaves correctly in those common streaming situations.

Think of `LineBuffer` like a mail sorter for a conveyor belt of letters. It waits until it sees a newline character, which marks the end of one message, then hands that complete message onward. If the conveyor stops in the middle of a message, it keeps the unfinished part instead of losing it.

The tests focus on three important promises. First, after the buffer has already looked through bytes and found no newline, adding more bytes should not make it wastefully re-check everything from the beginning; its remembered scan position should move forward correctly. Second, when several lines arrive together, the buffer should return them one by one and leave any unfinished tail behind. Third, when the input stream ends, any remaining bytes without a final newline can still be taken as the last message.

Without these guarantees, communication with a child process could drop output, join messages incorrectly, or wait forever for a newline that will never come.

#### Function details

##### `searches_only_new_bytes_after_partial_line`  (lines 7–42)

```
fn searches_only_new_bytes_after_partial_line()
```

**Purpose**: This test checks that `LineBuffer` remembers how far it has already searched when no full line is available yet. It protects against both incorrect line splitting and inefficient repeated scanning of the same bytes.

**Data flow**: The test starts with an empty buffer, adds the bytes for `partial`, and asks for a line. Because there is no newline, nothing comes out, and the buffer keeps those bytes while recording that it has already scanned them. It then adds ` line`, checks again, and still gets no complete line. Finally it adds `\nnext`; now the buffer returns `partial line` as one complete line and leaves `next` waiting for later.

**Call relations**: This test is run by Rust's test runner. It directly exercises `LineBuffer` by creating a default buffer, feeding it bytes in pieces, and using equality checks to confirm both the returned line and the buffer's internal state after each step.

*Call graph*: 2 external calls (assert_eq!, default).


##### `splits_multiple_lines_and_retains_partial_tail`  (lines 45–59)

```
fn splits_multiple_lines_and_retains_partial_tail()
```

**Purpose**: This test checks that `LineBuffer` can pull out more than one complete line from a single chunk of incoming bytes. It also confirms that unfinished bytes after the last newline are not thrown away.

**Data flow**: The test begins with an empty buffer and adds `first\nsecond\npartial` all at once. The first call to take a line returns `first`; the second returns `second`. The third call finds no newline after `partial`, so it returns nothing and leaves `partial` stored in the buffer as an unfinished tail.

**Call relations**: This test is invoked by the test runner and focuses on the normal case where a process writes several messages at once. It uses `LineBuffer`'s append-and-take behavior and then checks the final stored bytes so later code can rely on partial data being preserved.

*Call graph*: 2 external calls (assert_eq!, default).


##### `takes_unterminated_remaining_bytes_at_eof`  (lines 62–72)

```
fn takes_unterminated_remaining_bytes_at_eof()
```

**Purpose**: This test checks what happens when the input ends without a final newline. It makes sure the remaining bytes can still be collected instead of being stranded in the buffer.

**Data flow**: The test creates an empty buffer, adds `remaining`, and asks for a line. Since there is no newline, no line is returned. It then calls the method meant for end-of-file cleanup, which returns `remaining` and resets the buffer back to empty.

**Call relations**: This test represents the shutdown path for reading from a process: the stream has ended, so the caller needs any leftover output. The test runner calls this test, and the test confirms that `LineBuffer` hands back the final unterminated data and clears itself afterward.

*Call graph*: 2 external calls (assert_eq!, default).


### `rmcp-client/src/http_client_adapter/www_authenticate_tests.rs`

`test` · `test run`

When a web server rejects a request, it can send a `WWW-Authenticate` header explaining what kind of login or permission is needed. For OAuth Bearer tokens, one important case is `insufficient_scope`: it means the token is valid, but it lacks a required permission such as `files:read`. This test file checks that the parser recognizes that case accurately.

The tests cover normal headers, mixed letter casing, quoted and unquoted scope values, multiple authentication schemes in one header, and multiple header fields. They also check the dangerous edges: text that merely contains the word `scope`, duplicated scope parameters, malformed quoting, or other Bearer errors such as `invalid_token`. In those cases, the parser must not invent a permission requirement that the server did not clearly state.

This matters because the client may use this result to decide what permission to request next. A loose parser could ask for the wrong permission, ignore a real missing permission, or be confused by misleading text inside an error description. These tests act like a checklist for the header parser: accept clear `insufficient_scope` challenges, reject unclear scope values, and find the right Bearer challenge even when other authentication options appear first.

#### Function details

##### `extracts_scope_from_bearer_insufficient_scope_challenges`  (lines 10–52)

```
fn extracts_scope_from_bearer_insufficient_scope_challenges()
```

**Purpose**: This test proves that valid Bearer `insufficient_scope` challenges produce the expected required scope. It checks several real-world formatting variations so the parser is not too fragile.

**Data flow**: It starts with a table of header strings and the scope each one should reveal. For each header, it sends the text into `parse_bearer_insufficient_scope`, then compares the returned value with a `BearerInsufficientScope` containing that expected scope. Nothing is changed outside the test; the result is simply pass or fail.

**Call relations**: During the test suite, this function exercises the parser directly. It uses an equality assertion to confirm that the parser hands back the same meaning no matter whether the scope appears before or after the error, uses unusual spacing or casing, or appears after another authentication scheme.

*Call graph*: 1 external calls (assert_eq!).


##### `does_not_treat_other_bearer_errors_as_insufficient_scope`  (lines 55–60)

```
fn does_not_treat_other_bearer_errors_as_insufficient_scope()
```

**Purpose**: This test makes sure the parser does not mistake every Bearer error for a missing-permission error. In particular, `invalid_token` means a different problem than `insufficient_scope`.

**Data flow**: It gives the parser a Bearer header that includes a scope value but has the error type `invalid_token`. The expected output is `None`, meaning there is no insufficient-scope challenge to act on.

**Call relations**: This test calls the parser in a negative case. The equality assertion confirms that the parser only reports insufficient scope when the server explicitly says that is the error.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_invalid_or_ambiguous_scope_parameters`  (lines 63–84)

```
fn rejects_invalid_or_ambiguous_scope_parameters()
```

**Purpose**: This test checks that the parser is cautious when a scope value is malformed or unclear. If the required permission cannot be read safely, the parser should still recognize the `insufficient_scope` error but avoid claiming a specific scope.

**Data flow**: It feeds several problematic header strings into `parse_bearer_insufficient_scope`: empty values, confusing escapes, double spaces, unsafe unquoted values, and duplicate scope fields. Each should come back as a `BearerInsufficientScope` whose `required_scope` is `None`, meaning the server did say permissions were insufficient, but the exact permission was not trustworthy.

**Call relations**: This test directly pressures the parser’s validation rules. The assertions show that ambiguous input is not silently cleaned up into a possibly wrong permission request.

*Call graph*: 1 external calls (assert_eq!).


##### `ignores_scope_text_outside_a_scope_parameter`  (lines 87–102)

```
fn ignores_scope_text_outside_a_scope_parameter()
```

**Purpose**: This test ensures the parser only treats `scope` as meaningful when it is an actual scope parameter. The word `scope` appearing inside descriptions or other parameter names should not count.

**Data flow**: It sends headers containing misleading scope-like text into `parse_bearer_insufficient_scope`. Since none of them contain a valid Bearer `insufficient_scope` challenge with a real scope parameter, the expected result is `None` each time.

**Call relations**: This test guards against over-eager text searching. It verifies that the parser reads the header structure, rather than just scanning for the substring `scope=` anywhere in the text.

*Call graph*: 1 external calls (assert_eq!).


##### `selects_bearer_challenge_from_a_later_www_authenticate_field_value`  (lines 105–124)

```
fn selects_bearer_challenge_from_a_later_www_authenticate_field_value()
```

**Purpose**: This test checks the higher-level helper that looks through multiple HTTP headers and finds the relevant Bearer insufficient-scope challenge, even if it is not the first `WWW-Authenticate` value.

**Data flow**: It builds a small list of HTTP headers: first a Basic authentication challenge, then a Bearer `insufficient_scope` challenge. It passes that list to `insufficient_scope_challenge` and expects an `InsufficientScopeChallenge` containing the Bearer header text and the required `files:read` scope.

**Call relations**: Unlike the parser-only tests, this one tests the function that searches across header fields. It shows how the client should behave after receiving a response with several authentication options: skip unrelated challenges, choose the Bearer one, and return the information the rest of the client can use.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `rmcp-client/src/streamable_http_retry_tests.rs`

`test` · `test run`

This is a small test file for the RMCP client’s retry decisions. A retry is useful when a failure is likely temporary, like a dropped connection. But retrying the wrong thing can make bugs worse, repeat bad requests, or hide real protocol errors. These tests act like a checklist for that boundary.

The first test focuses on client startup. During startup, the client sends an initialize request, sends an initialized notification, and waits for the initialize response. The test says that failures while sending the request or notification should be treated as retryable, but a failure while receiving the response should not be treated the same way.

The second test builds several streamable HTTP errors and checks whether the client classifies each one correctly. It includes plain request-send failures, server-wrapped request failures, broken response body streams, out-of-order stream messages, and unexpected HTTP responses such as 502 and 400. In everyday terms, the test checks whether the client can tell the difference between “the road was blocked, try again” and “the message itself was wrong, stop.”

The helper function at the bottom builds a realistic initialize error so the startup retry test does not have to repeat noisy setup code.

#### Function details

##### `retryable_initialize_error_includes_initialized_notification_context`  (lines 13–26)

```
fn retryable_initialize_error_includes_initialized_notification_context()
```

**Purpose**: This test checks the retry rule for failures during the client initialization sequence. It makes sure that errors while sending the initialize request or initialized notification are retryable, while an error while receiving the initialize response is not.

**Data flow**: It starts with three text labels describing where initialization failed. For each label, it builds a matching fake initialization error and asks the RMCP client whether that error is retryable. The test then compares the answers with the expected result: true, true, then false.

**Call relations**: The test runner calls this function during automated tests. Inside the test, it relies on the local helper retryable_initialize_error to create realistic errors, then uses the client’s retry-classification function and assert_eq! to prove the result matches the intended behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `retryable_streamable_http_error_includes_remote_body_stream_failure`  (lines 29–59)

```
fn retryable_streamable_http_error_includes_remote_body_stream_failure()
```

**Purpose**: This test checks the retry rule for streamable HTTP errors. It confirms that temporary-looking failures, such as failed requests, disconnected response streams, and HTTP 502 responses, are retryable, while protocol-order mistakes and HTTP 400 bad requests are not.

**Data flow**: It builds a list of different HTTP transport errors, each representing a different failure story. It feeds each error into the RMCP client’s streamable HTTP retry checker. The resulting true-or-false list is compared with the expected list, showing exactly which failures should lead to another attempt.

**Call relations**: The test runner calls this function during automated tests. The function constructs errors using external error types such as StreamableHttpError, StreamableHttpClientAdapterError, and ExecServerError, then hands those errors to RmcpClient::is_retryable_streamable_http_error and verifies the answers with assert_eq!.

*Call graph*: 6 external calls (Client, UnexpectedServerResponse, assert_eq!, HttpRequest, Protocol, HttpRequest).


##### `retryable_initialize_error`  (lines 61–74)

```
fn retryable_initialize_error(context: &'static str) -> rmcp::service::ClientInitializeError
```

**Purpose**: This helper builds a realistic client initialization transport error for a chosen initialization step. It keeps the startup retry test readable by hiding the repeated error-wrapping details.

**Data flow**: It receives a context string, such as “send initialize request.” It wraps a simulated HTTP request failure inside the same layers of transport and streamable HTTP error types the real client would see. It returns a ClientInitializeError containing both the wrapped error and the context text.

**Call relations**: The initialization retry test calls this helper once for each startup context it wants to check. The helper uses external constructors such as DynamicTransportError::from_parts and StreamableHttpError::Client to build an error shaped like a real failure, then gives that finished error back to the test.

*Call graph*: 5 external calls (new, from_parts, Client, HttpRequest, HttpRequest).


### `rmcp-client/tests/streamable_http_oauth_startup.rs`

`test` · `test run`

This is a test file for the MCP client’s OAuth startup path. OAuth is the common “log in and receive a token” system used by many web services. Here, the important question is: if the client already has saved OAuth tokens from an earlier login, does it use them correctly when starting up again?

The tests create isolated temporary Codex homes so they can write fake saved credentials without touching a developer’s real machine. Some tests spawn a second copy of the test process as an ignored “child” test. That is done because the credential store reads CODEX_HOME from the process environment, and changing that directly inside the main test runner could leak into other tests.

One test starts a fake HTTP server. The server pretends to publish OAuth metadata, accepts a refresh-token request, and then expects the MCP initialize request to arrive with the newly refreshed access token. This proves the client refreshes expired saved credentials before sending its first initialization message.

Another test writes three different saved credential cases: expired with no refresh token, still valid, and expired but refreshable. It then checks the reported authentication status for each. This protects the user-facing behavior: the client should know when it is truly logged out versus when saved OAuth credentials can still be used.

#### Function details

##### `refreshes_expired_persisted_token_before_initialize`  (lines 47–122)

```
async fn refreshes_expired_persisted_token_before_initialize() -> anyhow::Result<()>
```

**Purpose**: This test proves that an expired saved OAuth access token is refreshed before the MCP client sends its first initialize request. It protects against a startup bug where the client might contact the server with an old, unusable token.

**Data flow**: The test starts with a fake HTTP server and teaches it three things: where the OAuth token endpoint is, how to answer a refresh-token request, and how to respond to MCP initialization only when the refreshed token is used. It then creates a temporary CODEX_HOME and launches a child test process with that home and the fake server URL. The child writes expired credentials and starts the client; the parent checks that the child succeeded and that the fake server saw exactly the expected requests.

**Call relations**: This is the parent half of the startup-refresh scenario. It does the server setup and process isolation, then relies on the ignored child test oauth_startup_child to perform the actual client startup using the isolated environment.

*Call graph*: 13 external calls (given, start, new, new, assert!, new, format!, json!, current_exe, body_string_contains (+3 more)).


##### `reports_auth_status_for_persisted_credentials`  (lines 125–144)

```
async fn reports_auth_status_for_persisted_credentials() -> anyhow::Result<()>
```

**Purpose**: This test checks that saved OAuth credentials produce the correct high-level authentication status. It exists so the rest of the application can tell users accurately whether an MCP server is logged in or not.

**Data flow**: The test creates a fresh temporary Codex home and starts a child test process using that directory as CODEX_HOME. The child writes different saved credential examples and asks the auth-status code what each one means. The parent only receives the child process result and fails if the child fails.

**Call relations**: This is the parent wrapper for persisted_credentials_auth_status_child. Like the other parent test in this file, it uses a separate process because credential lookup depends on environment variables.

*Call graph*: 4 external calls (new, assert!, new, current_exe).


##### `persisted_credentials_auth_status_child`  (lines 148–220)

```
async fn persisted_credentials_auth_status_child() -> anyhow::Result<()>
```

**Purpose**: This child test writes several kinds of saved OAuth tokens and checks how the client classifies them. It covers the difference between unusable expired credentials, valid current credentials, and expired credentials that can still be refreshed.

**Data flow**: First it saves an expired access token with no refresh token, then asks for the auth status and expects NotLoggedIn. Next it saves an unexpired access token and expects OAuth, meaning the user is considered logged in through OAuth. Finally it saves an expired access token that does include a refresh token and also expects OAuth, because the client can recover by refreshing it.

**Call relations**: This test is launched by reports_auth_status_for_persisted_credentials. For each saved-token case, it calls auth_status as the small helper that asks the real client library to classify the credentials.

*Call graph*: calls 2 internal fn (default, auth_status); 8 external calls (new, new, new, now, default, assert_eq!, save_oauth_tokens, new).


##### `auth_status`  (lines 222–233)

```
async fn auth_status(server_url: &str) -> anyhow::Result<McpAuthStatus>
```

**Purpose**: This helper asks the client library what authentication status applies to one server URL. It keeps the test cases short and makes sure they all use the same settings for saved-file credentials.

**Data flow**: It receives a server URL. It combines that URL with the test server name, no direct bearer token, no extra HTTP headers, file-based OAuth credential storage, and the default keyring backend setting. It returns the McpAuthStatus result from the library.

**Call relations**: persisted_credentials_auth_status_child calls this helper after saving each credential variant. The helper hands the work to determine_streamable_http_auth_status, which is the production code being tested.

*Call graph*: calls 1 internal fn (default); called by 1 (persisted_credentials_auth_status_child); 1 external calls (determine_streamable_http_auth_status).


##### `oauth_startup_child`  (lines 237–281)

```
async fn oauth_startup_child() -> anyhow::Result<()>
```

**Purpose**: This child test performs the actual client startup for the refresh-before-initialize scenario. It writes expired saved OAuth credentials with a valid refresh token, then starts the streamable HTTP client without giving it a direct bearer token, forcing it to use and refresh the saved credentials.

**Data flow**: It reads the fake MCP server URL from an environment variable. It saves an expired token record that includes a refresh token. Then it creates a streamable HTTP RmcpClient using file-based OAuth credentials and a test HTTP client. Finally it initializes the client, which should cause the production code to refresh the token and send the MCP initialize request using the new access token.

**Call relations**: refreshes_expired_persisted_token_before_initialize launches this child test after setting up the fake server. This function then calls the real client constructor and passes the resulting client to initialize_client so the normal MCP startup exchange happens.

*Call graph*: calls 4 internal fn (default, default_for_tests, new_streamable_http_client, initialize_client); 8 external calls (new, from_secs, new, new, default, save_oauth_tokens, new, var).


### `rmcp-client/tests/streamable_http_recovery.rs`

`test` · `test run`

A streamable HTTP connection is meant to stay useful across several requests, but real networks fail: a server may briefly return a bad status, a session may expire, or the first setup request may get no response. This test file checks those awkward moments. It starts a small test server, creates a client, deliberately tells the server or a wrapper HTTP client to fail in specific ways, and then checks whether a normal tool call still works afterward.

The tests focus on the client’s recovery rules. During startup, the client sends an “initialize” request; these tests confirm that a one-time failure there is retried. After startup, the client sends session requests; these tests confirm that a 404, treated here as an expired session, causes the client to re-initialize and retry once. They also confirm the opposite cases: 401 unauthorized, 403 insufficient permission, and 500 server errors should be reported instead of quietly turned into recovery.

The helper type `FailFirstInitializeHttpClient` acts like a prank mail carrier: it forwards all normal requests, but can intentionally drop the first initialize stream request so the retry behavior can be observed. Without tests like these, the client might fail too easily on temporary problems, or worse, might retry when it should tell the user about a real access problem.

#### Function details

##### `FailFirstInitializeHttpClient::new`  (lines 42–48)

```
fn new(inner: Arc<dyn HttpClient>, failures_remaining: usize) -> Self
```

**Purpose**: Builds a wrapper around a real HTTP client that can intentionally fail a set number of initialize requests. Tests use it to simulate a temporary no-response failure without changing the real client code.

**Data flow**: It receives an existing HTTP client and a number of planned initialize failures. It stores the real client, the remaining failure count, and a counter for how many initialize attempts happened, all in shared thread-safe containers. It returns a new wrapper client ready to be passed into the normal client creation path.

**Call relations**: The initialize retry tests call this before creating the main client. Later, when the main client sends HTTP traffic through the wrapper, `FailFirstInitializeHttpClient::http_request_stream` uses the stored counters to decide whether to fail or forward the request.

*Call graph*: called by 2 (streamable_http_initialize_retries_remote_no_response_error, streamable_http_session_recovery_retries_initialize_failure); 2 external calls (new, new).


##### `FailFirstInitializeHttpClient::initialize_attempts`  (lines 50–52)

```
fn initialize_attempts(&self) -> usize
```

**Purpose**: Reports how many initialize POST requests the wrapper has seen. Tests use this to prove that a retry really happened, instead of only checking that the final operation succeeded.

**Data flow**: It reads the shared atomic counter, which is a number safely updated across async tasks or threads. It returns that number as a plain `usize` count and does not change anything.

**Call relations**: The tests call this after a client operation to verify the retry count. The count is increased inside `FailFirstInitializeHttpClient::http_request_stream` whenever an initialize POST is detected.


##### `FailFirstInitializeHttpClient::fail_next_initialize`  (lines 54–56)

```
fn fail_next_initialize(&self)
```

**Purpose**: Arms the wrapper so the next initialize request will fail once. This is useful after a client is already running, when a test wants to simulate session recovery that itself hits a temporary initialize failure.

**Data flow**: It writes `1` into the shared remaining-failures counter. The next matching initialize stream request consumes that value and turns it into one simulated error.

**Call relations**: The session recovery test calls this after forcing a session-expired response. Then `FailFirstInitializeHttpClient::http_request_stream` sees the next initialize request during recovery and fails it once.


##### `FailFirstInitializeHttpClient::http_request`  (lines 60–65)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Forwards ordinary non-streaming HTTP requests unchanged to the real HTTP client. The wrapper only wants to interfere with streamed initialize requests, so this path stays transparent.

**Data flow**: It receives request details, passes them directly to the inner HTTP client, and returns the inner client’s future result. It does not inspect, count, or alter the request.

**Call relations**: This method is part of the `HttpClient` interface. If code under test sends a normal HTTP request through the wrapper, this method hands it straight to the real client so the test only changes the behavior it intends to test.


##### `FailFirstInitializeHttpClient::http_request_stream`  (lines 67–89)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Intercepts streamed HTTP requests and optionally fails initialize POSTs once, while forwarding everything else. This lets tests mimic a remote server that gives no usable response during setup.

**Data flow**: It receives request details. First it checks whether the request is an initialize POST by calling `is_initialize_post`. If so, it increments the initialize-attempt counter and, if a failure is armed, returns a simulated server error. Otherwise it forwards the request to the real inner HTTP client and returns that result.

**Call relations**: The main client uses this through the `HttpClient` trait during setup and recovery. This method calls `is_initialize_post` to decide whether the request is the special one to fail; for all other requests, it hands off to the inner client.

*Call graph*: calls 1 internal fn (is_initialize_post); 1 external calls (clone).


##### `is_initialize_post`  (lines 92–104)

```
fn is_initialize_post(params: &HttpRequestParams) -> bool
```

**Purpose**: Checks whether an HTTP request is the JSON-RPC initialize call. JSON-RPC is a message format where the request body names a method such as `initialize`.

**Data flow**: It receives HTTP request parameters. It first checks that the HTTP method is POST, then tries to parse the body as JSON, then looks for a `method` field equal to `initialize`. It returns `true` only when all of those checks succeed; otherwise it returns `false`.

**Call relations**: Only `FailFirstInitializeHttpClient::http_request_stream` calls this helper. It acts as the wrapper’s filter, so the wrapper fails only setup requests and leaves unrelated traffic alone.

*Call graph*: called by 1 (http_request_stream).


##### `streamable_http_initialize_retries_remote_no_response_error`  (lines 107–121)

```
async fn streamable_http_initialize_retries_remote_no_response_error() -> anyhow::Result<()>
```

**Purpose**: Tests that the client retries initialization when the first initialize request appears to get no response. This protects users from a one-time connection hiccup during startup.

**Data flow**: The test starts the streamable HTTP test server, wraps the default test HTTP client with `FailFirstInitializeHttpClient`, and creates the main client through that wrapper. The wrapper fails the first initialize attempt. The test then calls the echo tool and checks that the wrapper saw two initialize attempts and that the echo result is correct.

**Call relations**: The async test runner calls this test. It uses `spawn_streamable_http_server` for a server, `FailFirstInitializeHttpClient::new` to inject the failure, `create_client_with_http_client` to build the client, and `call_echo_tool` to prove the recovered client works.

*Call graph*: calls 5 internal fn (default_for_tests, new, call_echo_tool, create_client_with_http_client, spawn_streamable_http_server); 2 external calls (new, assert_eq!).


##### `streamable_http_initialize_retries_transient_http_status`  (lines 124–135)

```
async fn streamable_http_initialize_retries_transient_http_status() -> anyhow::Result<()>
```

**Purpose**: Tests that a temporary HTTP status error during initialization, such as 502 Bad Gateway, is retried. This checks recovery from a common short-lived server or proxy problem.

**Data flow**: The test starts the server, tells the server to make the next initialize POST fail with status 502, then creates a client. Client creation must retry successfully. Finally it calls the echo tool and compares the result with the expected echo response.

**Call relations**: The test runner calls this test. It relies on `arm_initialize_post_failure` to prepare the server-side failure, then `create_client` and `call_echo_tool` exercise the normal initialization and request path.

*Call graph*: calls 4 internal fn (arm_initialize_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_initialize_retries_json_rpc_transient_status`  (lines 138–149)

```
async fn streamable_http_initialize_retries_json_rpc_transient_status() -> anyhow::Result<()>
```

**Purpose**: Tests that the client also retries when initialization fails through a JSON-RPC error that represents a transient HTTP-style status. This covers failures reported inside the protocol message rather than only as raw HTTP responses.

**Data flow**: The test starts the server, arms one JSON-RPC initialize failure with status 502, creates the client, and then calls the echo tool. If retry works, the final echo output matches the expected value.

**Call relations**: The test runner invokes this test. `arm_initialize_post_json_rpc_failure` sets up the special protocol-level failure, while `create_client` and `call_echo_tool` confirm that the client retries and becomes usable.

*Call graph*: calls 4 internal fn (arm_initialize_post_json_rpc_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_retries_initialized_notification_status`  (lines 152–169)

```
async fn streamable_http_retries_initialized_notification_status() -> anyhow::Result<()>
```

**Purpose**: Tests that a temporary failure while sending the post-initialize notification is retried. This notification tells the server that initialization is complete, so losing it once should not make the whole client unusable.

**Data flow**: The test starts the server, arms a one-time JSON-RPC failure for the initialized notification, creates the client, and then calls the echo tool. The expected echo result proves the client completed setup after retrying the notification.

**Call relations**: The test runner calls this. It uses `arm_initialized_notification_post_json_rpc_failure` to create the specific setup failure, then uses the standard client creation and echo helper flow to verify recovery.

*Call graph*: calls 4 internal fn (arm_initialized_notification_post_json_rpc_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_tools_list_retries_transient_http_status`  (lines 172–200)

```
async fn streamable_http_tools_list_retries_transient_http_status() -> anyhow::Result<()>
```

**Purpose**: Tests that listing available tools is retried after a one-time transient HTTP failure on an established session. This checks retry behavior after the client is already initialized.

**Data flow**: The test starts the server and creates a client. It first lists tools successfully and saves that as the expected answer. Then it arms the next session POST to fail once with status 502, calls `list_tools` again, and checks that the retried result equals the original result.

**Call relations**: The test runner calls this test. The setup helpers provide the server and client, `arm_session_post_failure` injects the one-time failure, and the client’s own `list_tools` method is the operation being tested.

*Call graph*: calls 3 internal fn (arm_session_post_failure, create_client, spawn_streamable_http_server); 2 external calls (from_secs, assert_eq!).


##### `streamable_http_tools_list_retries_json_rpc_transient_status`  (lines 203–225)

```
async fn streamable_http_tools_list_retries_json_rpc_transient_status() -> anyhow::Result<()>
```

**Purpose**: Tests that listing tools is retried when the transient failure is reported as a JSON-RPC error rather than only as an HTTP status. This makes sure both error shapes follow the same recovery rule.

**Data flow**: The test creates a server and client, records a successful `list_tools` response, then arms a one-time JSON-RPC session failure with status 502. It calls `list_tools` again and expects the same response after the retry.

**Call relations**: The async test runner invokes this. `arm_session_post_json_rpc_failure` prepares the protocol-level failure, and the repeated `list_tools` calls show that normal data still comes back after retry.

*Call graph*: calls 3 internal fn (arm_session_post_json_rpc_failure, create_client, spawn_streamable_http_server); 2 external calls (from_secs, assert_eq!).


##### `streamable_http_404_session_expiry_recovers_and_retries_once`  (lines 228–247)

```
async fn streamable_http_404_session_expiry_recovers_and_retries_once() -> anyhow::Result<()>
```

**Purpose**: Tests that a 404 on a session request is treated as an expired session and recovered from. The client should start a fresh session and retry the user’s request once.

**Data flow**: The test starts the server, creates a client, and performs a warmup echo call to establish that the session works. It then makes the next session POST return 404 once. A second echo call should trigger recovery and return the expected echo result.

**Call relations**: The test runner calls this. `arm_session_post_failure` simulates the expired session, and `call_echo_tool` is used before and after the failure to show the client moves from healthy, to expired, back to healthy.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 1 external calls (assert_eq!).


##### `streamable_http_session_recovery_retries_initialize_failure`  (lines 250–275)

```
async fn streamable_http_session_recovery_retries_initialize_failure() -> anyhow::Result<()>
```

**Purpose**: Tests a harder recovery path: the session expires, then the re-initialization attempt fails once, and the client still succeeds. This ensures retry logic applies during recovery, not only during first startup.

**Data flow**: The test starts the server and creates a client through `FailFirstInitializeHttpClient`, initially with no planned failure. After a successful warmup call, it arms a one-time 404 session failure and also tells the wrapper to fail the next initialize request. The final echo call should recover, retry initialization, and return the expected result; the initialize-attempt count should show three attempts total.

**Call relations**: The test runner calls this. It combines `arm_session_post_failure` with `FailFirstInitializeHttpClient::fail_next_initialize` so the client must perform session recovery and initialization retry in one flow.

*Call graph*: calls 6 internal fn (default_for_tests, new, arm_session_post_failure, call_echo_tool, create_client_with_http_client, spawn_streamable_http_server); 2 external calls (new, assert_eq!).


##### `streamable_http_401_does_not_trigger_recovery`  (lines 278–302)

```
async fn streamable_http_401_does_not_trigger_recovery() -> anyhow::Result<()>
```

**Purpose**: Tests that a 401 Unauthorized response is not treated as an expired session. A 401 usually means credentials are missing or rejected, so silently retrying as if the session expired would hide the real problem.

**Data flow**: The test starts the server, creates a client, and verifies a warmup echo call. It then arms two session POST failures with status 401. Two echo attempts are made, and both are expected to return errors containing `401`.

**Call relations**: The test runner invokes this. `arm_session_post_failure` supplies repeated unauthorized responses, while `call_echo_tool` proves the client reports the authorization failure instead of recovering behind the scenes.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_403_scope_challenge_returns_insufficient_scope`  (lines 305–328)

```
async fn streamable_http_403_scope_challenge_returns_insufficient_scope() -> anyhow::Result<()>
```

**Purpose**: Tests that a 403 Forbidden response with a Bearer `insufficient_scope` challenge becomes a clear insufficient-scope error. In plain terms, the server is saying the token is valid but lacks required permissions.

**Data flow**: The test creates a working client and confirms it with a warmup echo. Then it arms one session POST failure with status 403 and a `WWW-Authenticate` header describing the missing permission scope. The next echo call must fail, and its error text must mention insufficient scope.

**Call relations**: The test runner calls this. `arm_session_post_failure` creates the permission challenge, and `call_echo_tool` exercises the client path that should turn the header into a meaningful transport error.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_403_finds_bearer_challenge_in_later_header_value`  (lines 331–357)

```
async fn streamable_http_403_finds_bearer_challenge_in_later_header_value() -> anyhow::Result<()>
```

**Purpose**: Tests that the client can find the Bearer insufficient-scope challenge even when it is not the first authentication header. Servers can send several authentication options, so the client must inspect more than the first one.

**Data flow**: The test starts the server, creates the client, and performs a successful warmup call. It then arms a 403 response with two `WWW-Authenticate` values: first a Basic challenge, then a Bearer insufficient-scope challenge. The next echo call should fail with an insufficient-scope message.

**Call relations**: The test runner invokes this. `arm_session_post_failure` provides the multi-header response, and `call_echo_tool` triggers the code path that parses those headers.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_404_recovery_only_retries_once`  (lines 360–386)

```
async fn streamable_http_404_recovery_only_retries_once() -> anyhow::Result<()>
```

**Purpose**: Tests that session-expiry recovery does not loop forever when 404 keeps happening. The client should try one recovery, then surface the error if the retry also fails.

**Data flow**: The test creates a working client and verifies a warmup echo. It then arms two 404 session failures. The next echo call should fail after the single allowed recovery attempt, and the error should mention 404 or session expiry. A later echo call should succeed once the armed failures are used up.

**Call relations**: The test runner calls this. `arm_session_post_failure` sets up repeated session expiry, `call_echo_tool` first proves the retry limit is enforced, and a final `call_echo_tool` proves the client can still work afterward.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


##### `streamable_http_non_session_failure_does_not_trigger_recovery`  (lines 389–413)

```
async fn streamable_http_non_session_failure_does_not_trigger_recovery() -> anyhow::Result<()>
```

**Purpose**: Tests that ordinary server errors, such as 500 Internal Server Error, do not trigger session recovery. A 500 means the server failed, not necessarily that the client’s session is gone.

**Data flow**: The test starts the server, creates a client, and confirms normal operation with a warmup echo. It then arms two session POST failures with status 500. Two echo calls are expected to fail with errors mentioning `500`, showing that the client reports the server problem rather than re-initializing.

**Call relations**: The test runner invokes this. `arm_session_post_failure` creates the repeated server failures, and `call_echo_tool` checks that the client does not use the session-expiry recovery path for this kind of error.

*Call graph*: calls 4 internal fn (arm_session_post_failure, call_echo_tool, create_client, spawn_streamable_http_server); 2 external calls (assert!, assert_eq!).


### `network-proxy/src/mitm_tests.rs`

`test` · `test suite`

This is a test file for the network proxy’s MITM path. MITM means “man in the middle”: the proxy is able to look inside an HTTPS request after a CONNECT tunnel is opened, then decide whether to let that inner request continue. These tests protect several important safety rules. For example, limited network mode should not allow write methods like POST, a request’s Host header must match the destination the tunnel was opened for, and private/local IP addresses must still be rejected even after the tunnel exists.

The file also tests “MITM hooks.” A hook is a carefully described exception for a specific host, HTTP method, and path. In full network mode, a matching hook can allow a write request and can replace sensitive headers, such as swapping a user-supplied Authorization header for a configured secret. But the tests also confirm that hooks do not weaken limited mode, and that requests to a hooked host are blocked when they do not match the hook’s allowed shape.

Most tests build a small fake proxy configuration, create a request, pass it through the same policy function used by the proxy, and then check both the HTTP response and the proxy’s telemetry. The telemetry check matters because users and developers need to know why a request was blocked, not just that it failed.

#### Function details

##### `github_write_hook`  (lines 19–37)

```
fn github_write_hook() -> crate::mitm_hook::MitmHookConfig
```

**Purpose**: Builds a reusable test hook for write requests to GitHub repository paths. The hook says that POST and PUT requests under `/repos/openai/` on `api.github.com` may have their Authorization header replaced with a secret token.

**Data flow**: It takes no input. It creates a hook configuration with a host, allowed methods, allowed path prefix, one header to remove, and one header to inject. It returns that configuration so several tests can start from the same realistic GitHub write-rule setup.

**Call relations**: The hook-focused tests call this helper before building their proxy settings. Some tests then adjust the returned hook, such as changing where the secret comes from or removing injected headers, so they can check different policy outcomes without repeating the whole hook definition.

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

**Purpose**: Creates the small bundle of information that the MITM policy checker needs for one request. It ties together the proxy state, the current network mode, and the destination host and port.

**Data flow**: It receives shared proxy state, a network mode, a target host, and a target port. It copies the host into an owned string and packages all four pieces into a policy context. The returned context is then passed to the MITM policy decision function.

**Call relations**: Nearly every policy test calls this helper after creating its test proxy state. It keeps the tests focused on the rule being checked instead of repeating the same context-building code each time.

*Call graph*: called by 6 (mitm_policy_allows_matching_hooked_write_in_full_mode, mitm_policy_blocks_disallowed_method_and_records_telemetry, mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode, mitm_policy_blocks_matching_hooked_write_in_limited_mode, mitm_policy_rechecks_local_private_target_after_connect, mitm_policy_rejects_host_mismatch).


##### `mitm_policy_blocks_disallowed_method_and_records_telemetry`  (lines 54–90)

```
async fn mitm_policy_blocks_disallowed_method_and_records_telemetry()
```

**Purpose**: Checks that limited network mode blocks a POST request, even when the destination domain is otherwise allowed. It also verifies that the block is recorded with the expected reason and request details.

**Data flow**: The test builds proxy settings that allow `example.com`, wraps them in proxy state, and creates a limited-mode policy context for `example.com:443`. It then builds a POST request and asks the MITM policy checker whether to block it. The expected result is a 403 Forbidden response with a method-policy error header, plus one telemetry record showing the POST to `example.com` was blocked.

**Call relations**: The async test runner invokes this test. Inside the test, `policy_ctx` prepares the context and `network_proxy_state_for_policy` prepares the proxy state; the test then exercises the MITM blocking decision and inspects the state’s blocked-request log afterward.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_rejects_host_mismatch`  (lines 93–119)

```
async fn mitm_policy_rejects_host_mismatch()
```

**Purpose**: Checks that the proxy rejects a request whose Host header does not match the host the tunnel was opened for. This prevents a client from connecting to one place while claiming inside the request that it is talking to another.

**Data flow**: The test creates proxy state that allows `example.com` and a full-mode context whose target host is `example.com`. It then sends a GET request with `Host: evil.example`. The policy checker returns a 400 Bad Request response, and the blocked-request telemetry remains empty because this is treated as a malformed or mismatched request rather than a normal policy block.

**Call relations**: The async test runner calls this test. The test uses `policy_ctx` and `network_proxy_state_for_policy` to set up the same kind of context the real proxy would have after CONNECT, then checks the MITM policy response directly.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_rechecks_local_private_target_after_connect`  (lines 122–154)

```
async fn mitm_policy_rechecks_local_private_target_after_connect()
```

**Purpose**: Checks that the proxy still blocks local or private network targets after a CONNECT tunnel has been made. This matters because private addresses can expose internal services that should not be reachable unless explicitly allowed.

**Data flow**: The test builds settings that do not allow local binding, then creates a full-mode context for target `10.0.0.1:443`. It sends a GET request whose Host header matches that private address. The policy checker returns a 403 Forbidden response, and the blocked telemetry records the local/private-network reason, host, and port.

**Call relations**: The async test runner invokes this test. The setup flows through `network_proxy_state_for_policy` and `policy_ctx`, then the MITM policy checker is asked to make the after-CONNECT decision that this test is protecting.

*Call graph*: calls 3 internal fn (default, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_allows_matching_hooked_write_in_full_mode`  (lines 157–192)

```
async fn mitm_policy_allows_matching_hooked_write_in_full_mode()
```

**Purpose**: Checks that full network mode can allow a write request when it exactly matches a configured MITM hook. This proves that hooks can create narrow, intentional exceptions for trusted workflows.

**Data flow**: The test creates a temporary file containing a fake GitHub token, builds the GitHub write hook, and changes the hook so its injected Authorization value comes from that file. It configures the proxy for full mode with MITM enabled and `api.github.com` allowed, then sends a matching POST request to a GitHub repository path. The policy checker returns no blocking response, and no blocked-request telemetry is recorded.

**Call relations**: The async test runner calls this test. It relies on `github_write_hook` for the shared hook shape, uses `policy_ctx` and `network_proxy_state_for_policy` to build the policy environment, and then verifies that the MITM policy checker lets the matching request continue.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 8 external calls (new, new, assert!, assert_eq!, builder, empty, write, vec!).


##### `mitm_policy_blocks_matching_hooked_write_in_limited_mode`  (lines 195–236)

```
async fn mitm_policy_blocks_matching_hooked_write_in_limited_mode()
```

**Purpose**: Checks that a matching hook does not override limited network mode’s ban on write methods. In other words, limited mode stays restrictive even if a hook would otherwise match.

**Data flow**: The test builds the GitHub write hook, removes its injected headers, and configures the proxy in limited mode with MITM enabled. It then sends a matching POST request to `api.github.com`. The policy checker returns a 403 Forbidden response for the method policy, and the telemetry records one blocked POST request for that host and port.

**Call relations**: The async test runner invokes this test. The test starts with `github_write_hook`, prepares proxy state through `network_proxy_state_for_policy`, creates a context with `policy_ctx`, and then confirms that the main MITM policy decision still enforces limited-mode method rules.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode`  (lines 239–285)

```
async fn mitm_policy_blocks_hook_miss_for_hooked_host_and_records_telemetry_in_full_mode()
```

**Purpose**: Checks that when a host has a MITM hook, requests to that host must match the hook’s allowed method and path shape. A request that misses the hook is blocked, even in full mode.

**Data flow**: The test creates a temporary secret file, builds the GitHub write hook, and configures the proxy in full mode for `api.github.com`. It then sends a GET request to a GitHub repository path with a user-supplied Authorization header. Because the hook only allows POST and PUT, the request misses the hook. The policy checker returns a 403 Forbidden response with a MITM-hook error header, and the blocked telemetry records the hook-denied reason, method, host, and port.

**Call relations**: The async test runner calls this test. It uses `github_write_hook` to set up the protected host behavior, `network_proxy_state_for_policy` for test state, and `policy_ctx` for the request’s destination context before exercising the MITM blocking decision.

*Call graph*: calls 4 internal fn (default, github_write_hook, policy_ctx, network_proxy_state_for_policy); 7 external calls (new, new, assert_eq!, builder, empty, write, vec!).


##### `apply_mitm_hook_actions_replaces_authorization_header`  (lines 288–320)

```
fn apply_mitm_hook_actions_replaces_authorization_header()
```

**Purpose**: Checks that hook actions can remove an existing Authorization header and replace it with the configured secret value. It also makes sure unrelated headers are left alone.

**Data flow**: The test starts with a header map containing a user-provided Authorization header and an `x-request-id` header. It builds hook actions that strip Authorization and inject a new Authorization value from a resolved secret. After applying the actions, the Authorization header contains the secret token, while `x-request-id` is unchanged.

**Call relations**: The normal test runner invokes this synchronous test. It directly exercises `apply_mitm_hook_actions`, which is the lower-level helper used by the MITM hook path when a request has matched a hook and needs header changes before being forwarded.

*Call graph*: 5 external calls (new, from_static, from_static, assert_eq!, vec!).


### `uds/src/lib_tests.rs`

`test` · `automated test run`

This file tests the small but important pieces of the Unix domain socket support. A Unix domain socket is a local communication endpoint that looks like a file path, but lets two processes talk without using the network. Because socket paths live on disk, the library must be careful about where it creates them, who can access the directory, and whether an old path is safe to reuse.

The tests use temporary directories so they do not touch a real user’s files. First, they check that the library creates a private socket directory when it does not exist. On Unix systems, they also check that an existing directory is tightened to owner-only permissions, like locking a mailbox so only its owner can open it.

Other tests check how the library identifies socket paths. A normal file must not be mistaken for a stale socket. A bound socket path, however, should be recognized as a socket path. The final test proves the full path works end to end: a listener accepts a connection, reads the word “request,” sends back “response,” and the client receives it. Some tests skip gracefully if the operating system refuses socket creation because of permissions.

#### Function details

##### `prepare_private_socket_directory_creates_directory`  (lines 10–19)

```
async fn prepare_private_socket_directory_creates_directory()
```

**Purpose**: This test proves that the socket helper creates the directory it needs when the directory is missing. Without this, later socket setup could fail simply because the parent folder was not there.

**Data flow**: It starts with a fresh temporary directory and builds a path inside it for the socket directory. It asks the library to prepare that path, then checks the filesystem afterward. The expected result is that the path now exists and is a directory.

**Call relations**: The asynchronous test runner invokes this test during the test suite. Inside the test, a temporary directory is created, the socket-directory preparation code is exercised, and the final assertion confirms the visible result on disk.

*Call graph*: 2 external calls (assert!, new).


##### `prepare_private_socket_directory_sets_existing_permissions_to_owner_only`  (lines 23–43)

```
async fn prepare_private_socket_directory_sets_existing_permissions_to_owner_only()
```

**Purpose**: This Unix-only test checks that an already existing socket directory is made private to its owner. This matters because a control socket directory with loose permissions could let other users interfere with or inspect local control traffic.

**Data flow**: It creates temporary directories with deliberately different permission settings, such as broadly readable permissions. For each one, it calls the directory preparation code, reads the directory metadata afterward, and compares the final permission bits. The expected output is that the directory permissions are exactly owner-only, written as 0700 in Unix permission notation.

**Call relations**: The test runner calls this only on Unix platforms. The test uses standard filesystem calls to set up unsafe or incorrect starting permissions, then hands the path to the library code and uses an equality assertion to verify the library corrected them.

*Call graph*: 7 external calls (assert_eq!, from_mode, format!, create_dir, metadata, set_permissions, new).


##### `regular_file_path_is_not_stale_socket_path`  (lines 47–57)

```
async fn regular_file_path_is_not_stale_socket_path()
```

**Purpose**: This Unix-only test makes sure a plain file is not treated as an old socket file. That protects the library from deleting or reusing the wrong kind of path.

**Data flow**: It creates a temporary directory, writes a normal file named like something that could be confused with a socket, and then asks the library whether that path is a stale socket path. The result should be false: the file exists, but it is not a socket.

**Call relations**: The test runner invokes this test on Unix systems. The test uses a normal file write to create the starting condition, then calls the stale-socket detection logic and asserts that the answer rejects the ordinary file.

*Call graph*: 3 external calls (assert!, write, new).


##### `bound_listener_path_is_stale_socket_path`  (lines 60–77)

```
async fn bound_listener_path_is_stale_socket_path()
```

**Purpose**: This test checks that a path created by binding a Unix socket listener is recognized as a socket path by the stale-path detection logic. It helps confirm that the library can tell real socket files apart from ordinary files.

**Data flow**: It creates a temporary socket path and tries to bind a Unix listener there. If the operating system denies permission, the test prints a skip message and exits. Otherwise, it asks the library whether the socket path looks like a stale socket path, and expects the answer to be true.

**Call relations**: During the test run, this function sets up a real Unix socket listener through the bind operation. It then passes the resulting filesystem path into the stale-socket check and uses an assertion to confirm the check sees the path as a socket. If binding fails for an unexpected reason, the test stops with a panic so the failure is visible.

*Call graph*: calls 1 internal fn (bind); 4 external calls (assert!, eprintln!, panic!, new).


##### `stream_round_trips_data_between_listener_and_client`  (lines 80–121)

```
async fn stream_round_trips_data_between_listener_and_client()
```

**Purpose**: This test proves that the library’s Unix socket stream can carry bytes in both directions between a server side and a client side. It is the end-to-end confidence check that local socket communication actually works.

**Data flow**: It creates a temporary socket path and binds a listener there. A background server task waits for one client, reads the exact bytes spelling “request,” and writes back “response.” Meanwhile, the client connects to the socket path, sends “request,” reads eight response bytes, and checks that they spell “response.” The final result is that both sides complete and the server task joins successfully.

**Call relations**: The test runner starts this asynchronous test. The function first creates the listener with a bind call, then uses a spawned asynchronous task as the server side while the main test body acts as the client side through a connect call. Assertions on both sides confirm the message exchange, and the final join waits for the server task so failures inside it are reported.

*Call graph*: calls 2 internal fn (bind, connect); 5 external calls (assert_eq!, eprintln!, panic!, new, spawn).


### `utils/rustls-provider/tests/provider.rs`

`test` · `test suite`

Rustls is a Rust library for TLS, the encryption layer used for secure network connections. Rustls needs a “crypto provider,” which is the part that supplies the actual cryptographic algorithms. This test makes sure the project’s helper function, `ensure_rustls_crypto_provider`, does what the rest of the system expects: it installs a default provider with support for `ECDSA_NISTP521_SHA512`, a particular digital signature scheme used during certificate checking.

In plain terms, this is like checking that a toolbox has the exact wrench needed before relying on it to repair something important. The test first asks the project helper to install the Rustls provider. Then it asks Rustls for the currently installed default provider. If none is installed, the test fails immediately, because secure TLS operations would not have the crypto backing they need. Finally, it checks the provider’s list of supported signature schemes and confirms that the required one is present.

This matters because TLS failures can be hard to diagnose later. Without this test, a change to the provider setup could silently remove support for this signature scheme, causing secure connections or certificate verification to fail only at runtime.

#### Function details

##### `ensure_provider_installs_ecdsa_p521_sha512_support`  (lines 4–16)

```
fn ensure_provider_installs_ecdsa_p521_sha512_support()
```

**Purpose**: This test proves that the project’s Rustls provider setup installs a usable default crypto provider. It specifically checks that the installed provider can verify signatures using the ECDSA P-521 with SHA-512 scheme.

**Data flow**: The test starts with no direct input from the caller. It calls `ensure_rustls_crypto_provider`, then reads Rustls’s global default crypto provider. If there is no provider, it stops with a failure. If there is one, it inspects the provider’s supported signature schemes and succeeds only if `ECDSA_NISTP521_SHA512` is included.

**Call relations**: The test calls the project’s provider setup function first, because that is the behavior under test. It then asks Rustls for the default provider and uses assertions to turn missing setup or missing algorithm support into a clear test failure.

*Call graph*: 4 external calls (assert!, ensure_rustls_crypto_provider, panic!, get_default).


### `utils/rustls-provider/tests/preinstalled.rs`

`test` · `test run`

Rustls is a library used for TLS, the security layer behind HTTPS and other encrypted connections. To work, Rustls needs a crypto provider: the part that supplies the actual cryptographic algorithms. This file tests one important promise of `ensure_rustls_crypto_provider`: if a default provider is already installed, the helper should leave it alone.

The test builds a normal AWS-LC-based Rustls provider, then deliberately changes one part of it: it removes all supported signature verification algorithms. That makes the provider easy to recognize later, like putting a bright sticker on a suitcase. The test installs this altered provider as the global default. Then it calls `ensure_rustls_crypto_provider`, which is the project helper meant to make sure Rustls has a provider available.

Afterward, the test asks Rustls for the current default provider. If the helper had replaced the preinstalled provider, the removed algorithms would likely be back. Instead, the test confirms that a specific signature scheme is still absent. That proves the original, intentionally altered provider survived. Without this behavior, code using this helper could unexpectedly override application-level security choices made earlier in startup.

#### Function details

##### `ensure_provider_preserves_preinstalled_provider`  (lines 10–26)

```
fn ensure_provider_preserves_preinstalled_provider()
```

**Purpose**: This test proves that `ensure_rustls_crypto_provider` does not replace an existing Rustls crypto provider. It uses a deliberately modified provider so it can tell whether the provider was preserved or overwritten.

**Data flow**: The test starts by creating Rustls’s default AWS-LC provider, then changes its signature verification algorithms to an empty set. It installs that changed provider as the global default, calls the project’s provider-setup helper, then reads the global default provider back from Rustls. The expected result is that the read-back provider still lacks the chosen signature scheme, showing that the helper did not swap it out.

**Call relations**: During the test, this function first asks Rustls for a standard provider, installs its modified version, and then calls `ensure_rustls_crypto_provider` as real startup code would. It then asks Rustls for the default provider and uses assertions to confirm the provider is still the one it installed; if Rustls reports no provider, the test stops with a panic because that would mean the setup failed completely.

*Call graph*: 5 external calls (assert!, ensure_rustls_crypto_provider, panic!, get_default, default_provider).
