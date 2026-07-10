# Provider and backend auth adaptation  `stage-5.2`

This stage is the system’s “ID and badge desk.” It sits behind the scenes and prepares all the different ways later network clients prove who they are. The rest of the system can then send HTTP, websocket, or RPC requests without each caller reinventing login rules.

The model-provider files are the main switchboard. They define what a provider is, choose the right provider implementation, and turn saved settings into a concrete auth method. The shared bearer-token helper adds the usual Authorization header plus extra routing headers. The Bedrock-specific files do the special Amazon path: they normalize region and URL settings, choose between bearer tokens and AWS SigV4 signing, then adapt requests so Amazon accepts the signature.

The AWS auth crate is the signing engine. It loads AWS credentials and region from config, then rewrites a request with the cryptographic SigV4 signature. Agent-identity files manage a different proof system based on keys, signed claims, and JWTs.

Other files plug these auth methods into specific places: external command-based tokens, remote-control login refresh, MCP server auth detection, API-client auth hooks, optional attestation headers, and an account processor that builds an authenticated backend client before making its request.

## Files in this stage

### Provider runtime surface
Defines the public model-provider API and the main runtime wiring that selects and configures generic versus Bedrock-backed providers.

### `model-provider/src/lib.rs`

`orchestration` · `cross-cutting`

This file is a pure module-and-reexport boundary for the model-provider crate. It declares the internal implementation modules `amazon_bedrock`, `auth`, `bearer_auth_provider`, `models_endpoint`, and `provider`, then selectively republishes the crate’s stable surface so downstream code can depend on a compact API without knowing the internal module layout. The exported items show the crate’s responsibilities: building authentication providers (`auth_provider_from_auth`, `unauthenticated_auth_provider`, `BearerAuthProvider`), representing provider-linked account state (`ProviderAccount`, `ProviderAccountState`, `ProviderAccountError`, `ProviderAccountResult`), describing provider capabilities (`ProviderCapabilities`), and constructing or sharing provider instances (`ModelProvider`, `ModelProviderFuture`, `SharedModelProvider`, `create_model_provider`). One notable design choice is aliasing `BearerAuthProvider` as `CoreAuthProvider`, which preserves compatibility for callers expecting a more generic auth-provider name while still exposing the concrete bearer-token implementation. Because this file contains no executable logic, its importance is architectural: it defines what the rest of the workspace is allowed to import from this crate and hides implementation details such as Bedrock-specific support and model-endpoint internals behind a curated facade.


### `model-provider/src/provider.rs`

`orchestration` · `provider creation and cross-cutting runtime dispatch`

This file is the central runtime abstraction for model providers. It defines lightweight data types first: `ProviderCapabilities` advertises provider-owned feature limits with a permissive default of all `true`; `ProviderAccountState` exposes app-visible account information; and `ProviderAccountError` captures two concrete failure modes when deriving account state from auth, with human-readable `Display` messages. It also defines default preferred-model constants used by providers that do not need backend-specific IDs.

The `ModelProvider` trait combines metadata access, capability reporting, preferred-model selection, auth exposure, account-state reporting, API-provider construction, runtime base URL lookup, request-auth resolution, and model-manager creation. Several methods have default implementations: generic providers derive API provider and auth from `self.info()` plus current auth, and default runtime base URL simply echoes configured `base_url`.

`create_model_provider` is the factory: Bedrock configs instantiate `AmazonBedrockModelProvider`, everything else becomes `ConfiguredModelProvider`. The generic implementation wraps `ModelProviderInfo` plus an optional auth manager, but `ConfiguredModelProvider::new` may replace that manager with a provider-scoped external bearer manager when command auth is configured. Its `account_state` logic is the most nuanced part of the file: for providers requiring OpenAI auth, it inspects cached auth only if there is no recorded refresh failure, maps API keys to `ProviderAccount::ApiKey`, rejects Bedrock API keys, and requires both email and plan type for ChatGPT-like auth before returning `ProviderAccount::Chatgpt`. `supports_attestation` is enabled only for cached ChatGPT auth. Finally, `models_manager` chooses between a `StaticModelsManager` when a catalog is configured and an `OpenAiModelsManager` backed by `OpenAiModelsEndpoint` when models must be fetched remotely. The extensive tests cover provider selection, auth-manager behavior, account-state edge cases, Bedrock specialization, static versus remote model catalogs, and provider-owned bearer-token precedence.

#### Function details

##### `ProviderCapabilities::default`  (lines 36–42)

```
fn default() -> Self
```

**Purpose**: Supplies the default capability set for providers that do not override feature support.

**Data flow**: It returns `ProviderCapabilities { namespace_tools: true, image_generation: true, web_search: true }`.

**Call relations**: This default is used by the trait's `capabilities` method for generic providers and any provider that does not supply a narrower capability set.

*Call graph*: called by 1 (capabilities).


##### `ProviderAccountError::fmt`  (lines 60–75)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats provider account-state errors into user-facing messages.

**Data flow**: It matches `self` and writes either the missing-ChatGPT-details message or the unsupported-Bedrock-auth message into the formatter.

**Call relations**: This implementation is used whenever `ProviderAccountError` is displayed or converted into text by callers or tests.

*Call graph*: 1 external calls (write!).


##### `ModelProvider::capabilities`  (lines 104–106)

```
fn capabilities(&self) -> ProviderCapabilities
```

**Purpose**: Provides the trait default capability set for providers that do not override it.

**Data flow**: It calls `ProviderCapabilities::default()` and returns that value.

**Call relations**: Configured providers inherit this implementation; Bedrock overrides it with a narrower set.

*Call graph*: calls 1 internal fn (default).


##### `ModelProvider::approval_review_preferred_model`  (lines 111–113)

```
fn approval_review_preferred_model(&self) -> &'static str
```

**Purpose**: Provides the default preferred model for automatic approval review.

**Data flow**: It returns the constant `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL`.

**Call relations**: Providers that need backend-specific IDs, such as Bedrock, override this method.


##### `ModelProvider::memory_extraction_preferred_model`  (lines 118–120)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Provides the default preferred model for memory extraction.

**Data flow**: It returns the constant `DEFAULT_MEMORY_EXTRACTION_PREFERRED_MODEL`.

**Call relations**: This default is used by generic providers; specialized providers may override it.


##### `ModelProvider::memory_consolidation_preferred_model`  (lines 125–127)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Provides the default preferred model for memory consolidation.

**Data flow**: It returns the constant `DEFAULT_MEMORY_CONSOLIDATION_PREFERRED_MODEL`.

**Call relations**: This is the generic fallback for providers without backend-specific consolidation routing.


##### `ModelProvider::supports_attestation`  (lines 130–132)

```
fn supports_attestation(&self) -> bool
```

**Purpose**: Declares whether requests through the provider should include attestation by default.

**Data flow**: It returns `false` unconditionally.

**Call relations**: Configured providers override this based on cached ChatGPT auth; Bedrock leaves the default false.


##### `ModelProvider::api_provider`  (lines 149–155)

```
fn api_provider(&self) -> ModelProviderFuture<'_, codex_protocol::error::Result<Provider>>
```

**Purpose**: Builds a generic API provider configuration from provider metadata and current auth mode.

**Data flow**: It returns a boxed future that awaits `self.auth()`, maps the optional auth to `CodexAuth::auth_mode`, and passes that into `self.info().to_api_provider(...)`.

**Call relations**: This default implementation is used by generic providers; Bedrock overrides it to inject a runtime-resolved Mantle base URL.

*Call graph*: 1 external calls (pin).


##### `ModelProvider::runtime_base_url`  (lines 158–162)

```
fn runtime_base_url(
        &self,
    ) -> ModelProviderFuture<'_, codex_protocol::error::Result<Option<String>>>
```

**Purpose**: Returns the configured base URL as the default runtime URL for providers without dynamic endpoint resolution.

**Data flow**: It returns a boxed future that clones `self.info().base_url` and wraps it in `Ok(...)`.

**Call relations**: Configured providers inherit this behavior; Bedrock overrides it because its URL depends on resolved region/auth.

*Call graph*: 1 external calls (pin).


##### `ModelProvider::api_auth`  (lines 165–172)

```
fn api_auth(
        &self,
    ) -> ModelProviderFuture<'_, codex_protocol::error::Result<SharedAuthProvider>>
```

**Purpose**: Resolves the generic request auth provider from current auth and provider metadata.

**Data flow**: It returns a boxed future that awaits `self.auth()`, then calls `resolve_provider_auth(auth.as_ref(), self.info())` and returns the resulting `SharedAuthProvider` or error.

**Call relations**: This default path is used by generic providers. Bedrock overrides it to use Bedrock-specific auth resolution instead of the generic resolver.

*Call graph*: 2 external calls (pin, resolve_provider_auth).


##### `create_model_provider`  (lines 188–197)

```
fn create_model_provider(
    provider_info: ModelProviderInfo,
    auth_manager: Option<Arc<AuthManager>>,
) -> SharedModelProvider
```

**Purpose**: Factory-selects the runtime provider implementation appropriate for the configured provider metadata.

**Data flow**: It takes `provider_info` and an optional `Arc<AuthManager>`, checks `provider_info.is_amazon_bedrock()`, and returns either `Arc<AmazonBedrockModelProvider::new(...)>` or `Arc<ConfiguredModelProvider::new(...)>` as `SharedModelProvider`.

**Call relations**: This is the main entry point used by the rest of the system to instantiate providers. It dispatches between the Bedrock-specialized and generic implementations.

*Call graph*: calls 3 internal fn (is_amazon_bedrock, new, new); called by 15 (amazon_bedrock_provider_creates_static_models_manager, amazon_bedrock_provider_returns_bedrock_account_state, configured_bedrock_catalog_only_allows_default_service_tier, configured_provider_models_manager_uses_provider_bearer_token, configured_provider_runtime_base_url_uses_configured_base_url, configured_provider_uses_default_approval_review_preferred_model, configured_provider_uses_default_capabilities, create_model_provider_builds_command_auth_manager_without_base_manager, create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider, create_model_provider_uses_managed_auth_for_amazon_bedrock_provider (+5 more)); 1 external calls (new).


##### `ConfiguredModelProvider::new`  (lines 207–213)

```
fn new(provider_info: ModelProviderInfo, auth_manager: Option<Arc<AuthManager>>) -> Self
```

**Purpose**: Constructs the generic runtime provider and applies provider-scoped auth-manager substitution when command auth is configured.

**Data flow**: It takes `provider_info` and an optional auth manager, passes both to `auth_manager_for_provider`, and stores the resulting manager alongside the original `provider_info` in a new `ConfiguredModelProvider`.

**Call relations**: This constructor is called by `create_model_provider` for all non-Bedrock providers. Its only delegation is to auth-manager selection logic.

*Call graph*: calls 1 internal fn (auth_manager_for_provider); called by 1 (create_model_provider).


##### `ConfiguredModelProvider::info`  (lines 217–219)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Returns the stored generic provider metadata.

**Data flow**: It reads `self.info` and returns a shared reference.

**Call relations**: This satisfies the trait's metadata accessor for generic providers.


##### `ConfiguredModelProvider::auth_manager`  (lines 221–223)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Exposes the provider's auth manager, if any.

**Data flow**: It clones and returns `self.auth_manager`.

**Call relations**: This is the straightforward generic implementation of the trait method; unlike Bedrock, it does not filter by auth type.


##### `ConfiguredModelProvider::supports_attestation`  (lines 225–230)

```
fn supports_attestation(&self) -> bool
```

**Purpose**: Enables attestation only when the cached auth is ChatGPT-based.

**Data flow**: It reads `self.auth_manager`, obtains `auth_cached()` if present, and returns true only when the cached auth exists and `auth.is_chatgpt_auth()` is true.

**Call relations**: This overrides the trait default so generic providers can opt into attestation based on current auth state.


##### `ConfiguredModelProvider::auth`  (lines 232–239)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Asynchronously fetches the current auth snapshot from the provider's auth manager.

**Data flow**: It returns a boxed future that checks `self.auth_manager`; if present it awaits `auth_manager.auth()` and returns the result, otherwise it returns `None`.

**Call relations**: This method feeds the trait defaults for API-provider and API-auth construction, as well as account-state logic in callers.

*Call graph*: 1 external calls (pin).


##### `ConfiguredModelProvider::account_state`  (lines 241–281)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Derives the app-visible account state for generic providers from provider requirements and cached auth details.

**Data flow**: If `self.info.requires_openai_auth` is false, it returns `ProviderAccountState { account: None, requires_openai_auth: false }`. Otherwise it inspects `self.auth_manager`, fetches cached auth only when there is no recorded refresh failure for that auth, and maps auth variants: `ApiKey` becomes `ProviderAccount::ApiKey`; `BedrockApiKey` returns `Err(UnsupportedBedrockApiKeyAuth)`; ChatGPT-like, agent-identity, and PAT auth require both `get_account_email()` and `account_plan_type()` to produce `ProviderAccount::Chatgpt { email, plan_type }`, otherwise they return `Err(MissingChatgptAccountDetails)`. The final `ProviderAccountState` always echoes `requires_openai_auth` from config.

**Call relations**: This method is called by UI/status code to summarize provider auth state. It is self-contained and does not delegate to local helpers, because it encodes the generic provider's account-state policy directly.


##### `ConfiguredModelProvider::models_manager`  (lines 283–305)

```
fn models_manager(
        &self,
        codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> SharedModelsManager
```

**Purpose**: Chooses between a static and remote models manager for generic providers based on whether a model catalog is configured.

**Data flow**: It takes `codex_home` and optional `config_model_catalog`. If a catalog is provided, it returns `Arc<StaticModelsManager::new(self.auth_manager.clone(), model_catalog)>`. Otherwise it constructs an `Arc<OpenAiModelsEndpoint>` from cloned provider info and auth manager, then returns `Arc<OpenAiModelsManager::new(codex_home, endpoint, self.auth_manager.clone())>`.

**Call relations**: This method is the generic provider's model-catalog strategy switch. It delegates to `OpenAiModelsEndpoint` and `OpenAiModelsManager` for remote catalogs, or `StaticModelsManager` for configured catalogs.

*Call graph*: calls 3 internal fn (new, new, new); 2 external calls (new, clone).


##### `tests::provider_info_with_command_auth`  (lines 330–345)

```
fn provider_info_with_command_auth() -> ModelProviderInfo
```

**Purpose**: Creates a generic provider fixture configured with command-backed auth.

**Data flow**: It builds `ModelProviderAuthInfo` with command metadata and current directory, embeds it into an OpenAI provider config, and returns the resulting `ModelProviderInfo`.

**Call relations**: This helper supports tests around provider construction and command-auth manager creation.

*Call graph*: calls 1 internal fn (create_openai_provider); 3 external calls (new, new, current_dir).


##### `tests::test_codex_home`  (lines 347–349)

```
fn test_codex_home() -> std::path::PathBuf
```

**Purpose**: Builds a temporary per-process path used as a fake Codex home directory in tests.

**Data flow**: It reads `std::env::temp_dir()`, appends a process-ID-based suffix, and returns the resulting `PathBuf`.

**Call relations**: This helper is used by tests that instantiate models managers requiring a home directory path.

*Call graph*: 2 external calls (format!, temp_dir).


##### `tests::provider_for`  (lines 351–371)

```
fn provider_for(base_url: String) -> ModelProviderInfo
```

**Purpose**: Constructs a minimal custom provider configuration for tests targeting generic provider behavior.

**Data flow**: It takes a base URL string and returns a `ModelProviderInfo` populated with explicit fields such as `name`, `base_url`, `wire_api`, retry settings, and `requires_openai_auth: false`.

**Call relations**: This fixture is used by tests that need a non-OpenAI, non-Bedrock provider with predictable settings.


##### `tests::remote_model`  (lines 373–398)

```
fn remote_model(slug: &str) -> ModelInfo
```

**Purpose**: Builds a realistic `ModelInfo` test value from JSON for remote-model catalog tests.

**Data flow**: It interpolates the provided slug into a JSON object containing many `ModelInfo` fields, deserializes it with `serde_json::from_value`, and returns the parsed model.

**Call relations**: This helper supplies remote catalog payloads for tests involving the generic provider's remote models manager.

*Call graph*: 2 external calls (json!, from_value).


##### `tests::bedrock_api_key_auth`  (lines 400–405)

```
fn bedrock_api_key_auth() -> CodexAuth
```

**Purpose**: Creates a reusable Bedrock API-key auth fixture for tests.

**Data flow**: It constructs and returns `CodexAuth::BedrockApiKey(BedrockApiKeyAuth { api_key, region })` with fixed test values.

**Call relations**: This helper is used by tests that verify Bedrock auth handling and rejection in generic provider paths.

*Call graph*: 1 external calls (BedrockApiKey).


##### `tests::configured_provider_uses_default_capabilities`  (lines 408–415)

```
fn configured_provider_uses_default_capabilities()
```

**Purpose**: Verifies that generic configured providers inherit the default capability set.

**Data flow**: It creates a generic provider with `create_model_provider`, calls `capabilities()`, and asserts equality with `ProviderCapabilities::default()`.

**Call relations**: This test covers the trait default `capabilities` path as exercised through the generic provider implementation.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::configured_provider_uses_default_approval_review_preferred_model`  (lines 418–428)

```
fn configured_provider_uses_default_approval_review_preferred_model()
```

**Purpose**: Checks that generic providers use the default approval-review preferred model constant.

**Data flow**: It creates a generic provider and asserts `approval_review_preferred_model()` equals `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL`.

**Call relations**: This test validates the inherited trait default for approval-review model selection.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::configured_provider_runtime_base_url_uses_configured_base_url`  (lines 431–444)

```
async fn configured_provider_runtime_base_url_uses_configured_base_url()
```

**Purpose**: Ensures the generic provider's runtime base URL simply reflects configured provider metadata.

**Data flow**: It creates a provider from `provider_for("https://example.test/v1")`, awaits `runtime_base_url()`, and asserts the result is that same URL wrapped in `Some`.

**Call relations**: This test covers the trait default `runtime_base_url` implementation through a generic provider.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (assert_eq!, provider_for).


##### `tests::create_model_provider_builds_command_auth_manager_without_base_manager`  (lines 447–458)

```
fn create_model_provider_builds_command_auth_manager_without_base_manager()
```

**Purpose**: Verifies that command-auth providers get a provider-scoped auth manager even when no base manager is supplied.

**Data flow**: It creates a provider from `provider_info_with_command_auth()` and `None`, retrieves `auth_manager()`, and asserts `has_external_auth()` is true.

**Call relations**: This test exercises `create_model_provider` plus `ConfiguredModelProvider::new` and `auth_manager_for_provider` on the command-auth path.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (assert!, provider_info_with_command_auth).


##### `tests::create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider`  (lines 461–473)

```
fn create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider()
```

**Purpose**: Checks that the provider factory does not expose an OpenAI auth manager through a Bedrock provider.

**Data flow**: It creates a Bedrock provider with an auth manager containing an OpenAI API key and asserts `provider.auth_manager()` is `None`.

**Call relations**: This test validates factory dispatch to the Bedrock implementation and Bedrock's auth filtering behavior.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_amazon_bedrock_provider, create_model_provider); 1 external calls (assert!).


##### `tests::create_model_provider_uses_managed_auth_for_amazon_bedrock_provider`  (lines 476–484)

```
async fn create_model_provider_uses_managed_auth_for_amazon_bedrock_provider()
```

**Purpose**: Verifies that the provider factory preserves managed Bedrock auth when constructing a Bedrock provider.

**Data flow**: It creates a Bedrock provider with an auth manager containing `bedrock_api_key_auth()`, awaits `provider.auth()`, and asserts the returned auth matches the fixture.

**Call relations**: This test covers factory dispatch plus Bedrock provider auth exposure on the managed-auth path.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_amazon_bedrock_provider, create_model_provider); 2 external calls (assert_eq!, bedrock_api_key_auth).


##### `tests::openai_provider_returns_unauthenticated_openai_account_state`  (lines 487–500)

```
fn openai_provider_returns_unauthenticated_openai_account_state()
```

**Purpose**: Checks the generic account-state result for an OpenAI provider with no auth.

**Data flow**: It creates an OpenAI provider without an auth manager and asserts `account_state()` returns `account: None` and `requires_openai_auth: true`.

**Call relations**: This test covers the no-auth branch of `ConfiguredModelProvider::account_state` when auth is required.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_returns_api_key_account_state`  (lines 503–518)

```
fn openai_provider_returns_api_key_account_state()
```

**Purpose**: Verifies that cached API-key auth maps to `ProviderAccount::ApiKey` for OpenAI providers.

**Data flow**: It creates an OpenAI provider with an auth manager containing `CodexAuth::ApiKey`, calls `account_state()`, and asserts the returned state contains `Some(ProviderAccount::ApiKey)` with `requires_openai_auth: true`.

**Call relations**: This test exercises the API-key mapping branch in `ConfiguredModelProvider::account_state`.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_rejects_chatgpt_account_state_without_email`  (lines 521–533)

```
fn openai_provider_rejects_chatgpt_account_state_without_email()
```

**Purpose**: Checks that ChatGPT-like auth without complete account details is rejected when deriving account state.

**Data flow**: It creates an OpenAI provider with dummy ChatGPT auth lacking required details, calls `account_state()`, and asserts the result is `Err(ProviderAccountError::MissingChatgptAccountDetails)`.

**Call relations**: This test covers the validation branch in `ConfiguredModelProvider::account_state` that requires both email and plan type.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_rejects_bedrock_api_key_account_state`  (lines 536–546)

```
fn openai_provider_rejects_bedrock_api_key_account_state()
```

**Purpose**: Verifies that Bedrock API-key auth is invalid for generic OpenAI provider account-state derivation.

**Data flow**: It creates an OpenAI provider with cached `bedrock_api_key_auth()`, calls `account_state()`, and asserts the result is `Err(ProviderAccountError::UnsupportedBedrockApiKeyAuth)`.

**Call relations**: This test covers the explicit Bedrock-auth rejection branch in `ConfiguredModelProvider::account_state`.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_openai_provider, create_model_provider); 2 external calls (assert_eq!, bedrock_api_key_auth).


##### `tests::custom_non_openai_provider_returns_no_account_state`  (lines 549–568)

```
fn custom_non_openai_provider_returns_no_account_state()
```

**Purpose**: Checks that providers not requiring OpenAI auth report no account information.

**Data flow**: It creates a custom provider with `requires_openai_auth: false`, calls `account_state()`, and asserts the result contains `account: None` and `requires_openai_auth: false`.

**Call relations**: This test covers the early-return branch in `ConfiguredModelProvider::account_state` for providers that do not require OpenAI auth.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (default, assert_eq!).


##### `tests::amazon_bedrock_provider_returns_bedrock_account_state`  (lines 571–587)

```
fn amazon_bedrock_provider_returns_bedrock_account_state()
```

**Purpose**: Verifies that Bedrock providers report an Amazon Bedrock account state with AWS-managed credentials by default.

**Data flow**: It creates a Bedrock provider without managed auth, calls `account_state()`, and asserts the result contains `ProviderAccount::AmazonBedrock { credential_source: AwsManaged }` and `requires_openai_auth: false`.

**Call relations**: This test validates factory dispatch to the Bedrock implementation and Bedrock-specific account-state reporting.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::amazon_bedrock_provider_creates_static_models_manager`  (lines 590–615)

```
async fn amazon_bedrock_provider_creates_static_models_manager()
```

**Purpose**: Checks that Bedrock providers use a static models manager with the expected built-in catalog and default model ordering.

**Data flow**: It creates a Bedrock provider, builds its models manager with no configured catalog, fetches the raw catalog and listed presets, collects model slugs, and asserts the catalog contains `openai.gpt-5.5` then `openai.gpt-5.4`, with GPT-5.5 marked as the default preset.

**Call relations**: This test exercises `create_model_provider`, Bedrock `models_manager`, and the static catalog path end-to-end.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 2 external calls (assert_eq!, test_codex_home).


##### `tests::configured_bedrock_catalog_only_allows_default_service_tier`  (lines 618–649)

```
async fn configured_bedrock_catalog_only_allows_default_service_tier()
```

**Purpose**: Verifies that even a caller-supplied Bedrock catalog is normalized to remove explicit service-tier options.

**Data flow**: It loads the bundled GPT-5.5 model, asserts that its original tier fields are non-empty, creates a Bedrock provider, passes a one-model `ModelsResponse` into `models_manager`, fetches the resulting raw catalog, and asserts the returned model keeps slug `gpt-5.5` but has empty `additional_speed_tiers`, empty `service_tiers`, and `default_service_tier: None`.

**Call relations**: This test covers the Bedrock provider's configured-catalog path and the application of `with_default_only_service_tier`.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 5 external calls (assert!, assert_eq!, bundled_models_response, test_codex_home, vec!).


##### `tests::configured_provider_models_manager_uses_provider_bearer_token`  (lines 652–689)

```
async fn configured_provider_models_manager_uses_provider_bearer_token()
```

**Purpose**: Checks that a generic provider's remote models fetch uses the provider-configured bearer token rather than caller auth.

**Data flow**: It starts a mock server, configures it to expect `GET /models` with `Authorization: Bearer provider-token`, builds a provider whose `experimental_bearer_token` is set while the auth manager contains dummy ChatGPT auth, creates the models manager, fetches the raw catalog online, and asserts the returned models include `provider-model`.

**Call relations**: This test exercises the generic provider's remote models-manager path together with `OpenAiModelsEndpoint` and generic auth resolution, proving provider-owned bearer auth takes precedence.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_model_provider); 10 external calls (given, start, new, assert!, provider_for, test_codex_home, vec!, header_regex, method, path).


### Generic provider authentication
Builds the reusable auth primitives and identity-backed token sources used by non-Bedrock model providers.

### `agent-identity/src/lib.rs`

`domain_logic` · `authentication / registration / request signing`

This library concentrates the mechanics for proving agent identity to backend services. It defines lightweight input structs such as `AgentIdentityKey` and `AgentTaskAuthorizationTarget`, output structs like `GeneratedAgentKeyMaterial`, and protocol payload types including `AgentIdentityJwtClaims`, `AgentAssertionEnvelope`, `RegisterTaskRequest`, and `RegisterTaskResponse`.

The signing path uses Ed25519 PKCS#8 private keys stored as base64. `authorization_header_for_agent_task` validates that the stored runtime id matches the target runtime id, timestamps the assertion with RFC3339 seconds precision, signs the `agent_runtime_id:task_id:timestamp` payload, serializes a deterministic JSON envelope via a `BTreeMap`, base64url-encodes it, and prefixes it with `AgentAssertion `. Task registration uses a similar timestamped signature over `agent_runtime_id:timestamp`, posts JSON to the registration endpoint, and accepts either plaintext task ids or encrypted task ids. Encrypted task ids are decrypted by deriving a Curve25519 secret key from the Ed25519 signing key using SHA-512 plus clamping, then calling `crypto_box` unseal.

JWT handling has two modes: if no JWKS is supplied, `decode_agent_identity_jwt` decodes only the payload segment after validating the three-part JWT shape and base64url/JSON syntax; if JWKS is present, it extracts `kid`, finds the trusted JWK, builds an RS256 decoding key, and enforces issuer and audience constants. Utility functions derive verifying keys, SSH public keys, request ids, and endpoint URLs, including a special JWKS path when the base URL contains `/backend-api`.

Tests cover signature correctness, runtime mismatch rejection, JWT claim decoding and verification, plan alias mapping, and URL construction. The file’s main invariants are stable payload formats, strict issuer/audience checks when trust material exists, and consistent derivation from the stored PKCS#8 private key.

#### Function details

##### `authorization_header_for_agent_task`  (lines 106–126)

```
fn authorization_header_for_agent_task(
    key: AgentIdentityKey<'_>,
    target: AgentTaskAuthorizationTarget<'_>,
) -> Result<String>
```

**Purpose**: Builds the `Authorization` header value used to authenticate an agent for a specific task by embedding a signed assertion envelope.

**Data flow**: Takes an `AgentIdentityKey` and `AgentTaskAuthorizationTarget`; first checks the runtime ids match with `ensure!`; generates an RFC3339 UTC timestamp; signs `agent_runtime_id:task_id:timestamp` via `sign_agent_assertion_payload`; constructs an `AgentAssertionEnvelope`; serializes it with `serialize_agent_assertion`; returns `Ok("AgentAssertion <base64url-payload>")` or an error.

**Call relations**: Used by callers preparing authenticated task-scoped requests, and exercised by tests for both success and mismatch failure. It delegates signature creation and deterministic envelope serialization to private helpers.

*Call graph*: calls 2 internal fn (serialize_agent_assertion, sign_agent_assertion_payload); called by 2 (authorization_header_for_agent_task_rejects_mismatched_runtime, authorization_header_for_agent_task_serializes_signed_agent_assertion); 3 external calls (now, ensure!, format!).


##### `fetch_agent_identity_jwks`  (lines 128–145)

```
async fn fetch_agent_identity_jwks(
    client: &reqwest::Client,
    chatgpt_base_url: &str,
) -> Result<JwkSet>
```

**Purpose**: Downloads the trusted JWKS document used to verify agent identity JWTs from the backend.

**Data flow**: Accepts a `reqwest::Client` and base URL, derives the JWKS endpoint with `agent_identity_jwks_url`, performs a GET with a 10-second timeout, converts transport and HTTP status failures into contextual `anyhow` errors, then deserializes the response body as `JwkSet`.

**Call relations**: This is the network-fetch companion to `decode_agent_identity_jwt`. Callers fetch JWKS first, then pass the resulting set into JWT verification.

*Call graph*: calls 1 internal fn (agent_identity_jwks_url); 1 external calls (get).


##### `decode_agent_identity_jwt`  (lines 147–171)

```
fn decode_agent_identity_jwt(
    jwt: &str,
    jwks: Option<&JwkSet>,
) -> Result<AgentIdentityJwtClaims>
```

**Purpose**: Decodes agent identity JWT claims, optionally verifying the token signature and trusted issuer/audience when a JWKS is available.

**Data flow**: Takes a JWT string and optional `&JwkSet`. If `jwks` is `None`, it returns `decode_agent_identity_jwt_payload(jwt)`. Otherwise it decodes the header, extracts `kid`, finds the matching JWK, builds an RS256 `DecodingKey`, configures `Validation` with the fixed audience and issuer constants plus required `iss`/`aud` claims, verifies the token with `jsonwebtoken::decode`, and returns the decoded `AgentIdentityJwtClaims`.

**Call relations**: This is the main JWT entry point, used by tests for raw payload decoding and verified decoding. It branches between an unverified payload-only path and a fully verified JWKS-backed path.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt_payload); called by 4 (decode_agent_identity_jwt_maps_raw_plan_aliases, decode_agent_identity_jwt_reads_claims, decode_agent_identity_jwt_rejects_untrusted_kid, decode_agent_identity_jwt_requires_issuer_and_audience); 3 external calls (from_jwk, new, decode_header).


##### `decode_agent_identity_jwt_payload`  (lines 173–185)

```
fn decode_agent_identity_jwt_payload(jwt: &str) -> Result<T>
```

**Purpose**: Parses the payload segment of a JWT without verifying its signature, for environments where no JWKS trust material is supplied.

**Data flow**: Splits the JWT on `.` into exactly three non-empty parts, rejects malformed shapes with `bail!`/`ensure!`, base64url-decodes the payload segment with `URL_SAFE_NO_PAD`, then deserializes the bytes into generic `T: DeserializeOwned` using `serde_json::from_slice`.

**Call relations**: Called only from `decode_agent_identity_jwt` when verification is intentionally skipped. It isolates the structural and decoding checks for the unverified path.

*Call graph*: called by 1 (decode_agent_identity_jwt); 3 external calls (bail!, ensure!, from_slice).


##### `sign_task_registration_payload`  (lines 187–194)

```
fn sign_task_registration_payload(
    key: AgentIdentityKey<'_>,
    timestamp: &str,
) -> Result<String>
```

**Purpose**: Signs the backend task-registration payload for an agent using its stored Ed25519 private key.

**Data flow**: Receives `AgentIdentityKey` and a timestamp string, reconstructs the `SigningKey` from base64 PKCS#8 via `signing_key_from_private_key_pkcs8_base64`, formats the payload as `agent_runtime_id:timestamp`, signs the bytes, base64-encodes the signature, and returns it.

**Call relations**: Used by `register_agent_task` to populate `RegisterTaskRequest.signature`. It shares the same key-decoding helper used by other signing and derivation functions.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64); called by 1 (register_agent_task); 1 external calls (format!).


##### `register_agent_task`  (lines 196–232)

```
async fn register_agent_task(
    client: &reqwest::Client,
    chatgpt_base_url: &str,
    key: AgentIdentityKey<'_>,
) -> Result<String>
```

**Purpose**: Registers a new task for an agent with the backend and returns the resulting task id, whether plaintext or encrypted.

**Data flow**: Builds a current timestamp, signs it with `sign_task_registration_payload`, constructs `RegisterTaskRequest`, derives the endpoint with `agent_task_registration_url`, POSTs JSON with a 30-second timeout, and on non-success reads and truncates the response body to 512 characters before bailing. On success it deserializes `RegisterTaskResponse` and extracts/decrypts the task id via `task_id_from_register_task_response`.

**Call relations**: This is the main registration workflow, delegating URL construction, signing, and response interpretation to helpers. It is the only function in the file that handles both HTTP transport and encrypted task-id fallback.

*Call graph*: calls 3 internal fn (agent_task_registration_url, sign_task_registration_payload, task_id_from_register_task_response); 4 external calls (now, bail!, post, format!).


##### `task_id_from_register_task_response`  (lines 234–246)

```
fn task_id_from_register_task_response(
    key: AgentIdentityKey<'_>,
    response: RegisterTaskResponse,
) -> Result<String>
```

**Purpose**: Normalizes the backend registration response by accepting either snake_case/camelCase plaintext task ids or encrypted task ids.

**Data flow**: Consumes an `AgentIdentityKey` and `RegisterTaskResponse`. It first checks `task_id` then `task_id_camel`; if either exists it returns that string. Otherwise it checks `encrypted_task_id` then `encrypted_task_id_camel`, errors if absent, and decrypts the chosen ciphertext with `decrypt_task_id_response`.

**Call relations**: Called only by `register_agent_task` after JSON decoding. It encapsulates the response-shape compatibility logic so the registration flow does not care which field naming the server used.

*Call graph*: calls 1 internal fn (decrypt_task_id_response); called by 1 (register_agent_task).


##### `decrypt_task_id_response`  (lines 248–260)

```
fn decrypt_task_id_response(
    key: AgentIdentityKey<'_>,
    encrypted_task_id: &str,
) -> Result<String>
```

**Purpose**: Decrypts an encrypted task id returned by the backend using a Curve25519 key derived from the stored Ed25519 private key.

**Data flow**: Takes `AgentIdentityKey` and a base64 ciphertext string, reconstructs the Ed25519 `SigningKey`, base64-decodes the ciphertext, derives a `Curve25519SecretKey` with `curve25519_secret_key_from_signing_key`, calls `unseal` to decrypt, and converts the plaintext bytes into UTF-8 `String`.

**Call relations**: Used by `task_id_from_register_task_response` when the backend omits plaintext ids. It depends on the shared key-decoding and Ed25519→Curve25519 derivation helpers.

*Call graph*: calls 2 internal fn (curve25519_secret_key_from_signing_key, signing_key_from_private_key_pkcs8_base64); called by 1 (task_id_from_register_task_response); 1 external calls (from_utf8).


##### `generate_agent_key_material`  (lines 262–276)

```
fn generate_agent_key_material() -> Result<GeneratedAgentKeyMaterial>
```

**Purpose**: Generates fresh Ed25519 agent key material and returns both the PKCS#8 private key and SSH-formatted public key.

**Data flow**: Fills a 32-byte array from `OsRng`, constructs a `SigningKey`, encodes it as PKCS#8 DER, base64-encodes the DER bytes, derives the verifying key, converts that to SSH public-key text with `encode_ssh_ed25519_public_key`, and returns `GeneratedAgentKeyMaterial`.

**Call relations**: This is the key-generation entry point for provisioning new agent identities. It delegates only the SSH formatting step; all randomness and PKCS#8 encoding happen here.

*Call graph*: calls 1 internal fn (encode_ssh_ed25519_public_key); 1 external calls (from_bytes).


##### `public_key_ssh_from_private_key_pkcs8_base64`  (lines 278–283)

```
fn public_key_ssh_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<String>
```

**Purpose**: Reconstructs the SSH public key string corresponding to a stored base64 PKCS#8 private key.

**Data flow**: Accepts the base64 PKCS#8 private key string, decodes it into a `SigningKey` with `signing_key_from_private_key_pkcs8_base64`, obtains the verifying key, formats it with `encode_ssh_ed25519_public_key`, and returns the SSH string.

**Call relations**: Used when callers already have persisted private key material and need the matching public key without generating a new pair.

*Call graph*: calls 2 internal fn (encode_ssh_ed25519_public_key, signing_key_from_private_key_pkcs8_base64).


##### `verifying_key_from_private_key_pkcs8_base64`  (lines 285–290)

```
fn verifying_key_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<VerifyingKey>
```

**Purpose**: Extracts the Ed25519 verifying key from stored base64 PKCS#8 private key material.

**Data flow**: Decodes the PKCS#8 base64 string into a `SigningKey` via `signing_key_from_private_key_pkcs8_base64` and returns `signing_key.verifying_key()`.

**Call relations**: This is a small derivation helper for callers that need the typed `VerifyingKey` rather than an SSH string.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64).


##### `curve25519_secret_key_from_private_key_pkcs8_base64`  (lines 292–297)

```
fn curve25519_secret_key_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<Curve25519SecretKey>
```

**Purpose**: Derives the Curve25519 secret key used for sealed-box decryption from stored Ed25519 PKCS#8 private key material.

**Data flow**: Decodes the base64 PKCS#8 private key into a `SigningKey`, passes it to `curve25519_secret_key_from_signing_key`, and returns the resulting `Curve25519SecretKey`.

**Call relations**: This is the public wrapper around the private Ed25519→Curve25519 derivation logic, mirroring the decryption path used internally by `decrypt_task_id_response`.

*Call graph*: calls 2 internal fn (curve25519_secret_key_from_signing_key, signing_key_from_private_key_pkcs8_base64).


##### `agent_registration_url`  (lines 299–302)

```
fn agent_registration_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the backend URL for agent registration from a configurable base URL.

**Data flow**: Trims any trailing slash from `chatgpt_base_url` and formats `<trimmed>/v1/agent/register`.

**Call relations**: A pure URL helper for callers constructing registration requests. It keeps path concatenation consistent with the other endpoint builders in this file.

*Call graph*: 1 external calls (format!).


##### `agent_task_registration_url`  (lines 304–307)

```
fn agent_task_registration_url(chatgpt_base_url: &str, agent_runtime_id: &str) -> String
```

**Purpose**: Builds the backend URL for registering a task under a specific agent runtime id.

**Data flow**: Trims trailing slashes from the base URL and formats `<trimmed>/v1/agent/{agent_runtime_id}/task/register`.

**Call relations**: Called by `register_agent_task` to target the correct per-agent registration endpoint.

*Call graph*: called by 1 (register_agent_task); 1 external calls (format!).


##### `agent_identity_biscuit_url`  (lines 309–312)

```
fn agent_identity_biscuit_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the endpoint URL used for the agent identity biscuit/authentication flow.

**Data flow**: Trims trailing slashes from the base URL and formats `<trimmed>/authenticate_app_v2`.

**Call relations**: This is another pure endpoint helper, grouped with the registration and JWKS URL builders.

*Call graph*: 1 external calls (format!).


##### `agent_identity_jwks_url`  (lines 314–321)

```
fn agent_identity_jwks_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the JWKS endpoint URL, with special handling for ChatGPT `/backend-api` base URLs.

**Data flow**: Trims trailing slashes from the base URL, checks whether the trimmed string contains `/backend-api`, and returns either `<trimmed>/wham/agent-identities/jwks` or `<trimmed>/agent-identities/jwks`.

**Call relations**: Used by `fetch_agent_identity_jwks` and covered by tests for both backend-api and codex-api style base URLs. The conditional path logic is the notable compatibility behavior here.

*Call graph*: called by 1 (fetch_agent_identity_jwks); 1 external calls (format!).


##### `agent_identity_request_id`  (lines 323–332)

```
fn agent_identity_request_id() -> Result<String>
```

**Purpose**: Generates a unique request id string for agent identity operations.

**Data flow**: Fills 16 random bytes from `OsRng`, base64url-encodes them without padding, prefixes them with `codex-agent-identity-`, and returns the resulting string.

**Call relations**: A standalone utility for callers that need a request correlation id in this subsystem.

*Call graph*: 1 external calls (format!).


##### `build_abom`  (lines 334–349)

```
fn build_abom(session_source: SessionSource) -> AgentBillOfMaterials
```

**Purpose**: Constructs an `AgentBillOfMaterials` describing the running agent version, harness identity, and runtime location.

**Data flow**: Takes a `SessionSource`, reads the crate version from `env!("CARGO_PKG_VERSION")`, maps `SessionSource::VSCode` to harness id `codex-app` and all other listed sources to `codex-cli`, formats `running_location` as `<session_source>-<os>`, and returns `AgentBillOfMaterials`.

**Call relations**: This is metadata assembly rather than crypto. It is used when callers need a concise description of the running agent environment.

*Call graph*: 2 external calls (env!, format!).


##### `encode_ssh_ed25519_public_key`  (lines 351–356)

```
fn encode_ssh_ed25519_public_key(verifying_key: &VerifyingKey) -> String
```

**Purpose**: Formats an Ed25519 verifying key into standard OpenSSH `ssh-ed25519 <base64>` text.

**Data flow**: Allocates a blob buffer with capacity for two SSH strings, appends the algorithm name `ssh-ed25519` and the 32-byte public key using `append_ssh_string`, base64-encodes the blob, and prefixes it with `ssh-ed25519 `.

**Call relations**: Called by both key-generation and public-key-derivation helpers. It centralizes the SSH wire-format encoding details.

*Call graph*: calls 1 internal fn (append_ssh_string); called by 2 (generate_agent_key_material, public_key_ssh_from_private_key_pkcs8_base64); 3 external calls (with_capacity, as_bytes, format!).


##### `sign_agent_assertion_payload`  (lines 358–366)

```
fn sign_agent_assertion_payload(
    key: AgentIdentityKey<'_>,
    task_id: &str,
    timestamp: &str,
) -> Result<String>
```

**Purpose**: Signs the payload used inside task authorization assertions.

**Data flow**: Decodes the stored PKCS#8 private key into a `SigningKey`, formats `agent_runtime_id:task_id:timestamp`, signs the bytes, base64-encodes the signature, and returns it.

**Call relations**: Used only by `authorization_header_for_agent_task` as the cryptographic core of the assertion header.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64); called by 1 (authorization_header_for_agent_task); 1 external calls (format!).


##### `serialize_agent_assertion`  (lines 368–377)

```
fn serialize_agent_assertion(envelope: &AgentAssertionEnvelope) -> Result<String>
```

**Purpose**: Serializes an assertion envelope into a deterministic base64url payload suitable for the `AgentAssertion` authorization scheme.

**Data flow**: Takes an `AgentAssertionEnvelope`, constructs a `BTreeMap` with keys `agent_runtime_id`, `signature`, `task_id`, and `timestamp`, serializes that map to JSON bytes with `serde_json::to_vec`, base64url-encodes the bytes without padding, and returns the encoded string.

**Call relations**: Called only by `authorization_header_for_agent_task`. The use of `BTreeMap` ensures stable key ordering in the serialized JSON payload.

*Call graph*: called by 1 (authorization_header_for_agent_task); 2 external calls (from, to_vec).


##### `curve25519_secret_key_from_signing_key`  (lines 379–387)

```
fn curve25519_secret_key_from_signing_key(signing_key: &SigningKey) -> Curve25519SecretKey
```

**Purpose**: Derives a Curve25519 secret key from an Ed25519 signing key using the standard SHA-512-and-clamp transformation.

**Data flow**: Hashes `signing_key.to_bytes()` with SHA-512, copies the first 32 digest bytes into a mutable array, applies Curve25519 clamping to bytes 0 and 31, and returns `Curve25519SecretKey::from(secret_key)`.

**Call relations**: This private helper underpins both public Curve25519 derivation and encrypted task-id decryption. It isolates the exact derivation algorithm from the higher-level workflows.

*Call graph*: called by 2 (curve25519_secret_key_from_private_key_pkcs8_base64, decrypt_task_id_response); 3 external calls (from, digest, to_bytes).


##### `append_ssh_string`  (lines 389–392)

```
fn append_ssh_string(buf: &mut Vec<u8>, value: &[u8])
```

**Purpose**: Appends one SSH binary string field to a buffer using a 4-byte big-endian length prefix followed by raw bytes.

**Data flow**: Mutably borrows a `Vec<u8>` buffer and a byte slice, extends the buffer with the slice length as `u32` big-endian bytes, then extends it with the slice contents.

**Call relations**: Used twice by `encode_ssh_ed25519_public_key` to build the SSH public-key blob.

*Call graph*: called by 1 (encode_ssh_ed25519_public_key).


##### `signing_key_from_private_key_pkcs8_base64`  (lines 394–400)

```
fn signing_key_from_private_key_pkcs8_base64(private_key_pkcs8_base64: &str) -> Result<SigningKey>
```

**Purpose**: Decodes stored base64 PKCS#8 private key material into an Ed25519 `SigningKey` with contextual error messages.

**Data flow**: Base64-decodes the input string with `BASE64_STANDARD`, then parses the resulting DER bytes with `SigningKey::from_pkcs8_der`, returning the `SigningKey` or an `anyhow` error describing invalid base64 or invalid PKCS#8.

**Call relations**: This is the shared key-loading primitive used by all signing, verifying-key derivation, SSH encoding, Curve25519 derivation, and decryption helpers.

*Call graph*: called by 6 (curve25519_secret_key_from_private_key_pkcs8_base64, decrypt_task_id_response, public_key_ssh_from_private_key_pkcs8_base64, sign_agent_assertion_payload, sign_task_registration_payload, verifying_key_from_private_key_pkcs8_base64); 1 external calls (from_pkcs8_der).


##### `tests::authorization_header_for_agent_task_serializes_signed_agent_assertion`  (lines 416–465)

```
fn authorization_header_for_agent_task_serializes_signed_agent_assertion()
```

**Purpose**: Verifies that task authorization headers contain a decodable assertion envelope whose signature validates against the expected payload.

**Data flow**: Creates a deterministic signing key, encodes it as PKCS#8 base64, builds matching key/target inputs, calls `authorization_header_for_agent_task`, strips the scheme prefix, base64url-decodes and deserializes the envelope, asserts its fields, decodes the signature bytes, and verifies the signature over `agent_runtime_id:task_id:timestamp`.

**Call relations**: This test exercises the happy path through header construction, envelope serialization, and signature generation.

*Call graph*: calls 1 internal fn (authorization_header_for_agent_task); 5 external calls (from_slice, from_bytes, assert_eq!, format!, from_slice).


##### `tests::authorization_header_for_agent_task_rejects_mismatched_runtime`  (lines 468–490)

```
fn authorization_header_for_agent_task_rejects_mismatched_runtime()
```

**Purpose**: Checks that authorization header creation fails when the target runtime id does not match the stored key’s runtime id.

**Data flow**: Builds a deterministic key, constructs a mismatched target, calls `authorization_header_for_agent_task`, captures the error, and asserts the exact error string.

**Call relations**: This test covers the early `ensure!` guard in `authorization_header_for_agent_task` before any signing or serialization occurs.

*Call graph*: calls 1 internal fn (authorization_header_for_agent_task); 2 external calls (from_bytes, assert_eq!).


##### `tests::decode_agent_identity_jwt_reads_claims`  (lines 493–526)

```
fn decode_agent_identity_jwt_reads_claims()
```

**Purpose**: Confirms that the payload-only JWT decoding path reads all expected claims into `AgentIdentityJwtClaims`.

**Data flow**: Constructs an unsigned-style JWT string with `jwt_with_payload`, calls `decode_agent_identity_jwt` with `jwks` set to `None`, and asserts the returned claims struct matches the expected values including plan type.

**Call relations**: This test drives the unverified branch of `decode_agent_identity_jwt`, which delegates to `decode_agent_identity_jwt_payload`.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 3 external calls (jwt_with_payload, assert_eq!, json!).


##### `tests::decode_agent_identity_jwt_maps_raw_plan_aliases`  (lines 529–547)

```
fn decode_agent_identity_jwt_maps_raw_plan_aliases()
```

**Purpose**: Verifies that raw plan aliases in JWT payloads deserialize into the normalized `AuthPlanType` representation.

**Data flow**: Builds a JWT payload containing `plan_type: "hc"`, decodes it without JWKS verification, and asserts the resulting `plan_type` is `Known(Enterprise)`.

**Call relations**: This test focuses on serde-level claim decoding behavior inside `AgentIdentityJwtClaims`, reached through `decode_agent_identity_jwt`.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 3 external calls (jwt_with_payload, assert_eq!, json!).


##### `tests::decode_agent_identity_jwt_verifies_when_jwks_is_present`  (lines 550–601)

```
fn decode_agent_identity_jwt_verifies_when_jwks_is_present()
```

**Purpose**: Checks that a JWT signed with the matching RSA key verifies successfully against a trusted JWKS and yields the expected claims.

**Data flow**: Builds a test JWKS and claims, encodes a JWT with a matching `kid` and RSA private key, calls `decode_agent_identity_jwt` with `Some(&jwks)`, and asserts the verified claims equal the expected struct.

**Call relations**: This test exercises the verified branch of `decode_agent_identity_jwt`, including header decoding, `kid` lookup, JWK conversion, and issuer/audience validation.

*Call graph*: 7 external calls (Known, test_jwks, test_jwt_header, test_rsa_encoding_key, assert_eq!, encode, json!).


##### `tests::decode_agent_identity_jwt_rejects_untrusted_kid`  (lines 604–627)

```
fn decode_agent_identity_jwt_rejects_untrusted_kid()
```

**Purpose**: Ensures JWT verification fails when the token header references a `kid` not present in the trusted JWKS.

**Data flow**: Creates a JWKS with a different key id, encodes a JWT with `kid = test-key`, and asserts that `decode_agent_identity_jwt(..., Some(&jwks))` returns an error.

**Call relations**: This test covers the trust-selection failure path in `decode_agent_identity_jwt` before signature verification can proceed.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 5 external calls (test_jwks, test_jwt_header, test_rsa_encoding_key, encode, json!).


##### `tests::decode_agent_identity_jwt_requires_issuer_and_audience`  (lines 630–650)

```
fn decode_agent_identity_jwt_requires_issuer_and_audience()
```

**Purpose**: Verifies that the verified JWT path rejects tokens missing required `iss` and `aud` claims.

**Data flow**: Builds a JWKS and encodes a JWT payload without issuer or audience, then asserts that verified decoding returns an error.

**Call relations**: This test targets the explicit `Validation` configuration in `decode_agent_identity_jwt`, especially the required spec claims set.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 5 external calls (test_jwks, test_jwt_header, test_rsa_encoding_key, encode, json!).


##### `tests::test_jwt_header`  (lines 652–656)

```
fn test_jwt_header(kid: &str) -> Header
```

**Purpose**: Creates a JWT header configured for RS256 with a caller-specified key id for verification tests.

**Data flow**: Constructs `Header::new(Algorithm::RS256)`, sets `header.kid` to the provided string, and returns the header.

**Call relations**: Used by the JWT verification tests to produce tokens whose `kid` can be matched or intentionally mismatched against test JWKS data.

*Call graph*: 1 external calls (new).


##### `tests::test_rsa_encoding_key`  (lines 658–690)

```
fn test_rsa_encoding_key() -> EncodingKey
```

**Purpose**: Parses the embedded PEM RSA private key used to sign JWTs in verification tests.

**Data flow**: Feeds a hardcoded PEM byte string into `EncodingKey::from_rsa_pem` and returns the resulting encoding key.

**Call relations**: Shared by the JWT verification tests that need to produce RS256-signed tokens.

*Call graph*: 1 external calls (from_rsa_pem).


##### `tests::test_jwks`  (lines 692–704)

```
fn test_jwks(kid: &str) -> jsonwebtoken::jwk::JwkSet
```

**Purpose**: Builds a minimal RSA JWKS document with a caller-selected `kid` for verification tests.

**Data flow**: Constructs a JSON value containing one RSA key with the supplied `kid`, modulus `n`, and exponent `e`, deserializes it into `jsonwebtoken::jwk::JwkSet`, and returns it.

**Call relations**: Used by the JWT verification tests to control whether a token’s `kid` is trusted.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::agent_identity_jwks_url_uses_backend_api_base_url`  (lines 707–716)

```
fn agent_identity_jwks_url_uses_backend_api_base_url()
```

**Purpose**: Checks that JWKS URLs under `/backend-api` use the special `/wham/agent-identities/jwks` suffix.

**Data flow**: Calls `agent_identity_jwks_url` with backend-api base URLs with and without trailing slash and asserts the exact resulting strings.

**Call relations**: This test locks down the conditional path branch inside `agent_identity_jwks_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::agent_identity_jwks_url_uses_codex_api_base_url`  (lines 719–728)

```
fn agent_identity_jwks_url_uses_codex_api_base_url()
```

**Purpose**: Checks that non-backend-api base URLs use the plain `/agent-identities/jwks` suffix.

**Data flow**: Calls `agent_identity_jwks_url` with codex-api style base URLs with and without trailing slash and asserts the exact resulting strings.

**Call relations**: This complements the backend-api URL test by covering the default branch of `agent_identity_jwks_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::jwt_with_payload`  (lines 730–736)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Constructs a syntactically valid JWT string with a caller-provided JSON payload and dummy signature for payload-decoding tests.

**Data flow**: Base64url-encodes a fixed `{"alg":"none","typ":"JWT"}` header, serializes and base64url-encodes the provided payload JSON, base64url-encodes the bytes `sig`, and joins the three segments with periods into a JWT string.

**Call relations**: Used by the payload-only JWT tests so they can exercise decoding logic without needing real signature verification.

*Call graph*: 2 external calls (format!, to_vec).


### `login/src/auth/agent_identity.rs`

`domain_logic` · `auth initialization and request header preparation`

This module defines `AgentIdentityAuth`, the runtime representation of agent-identity authentication after the process has registered itself with the auth API. The struct stores the original `AgentIdentityAuthRecord` plus a `process_task_id` returned by `codex_agent_identity::register_agent_task`. The async constructor `load` is the key behavior: it computes the auth API base URL from `CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL` or the production constant, builds a reqwest client via `build_reqwest_client`, derives an `AgentIdentityKey` borrowing the runtime ID and private key from the record, and registers the current process task. Registration failures are converted into `std::io::Error::other`.

The rest of the impl is intentionally accessor-heavy and side-effect free. Methods expose the underlying record, task ID, account ID, ChatGPT user ID, email, plan type, and FedRAMP flag so other auth code can attach headers or inspect account metadata without reaching into storage types directly. The helper `agent_identity_authapi_base_url` trims whitespace and trailing slashes from the environment override and falls back to the production URL when the variable is unset or empty. Tests use a small `EnvVarGuard` RAII helper plus `serial_test` to safely mutate process environment and verify both override and default URL behavior.

#### Function details

##### `AgentIdentityAuth::load`  (lines 20–33)

```
async fn load(record: AgentIdentityAuthRecord) -> std::io::Result<Self>
```

**Purpose**: Creates a runtime `AgentIdentityAuth` by registering the agent task with the auth API using the persisted record's key material.

**Data flow**: Consumes an `AgentIdentityAuthRecord`, computes the auth API base URL, builds a reqwest client, derives an `AgentIdentityKey` borrowing fields from the record, awaits `register_agent_task`, maps any registration error into `std::io::Error::other`, and returns `AgentIdentityAuth { record, process_task_id }`.

**Call relations**: Called when an agent-identity JWT has already been validated and converted into a record; it performs the extra runtime registration step needed before authenticated requests can be made.

*Call graph*: calls 3 internal fn (agent_identity_authapi_base_url, key, build_reqwest_client); called by 1 (from_agent_identity_jwt); 1 external calls (register_agent_task).


##### `AgentIdentityAuth::record`  (lines 35–37)

```
fn record(&self) -> &AgentIdentityAuthRecord
```

**Purpose**: Returns the full underlying persisted agent-identity record.

**Data flow**: Borrows `self.record` and returns `&AgentIdentityAuthRecord` without mutation.

**Call relations**: Downstream header-building code uses this when it needs the complete stored record rather than individual fields.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::process_task_id`  (lines 39–41)

```
fn process_task_id(&self) -> &str
```

**Purpose**: Returns the registered process task identifier assigned by the auth API.

**Data flow**: Borrows `self.process_task_id` and returns it as `&str`.

**Call relations**: Header-building code uses this to attach the runtime task identifier to outgoing requests.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::account_id`  (lines 43–45)

```
fn account_id(&self) -> &str
```

**Purpose**: Returns the ChatGPT account/workspace identifier associated with the agent identity.

**Data flow**: Borrows `self.record.account_id` and returns it as `&str`.

**Call relations**: Used by downstream auth/header logic when account scoping must be attached or checked.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::chatgpt_user_id`  (lines 47–49)

```
fn chatgpt_user_id(&self) -> &str
```

**Purpose**: Returns the ChatGPT user identifier from the stored record.

**Data flow**: Borrows `self.record.chatgpt_user_id` and returns it as `&str`.

**Call relations**: This accessor is available for consumers that need user-level identity metadata.


##### `AgentIdentityAuth::email`  (lines 51–53)

```
fn email(&self) -> &str
```

**Purpose**: Returns the account email address associated with the agent identity.

**Data flow**: Borrows `self.record.email` and returns it as `&str`.

**Call relations**: Exposes email metadata to callers without requiring direct access to the storage record.


##### `AgentIdentityAuth::plan_type`  (lines 55–57)

```
fn plan_type(&self) -> AccountPlanType
```

**Purpose**: Returns the account plan type stored in the agent-identity record.

**Data flow**: Reads `self.record.plan_type` and returns the copied `AccountPlanType` value.

**Call relations**: Used by auth consumers that need to surface or branch on account plan information.


##### `AgentIdentityAuth::is_fedramp_account`  (lines 59–61)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Returns whether the associated ChatGPT account is marked as FedRAMP.

**Data flow**: Reads `self.record.chatgpt_account_is_fedramp` and returns the boolean.

**Call relations**: Header-building code uses this to propagate compliance/account-class metadata.

*Call graph*: called by 1 (add_auth_headers).


##### `agent_identity_authapi_base_url`  (lines 64–70)

```
fn agent_identity_authapi_base_url() -> String
```

**Purpose**: Resolves the base URL for agent-identity auth API calls from environment or production default.

**Data flow**: Reads `CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL` from the environment, trims whitespace and trailing slashes, filters out empty strings, and returns the cleaned override or `PROD_AGENT_IDENTITY_AUTHAPI_BASE_URL` if no usable override exists.

**Call relations**: Called by `AgentIdentityAuth::load` so runtime registration targets the correct auth API endpoint.

*Call graph*: called by 1 (load); 1 external calls (var).


##### `key`  (lines 72–77)

```
fn key(record: &AgentIdentityAuthRecord) -> AgentIdentityKey<'_>
```

**Purpose**: Builds the borrowed `AgentIdentityKey` view required by the registration API from a stored auth record.

**Data flow**: Borrows `agent_runtime_id` and `agent_private_key` from the provided `AgentIdentityAuthRecord` and returns an `AgentIdentityKey<'_>` referencing those fields.

**Call relations**: Used only by `AgentIdentityAuth::load` to adapt storage data to the registration API's expected input type.

*Call graph*: called by 1 (load).


##### `tests::agent_identity_authapi_base_url_prefers_env_value`  (lines 86–95)

```
fn agent_identity_authapi_base_url_prefers_env_value()
```

**Purpose**: Verifies that the environment override is used and normalized by trimming the trailing slash.

**Data flow**: Sets the override env var through `EnvVarGuard::set`, calls `agent_identity_authapi_base_url`, and asserts the returned string equals the trimmed custom URL.

**Call relations**: This test covers the override branch of the base-URL resolver.

*Call graph*: calls 1 internal fn (set); 1 external calls (assert_eq!).


##### `tests::agent_identity_authapi_base_url_uses_prod_authapi_by_default`  (lines 99–105)

```
fn agent_identity_authapi_base_url_uses_prod_authapi_by_default()
```

**Purpose**: Verifies that the production auth API URL is used when no override environment variable is present.

**Data flow**: Removes the override env var through `EnvVarGuard::remove`, calls `agent_identity_authapi_base_url`, and asserts the result equals the production constant.

**Call relations**: This test covers the default branch of the base-URL resolver.

*Call graph*: 2 external calls (remove, assert_eq!).


##### `tests::EnvVarGuard::set`  (lines 113–119)

```
fn set(key: &'static str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its previous value.

**Data flow**: Reads the original value with `env::var_os`, unsafely sets the new value with `env::set_var`, and returns `EnvVarGuard { key, original }`.

**Call relations**: Tests use this RAII helper to isolate environment mutations around base-URL resolution.

*Call graph*: 2 external calls (set_var, var_os).


##### `tests::EnvVarGuard::remove`  (lines 121–127)

```
fn remove(key: &'static str) -> Self
```

**Purpose**: Temporarily removes an environment variable for a test while remembering its previous value.

**Data flow**: Reads the original value with `env::var_os`, unsafely removes the variable with `env::remove_var`, and returns `EnvVarGuard { key, original }`.

**Call relations**: Used by tests that need to force the resolver onto its default path.

*Call graph*: 2 external calls (remove_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 131–138)

```
fn drop(&mut self)
```

**Purpose**: Restores the original environment variable state when the guard goes out of scope.

**Data flow**: On drop, checks `self.original`; if `Some`, unsafely restores it with `env::set_var`, otherwise removes the variable with `env::remove_var`.

**Call relations**: This cleanup logic makes the environment-mutating tests safe to run serially without leaking state.

*Call graph*: 2 external calls (remove_var, set_var).


### `login/src/auth/external_bearer.rs`

`domain_logic` · `request-time external auth resolution and refresh`

This file adapts `ModelProviderAuthInfo` command-based auth into the generic external-auth mechanism used by `AuthManager`. `BearerTokenRefresher` is a thin cloneable wrapper around shared `ExternalBearerAuthState`, which stores the provider config and an async `Mutex<Option<CachedExternalBearerToken>>`. The cache records both the token string and the `Instant` when it was fetched.

The main behavior lives in `resolve` and `refresh`. `resolve` first locks the cache and, if a token exists, decides whether it is still usable based on `config.refresh_interval()`: with no interval configured it reuses indefinitely, otherwise it compares elapsed time against the interval. On a cache miss or stale entry, it intentionally holds the mutex across the provider command execution so concurrent callers do not spawn duplicate refresh commands. `refresh` always reruns the command and overwrites the cache. Both methods wrap the token in `ExternalAuthTokens::access_token_only`, and `auth_mode` reports `AuthMode::ApiKey`, meaning the manager treats the token as a bearer/API-key credential rather than ChatGPT metadata-bearing auth.

`run_provider_auth_command` handles the shell-out details: resolve the executable path relative to `cwd` when needed, run with null stdin and piped stdout/stderr, enforce a timeout, surface startup and non-zero-exit failures with stderr text, require UTF-8 stdout, trim whitespace, and reject empty output. `resolve_provider_auth_program` preserves absolute paths, joins multi-component relative paths against `cwd`, and leaves bare command names for PATH lookup.

#### Function details

##### `BearerTokenRefresher::new`  (lines 23–27)

```
fn new(config: ModelProviderAuthInfo) -> Self
```

**Purpose**: Constructs a new external bearer refresher around a provider-auth command configuration.

**Data flow**: It takes a `ModelProviderAuthInfo`, creates an `ExternalBearerAuthState` with that config and an empty cached token, wraps the state in an `Arc`, and returns a `BearerTokenRefresher` holding it.

**Call relations**: `AuthManager::external_bearer_only` uses this constructor to install command-based external API-key auth into a manager instance.

*Call graph*: calls 1 internal fn (new); called by 1 (external_bearer_only); 1 external calls (new).


##### `BearerTokenRefresher::auth_mode`  (lines 73–75)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Declares that this external provider supplies API-key-style auth.

**Data flow**: It takes `&self` and returns the constant `AuthMode::ApiKey`.

**Call relations**: The `ExternalAuth` machinery consults this to decide whether refreshed tokens should be persisted as ChatGPT auth or simply treated as direct bearer/API-key credentials.


##### `BearerTokenRefresher::resolve`  (lines 77–79)

```
fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Returns a cached bearer token when still fresh, otherwise runs the provider command once and caches the result.

**Data flow**: It locks `self.state.cached_token`, inspects any existing `CachedExternalBearerToken`, and compares `fetched_at.elapsed()` against `self.state.config.refresh_interval()`. If the cached token is still valid, it immediately returns `Ok(Some(ExternalAuthTokens::access_token_only(cloned_token)))`. Otherwise it calls `run_provider_auth_command`, stores a new cached token with `Instant::now()`, and returns the new token wrapped the same way.

**Call relations**: This is the concrete implementation behind the trait-level `resolve` future. `AuthManager::resolve_external_api_key_auth` invokes it when external API-key auth is active and a caller asks for current auth.

*Call graph*: calls 2 internal fn (run_provider_auth_command, access_token_only); 2 external calls (pin, now).


##### `BearerTokenRefresher::refresh`  (lines 81–86)

```
fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Forces a fresh provider-command execution and replaces the cached bearer token regardless of cache age.

**Data flow**: It ignores the supplied `ExternalAuthRefreshContext`, calls `run_provider_auth_command(&self.state.config)`, then locks `cached_token` and overwrites it with the new token plus `Instant::now()`. It returns `ExternalAuthTokens::access_token_only(access_token)`.

**Call relations**: This method backs the trait-level refresh future and is used by unauthorized-recovery flows when the manager wants to retry external bearer auth after a 401.

*Call graph*: calls 2 internal fn (run_provider_auth_command, access_token_only); 2 external calls (pin, now).


##### `BearerTokenRefresher::fmt`  (lines 90–93)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a non-exhaustive debug representation that avoids exposing internal state details.

**Data flow**: It writes a `debug_struct("BearerTokenRefresher")` and finishes it as non-exhaustive without printing the token cache or command configuration.

**Call relations**: This supports diagnostics when the refresher is embedded in larger debug output, while intentionally keeping sensitive or unstable internals out of logs.

*Call graph*: 1 external calls (debug_struct).


##### `ExternalBearerAuthState::new`  (lines 102–107)

```
fn new(config: ModelProviderAuthInfo) -> Self
```

**Purpose**: Initializes the shared state object for command-based bearer auth with an empty cache.

**Data flow**: It takes a `ModelProviderAuthInfo`, stores it in `config`, initializes `cached_token` to `Mutex::new(None)`, and returns the state struct.

**Call relations**: Only `BearerTokenRefresher::new` calls this helper to build the shared state wrapped by `Arc`.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `run_provider_auth_command`  (lines 115–171)

```
async fn run_provider_auth_command(config: &ModelProviderAuthInfo) -> io::Result<String>
```

**Purpose**: Executes the configured provider-auth command, enforces timeout and output validity, and returns the trimmed stdout token string.

**Data flow**: It receives a `ModelProviderAuthInfo`, resolves the executable path with `resolve_provider_auth_program`, builds a `tokio::process::Command` with configured args and cwd, null stdin, piped stdout/stderr, and `kill_on_drop(true)`, then awaits `command.output()` under `tokio::time::timeout(config.timeout(), ...)`. It maps timeout, startup failure, non-success exit status, non-UTF-8 stdout, and empty trimmed stdout into `io::Error::other(...)`; on success it returns the non-empty trimmed stdout token.

**Call relations**: Both `BearerTokenRefresher::resolve` and `BearerTokenRefresher::refresh` delegate token acquisition to this function so all command execution, timeout, and error formatting logic stays in one place.

*Call graph*: calls 1 internal fn (resolve_provider_auth_program); called by 2 (refresh, resolve); 10 external calls (null, piped, from_utf8, from_utf8_lossy, new, new, other, timeout, format!, timeout).


##### `resolve_provider_auth_program`  (lines 173–184)

```
fn resolve_provider_auth_program(command: &str, cwd: &Path) -> io::Result<PathBuf>
```

**Purpose**: Determines how to interpret the configured command string as an executable path.

**Data flow**: It takes the raw `command` string and a working directory `cwd`. If `command` parses as an absolute path, it returns that path unchanged. If it has more than one path component, it joins it against `cwd`. Otherwise it returns `PathBuf::from(command)` so bare command names can be resolved via PATH by the process launcher.

**Call relations**: `run_provider_auth_command` calls this before spawning the process, ensuring relative script paths are anchored to the configured working directory while preserving PATH-based commands.

*Call graph*: called by 1 (run_provider_auth_command); 3 external calls (join, new, from).


### `model-provider/src/bearer_auth_provider.rs`

`util` · `per-request header construction`

This file contains the small `BearerAuthProvider` data type and its `AuthProvider` implementation. The struct stores three pieces of request-auth state: an optional bearer token, an optional `ChatGPT-Account-ID`, and a boolean indicating whether the account should be routed through FedRAMP infrastructure. `new` is the production constructor and initializes only the token, leaving account ID absent and FedRAMP disabled. `for_test` is a convenience constructor that accepts borrowed string options and materializes owned values for tests.

The core behavior lives in `add_auth_headers`. It conditionally inserts `Authorization: Bearer <token>` when `token` is present and can be converted into a valid `HeaderValue`. It separately inserts `ChatGPT-Account-ID` when `account_id` is present and valid, and adds `X-OpenAI-Fedramp: true` when `is_fedramp_account` is set. Like the agent-identity provider, invalid header values are ignored rather than causing an error, so auth attachment is best-effort at the header-construction layer. Tests verify both telemetry-visible behavior—whether an authorization header would be attached—and concrete header insertion for bearer token, account ID, and FedRAMP routing.

#### Function details

##### `BearerAuthProvider::new`  (lines 14–20)

```
fn new(token: String) -> Self
```

**Purpose**: Creates a bearer auth provider from a token string for normal runtime use.

**Data flow**: It takes an owned token `String` and returns `BearerAuthProvider { token: Some(token), account_id: None, is_fedramp_account: false }`.

**Call relations**: This constructor is used when provider configuration supplies an API key or explicit bearer token, via `bearer_auth_for_provider`.

*Call graph*: called by 1 (bearer_auth_for_provider).


##### `BearerAuthProvider::for_test`  (lines 22–28)

```
fn for_test(token: Option<&str>, account_id: Option<&str>) -> Self
```

**Purpose**: Builds a bearer auth provider from optional borrowed token and account ID values for tests.

**Data flow**: It accepts `Option<&str>` for token and account ID, maps each to owned `String` values when present, sets `is_fedramp_account` to `false`, and returns the resulting struct.

**Call relations**: This helper is used by tests that need a compact way to create a provider with or without token/account headers.

*Call graph*: called by 2 (auth_request_telemetry_context_tracks_attached_auth_and_retry_phase, bearer_auth_provider_adds_auth_headers).


##### `BearerAuthProvider::add_auth_headers`  (lines 32–46)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Attaches bearer-token auth and related routing headers to an outgoing request.

**Data flow**: It reads `self.token`, `self.account_id`, and `self.is_fedramp_account`. If a token exists and `HeaderValue::from_str("Bearer {token}")` succeeds, it inserts `Authorization`. If an account ID exists and parses, it inserts `ChatGPT-Account-ID`. If the FedRAMP flag is true, it inserts `X-OpenAI-Fedramp: true`.

**Call relations**: This method is called by HTTP request code through the `AuthProvider` trait whenever a request resolves to bearer-style auth.

*Call graph*: 4 external calls (insert, from_static, from_str, format!).


##### `tests::bearer_auth_provider_reports_when_auth_header_will_attach`  (lines 55–69)

```
fn bearer_auth_provider_reports_when_auth_header_will_attach()
```

**Purpose**: Verifies that telemetry sees an authorization header as attached when the provider has a token.

**Data flow**: It constructs a `BearerAuthProvider` with a token, passes it to `codex_api::auth_header_telemetry`, and asserts the returned telemetry reports `attached: true` and `name: Some("authorization")`.

**Call relations**: This test validates the observable behavior of the provider as consumed by telemetry helpers, not just raw header insertion.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::bearer_auth_provider_adds_auth_headers`  (lines 72–90)

```
fn bearer_auth_provider_adds_auth_headers()
```

**Purpose**: Checks that bearer token and account ID are inserted into the expected HTTP headers.

**Data flow**: It creates a provider with `for_test(Some("access-token"), Some("workspace-123"))`, applies `add_auth_headers` to a fresh `HeaderMap`, and asserts the resulting `Authorization` and `ChatGPT-Account-ID` values match the expected strings.

**Call relations**: This test exercises the main happy path of `add_auth_headers`.

*Call graph*: calls 1 internal fn (for_test); 2 external calls (new, assert_eq!).


##### `tests::bearer_auth_provider_adds_fedramp_routing_header_for_fedramp_accounts`  (lines 93–109)

```
fn bearer_auth_provider_adds_fedramp_routing_header_for_fedramp_accounts()
```

**Purpose**: Verifies that FedRAMP accounts receive the extra routing header.

**Data flow**: It constructs a `BearerAuthProvider` with token, account ID, and `is_fedramp_account: true`, applies `add_auth_headers`, and asserts the `X-OpenAI-Fedramp` header is present with value `true`.

**Call relations**: This test covers the conditional FedRAMP branch in `add_auth_headers`.

*Call graph*: 2 external calls (new, assert_eq!).


### `model-provider/src/auth.rs`

`domain_logic` · `request auth resolution and provider initialization`

This file is the central auth adapter for non-Bedrock providers. It defines two concrete `AuthProvider` implementations. `AgentIdentityAuthProvider` turns a `codex_login::auth::AgentIdentityAuth` snapshot into request headers by deriving an authorization header with `authorization_header_for_agent_task`, adding `ChatGPT-Account-ID`, and conditionally adding `X-OpenAI-Fedramp: true`. Header insertion is intentionally best-effort: invalid generated values are silently skipped rather than failing the request setup path. `UnauthenticatedAuthProvider` is the opposite extreme and writes nothing at all.

The exported helpers decide which auth path to use. `auth_manager_for_provider` swaps in an external-bearer-only `AuthManager` when the provider config contains command-backed auth; otherwise it preserves the caller-supplied manager. `resolve_provider_auth` then applies precedence rules for actual request headers: Bedrock API-key auth is rejected here with `UnsupportedOperation`, provider-owned credentials from `provider.api_key()` or `experimental_bearer_token` override any caller auth, and only if neither is present does it fall back to converting the supplied `CodexAuth` via `auth_provider_from_auth`. That conversion maps agent identity to the custom provider above and all token-like first-party auth variants to `BearerAuthProvider`, carrying token, account ID, and FedRAMP routing state. Tests cover the unauthenticated path and the explicit rejection of Bedrock API-key auth for ordinary providers.

#### Function details

##### `AgentIdentityAuthProvider::add_auth_headers`  (lines 26–53)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds agent-identity request headers derived from the stored auth snapshot. It signs an agent-task authorization target, attaches account routing metadata, and marks FedRAMP accounts when applicable.

**Data flow**: It reads the embedded `AgentIdentityAuth`, extracts its record, builds `AgentIdentityKey` and `AgentTaskAuthorizationTarget`, and calls `authorization_header_for_agent_task`. If that succeeds and parses as an HTTP header value, it inserts `Authorization`. It separately inserts `ChatGPT-Account-ID` from `account_id()` when valid, and inserts `X-OpenAI-Fedramp: true` when `is_fedramp_account()` is true.

**Call relations**: This method is invoked by HTTP request code through the `AuthProvider` trait whenever a provider resolves to agent-identity auth. It does not call other local helpers; its work is the terminal header-construction step.

*Call graph*: calls 4 internal fn (account_id, is_fedramp_account, process_task_id, record); 4 external calls (insert, from_static, from_str, authorization_header_for_agent_task).


##### `UnauthenticatedAuthProvider::add_auth_headers`  (lines 62–62)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements a no-op auth provider for providers that should send no auth headers.

**Data flow**: It accepts a mutable `HeaderMap` and leaves it unchanged.

**Call relations**: This is used when `resolve_provider_auth` determines that neither provider-owned credentials nor caller auth should be attached.


##### `unauthenticated_auth_provider`  (lines 65–67)

```
fn unauthenticated_auth_provider() -> SharedAuthProvider
```

**Purpose**: Constructs the shared no-auth provider instance used by unauthenticated providers.

**Data flow**: It allocates `UnauthenticatedAuthProvider` inside an `Arc` and returns it as `SharedAuthProvider`.

**Call relations**: This helper is called by `resolve_provider_auth` on the final fallback path when no other auth source applies.

*Call graph*: called by 1 (resolve_provider_auth); 1 external calls (new).


##### `auth_manager_for_provider`  (lines 72–80)

```
fn auth_manager_for_provider(
    auth_manager: Option<Arc<AuthManager>>,
    provider: &ModelProviderInfo,
) -> Option<Arc<AuthManager>>
```

**Purpose**: Chooses the auth manager that should be associated with a provider at runtime. Providers with command-backed auth get a provider-scoped external bearer manager instead of reusing the caller's base manager.

**Data flow**: It takes an optional existing `Arc<AuthManager>` and a `ModelProviderInfo`. If `provider.auth` is `Some`, it clones that config into `AuthManager::external_bearer_only(config)` and returns the new manager; otherwise it returns the original `auth_manager` unchanged.

**Call relations**: This function is used during generic provider construction so command-auth providers can refresh their own bearer tokens independently of any global auth manager.

*Call graph*: calls 1 internal fn (external_bearer_only); called by 1 (new).


##### `resolve_provider_auth`  (lines 82–100)

```
fn resolve_provider_auth(
    auth: Option<&CodexAuth>,
    provider: &ModelProviderInfo,
) -> codex_protocol::error::Result<SharedAuthProvider>
```

**Purpose**: Resolves the concrete request-header auth provider for a non-Bedrock model provider, applying provider-owned credentials first and rejecting misplaced Bedrock auth.

**Data flow**: It accepts an optional `CodexAuth` reference and a `ModelProviderInfo`. If the auth is `CodexAuth::BedrockApiKey`, it returns `Err(CodexErr::UnsupportedOperation(...))`. Otherwise it asks `bearer_auth_for_provider(provider)` for provider-owned bearer credentials; if present, it wraps and returns them. If not, it converts the supplied auth with `auth_provider_from_auth`, or falls back to `unauthenticated_auth_provider()` when no auth exists.

**Call relations**: This is the main auth-resolution entry point used by generic provider request setup and models-endpoint fetching. It delegates to `bearer_auth_for_provider` for provider-configured secrets, `auth_provider_from_auth` for first-party auth snapshots, and `unauthenticated_auth_provider` as the terminal fallback.

*Call graph*: calls 3 internal fn (auth_provider_from_auth, bearer_auth_for_provider, unauthenticated_auth_provider); called by 2 (openai_provider_rejects_bedrock_api_key_auth, unauthenticated_auth_provider_adds_no_headers); 3 external calls (new, matches!, UnsupportedOperation).


##### `bearer_auth_for_provider`  (lines 102–114)

```
fn bearer_auth_for_provider(
    provider: &ModelProviderInfo,
) -> codex_protocol::error::Result<Option<BearerAuthProvider>>
```

**Purpose**: Extracts provider-owned bearer credentials from provider configuration. It supports both standard provider API keys and an experimental explicit bearer token field.

**Data flow**: It reads `provider.api_key()?`; if present, it returns `Some(BearerAuthProvider::new(api_key))`. Otherwise it checks `provider.experimental_bearer_token.clone()` and returns a bearer provider for that token if present. If neither exists, it returns `Ok(None)`.

**Call relations**: This helper is called only by `resolve_provider_auth` and implements the precedence rule that provider-configured credentials override caller auth.

*Call graph*: calls 2 internal fn (api_key, new); called by 1 (resolve_provider_auth).


##### `auth_provider_from_auth`  (lines 117–132)

```
fn auth_provider_from_auth(auth: &CodexAuth) -> SharedAuthProvider
```

**Purpose**: Converts a first-party `CodexAuth` snapshot into a concrete `SharedAuthProvider` implementation suitable for request headers.

**Data flow**: It pattern-matches the input auth. `AgentIdentity` becomes `Arc<AgentIdentityAuthProvider { auth: clone }}`. `BedrockApiKey` is marked unreachable because callers should have rejected it earlier. `ApiKey`, `Chatgpt`, `ChatgptAuthTokens`, and `PersonalAccessToken` become `Arc<BearerAuthProvider>` populated from `get_token().ok()`, `get_account_id()`, and `is_fedramp_account()`.

**Call relations**: This function is the fallback conversion path inside `resolve_provider_auth` after provider-owned credentials have been ruled out.

*Call graph*: calls 3 internal fn (get_account_id, get_token, is_fedramp_account); called by 1 (resolve_provider_auth); 3 external calls (new, clone, unreachable!).


##### `tests::unauthenticated_auth_provider_adds_no_headers`  (lines 144–150)

```
fn unauthenticated_auth_provider_adds_no_headers()
```

**Purpose**: Verifies that a provider with no auth requirements resolves to an auth provider that leaves headers empty.

**Data flow**: It creates an OSS provider with a localhost base URL, calls `resolve_provider_auth(None, &provider)`, converts the result to headers, and asserts the header map is empty.

**Call relations**: This test covers the final fallback branch in `resolve_provider_auth`, including construction of `UnauthenticatedAuthProvider`.

*Call graph*: calls 1 internal fn (resolve_provider_auth); 2 external calls (assert!, create_oss_provider_with_base_url).


##### `tests::openai_provider_rejects_bedrock_api_key_auth`  (lines 153–167)

```
fn openai_provider_rejects_bedrock_api_key_auth()
```

**Purpose**: Checks that Bedrock API-key auth cannot be used with an ordinary OpenAI provider.

**Data flow**: It creates an OpenAI provider and a `CodexAuth::BedrockApiKey`, calls `resolve_provider_auth(Some(&auth), &provider)`, matches the result, and asserts the error is `CodexErr::UnsupportedOperation` with the exact unsupported-message constant.

**Call relations**: This test validates the early rejection guard at the top of `resolve_provider_auth`.

*Call graph*: calls 2 internal fn (create_openai_provider, resolve_provider_auth); 3 external calls (assert_eq!, BedrockApiKey, panic!).


### Bedrock and AWS signing
Implements Bedrock-specific endpoint resolution and auth selection on top of AWS config loading and SigV4 request signing.

### `aws-auth/src/config.rs`

`config` · `config load`

This file contains the AWS SDK integration layer used by `AwsAuthContext::load`. `load_sdk_config` validates one critical invariant up front: `AwsAuthConfig.service` must not be blank after trimming. It then starts from `aws_config::defaults(BehaviorVersion::latest())` and conditionally applies the configured profile name and region override before asynchronously loading the final `SdkConfig`.

The other two helpers turn optional SDK outputs into explicit crate-level errors. `credentials_provider` extracts the SDK’s resolved credentials provider and fails with `AwsAuthError::MissingCredentialsProvider` if the SDK did not produce one. `resolved_region` similarly converts the SDK’s optional region into an owned `String`, failing with `AwsAuthError::MissingRegion` when absent.

The design keeps AWS-specific loading concerns isolated from signing logic. It also means `AwsAuthContext::load` receives already-validated, concrete pieces: a `SharedCredentialsProvider`, a resolved region string, and the trimmed service name. That separation makes retryability and signing errors easier to reason about later, because configuration resolution failures are surfaced early and with dedicated error variants.

#### Function details

##### `load_sdk_config`  (lines 9–23)

```
async fn load_sdk_config(config: &AwsAuthConfig) -> Result<SdkConfig, AwsAuthError>
```

**Purpose**: Builds and asynchronously loads an AWS `SdkConfig` from `AwsAuthConfig`, applying optional profile and region overrides. It rejects empty or whitespace-only service names before touching the SDK.

**Data flow**: Reads `config.service`, `config.profile`, and `config.region`. If the trimmed service is empty it returns `AwsAuthError::EmptyService`; otherwise it creates an AWS config loader with latest behavior version, conditionally sets profile and region, awaits `load()`, and returns the resulting `SdkConfig`.

**Call relations**: It is called by `AwsAuthContext::load` as the first step in constructing a signing context.

*Call graph*: called by 1 (load); 3 external calls (latest, new, defaults).


##### `credentials_provider`  (lines 25–31)

```
fn credentials_provider(
    sdk_config: &SdkConfig,
) -> Result<SharedCredentialsProvider, AwsAuthError>
```

**Purpose**: Extracts the resolved credentials provider from an AWS `SdkConfig`. It converts the SDK’s optional provider into a required value for this crate.

**Data flow**: Borrows `sdk_config`, calls `credentials_provider()`, and returns the `SharedCredentialsProvider` on success or `AwsAuthError::MissingCredentialsProvider` if absent.

**Call relations**: It is called by `AwsAuthContext::load` after SDK config loading succeeds.

*Call graph*: called by 1 (load); 1 external calls (credentials_provider).


##### `resolved_region`  (lines 33–38)

```
fn resolved_region(sdk_config: &SdkConfig) -> Result<String, AwsAuthError>
```

**Purpose**: Extracts the resolved AWS region from an AWS `SdkConfig` as an owned string. It treats missing region resolution as a hard configuration error.

**Data flow**: Borrows `sdk_config`, calls `region()`, converts the region to `String` with `ToString`, and returns it or `AwsAuthError::MissingRegion` if no region is present.

**Call relations**: It is called by `AwsAuthContext::load` alongside `credentials_provider` to finalize the auth context.

*Call graph*: called by 1 (load); 1 external calls (region).


### `aws-auth/src/signing.rs`

`domain_logic` · `request signing`

This file converts `AwsRequestToSign` into the AWS SigV4 library’s expected structures and then applies the resulting signing instructions back onto an `http::Request`. The main function, `sign_request`, first walks the incoming `HeaderMap` and converts each header value to UTF-8 text, failing with `AwsAuthError::InvalidHeaderValue` if any header cannot be represented as a string. Those headers, along with the method, URL, and raw body bytes, are used to build an `aws_sigv4::http_request::SignableRequest`.

It then clones the provided `Credentials` into an identity, builds `v4::SigningParams` with region, service name, explicit signing time, and default signing settings, and calls `aws_sigv4::http_request::sign`. Any failure in request construction, signing parameter construction, or signing itself is mapped into a distinct `AwsAuthError` variant.

After signing, the function reparses the URL into an `http::Uri`, constructs an empty-body `http::Request<()>`, restores the original headers, and applies the signing instructions in HTTP/1.x form. The returned `AwsSignedRequest` contains the final URL string and cloned signed headers. The test-only `header_value` helper extracts UTF-8 header values from a `HeaderMap` for assertions.

#### Function details

##### `sign_request`  (lines 17–68)

```
fn sign_request(
    credentials: &Credentials,
    region: &str,
    service: &str,
    request: AwsRequestToSign,
    time: SystemTime,
) -> Result<AwsSignedRequest, AwsAuthError>
```

**Purpose**: Builds a signable AWS request, computes SigV4 headers for the given credentials/region/service/time, and returns the signed URL and headers. It is the concrete implementation behind `AwsAuthContext::sign_at`.

**Data flow**: Consumes borrowed `Credentials`, borrowed region and service strings, an `AwsRequestToSign`, and a `SystemTime`. It converts request headers into `(name, utf8_value)` pairs, builds a `SignableRequest`, clones credentials into an identity, builds signing params, signs the request, reparses the URL into `Uri`, constructs an `http::Request<()>`, restores original headers, applies signing instructions, and returns `AwsSignedRequest { url, headers }`. Errors are mapped into `AwsAuthError` variants at each conversion/signing step.

**Call relations**: It is called only from `AwsAuthContext::sign_at`, which supplies resolved credentials and signer configuration.

*Call graph*: called by 1 (sign_at); 8 external calls (clone, Bytes, new, default, from_str, sign, builder, builder).


##### `header_value`  (lines 71–76)

```
fn header_value(headers: &http::HeaderMap, name: &str) -> Option<String>
```

**Purpose**: Extracts a named header as a UTF-8 `String` for tests. It is a convenience helper for asserting on signed header contents.

**Data flow**: Borrows a `HeaderMap` and header name, looks up the header, converts it to `&str` if valid UTF-8, clones it into `String`, and returns `Option<String>`.

**Call relations**: It is used only by tests in `aws-auth/src/lib.rs` to inspect signing output.

*Call graph*: 1 external calls (get).


### `aws-auth/src/lib.rs`

`domain_logic` · `request signing`

This file exposes the types consumers use to configure and perform AWS SigV4 signing. `AwsAuthConfig` carries optional profile and region plus the required service name. `AwsRequestToSign` is a generic HTTP request shape with `Method`, URL string, `HeaderMap`, and raw `Bytes` body; `AwsSignedRequest` returns the signed URL and headers. `AwsAuthError` enumerates configuration, credential, URI/header conversion, and signing failures with precise variants.

`AwsAuthContext` is the loaded signer state: a `SharedCredentialsProvider`, resolved region string, and trimmed service string. Its custom `Debug` implementation intentionally omits credentials and prints only non-sensitive fields. `load` delegates SDK resolution to the `config` module, then stores the provider and resolved region while normalizing the service name with `trim()`. `sign` is the public convenience method that signs at `SystemTime::now()`, while `sign_at` exists for deterministic testing and delegates the actual SigV4 transformation to `signing::sign_request` after asynchronously fetching credentials.

The file also defines retry semantics through `AwsAuthError::is_retryable`. Only transient credential-provider failures (`ProviderTimedOut` and `ProviderError`) are considered retryable; malformed input, missing config, and deterministic signing/build failures are not. Tests verify header preservation, session-token propagation, empty-service rejection, and the retryability classification.

#### Function details

##### `AwsAuthContext::fmt`  (lines 71–76)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `AwsAuthContext` for debugging without exposing credential material. It shows only region and service and marks the struct as non-exhaustive.

**Data flow**: Reads `self.region` and `self.service`, writes them into a `DebugStruct`, omits `credentials_provider`, and returns the formatter result.

**Call relations**: This is Rust trait plumbing used whenever the context is debug-printed; it supports safe observability around the signer state.

*Call graph*: 1 external calls (debug_struct).


##### `AwsAuthContext::load`  (lines 80–90)

```
async fn load(config: AwsAuthConfig) -> Result<Self, AwsAuthError>
```

**Purpose**: Resolves AWS SDK configuration into a reusable signing context. It validates config indirectly through the config helpers and stores the normalized service name.

**Data flow**: Consumes an `AwsAuthConfig`, awaits `config::load_sdk_config(&config)`, extracts a `SharedCredentialsProvider` and region string via `config::credentials_provider` and `config::resolved_region`, trims `config.service`, and returns a populated `AwsAuthContext`.

**Call relations**: It is called by higher-level auth resolution code and by a test that verifies empty service names are rejected. It delegates all SDK loading details to `aws-auth/src/config.rs`.

*Call graph*: calls 3 internal fn (credentials_provider, load_sdk_config, resolved_region); called by 2 (load_rejects_empty_service_name, resolve_auth_method).


##### `AwsAuthContext::region`  (lines 92–94)

```
fn region(&self) -> &str
```

**Purpose**: Returns the resolved AWS region stored in the auth context. It is a simple accessor for callers that need to inspect signer configuration.

**Data flow**: Borrows `self` and returns `&self.region`.

**Call relations**: This is a leaf accessor used by consumers of the loaded context.


##### `AwsAuthContext::service`  (lines 96–98)

```
fn service(&self) -> &str
```

**Purpose**: Returns the normalized AWS service name stored in the auth context. It exposes the service used for SigV4 scope construction.

**Data flow**: Borrows `self` and returns `&self.service`.

**Call relations**: This is a leaf accessor used by consumers of the loaded context.


##### `AwsAuthContext::sign`  (lines 100–102)

```
async fn sign(&self, request: AwsRequestToSign) -> Result<AwsSignedRequest, AwsAuthError>
```

**Purpose**: Signs a request using the current wall-clock time. It is the public convenience API for normal request signing.

**Data flow**: Consumes an `AwsRequestToSign`, reads the current `SystemTime::now()`, forwards both to `self.sign_at`, and returns the resulting `AwsSignedRequest` or `AwsAuthError`.

**Call relations**: It is invoked by higher-level outbound auth application code. Internally it delegates all real work to `AwsAuthContext::sign_at`.

*Call graph*: calls 1 internal fn (sign_at); called by 1 (apply_auth); 1 external calls (now).


##### `AwsAuthContext::sign_at`  (lines 104–111)

```
async fn sign_at(
        &self,
        request: AwsRequestToSign,
        time: SystemTime,
    ) -> Result<AwsSignedRequest, AwsAuthError>
```

**Purpose**: Signs a request at an explicit timestamp, mainly to support deterministic tests. It first resolves credentials, then performs SigV4 signing with the stored region and service.

**Data flow**: Consumes an `AwsRequestToSign` and a `SystemTime`, awaits `self.credentials_provider.provide_credentials()`, then passes the credentials, `self.region`, `self.service`, request, and time into `signing::sign_request`; returns the signed request or any propagated auth/signing error.

**Call relations**: It is called by `AwsAuthContext::sign` in production and directly by tests that need stable timestamps. It delegates the HTTP/SigV4 transformation to `aws-auth/src/signing.rs`.

*Call graph*: calls 1 internal fn (sign_request); called by 1 (sign); 1 external calls (provide_credentials).


##### `AwsAuthError::is_retryable`  (lines 116–133)

```
fn is_retryable(&self) -> bool
```

**Purpose**: Classifies auth errors by whether retrying the outbound request could plausibly succeed. Only transient credential-provider failures are treated as retryable.

**Data flow**: Borrows `self`, pattern-matches on the error variant, and returns `true` only for `AwsAuthError::Credentials` wrapping `ProviderTimedOut` or `ProviderError`; all other variants return `false`.

**Call relations**: It is consumed by higher-level error translation logic to decide retry behavior. Tests in this file cover both retryable and non-retryable cases.

*Call graph*: called by 1 (aws_auth_error_to_auth_error); 1 external calls (matches!).


##### `tests::test_context`  (lines 147–159)

```
fn test_context(session_token: Option<&str>) -> AwsAuthContext
```

**Purpose**: Builds a deterministic `AwsAuthContext` backed by static test credentials. It optionally includes a session token to exercise token propagation.

**Data flow**: Takes an optional session-token string, constructs `Credentials`, wraps them in `SharedCredentialsProvider`, fills fixed region and service strings, and returns the resulting `AwsAuthContext`.

**Call relations**: It is a shared fixture for signing tests in this file.

*Call graph*: 2 external calls (new, new).


##### `tests::test_request`  (lines 161–174)

```
fn test_request() -> AwsRequestToSign
```

**Purpose**: Builds a representative Bedrock HTTP request with headers and JSON body for signing tests. It provides stable input for verifying header preservation and SigV4 additions.

**Data flow**: Creates a `HeaderMap`, inserts `content-type` and `x-test-header`, constructs an `AwsRequestToSign` with POST method, fixed URL, those headers, and a static JSON `Bytes` body, and returns it.

**Call relations**: It is used by the signing tests that call `sign_at`.

*Call graph*: 3 external calls (from_static, new, from_static).


##### `tests::sign_adds_sigv4_headers_and_preserves_existing_headers`  (lines 177–203)

```
async fn sign_adds_sigv4_headers_and_preserves_existing_headers()
```

**Purpose**: Verifies that signing adds SigV4 metadata while leaving original headers and URL intact. It checks both preservation and augmentation behavior.

**Data flow**: Creates a test context without session token, signs a fixed request at a fixed UNIX timestamp, then asserts that original headers remain, the URL is unchanged, and `authorization` plus `x-amz-date` headers were added.

**Call relations**: It directly exercises `AwsAuthContext::sign_at` and indirectly `signing::sign_request`.

*Call graph*: 5 external calls (from_secs, assert!, assert_eq!, test_context, test_request).


##### `tests::credentials_provider_failures_are_retryable`  (lines 206–215)

```
fn credentials_provider_failures_are_retryable()
```

**Purpose**: Verifies that transient credential-provider failures are classified as retryable. This documents the intended retry policy boundary.

**Data flow**: Constructs `AwsAuthError::Credentials` values for provider error and provider timeout cases, calls `is_retryable`, and asserts both return true.

**Call relations**: It targets the positive branches of `AwsAuthError::is_retryable`.

*Call graph*: 1 external calls (assert!).


##### `tests::deterministic_aws_auth_errors_are_not_retryable`  (lines 218–231)

```
fn deterministic_aws_auth_errors_are_not_retryable()
```

**Purpose**: Verifies that deterministic configuration and credential failures are not marked retryable. This prevents pointless retries on malformed or absent configuration.

**Data flow**: Constructs several non-transient `AwsAuthError` values, including empty service and multiple credential error kinds, calls `is_retryable`, and asserts each returns false.

**Call relations**: It targets the negative branches of `AwsAuthError::is_retryable`.

*Call graph*: 1 external calls (assert!).


##### `tests::sign_includes_session_token_when_credentials_have_one`  (lines 234–247)

```
async fn sign_includes_session_token_when_credentials_have_one()
```

**Purpose**: Verifies that temporary-session credentials produce the `x-amz-security-token` header during signing. This is required for AWS session-based auth to work.

**Data flow**: Creates a test context with a session token, signs the fixed request at a fixed timestamp, and asserts the signed headers contain the expected security token value.

**Call relations**: It exercises `AwsAuthContext::sign_at` with credential state that changes the signing output.

*Call graph*: 4 external calls (from_secs, assert_eq!, test_context, test_request).


##### `tests::load_rejects_empty_service_name`  (lines 250–260)

```
async fn load_rejects_empty_service_name()
```

**Purpose**: Verifies that loading an auth context fails when the configured service name is blank after trimming. This protects later signing code from invalid SigV4 scope input.

**Data flow**: Calls `AwsAuthContext::load` with `service` set to whitespace and no profile/region overrides, awaits the error, and asserts the rendered message matches the `EmptyService` variant.

**Call relations**: It exercises the validation path reached through `config::load_sdk_config` from `AwsAuthContext::load`.

*Call graph*: calls 1 internal fn (load); 1 external calls (assert_eq!).


### `model-provider/src/amazon_bedrock/auth.rs`

`domain_logic` · `provider auth resolution and per-request signing for Amazon Bedrock`

This module encapsulates all Bedrock auth branching. `BedrockAuthMethod` is the internal enum describing the three supported modes: a managed bearer token supplied by login state, a bearer token from `AWS_BEARER_TOKEN_BEDROCK`, or full AWS SDK auth via `AwsAuthContext`. `resolve_auth_method` chooses among them in priority order: managed auth wins first, then a non-empty env bearer token, and finally SDK-based auth loaded from `aws_auth_config(aws)`. When bearer-token auth is selected, `bearer_token_region` resolves the required region from `model_providers.amazon-bedrock.aws.region`, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, trimming whitespace and failing with a fatal `CodexErr` if none are set. `resolve_provider_auth` turns the chosen method into a `SharedAuthProvider`, either a simple `BearerAuthProvider` or a `BedrockMantleSigV4AuthProvider` wrapped in `Arc`.

Error conversion helpers map `AwsAuthError` into either fatal Codex errors during setup or retryable/non-retryable `AuthError` values during request signing. The Bedrock-specific transport quirk is handled by `remove_headers_not_preserved_by_bedrock_mantle`: any header whose name contains an underscore is removed before signing because Mantle drops those legacy OpenAI-compatibility headers before SigV4 verification. `BedrockMantleSigV4AuthProvider::apply_auth` prepares the request body for sending, signs method/url/headers/body through `AwsAuthContext::sign`, then replaces the request URL and headers with the signed versions, rewrites the body as raw bytes, and disables compression. The embedded tests cover region precedence, missing-region failure, and underscore-header stripping.

#### Function details

##### `resolve_auth_method`  (lines 33–54)

```
async fn resolve_auth_method(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<BedrockAuthMethod>
```

**Purpose**: Chooses which Bedrock authentication mechanism to use based on managed login state, environment variables, and AWS config.

**Data flow**: It takes an optional `&BedrockApiKeyAuth` and `&ModelProviderAwsAuthInfo`. If managed auth is present, it returns `BedrockAuthMethod::ManagedBearerToken` with cloned token and region. Otherwise it checks `AWS_BEARER_TOKEN_BEDROCK` via `non_empty_env_var_from`; if present, it resolves the region with `bearer_token_region` and returns `EnvBearerToken`. If neither bearer-token source is available, it builds AWS auth config with `aws_auth_config(aws)`, asynchronously loads an `AwsAuthContext`, maps any `AwsAuthError` through `aws_auth_error_to_codex_error`, and returns `AwsSdkAuth { context }`.

**Call relations**: Both `resolve_provider_auth` and a separate region-resolution path call this as the central Bedrock auth-selection routine. It delegates env-var normalization, region lookup, and AWS SDK context loading to helpers.

*Call graph*: calls 4 internal fn (load, bearer_token_region, non_empty_env_var_from, aws_auth_config); called by 2 (resolve_provider_auth, resolve_region).


##### `resolve_provider_auth`  (lines 56–71)

```
async fn resolve_provider_auth(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<SharedAuthProvider>
```

**Purpose**: Builds the concrete shared auth provider object corresponding to the resolved Bedrock auth method.

**Data flow**: It takes optional managed auth and AWS config, awaits `resolve_auth_method`, then matches the result. For managed or env bearer-token methods it constructs a `BearerAuthProvider` with the token and no account metadata, wraps it in `Arc`, and returns it as `SharedAuthProvider`. For `AwsSdkAuth` it constructs `BedrockMantleSigV4AuthProvider::new(context)`, wraps that in `Arc`, and returns it.

**Call relations**: Higher-level provider setup calls this after deciding to use the Bedrock provider. It delegates the actual auth-mode decision to `resolve_auth_method` and then adapts that decision into the trait object expected by the client layer.

*Call graph*: calls 2 internal fn (new, resolve_auth_method); 1 external calls (new).


##### `non_empty_env_var_from`  (lines 73–81)

```
fn non_empty_env_var_from(
    name: &'static str,
    env_var: impl Fn(&'static str) -> std::result::Result<String, std::env::VarError>,
) -> Option<String>
```

**Purpose**: Reads an environment variable through an injected accessor and returns a trimmed value only when it is present and non-empty.

**Data flow**: It takes a static variable name and an env-var lookup function, calls the function, converts success into a trimmed `String`, filters out empty results, and returns `Option<String>`.

**Call relations**: This helper is used by `resolve_auth_method` to detect `AWS_BEARER_TOKEN_BEDROCK` and by `bearer_token_region` to probe region environment variables in a testable way.

*Call graph*: called by 1 (resolve_auth_method).


##### `bearer_token_region`  (lines 83–97)

```
fn bearer_token_region(
    aws: &ModelProviderAwsAuthInfo,
    env_var: impl Fn(&'static str) -> std::result::Result<String, std::env::VarError> + Copy,
) -> Result<String>
```

**Purpose**: Resolves the AWS region required for Bedrock bearer-token auth, preferring explicit provider config over environment variables.

**Data flow**: It takes `&ModelProviderAwsAuthInfo` and an env-var accessor. It first asks `region_from_config(aws)` for a trimmed configured region, then falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION` via `non_empty_env_var_from`. If none yield a value, it returns `CodexErr::Fatal` with a message explaining the required config/env sources; otherwise it returns the chosen region string.

**Call relations**: `resolve_auth_method` uses this when bearer-token auth is selected, and the unit tests call it directly to verify precedence and failure behavior.

*Call graph*: calls 1 internal fn (region_from_config); called by 5 (resolve_auth_method, bedrock_bearer_auth_prefers_configured_region_and_uses_header, bedrock_bearer_auth_rejects_missing_configured_region, bedrock_bearer_auth_uses_aws_default_region_env, bedrock_bearer_auth_uses_aws_region_env).


##### `aws_auth_error_to_codex_error`  (lines 99–101)

```
fn aws_auth_error_to_codex_error(error: AwsAuthError) -> CodexErr
```

**Purpose**: Converts AWS auth setup failures into fatal Codex errors with Bedrock-specific context.

**Data flow**: It takes an `AwsAuthError`, formats it into `"failed to resolve Amazon Bedrock auth: ..."`, wraps that string in `CodexErr::Fatal`, and returns it.

**Call relations**: `resolve_auth_method` uses this when `AwsAuthContext::load` fails during provider setup.

*Call graph*: 2 external calls (format!, Fatal).


##### `aws_auth_error_to_auth_error`  (lines 103–109)

```
fn aws_auth_error_to_auth_error(error: AwsAuthError) -> AuthError
```

**Purpose**: Maps AWS signing errors into retryable or non-retryable client auth errors based on the error’s retryability flag.

**Data flow**: It takes an `AwsAuthError`, checks `error.is_retryable()`, and returns `AuthError::Transient(error.to_string())` for retryable failures or `AuthError::Build(error.to_string())` otherwise.

**Call relations**: `BedrockMantleSigV4AuthProvider::apply_auth` uses this when request signing fails so the client layer can decide whether to retry.

*Call graph*: calls 1 internal fn (is_retryable); 3 external calls (to_string, Build, Transient).


##### `remove_headers_not_preserved_by_bedrock_mantle`  (lines 111–124)

```
fn remove_headers_not_preserved_by_bedrock_mantle(headers: &mut HeaderMap)
```

**Purpose**: Removes request headers whose names contain underscores because Bedrock Mantle drops them before SigV4 verification, which would otherwise invalidate the signature.

**Data flow**: It takes a mutable `HeaderMap`, collects all header names whose `as_str()` contains `'_'` into a temporary vector, then iterates that vector and removes each header from the map.

**Call relations**: The SigV4 auth provider calls this immediately before signing requests, and the dedicated unit test calls it directly to verify the filtering rule.

*Call graph*: called by 2 (apply_auth, bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle); 2 external calls (keys, remove).


##### `BedrockMantleSigV4AuthProvider::new`  (lines 133–135)

```
fn new(context: AwsAuthContext) -> Self
```

**Purpose**: Constructs the Bedrock SigV4 auth provider from a preloaded AWS auth context.

**Data flow**: It takes an `AwsAuthContext`, stores it in the struct’s `context` field, and returns the new provider instance.

**Call relations**: `resolve_provider_auth` uses this when AWS SDK auth is selected instead of bearer-token auth.

*Call graph*: called by 1 (resolve_provider_auth).


##### `BedrockMantleSigV4AuthProvider::add_auth_headers`  (lines 161–161)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements the `AuthProvider` trait’s header-only hook as a no-op because Bedrock SigV4 auth is applied by rewriting the full request, not by prepopulating static headers.

**Data flow**: It accepts a mutable `HeaderMap` reference and intentionally leaves it unchanged, returning unit.

**Call relations**: The client layer may call this through the `AuthProvider` trait, but for this provider all meaningful work happens in `apply_auth`.


##### `BedrockMantleSigV4AuthProvider::apply_auth`  (lines 163–165)

```
fn apply_auth(&self, request: Request) -> codex_api::AuthProviderFuture<'_>
```

**Purpose**: Signs a Bedrock request with AWS SigV4 after normalizing headers and preparing the body for transmission.

**Data flow**: It takes ownership of a `Request`, mutably removes underscore-containing headers via `remove_headers_not_preserved_by_bedrock_mantle`, calls `request.prepare_body_for_send()` and maps preparation failures to `AuthError::Build`, then asynchronously signs an `AwsRequestToSign` containing the request method, URL, prepared headers, and body bytes using `self.context.sign(...)`. On success it replaces `request.url` and `request.headers` with the signed values, rewrites `request.body` to `RequestBody::Raw` from the prepared body, sets `request.compression = RequestCompression::None`, and returns the modified request; signing failures are mapped through `aws_auth_error_to_auth_error`.

**Call relations**: This is the core per-request path used through the `AuthProvider` trait implementation when Bedrock AWS SDK auth is active. It depends on the header-stripping helper and AWS signing context.

*Call graph*: calls 3 internal fn (sign, prepare_body_for_send, remove_headers_not_preserved_by_bedrock_mantle); 1 external calls (pin).


##### `tests::missing_env_var`  (lines 176–178)

```
fn missing_env_var(_: &'static str) -> std::result::Result<String, std::env::VarError>
```

**Purpose**: Test helper that simulates an environment lookup where every variable is absent.

**Data flow**: It ignores the requested variable name and always returns `Err(std::env::VarError::NotPresent)`.

**Call relations**: The missing-region test passes this helper into `bearer_token_region` to force the fatal error path without mutating real process environment.


##### `tests::bedrock_bearer_auth_prefers_configured_region_and_uses_header`  (lines 181–210)

```
fn bedrock_bearer_auth_prefers_configured_region_and_uses_header()
```

**Purpose**: Verifies that bearer-token region resolution prefers the configured AWS region over environment variables and that bearer auth writes an `Authorization` header.

**Data flow**: It constructs AWS config with a whitespace-padded `region`, passes a closure that would otherwise return `AWS_REGION`, calls `bearer_token_region`, builds a `BearerAuthProvider` with a test token, adds auth headers into a fresh `HeaderMap`, and asserts the resolved region is trimmed to `us-west-2` and the authorization header starts with `Bearer bedrock-api-key-`.

**Call relations**: This test covers both the precedence logic in `bearer_token_region` and the downstream compatibility of the chosen bearer-token auth path.

*Call graph*: calls 1 internal fn (bearer_token_region); 3 external calls (assert!, assert_eq!, new).


##### `tests::bedrock_bearer_auth_uses_aws_region_env`  (lines 213–227)

```
fn bedrock_bearer_auth_uses_aws_region_env()
```

**Purpose**: Checks that `AWS_REGION` is used when no region is configured in provider settings.

**Data flow**: It constructs AWS config with `region: None`, passes an env-var closure that returns a whitespace-padded `AWS_REGION`, calls `bearer_token_region`, and asserts the result is the trimmed region string.

**Call relations**: This test exercises the first environment-variable fallback branch in `bearer_token_region`.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_bearer_auth_uses_aws_default_region_env`  (lines 230–244)

```
fn bedrock_bearer_auth_uses_aws_default_region_env()
```

**Purpose**: Checks that `AWS_DEFAULT_REGION` is used when neither provider config nor `AWS_REGION` supplies a region.

**Data flow**: It constructs AWS config with no region, passes an env-var closure that returns only `AWS_DEFAULT_REGION`, calls `bearer_token_region`, and asserts the returned region matches that value.

**Call relations**: This test covers the second environment-variable fallback branch in `bearer_token_region`.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_bearer_auth_rejects_missing_configured_region`  (lines 247–262)

```
fn bedrock_bearer_auth_rejects_missing_configured_region()
```

**Purpose**: Ensures bearer-token auth fails with the documented fatal error when no region can be resolved from config or environment.

**Data flow**: It constructs AWS config with no region, calls `bearer_token_region` using `missing_env_var`, captures the error, and asserts its string form matches the expected fatal message.

**Call relations**: This test targets the final error path in `bearer_token_region`.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle`  (lines 265–295)

```
fn bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle()
```

**Purpose**: Verifies that underscore-containing headers are removed before signing while normal hyphenated headers are preserved.

**Data flow**: It creates a `HeaderMap`, inserts `session_id`, `thread_id`, `future_identity_header`, and `x-client-request-id`, calls `remove_headers_not_preserved_by_bedrock_mantle`, then asserts the underscore headers are absent and the hyphenated request-id header remains with its original value.

**Call relations**: This test directly validates the Bedrock Mantle compatibility workaround used by `BedrockMantleSigV4AuthProvider::apply_auth`.

*Call graph*: calls 1 internal fn (remove_headers_not_preserved_by_bedrock_mantle); 4 external calls (new, from_static, assert!, assert_eq!).


### `model-provider/src/amazon_bedrock/mantle.rs`

`config` · `provider auth resolution and request URL setup`

This file encapsulates the Bedrock Mantle-specific pieces that differ from generic OpenAI-compatible providers. It defines the AWS service name `bedrock-mantle` and a fixed allowlist of 12 supported regions. `aws_auth_config` converts `ModelProviderAwsAuthInfo` into `AwsAuthConfig`, preserving the configured profile and normalizing the configured region through `region_from_config`, which trims whitespace and drops empty strings so downstream AWS resolution does not see meaningless values.

For endpoint construction, `base_url` validates that a region is in the supported list before formatting `https://bedrock-mantle.{region}.api.aws/openai/v1`; unsupported regions become a fatal `CodexErr`, not a fallback. Runtime resolution is slightly more dynamic: `runtime_base_url` first asks `resolve_region` to determine the effective region from whichever Bedrock auth method is active. That helper delegates to `resolve_auth_method` and then extracts the region from one of three variants: managed bearer token auth, environment bearer token auth, or AWS SDK auth context. This means the final URL can come from managed Bedrock credentials even when static config also contains AWS profile/region data. Tests cover endpoint formatting, unsupported-region rejection, and the exact `AwsAuthConfig` produced from profile and region inputs.

#### Function details

##### `aws_auth_config`  (lines 26–32)

```
fn aws_auth_config(aws: &ModelProviderAwsAuthInfo) -> AwsAuthConfig
```

**Purpose**: Builds the AWS SDK auth configuration used for Bedrock Mantle requests. It fixes the AWS service name to `bedrock-mantle` and carries through provider-specific profile and normalized region settings.

**Data flow**: It takes a `ModelProviderAwsAuthInfo`, clones its `profile`, derives `region` by calling `region_from_config`, and returns an `AwsAuthConfig` struct with those values plus `service: "bedrock-mantle"`.

**Call relations**: This function is used during Bedrock auth-method resolution when AWS SDK credentials may be needed. It delegates region cleanup to `region_from_config` so all callers share the same trimming and empty-string filtering.

*Call graph*: calls 1 internal fn (region_from_config); called by 1 (resolve_auth_method).


##### `region_from_config`  (lines 34–40)

```
fn region_from_config(aws: &ModelProviderAwsAuthInfo) -> Option<String>
```

**Purpose**: Normalizes an optional configured AWS region string into a usable value. It removes surrounding whitespace and treats blank strings as absent.

**Data flow**: It reads `aws.region`, converts the `Option<String>` to `Option<&str>`, trims whitespace, filters out empty results, and returns an owned `Option<String>` containing the cleaned region if present.

**Call relations**: It is called by `aws_auth_config` and elsewhere in Bedrock auth logic to ensure configured regions are consistently sanitized before use.

*Call graph*: called by 2 (bearer_token_region, aws_auth_config).


##### `base_url`  (lines 42–50)

```
fn base_url(region: &str) -> Result<String>
```

**Purpose**: Validates a Bedrock region and formats the exact Mantle OpenAI-compatible base URL for that region. Unsupported regions are rejected with a fatal error.

**Data flow**: It accepts a region string, checks membership in the `BEDROCK_MANTLE_SUPPORTED_REGIONS` array, and either returns `Ok("https://bedrock-mantle.{region}.api.aws/openai/v1")` or `Err(CodexErr::Fatal(...))` naming the unsupported region.

**Call relations**: It is the final URL formatter used by `runtime_base_url` after region resolution, and it is also exercised directly by tests and by code that wants to validate a configured endpoint shape.

*Call graph*: called by 3 (runtime_base_url, base_url_rejects_unsupported_region, api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint); 2 external calls (format!, Fatal).


##### `runtime_base_url`  (lines 52–58)

```
async fn runtime_base_url(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<String>
```

**Purpose**: Computes the effective Bedrock Mantle base URL at runtime from the active auth context and provider AWS settings. It ensures the URL reflects the resolved region rather than blindly trusting static config.

**Data flow**: It takes an optional managed `BedrockApiKeyAuth` reference and a `ModelProviderAwsAuthInfo`, awaits `resolve_region` to get the effective region string, then passes that region to `base_url` and returns the resulting `Result<String>`.

**Call relations**: This function is called by the Bedrock provider when constructing API provider metadata and when reporting the runtime base URL. It delegates first to auth-aware region resolution and then to strict region validation/formatting.

*Call graph*: calls 2 internal fn (base_url, resolve_region); called by 2 (api_provider, runtime_base_url).


##### `resolve_region`  (lines 60–69)

```
async fn resolve_region(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<String>
```

**Purpose**: Extracts the effective AWS region from the resolved Bedrock authentication method. It unifies bearer-token and AWS-SDK auth paths into a single region string.

**Data flow**: It accepts optional managed Bedrock auth and provider AWS config, awaits `resolve_auth_method`, pattern-matches the returned `BedrockAuthMethod`, and returns either the embedded bearer-token region or `context.region().to_string()` from AWS SDK auth.

**Call relations**: It is an internal helper used only by `runtime_base_url`. Its key role is to centralize the precedence rules already encoded in `resolve_auth_method` and expose only the region needed for URL construction.

*Call graph*: calls 1 internal fn (resolve_auth_method); called by 1 (runtime_base_url).


##### `tests::base_url_uses_region_endpoint`  (lines 78–83)

```
fn base_url_uses_region_endpoint()
```

**Purpose**: Checks that a supported region is interpolated into the expected Mantle endpoint URL.

**Data flow**: It calls `base_url("ap-northeast-1")`, unwraps the success case, and asserts the returned string matches the exact regional URL.

**Call relations**: This test directly validates the happy-path formatting logic in `base_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::base_url_rejects_unsupported_region`  (lines 86–93)

```
fn base_url_rejects_unsupported_region()
```

**Purpose**: Verifies that unsupported regions fail with the intended fatal error message.

**Data flow**: It calls `base_url("us-west-1")`, expects an error, converts that error to string form, and asserts the message names the unsupported region.

**Call relations**: This test covers the rejection branch in `base_url`, ensuring unsupported regions do not silently produce endpoints.

*Call graph*: calls 1 internal fn (base_url); 1 external calls (assert_eq!).


##### `tests::aws_auth_config_uses_profile_and_mantle_service`  (lines 96–108)

```
fn aws_auth_config_uses_profile_and_mantle_service()
```

**Purpose**: Confirms that AWS auth config preserves the configured profile and always uses the Mantle service name.

**Data flow**: It constructs a `ModelProviderAwsAuthInfo` with a profile and no region, passes it to `aws_auth_config`, and asserts the returned `AwsAuthConfig` contains the same profile, no region, and `service: "bedrock-mantle"`.

**Call relations**: This test validates the struct assembly performed by `aws_auth_config` on the no-region path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::aws_auth_config_uses_configured_region`  (lines 111–123)

```
fn aws_auth_config_uses_configured_region()
```

**Purpose**: Checks that configured regions are trimmed before being embedded in the AWS auth config.

**Data flow**: It builds `ModelProviderAwsAuthInfo` with a whitespace-padded region, calls `aws_auth_config`, and asserts the returned `AwsAuthConfig.region` is the trimmed string while the service remains `bedrock-mantle`.

**Call relations**: This test exercises the interaction between `aws_auth_config` and `region_from_config`, specifically the normalization behavior.

*Call graph*: 1 external calls (assert_eq!).


### `model-provider/src/amazon_bedrock/mod.rs`

`domain_logic` · `provider instantiation and Bedrock request handling`

This module wires together Bedrock-specific auth, endpoint, and catalog behavior behind `AmazonBedrockModelProvider`. The struct stores the original `ModelProviderInfo`, a normalized `ModelProviderAwsAuthInfo` extracted from it, and an optional shared `AuthManager`. Construction fills in missing AWS config with `{ profile: None, region: None }` so later code can rely on `self.aws` always existing.

A central design choice is that only managed Bedrock API-key auth is visible to this provider. `managed_auth` reads the cached auth snapshot from the manager and returns `Some(BedrockApiKeyAuth)` only for `CodexAuth::BedrockApiKey`; all OpenAI/ChatGPT/PAT/agent auth variants are ignored. That choice drives several behaviors: `auth_manager()` only exposes the manager when Bedrock auth is actually present, `auth()` returns only Bedrock auth, `account_state()` reports `CodexManaged` versus `AwsManaged` credential source based on that presence, and `api_auth()` delegates to Bedrock-specific auth resolution.

Request configuration is also dynamic. `api_provider()` clones `self.info`, computes the runtime Mantle URL from auth and AWS config, writes it into `base_url`, and converts the result to a `codex_api::Provider`. `runtime_base_url()` exposes the same computed URL directly. For models, Bedrock never uses the remote models endpoint: `models_manager()` always returns a `StaticModelsManager`, using either the built-in Bedrock catalog or a caller-supplied catalog normalized through `with_default_only_service_tier`. Capability flags disable unsupported hosted features, and all preferred-model selectors point to the Bedrock GPT-5.4 model ID except the static catalog default ordering, which still prefers GPT-5.5.

#### Function details

##### `AmazonBedrockModelProvider::new`  (lines 42–58)

```
fn new(
        provider_info: ModelProviderInfo,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Constructs a Bedrock provider instance from serialized provider metadata and an optional auth manager. It also normalizes missing AWS config into an explicit empty `ModelProviderAwsAuthInfo`.

**Data flow**: It takes `provider_info` and `auth_manager`, clones `provider_info.aws` if present or substitutes `{ profile: None, region: None }`, and stores `info`, `aws`, and `auth_manager` in a new `AmazonBedrockModelProvider`.

**Call relations**: This constructor is selected by `create_model_provider` whenever `ModelProviderInfo` identifies Amazon Bedrock, and it is used directly in Bedrock-focused tests. It does not delegate further.

*Call graph*: called by 5 (approval_review_preferred_model_uses_bedrock_gpt_5_4, capabilities_disable_unsupported_hosted_tools, managed_auth_takes_precedence_over_aws_auth, openai_auth_is_not_exposed_to_bedrock, create_model_provider).


##### `AmazonBedrockModelProvider::managed_auth`  (lines 60–72)

```
fn managed_auth(&self) -> Option<BedrockApiKeyAuth>
```

**Purpose**: Extracts Bedrock-managed credentials from the shared auth manager while intentionally ignoring all non-Bedrock auth types. This is the gate that prevents OpenAI auth from leaking into Bedrock behavior.

**Data flow**: It reads `self.auth_manager`, asks for `auth_cached()`, pattern-matches the resulting `CodexAuth`, and returns `Some(BedrockApiKeyAuth)` only for `CodexAuth::BedrockApiKey`; every other variant yields `None`.

**Call relations**: This helper is the common dependency for account-state reporting, auth exposure, runtime URL resolution, and API auth/provider construction. It is called by nearly every Bedrock-specific method to enforce Bedrock-auth precedence rules.

*Call graph*: called by 6 (account_state, api_auth, api_provider, auth, auth_manager, runtime_base_url).


##### `AmazonBedrockModelProvider::info`  (lines 100–102)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Returns the stored provider metadata for trait consumers.

**Data flow**: It reads `self.info` and returns a shared reference without modification.

**Call relations**: This is the trait-required metadata accessor for callers using the provider polymorphically. It does not delegate.


##### `AmazonBedrockModelProvider::capabilities`  (lines 104–110)

```
fn capabilities(&self) -> ProviderCapabilities
```

**Purpose**: Declares the Bedrock provider's supported feature upper bounds. It explicitly disables hosted image generation and web search while leaving namespace tools enabled.

**Data flow**: It constructs and returns a `ProviderCapabilities` value with `namespace_tools: true`, `image_generation: false`, and `web_search: false`.

**Call relations**: This overrides the trait default so UI and runtime logic can suppress unsupported features for Bedrock.


##### `AmazonBedrockModelProvider::approval_review_preferred_model`  (lines 112–114)

```
fn approval_review_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the Bedrock-specific model ID preferred for automatic approval review.

**Data flow**: It returns the constant `AMAZON_BEDROCK_GPT_5_4_MODEL_ID`.

**Call relations**: This overrides the generic trait default because Bedrock requires backend-specific model IDs rather than generic OpenAI slugs.


##### `AmazonBedrockModelProvider::memory_extraction_preferred_model`  (lines 116–118)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the Bedrock-specific model ID preferred for memory extraction tasks.

**Data flow**: It returns the constant `AMAZON_BEDROCK_GPT_5_4_MODEL_ID`.

**Call relations**: Like the approval-review selector, this overrides the generic trait default for Bedrock-specific routing.


##### `AmazonBedrockModelProvider::memory_consolidation_preferred_model`  (lines 120–122)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the Bedrock-specific model ID preferred for memory consolidation tasks.

**Data flow**: It returns the constant `AMAZON_BEDROCK_GPT_5_4_MODEL_ID`.

**Call relations**: This is the third preferred-model override, keeping all memory-related Bedrock defaults aligned on GPT-5.4.


##### `AmazonBedrockModelProvider::auth_manager`  (lines 124–127)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Exposes the underlying auth manager only when it currently contains managed Bedrock auth. This prevents unrelated auth managers from being treated as Bedrock-capable.

**Data flow**: It calls `managed_auth()`; if that returns `Some`, it clones and returns `self.auth_manager`, otherwise it returns `None`.

**Call relations**: Trait consumers call this to discover provider-scoped auth management. Its behavior depends entirely on `managed_auth`, which enforces the Bedrock-only filter.

*Call graph*: calls 1 internal fn (managed_auth).


##### `AmazonBedrockModelProvider::auth`  (lines 129–131)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Returns the current provider-scoped auth snapshot as a future, but only for managed Bedrock credentials.

**Data flow**: It calls `managed_auth()`, maps the result into `CodexAuth::BedrockApiKey`, boxes the async result with `Box::pin`, and yields `Option<CodexAuth>`.

**Call relations**: This is the trait-facing async auth accessor. It is used by callers that need the provider's current auth state and relies on `managed_auth` to suppress non-Bedrock auth.

*Call graph*: calls 1 internal fn (managed_auth); 1 external calls (pin).


##### `AmazonBedrockModelProvider::account_state`  (lines 133–143)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Reports Bedrock account visibility to the app, distinguishing between Codex-managed Bedrock credentials and AWS-managed credentials.

**Data flow**: It checks whether `managed_auth()` returns `Some`. If so, it sets `credential_source` to `AmazonBedrockCredentialSource::CodexManaged`; otherwise it uses `AwsManaged`. It wraps that in `ProviderAccount::AmazonBedrock` and returns `ProviderAccountState { account: Some(...), requires_openai_auth: false }`.

**Call relations**: This method is called by higher-level account/status UI logic. It does not delegate beyond `managed_auth`, because Bedrock account state is derived solely from auth-source presence.

*Call graph*: calls 1 internal fn (managed_auth).


##### `AmazonBedrockModelProvider::api_provider`  (lines 145–147)

```
fn api_provider(&self) -> ModelProviderFuture<'_, Result<Provider>>
```

**Purpose**: Builds the concrete API provider configuration used for Bedrock requests, including the runtime-resolved Mantle base URL.

**Data flow**: It reads managed Bedrock auth via `managed_auth()`, clones `self.info` into a mutable `api_provider_info`, computes `base_url` by awaiting `mantle::runtime_base_url(managed_auth.as_ref(), &self.aws)`, writes that URL into `api_provider_info.base_url`, and converts the result with `to_api_provider(None)`.

**Call relations**: This async helper backs the trait's `api_provider()` method for Bedrock. It delegates URL computation to the Mantle module so auth-derived region selection is reflected in the final provider config.

*Call graph*: calls 2 internal fn (managed_auth, runtime_base_url); 2 external calls (pin, clone).


##### `AmazonBedrockModelProvider::runtime_base_url`  (lines 149–151)

```
fn runtime_base_url(&self) -> ModelProviderFuture<'_, Result<Option<String>>>
```

**Purpose**: Exposes the exact Bedrock Mantle base URL that will be used at request time.

**Data flow**: It obtains optional managed auth from `managed_auth()`, awaits `mantle::runtime_base_url(managed_auth.as_ref(), &self.aws)`, wraps the resulting string in `Some`, and returns `Result<Option<String>>`.

**Call relations**: This is the trait-facing runtime URL accessor. It shares the same Mantle resolution path as `api_provider` but returns only the URL instead of a full API provider struct.

*Call graph*: calls 2 internal fn (managed_auth, runtime_base_url); 1 external calls (pin).


##### `AmazonBedrockModelProvider::api_auth`  (lines 153–155)

```
fn api_auth(&self) -> ModelProviderFuture<'_, Result<SharedAuthProvider>>
```

**Purpose**: Resolves the request-header auth provider appropriate for Bedrock, using managed Bedrock auth when available and AWS-based fallback otherwise.

**Data flow**: It reads optional managed auth with `managed_auth()`, passes `managed_auth.as_ref()` and `&self.aws` to Bedrock-specific `resolve_provider_auth`, awaits the result, and returns a `SharedAuthProvider`.

**Call relations**: This async helper backs the trait's `api_auth()` implementation for Bedrock. It delegates to the Bedrock auth module because generic provider auth resolution does not understand Bedrock's AWS and bearer-token modes.

*Call graph*: calls 1 internal fn (managed_auth); 2 external calls (pin, resolve_provider_auth).


##### `AmazonBedrockModelProvider::models_manager`  (lines 157–166)

```
fn models_manager(
        &self,
        _codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> SharedModelsManager
```

**Purpose**: Creates the Bedrock models manager, always using a static catalog rather than a remote models endpoint.

**Data flow**: It ignores `codex_home`, takes an optional `config_model_catalog`, and constructs a `StaticModelsManager` with no auth manager. If a catalog is provided, it normalizes it with `with_default_only_service_tier`; otherwise it generates the built-in catalog with `static_model_catalog`.

**Call relations**: This overrides the generic provider behavior because Bedrock model metadata is fixed and provider-owned. It delegates to the catalog module and wraps the result in `Arc<StaticModelsManager>`.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint`  (lines 177–190)

```
fn api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint()
```

**Purpose**: Verifies that a Bedrock provider configured with a supported region produces the expected Mantle base URL in API-provider form.

**Data flow**: It creates Bedrock `ModelProviderInfo`, sets `base_url` using `mantle::base_url(region)`, converts it with `to_api_provider(None)`, and asserts the resulting `Provider.base_url` matches the regional Mantle URL.

**Call relations**: This test validates the endpoint shape expected by Bedrock API-provider construction, using the Mantle URL formatter directly.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, base_url); 1 external calls (assert_eq!).


##### `tests::managed_auth_takes_precedence_over_aws_auth`  (lines 193–243)

```
async fn managed_auth_takes_precedence_over_aws_auth()
```

**Purpose**: Checks that managed Bedrock API-key auth overrides configured AWS profile/region settings across auth exposure, account state, runtime URL, and request headers.

**Data flow**: It builds a managed `BedrockApiKeyAuth`, wraps it in an `AuthManager`, constructs a provider whose config also contains AWS profile and region, then asserts: the same auth manager is exposed, `auth()` returns the Bedrock auth, `account_state()` reports `CodexManaged`, `runtime_base_url()` uses the managed auth region, and `api_auth().to_auth_headers()` contains a bearer authorization header with the managed API key.

**Call relations**: This test exercises the full Bedrock provider flow from `managed_auth` through account-state, URL resolution, and auth-provider generation, proving managed credentials win over static AWS config.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_amazon_bedrock_provider, new); 3 external calls (assert!, assert_eq!, BedrockApiKey).


##### `tests::openai_auth_is_not_exposed_to_bedrock`  (lines 246–265)

```
async fn openai_auth_is_not_exposed_to_bedrock()
```

**Purpose**: Ensures that an auth manager containing ordinary OpenAI auth is ignored by the Bedrock provider.

**Data flow**: It constructs a Bedrock provider with an auth manager holding `CodexAuth::ApiKey`, then asserts `auth_manager()` returns `None`, `auth().await` returns `None`, and `account_state()` reports `AwsManaged` rather than a managed Bedrock source.

**Call relations**: This test directly validates the filtering behavior in `managed_auth` and the downstream methods that depend on it.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_amazon_bedrock_provider, new); 2 external calls (assert!, assert_eq!).


##### `tests::capabilities_disable_unsupported_hosted_tools`  (lines 268–282)

```
fn capabilities_disable_unsupported_hosted_tools()
```

**Purpose**: Confirms the Bedrock provider advertises the intended capability restrictions.

**Data flow**: It constructs a Bedrock provider and asserts that `capabilities()` returns `namespace_tools: true`, `image_generation: false`, and `web_search: false`.

**Call relations**: This test covers the Bedrock-specific override of the trait default capability set.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, new); 1 external calls (assert_eq!).


##### `tests::approval_review_preferred_model_uses_bedrock_gpt_5_4`  (lines 285–295)

```
fn approval_review_preferred_model_uses_bedrock_gpt_5_4()
```

**Purpose**: Checks that approval review uses the Bedrock GPT-5.4 model ID rather than a generic default.

**Data flow**: It constructs a Bedrock provider and asserts `approval_review_preferred_model()` equals `AMAZON_BEDROCK_GPT_5_4_MODEL_ID`.

**Call relations**: This test validates one of the Bedrock-specific preferred-model overrides.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, new); 1 external calls (assert_eq!).


### Client auth abstractions
Provides shared auth interfaces and attestation boundaries that downstream HTTP-style clients use when attaching credentials to requests.

### `core/src/attestation.rs`

`domain_logic` · `request handling`

This file establishes a small but important integration contract around request attestation. The constant `X_OAI_ATTESTATION_HEADER` fixes the outbound HTTP header name as `x-oai-attestation`, ensuring all callers and providers use the same wire-level identifier. `AttestationContext` is a lightweight request-scoped struct containing the `ThreadId` whose upstream request is being prepared; this gives providers enough context to apply policy or derive a token without exposing unrelated request internals.

Because attestation generation may involve asynchronous work, the file defines `GenerateAttestationFuture<'a>` as a boxed, pinned, `Send` future yielding `Option<HeaderValue>`. Returning `None` explicitly represents the policy decision not to attach an attestation header. The `AttestationProvider` trait is the host integration boundary: implementations own the logic for whether attestation should be attempted and, if so, produce the concrete `HeaderValue`. Requiring `Debug + Send + Sync` makes providers suitable for shared use in concurrent runtime components. The design keeps attestation policy decoupled from HTTP request construction: core code can ask for a header in a uniform way, while platform-specific integrations decide how and when to mint one.


### `codex-api/src/auth.rs`

`config` · `request preparation`

This file provides the core auth contract for outbound API requests. `AuthError` distinguishes between build-time failures (`Build`) and transient failures (`Transient`), and its `From<AuthError> for TransportError` implementation preserves that distinction by mapping build failures to `TransportError::Build` and transient ones to `TransportError::Network`.

The central trait, `AuthProvider`, is intentionally split into a cheap header-only path and a full-request path. Implementers must provide `add_auth_headers(&mut HeaderMap)`, which is documented as non-blocking and suitable for telemetry or non-HTTP code paths. The default `to_auth_headers` helper materializes those headers into a fresh `HeaderMap`. The default `apply_auth` implementation takes ownership of a `codex_client::Request`, mutates its header map via `add_auth_headers`, and returns the updated request asynchronously through the boxed `AuthProviderFuture`; providers that need to sign the full request can override this method.

The file also defines shared type aliases: `AuthProviderFuture` for the boxed async result and `SharedAuthProvider` as `Arc<dyn AuthProvider>`. Finally, `AuthHeaderTelemetry` and `auth_header_telemetry` provide a lightweight way to inspect whether an auth provider attaches an `Authorization` header, returning a stable telemetry shape with `attached` and optional header-name fields rather than exposing raw credentials.

#### Function details

##### `TransportError::from`  (lines 18–23)

```
fn from(error: AuthError) -> Self
```

**Purpose**: Converts an `AuthError` into the transport-layer error type expected by HTTP execution code.

**Data flow**: Consumes an `AuthError`, matches on its variant, and returns either `TransportError::Build(message)` for deterministic request-construction failures or `TransportError::Network(message)` for transient auth failures. No shared state is accessed.

**Call relations**: This conversion is used wherever auth application is folded into transport execution, preserving whether the failure should be treated as a build problem or a retryable/transient network-like issue.

*Call graph*: 2 external calls (Build, Network).


##### `AuthProvider::to_auth_headers`  (lines 38–42)

```
fn to_auth_headers(&self) -> HeaderMap
```

**Purpose**: Builds a standalone header map containing whatever headers the provider can attach without inspecting the full request.

**Data flow**: Allocates a fresh `HeaderMap`, calls `self.add_auth_headers(&mut headers)`, and returns the populated map. It reads provider state through the trait object and writes only into the local header map.

**Call relations**: Serves callers that need auth headers outside the full request path, such as telemetry or alternate transports, and is layered directly on top of the required `add_auth_headers` method.

*Call graph*: 1 external calls (new).


##### `AuthProvider::apply_auth`  (lines 55–61)

```
fn apply_auth(&self, request: Request) -> AuthProviderFuture<'_>
```

**Purpose**: Default async implementation for applying authentication to an owned outbound request.

**Data flow**: Takes ownership of a `Request`, boxes an async block, mutates `request.headers` by calling `self.add_auth_headers`, and returns `Ok(request)`. It does not inspect the body or URL unless an implementer overrides it.

**Call relations**: Used by API clients as the authoritative auth application step before sending a request. Header-only providers rely on this default; request-signing providers can override it to perform richer transformations.

*Call graph*: 1 external calls (pin).


##### `auth_header_telemetry`  (lines 76–86)

```
fn auth_header_telemetry(auth: &dyn AuthProvider) -> AuthHeaderTelemetry
```

**Purpose**: Produces a minimal telemetry summary indicating whether an auth provider attaches an `Authorization` header.

**Data flow**: Creates a fresh `HeaderMap`, asks the provider to add auth headers, checks whether the map contains `http::header::AUTHORIZATION`, and returns `AuthHeaderTelemetry { attached, name }` where `name` is `Some("authorization")` only when present.

**Call relations**: This helper is a read-only probe over `AuthProvider::add_auth_headers`, intended for instrumentation paths that need to know whether auth was attached without exposing header values.

*Call graph*: 2 external calls (new, add_auth_headers).


### Remote and MCP auth flows
Adapts authentication state for remote-control transport and MCP servers, including OAuth capability detection and status synthesis.

### `app-server-transport/src/transport/remote_control/auth.rs`

`domain_logic` · `remote-control enrollment, reconnect, and unauthorized recovery`

This file contains the small but important auth helpers used by the remote-control subsystem. `RemoteControlConnectionAuth` packages the two pieces remote control needs to talk to backend services: a `SharedAuthProvider` that can add request headers and the authenticated ChatGPT `account_id`. `load_remote_control_auth` repeatedly queries `AuthManager` for current auth, forcing at most one reload when auth is missing or when Codex-backend auth lacks an account id. A key invariant is that API-key auth is explicitly rejected: remote control requires ChatGPT authentication, and if the selected auth does not use the Codex backend the function returns `PermissionDenied`. If auth exists but still lacks an account id after a reload, the function returns `WouldBlock`, signaling that enrollment should wait rather than fail permanently.

`recover_remote_control_auth` drives one step of `UnauthorizedRecovery` after a 401-style failure. It snapshots the auth-change watch revision before recovery, runs the next recovery step, and if that step reports `auth_state_changed == Some(true)` it calls `mark_recovery_auth_change_seen`. That helper intentionally consumes only the single watch revision caused by the recovery itself when the revision advanced by exactly one; if additional external auth changes raced with recovery, they remain pending so the outer reconnect loop still wakes up and reacts. The logging distinguishes successful and failed recovery attempts with mode and step names for observability.

#### Function details

##### `load_remote_control_auth`  (lines 16–59)

```
async fn load_remote_control_auth(
    auth_manager: &Arc<AuthManager>,
) -> io::Result<RemoteControlConnectionAuth>
```

**Purpose**: Loads the current remote-control-capable auth state from `AuthManager`, reloading once if necessary, and returns the auth provider plus ChatGPT account id. It rejects unsupported auth modes and incomplete auth state with precise `io::ErrorKind`s.

**Data flow**: Takes `&Arc<AuthManager>`, loops calling `auth_manager.auth().await`, optionally triggers `auth_manager.reload().await` once when auth is missing or when Codex-backend auth lacks an account id, rejects non-Codex-backend auth with `PermissionDenied`, converts the final auth into a `SharedAuthProvider` via `auth_provider_from_auth`, extracts `account_id`, and returns `RemoteControlConnectionAuth` or an `io::Error` (`PermissionDenied` or `WouldBlock`).

**Call relations**: Called by many remote-control operations before making backend requests or enrolling. It is the common prerequisite for obtaining authenticated headers and the account id header.

*Call graph*: called by 11 (pairing_status, persist_preference, start_pairing, send_client_management_request, enable, resolve_persisted_preference, enroll_pairing_server, refresh_pairing_enrollment, resolve_unknown_desired_state, prepare_remote_control_enrollment (+1 more)); 2 external calls (new, auth_provider_from_auth).


##### `recover_remote_control_auth`  (lines 61–91)

```
async fn recover_remote_control_auth(
    auth_recovery: &mut UnauthorizedRecovery,
    auth_change_rx: &mut watch::Receiver<u64>,
) -> bool
```

**Purpose**: Attempts one unauthorized-recovery step after a remote-control request fails with an auth error, and updates auth-change watch state so the outer reconnect loop does not double-handle recovery-induced changes. It reports whether recovery actually ran successfully.

**Data flow**: Accepts a mutable `UnauthorizedRecovery` and mutable auth-change `watch::Receiver<u64>`. It returns `false` immediately if no recovery step remains; otherwise it records the current revision, captures the recovery mode and step names, awaits `auth_recovery.next()`, optionally calls `mark_recovery_auth_change_seen` when the step reports that auth state changed, logs success or failure, and returns `true` on successful recovery step completion or `false` on error.

**Call relations**: Called by remote-control request/enrollment flows after unauthorized responses. It delegates revision bookkeeping to `mark_recovery_auth_change_seen`.

*Call graph*: calls 5 internal fn (mark_recovery_auth_change_seen, has_next, mode_name, next, step_name); called by 5 (send_client_management_request, enroll_pairing_server, refresh_pairing_enrollment, enroll_and_persist_remote_control_server, prepare_remote_control_enrollment); 3 external calls (borrow, info!, warn!).


##### `mark_recovery_auth_change_seen`  (lines 93–105)

```
fn mark_recovery_auth_change_seen(
    auth_change_rx: &mut watch::Receiver<u64>,
    auth_change_revision_before_recovery: u64,
)
```

**Purpose**: Consumes exactly the auth-change watch revision produced by a recovery step, but leaves later racing revisions pending. This preserves the outer reconnect loop's ability to notice external auth changes that happened during recovery.

**Data flow**: Takes a mutable auth-change receiver and the revision observed before recovery. It reads the current revision; if it equals `before.wrapping_add(1)`, it calls `borrow_and_update()` to mark that single revision seen. Otherwise it does nothing.

**Call relations**: Called by `recover_remote_control_auth` when a recovery step reports that it changed auth state, and directly exercised by tests covering revision-race behavior.

*Call graph*: called by 3 (recover_remote_control_auth, mark_recovery_auth_change_seen_marks_only_recovery_revision_seen, mark_recovery_auth_change_seen_preserves_racing_auth_change); 2 external calls (borrow, borrow_and_update).


### `rmcp-client/src/auth_status.rs`

`domain_logic` · `connection setup, auth capability detection`

This file implements authentication-status inference for HTTP-based MCP servers. The top-level decision function, `determine_streamable_http_auth_status`, follows a deliberate precedence order. First, if a bearer-token environment variable is configured, it immediately returns `McpAuthStatus::BearerToken`. Next it builds default headers from explicit and environment-derived header maps; if those headers already contain `Authorization`, it also returns bearer-token mode. Only if no bearer token is configured does it consult local OAuth storage via `oauth_token_status`: a usable stored token yields `OAuth`, an authorization-required state yields `NotLoggedIn`, and a missing token falls through to network discovery.

Discovery is split into public wrappers and a private implementation. `discover_streamable_http_oauth_with_headers` parses the base URL, builds a reqwest client with a 5-second timeout and `no_proxy()` workaround, applies default headers, and probes a sequence of well-known metadata paths derived from the base path. For each candidate it sends a GET with `MCP-Protocol-Version: 2024-11-05`, ignores non-200 responses, and attempts to deserialize `OAuthDiscoveryMetadata`. OAuth support is recognized only when both `authorization_endpoint` and `token_endpoint` are present. Optional `scopes_supported` values are normalized by trimming whitespace, dropping empties, and deduplicating while preserving order.

Errors during probing are intentionally soft: the function remembers the last request/JSON error for debug logging, but callers generally degrade to `Unsupported` rather than failing the whole auth-status computation. The tests cover bearer-token precedence, environment-backed header expansion, scope normalization, empty-scope suppression, and the fact that OAuth support does not require `scopes_supported` to be present.

#### Function details

##### `determine_streamable_http_auth_status`  (lines 32–68)

```
async fn determine_streamable_http_auth_status(
    server_name: &str,
    url: &str,
    bearer_token_env_var: Option<&str>,
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: O
```

**Purpose**: Computes the effective authentication mode for a streamable HTTP MCP server by checking bearer-token configuration first, then stored OAuth token state, then live OAuth discovery. It intentionally treats discovery failures as non-fatal and falls back to `Unsupported`.

**Data flow**: Takes server identity/config inputs: `server_name`, `url`, optional `bearer_token_env_var`, optional explicit and env-derived HTTP header maps, and OAuth storage settings. If `bearer_token_env_var` is present it returns `BearerToken`. Otherwise it builds default headers with `build_default_headers`; if those contain `AUTHORIZATION`, it returns `BearerToken`. It then queries `oauth_token_status(server_name, url, store_mode, keyring_backend_kind)`: `Usable` maps to `OAuth`, `AuthorizationRequired` to `NotLoggedIn`, and `Missing` continues. Finally it awaits `discover_streamable_http_oauth_with_headers(url, &default_headers)` and maps `Some(_)` to `NotLoggedIn`, `None` to `Unsupported`, and any error to a debug log plus `Unsupported`.

**Call relations**: This is the main policy function used by callers deciding how to authenticate to an MCP server. It delegates header synthesis to `build_default_headers`, local credential inspection to `oauth_token_status`, and network probing to `discover_streamable_http_oauth_with_headers`.

*Call graph*: calls 3 internal fn (discover_streamable_http_oauth_with_headers, oauth_token_status, build_default_headers); called by 2 (determine_auth_status_uses_bearer_token_when_authorization_header_present, determine_auth_status_uses_bearer_token_when_env_authorization_header_present); 1 external calls (debug!).


##### `supports_oauth_login`  (lines 71–77)

```
async fn supports_oauth_login(url: &str) -> Result<bool>
```

**Purpose**: Provides a simple yes/no wrapper around OAuth discovery with no custom headers. It answers whether the server advertises OAuth login capability at all.

**Data flow**: Takes `url: &str`, calls `discover_streamable_http_oauth(url, None, None).await?`, converts the resulting `Option` to `bool` with `.is_some()`, and returns `Result<bool>`.

**Call relations**: Used by tests and higher-level callers that only need capability detection, not full auth-status classification. It delegates all probing work to `discover_streamable_http_oauth`.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); called by 1 (supports_oauth_login_does_not_require_scopes_supported).


##### `discover_streamable_http_oauth`  (lines 79–86)

```
async fn discover_streamable_http_oauth(
    url: &str,
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
) -> Result<Option<StreamableHttpOAuth
```

**Purpose**: Builds default headers from configuration and performs OAuth discovery against the target URL. It is the public discovery entrypoint when callers may supply custom headers.

**Data flow**: Takes `url`, optional explicit `http_headers`, and optional `env_http_headers`. It computes a `HeaderMap` via `build_default_headers` and then awaits `discover_streamable_http_oauth_with_headers(url, &default_headers)`, returning the resulting `Option<StreamableHttpOAuthDiscovery>`.

**Call relations**: Called by `supports_oauth_login` and tests. It exists mainly to separate header construction from the lower-level probing loop in `discover_streamable_http_oauth_with_headers`.

*Call graph*: calls 2 internal fn (discover_streamable_http_oauth_with_headers, build_default_headers); called by 3 (supports_oauth_login, discover_streamable_http_oauth_ignores_empty_scopes, discover_streamable_http_oauth_returns_normalized_scopes).


##### `discover_streamable_http_oauth_with_headers`  (lines 88–141)

```
async fn discover_streamable_http_oauth_with_headers(
    url: &str,
    default_headers: &HeaderMap,
) -> Result<Option<StreamableHttpOAuthDiscovery>>
```

**Purpose**: Probes RFC 8414-style well-known metadata endpoints derived from the server URL and returns normalized OAuth discovery data when both authorization and token endpoints are advertised. It tolerates individual request and parse failures across candidate paths.

**Data flow**: Takes `url: &str` and a prepared `default_headers: &HeaderMap`. It parses the URL, builds a reqwest `Client` with `DISCOVERY_TIMEOUT` and `no_proxy()`, applies default headers via `apply_default_headers`, and initializes `last_error`. It iterates over `discovery_paths(base_url.path())`, cloning the base URL and replacing its path for each candidate. For each URL it sends a GET with header `MCP-Protocol-Version: 2024-11-05`; request errors are stored in `last_error` and skipped. Non-200 responses are ignored. Successful 200 responses are parsed as `OAuthDiscoveryMetadata`; JSON errors are stored and skipped. If both `authorization_endpoint` and `token_endpoint` are present, it returns `Some(StreamableHttpOAuthDiscovery { scopes_supported: normalize_scopes(metadata.scopes_supported) })`. After all candidates, it debug-logs `last_error` if any and returns `Ok(None)`.

**Call relations**: This private helper is the engine behind both `determine_streamable_http_auth_status` and `discover_streamable_http_oauth`. It delegates candidate generation to `discovery_paths`, header application to `apply_default_headers`, and scope cleanup to `normalize_scopes`.

*Call graph*: calls 3 internal fn (discovery_paths, normalize_scopes, apply_default_headers); called by 2 (determine_streamable_http_auth_status, discover_streamable_http_oauth); 3 external calls (parse, builder, debug!).


##### `normalize_scopes`  (lines 153–173)

```
fn normalize_scopes(scopes_supported: Option<Vec<String>>) -> Option<Vec<String>>
```

**Purpose**: Cleans up the optional `scopes_supported` list from discovery metadata by trimming whitespace, removing empty entries, and deduplicating while preserving first-seen order. It returns `None` when nothing meaningful remains.

**Data flow**: Takes `Option<Vec<String>>`; if `None`, returns `None` immediately. Otherwise it iterates through the vector, trims each scope, skips empties, converts the trimmed value back to `String`, pushes it into a new `Vec` only if not already present, and finally returns `Some(normalized)` unless the normalized vector is empty, in which case it returns `None`.

**Call relations**: Called only by `discover_streamable_http_oauth_with_headers` after successful metadata parsing, so callers receive a cleaned scope list instead of raw server-provided strings.

*Call graph*: called by 1 (discover_streamable_http_oauth_with_headers); 1 external calls (new).


##### `discovery_paths`  (lines 179–199)

```
fn discovery_paths(base_path: &str) -> Vec<String>
```

**Purpose**: Generates the ordered set of well-known OAuth discovery paths to try for a given base path, following RFC 8414-style conventions and avoiding duplicates. It handles both root and nested MCP paths.

**Data flow**: Takes `base_path: &str`, trims leading/trailing slashes, defines the canonical path `/.well-known/oauth-authorization-server`, and returns either `[canonical]` for an empty path or a deduplicated vector containing `canonical/trimmed`, `/trimmed/.well-known/oauth-authorization-server`, and `canonical` in that order.

**Call relations**: Used by `discover_streamable_http_oauth_with_headers` to decide which metadata endpoints to probe for a given server URL.

*Call graph*: called by 1 (discover_streamable_http_oauth_with_headers); 3 external calls (new, format!, vec!).


##### `tests::TestServer::drop`  (lines 219–221)

```
fn drop(&mut self)
```

**Purpose**: Stops the spawned test HTTP server when the helper struct goes out of scope. It ensures tests do not leave background tasks running.

**Data flow**: Mutably borrows `self` and calls `self.handle.abort()`. It returns `()` and performs no other cleanup.

**Call relations**: Triggered automatically at the end of tests that use `spawn_oauth_discovery_server`, providing teardown for the background Axum server task.

*Call graph*: 1 external calls (abort).


##### `tests::spawn_oauth_discovery_server`  (lines 224–247)

```
async fn spawn_oauth_discovery_server(metadata: serde_json::Value) -> TestServer
```

**Purpose**: Starts a temporary local Axum server that serves fixed OAuth discovery metadata at the expected well-known path for `/mcp`. It gives tests a controllable discovery target.

**Data flow**: Takes `metadata: serde_json::Value`, binds a Tokio TCP listener on `127.0.0.1:0`, reads the assigned address, builds a `Router` with a GET route at `/.well-known/oauth-authorization-server/mcp` returning `Json(metadata.clone())`, spawns `axum::serve(listener, app)`, and returns `TestServer { url: format!("http://{address}/mcp"), handle }`.

**Call relations**: Used by the discovery-related async tests to exercise `discover_streamable_http_oauth` and `supports_oauth_login` against a real HTTP endpoint.

*Call graph*: 7 external calls (new, clone, get, serve, format!, bind, spawn).


##### `tests::EnvVarGuard::set`  (lines 255–264)

```
fn set(key: &str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its previous value. It supports restoration in the guard’s `Drop` implementation.

**Data flow**: Takes `key` and `value`, reads the original value with `std::env::var_os(key)`, unsafely sets the new value with `std::env::set_var`, and returns `EnvVarGuard { key: key.to_string(), original }`.

**Call relations**: Used by the env-header auth-status test to inject a bearer token source that `build_default_headers` can resolve.

*Call graph*: 2 external calls (set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 268–278)

```
fn drop(&mut self)
```

**Purpose**: Restores the environment variable state captured by `EnvVarGuard::set`. It either resets the original value or removes the variable entirely.

**Data flow**: On drop, checks `self.original`; if present it unsafely calls `std::env::set_var(&self.key, value)`, otherwise it unsafely calls `std::env::remove_var(&self.key)`.

**Call relations**: Runs automatically after tests using `EnvVarGuard::set`, ensuring environment mutations do not leak across serial or unrelated tests.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::determine_auth_status_uses_bearer_token_when_authorization_header_present`  (lines 282–299)

```
async fn determine_auth_status_uses_bearer_token_when_authorization_header_present()
```

**Purpose**: Verifies that an explicit Authorization header in configured HTTP headers takes precedence and yields `BearerToken` without requiring URL validity or discovery. It checks the early-return path.

**Data flow**: Calls `determine_streamable_http_auth_status` with `http_headers` containing `Authorization: Bearer token`, no env headers, and default keyring backend, awaits the result, and asserts it equals `McpAuthStatus::BearerToken`.

**Call relations**: This test targets the branch in `determine_streamable_http_auth_status` immediately after `build_default_headers` where presence of `AUTHORIZATION` short-circuits all later OAuth logic.

*Call graph*: calls 2 internal fn (default, determine_streamable_http_auth_status); 2 external calls (from, assert_eq!).


##### `tests::determine_auth_status_uses_bearer_token_when_env_authorization_header_present`  (lines 303–321)

```
async fn determine_auth_status_uses_bearer_token_when_env_authorization_header_present()
```

**Purpose**: Checks that an Authorization header sourced indirectly from an environment variable is also recognized as bearer-token mode. It validates integration between env expansion and auth-status precedence.

**Data flow**: Creates an `EnvVarGuard` setting a token variable, calls `determine_streamable_http_auth_status` with `env_http_headers` mapping `Authorization` to that variable name, awaits the result, and asserts `BearerToken`.

**Call relations**: This test exercises the interaction between `build_default_headers` and `determine_streamable_http_auth_status`, proving env-derived Authorization headers trigger the same early return as explicit ones.

*Call graph*: calls 3 internal fn (set, default, determine_streamable_http_auth_status); 2 external calls (from, assert_eq!).


##### `tests::discover_streamable_http_oauth_returns_normalized_scopes`  (lines 324–345)

```
async fn discover_streamable_http_oauth_returns_normalized_scopes()
```

**Purpose**: Verifies that discovery succeeds when both OAuth endpoints are present and that scope normalization trims whitespace, removes empties, and deduplicates. It checks the exact shape of returned `scopes_supported`.

**Data flow**: Spawns a local discovery server returning metadata with authorization/token endpoints and a noisy `scopes_supported` array, calls `discover_streamable_http_oauth(&server.url, None, None).await`, unwraps the `Some` result, and asserts the scopes equal `["profile", "email"]`.

**Call relations**: This test drives the full discovery path through `discover_streamable_http_oauth`, `discover_streamable_http_oauth_with_headers`, and `normalize_scopes`.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); 3 external calls (assert_eq!, spawn_oauth_discovery_server, json!).


##### `tests::discover_streamable_http_oauth_ignores_empty_scopes`  (lines 348–366)

```
async fn discover_streamable_http_oauth_ignores_empty_scopes()
```

**Purpose**: Ensures that a discovery document with only blank scope strings still counts as OAuth-capable but returns `None` for `scopes_supported`. It validates the empty-result behavior of normalization.

**Data flow**: Starts a local server whose metadata includes valid endpoints and only empty/whitespace scopes, calls `discover_streamable_http_oauth`, unwraps the discovery result, and asserts `discovery.scopes_supported == None`.

**Call relations**: This test specifically targets `normalize_scopes` returning `None` after filtering all entries away, while discovery itself still succeeds.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); 3 external calls (assert_eq!, spawn_oauth_discovery_server, json!).


##### `tests::supports_oauth_login_does_not_require_scopes_supported`  (lines 369–381)

```
async fn supports_oauth_login_does_not_require_scopes_supported()
```

**Purpose**: Checks that OAuth support detection depends only on the presence of authorization and token endpoints, not on `scopes_supported`. It guards against over-strict discovery requirements.

**Data flow**: Spawns a local server returning metadata with only `authorization_endpoint` and `token_endpoint`, calls `supports_oauth_login(&server.url).await`, and asserts the boolean is true.

**Call relations**: This test exercises the simplified wrapper `supports_oauth_login`, which delegates to `discover_streamable_http_oauth` and succeeds even when scope metadata is absent.

*Call graph*: calls 1 internal fn (supports_oauth_login); 3 external calls (assert!, spawn_oauth_discovery_server, json!).


### `codex-mcp/src/mcp/auth.rs`

`domain_logic` · `auth discovery and snapshot collection`

This file concentrates the auth-facing logic for MCP servers. Its small data types capture three distinct concerns: `McpOAuthLoginConfig` describes a streamable-HTTP server that can participate in OAuth login, `McpOAuthLoginSupport` distinguishes supported/unsupported/errored discovery outcomes, and `ResolvedMcpOAuthScopes` records both the chosen scope list and whether it came from explicit input, config, discovery, or an empty fallback. The scope resolver is intentionally precedence-based: explicit scopes always win, configured scopes override discovery even when configured as an empty list, and discovered scopes are only used when non-empty. That preserves user intent and avoids silently broadening requests.

For runtime status collection, the file walks effective servers concurrently with `join_all`, cloning each server name and optional configured `McpServerConfig` into a `McpAuthStatusEntry`. A special case marks the built-in `codex_apps` server as `BearerToken` when ChatGPT-backed runtime auth is active and the transport does not already specify a bearer-token environment variable. Disabled servers, stdio transports, missing configs, and failures to inspect auth all collapse to `McpAuthStatus::Unsupported`, with failures logged via `tracing::warn` rather than propagated. Streamable HTTP auth determination is delegated to `codex_rmcp_client`, but this file decides when that machinery is applicable and how errors affect user-visible status. The included tests pin down subtle scope precedence and retry behavior for provider-side `invalid_scope` style failures.

#### Function details

##### `oauth_login_support`  (lines 55–81)

```
async fn oauth_login_support(transport: &McpServerTransportConfig) -> McpOAuthLoginSupport
```

**Purpose**: Checks whether a transport can use Codex's interactive OAuth login flow. It only considers `McpServerTransportConfig::StreamableHttp` transports without a configured bearer-token environment variable, then performs OAuth discovery against the server URL.

**Data flow**: Reads a borrowed `McpServerTransportConfig`. If the transport is not `StreamableHttp`, or if `bearer_token_env_var` is present, it immediately returns `McpOAuthLoginSupport::Unsupported`. Otherwise it clones the URL and optional header maps, calls remote discovery, and converts `Ok(Some(...))` into `Supported(McpOAuthLoginConfig { url, http_headers, env_http_headers, discovered_scopes })`, `Ok(None)` into `Unsupported`, and discovery errors into `Unknown(anyhow::Error)`.

**Call relations**: This is the primitive used by `discover_supported_scopes` when callers only need scopes. Its main delegation is to `discover_streamable_http_oauth`, because this file decides eligibility for discovery while the external client library performs the actual protocol probe.

*Call graph*: called by 1 (discover_supported_scopes); 3 external calls (Supported, Unknown, discover_streamable_http_oauth).


##### `discover_supported_scopes`  (lines 83–90)

```
async fn discover_supported_scopes(
    transport: &McpServerTransportConfig,
) -> Option<Vec<String>>
```

**Purpose**: Extracts only the discovered OAuth scopes for a transport, if interactive OAuth login is supported. Unsupported transports and discovery failures both collapse to `None`.

**Data flow**: Accepts a borrowed `McpServerTransportConfig`, awaits `oauth_login_support`, and pattern-matches the result. It returns `config.discovered_scopes` from the supported case and `None` for unsupported or unknown outcomes.

**Call relations**: This is a thin convenience wrapper over `oauth_login_support`, used when callers do not need the full login configuration or error classification.

*Call graph*: calls 1 internal fn (oauth_login_support).


##### `resolve_oauth_scopes`  (lines 92–124)

```
fn resolve_oauth_scopes(
    explicit_scopes: Option<Vec<String>>,
    configured_scopes: Option<Vec<String>>,
    discovered_scopes: Option<Vec<String>>,
) -> ResolvedMcpOAuthScopes
```

**Purpose**: Chooses the final OAuth scope list from explicit input, server configuration, and discovery results, while recording where that choice came from. It preserves an explicitly empty configured scope list instead of falling through to discovery.

**Data flow**: Consumes three `Option<Vec<String>>` inputs in priority order. It returns a `ResolvedMcpOAuthScopes` containing the first applicable vector and a matching `McpOAuthScopesSource`: `Explicit`, then `Configured`, then non-empty `Discovered`; if none apply, it returns an empty vector with source `Empty`.

**Call relations**: This function is exercised directly by the unit tests in this file, which verify the precedence rules and the special handling of empty configured scopes. It is pure logic and does not delegate to runtime services.

*Call graph*: called by 5 (resolve_oauth_scopes_falls_back_to_empty, resolve_oauth_scopes_prefers_configured_over_discovered, resolve_oauth_scopes_prefers_explicit, resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes, resolve_oauth_scopes_uses_discovered_when_needed); 1 external calls (new).


##### `should_retry_without_scopes`  (lines 126–129)

```
fn should_retry_without_scopes(scopes: &ResolvedMcpOAuthScopes, error: &anyhow::Error) -> bool
```

**Purpose**: Decides whether an OAuth login attempt should be retried with no scopes after a failure. The retry is only allowed when the rejected scopes came from discovery rather than explicit or configured input.

**Data flow**: Reads a `ResolvedMcpOAuthScopes` and an `anyhow::Error`. It returns `true` only if `scopes.source == McpOAuthScopesSource::Discovered` and the error can be downcast to `OAuthProviderError`; otherwise it returns `false`.

**Call relations**: This is standalone decision logic used by higher-level OAuth flows to avoid overriding explicit user or config choices while still recovering from provider-side scope rejection.


##### `compute_auth_statuses`  (lines 131–186)

```
async fn compute_auth_statuses(
    servers: I,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    auth: Option<&CodexAuth>,
) -> HashMap<String, McpAuthS
```

**Purpose**: Builds a map of auth status entries for all effective MCP servers concurrently. It preserves each server's optional configured config alongside the computed `McpAuthStatus`.

**Data flow**: Consumes an iterable of `(&String, &EffectiveMcpServer)` plus credential-store settings and optional runtime `CodexAuth`. For each server it clones the name, clones any configured config, computes a `has_runtime_auth` flag for the special `codex_apps` case, then either awaits `compute_auth_status` or falls back to `Unsupported` on missing config or errors. It logs failures, wraps the result in `McpAuthStatusEntry { config, auth_status }`, and collects all `(name, entry)` pairs into a `HashMap<String, McpAuthStatusEntry>` after `join_all`.

**Call relations**: This function is invoked by both snapshot collection and direct resource reads before constructing an `McpConnectionManager`. It delegates per-server classification to `compute_auth_status`, while owning the fan-out/fan-in concurrency and the special runtime-auth shortcut for the built-in apps server.

*Call graph*: called by 2 (collect_mcp_server_status_snapshot_with_detail, read_mcp_resource); 2 external calls (into_iter, join_all).


##### `compute_auth_status`  (lines 188–223)

```
async fn compute_auth_status(
    server_name: &str,
    config: &McpServerConfig,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    has_runtime_auth: bo
```

**Purpose**: Computes the auth status for one configured MCP server. It short-circuits disabled servers and runtime-authenticated apps servers before consulting transport-specific auth inspection.

**Data flow**: Reads `server_name`, a borrowed `McpServerConfig`, credential-store settings, and `has_runtime_auth`. If `config.enabled` is false it returns `Unsupported`; if `has_runtime_auth` is true it returns `BearerToken`. Otherwise it matches on `config.transport`: `Stdio` returns `Unsupported`, while `StreamableHttp` clones headers and forwards URL, optional bearer-token env var, and storage settings to `determine_streamable_http_auth_status`, returning that async result.

**Call relations**: This is the per-server worker used by `compute_auth_statuses`. It delegates actual HTTP/OAuth/keyring inspection to `determine_streamable_http_auth_status`, keeping transport gating and built-in shortcuts local to this crate.

*Call graph*: 1 external calls (determine_streamable_http_auth_status).


##### `tests::resolve_oauth_scopes_prefers_explicit`  (lines 237–251)

```
fn resolve_oauth_scopes_prefers_explicit()
```

**Purpose**: Verifies that explicit scopes override both configured and discovered scopes. The test locks in the highest-precedence branch of `resolve_oauth_scopes`.

**Data flow**: Constructs three non-empty scope vectors, passes them to `resolve_oauth_scopes`, and asserts that the returned struct contains only the explicit vector with source `Explicit`.

**Call relations**: This unit test directly exercises `resolve_oauth_scopes` under the all-inputs-present condition to document intended precedence.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_prefers_configured_over_discovered`  (lines 254–268)

```
fn resolve_oauth_scopes_prefers_configured_over_discovered()
```

**Purpose**: Verifies that configured scopes win when explicit scopes are absent. It ensures discovery does not override persisted configuration.

**Data flow**: Calls `resolve_oauth_scopes` with `None` for explicit scopes and non-empty configured and discovered vectors, then asserts the result contains the configured vector and source `Configured`.

**Call relations**: This test covers the second precedence branch of `resolve_oauth_scopes`.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_uses_discovered_when_needed`  (lines 271–285)

```
fn resolve_oauth_scopes_uses_discovered_when_needed()
```

**Purpose**: Verifies that discovered scopes are used only when neither explicit nor configured scopes are supplied. It confirms the fallback-to-discovery path.

**Data flow**: Passes `None` for explicit and configured scopes and a non-empty discovered vector into `resolve_oauth_scopes`, then asserts the returned scopes and source are `Discovered`.

**Call relations**: This test documents the intended use of discovery as a fallback rather than a primary source.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes`  (lines 288–302)

```
fn resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes()
```

**Purpose**: Verifies that an explicitly configured empty scope list is preserved. This prevents accidental fallback to discovered scopes when config intentionally requests none.

**Data flow**: Calls `resolve_oauth_scopes` with `None` explicit scopes, `Some(Vec::new())` configured scopes, and a non-empty discovered vector, then asserts the result is an empty vector with source `Configured`.

**Call relations**: This test captures a subtle invariant in `resolve_oauth_scopes`: `Some(empty)` is meaningful and distinct from `None`.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 3 external calls (new, assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_falls_back_to_empty`  (lines 305–318)

```
fn resolve_oauth_scopes_falls_back_to_empty()
```

**Purpose**: Verifies the final fallback when no scope source is available. It ensures the resolver returns a stable empty result rather than `None`.

**Data flow**: Invokes `resolve_oauth_scopes` with all three inputs absent and asserts that the returned struct contains an empty vector and source `Empty`.

**Call relations**: This test covers the terminal branch of the scope-resolution decision tree.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 1 external calls (assert_eq!).


##### `tests::should_retry_without_scopes_only_for_discovered_provider_errors`  (lines 321–342)

```
fn should_retry_without_scopes_only_for_discovered_provider_errors()
```

**Purpose**: Verifies that retry-without-scopes is limited to provider errors on discovered scopes. It rejects retries for configured scopes and for unrelated error types.

**Data flow**: Builds a discovered-scope `ResolvedMcpOAuthScopes`, wraps an `OAuthProviderError` in `anyhow!`, and asserts `should_retry_without_scopes` returns true. It then constructs a configured-scope variant and a generic timeout error and asserts both return false.

**Call relations**: This test documents the narrow recovery policy encoded by `should_retry_without_scopes`.

*Call graph*: 3 external calls (anyhow!, assert!, vec!).


### Backend-authenticated account action
Uses the adapted backend authentication machinery to execute an authenticated account rate-limit reset operation.

### `app-server/src/request_processors/account_processor/rate_limit_resets.rs`

`domain_logic` · `request handling`

This small extension module keeps the rate-limit-reset-credit flow separate from the rest of account processing. The public method, `consume_account_rate_limit_reset_credit`, is a JSON-RPC-facing operation that first rejects empty `idempotency_key` values, then obtains a backend client through a dedicated helper that enforces both authentication presence and the requirement that the current auth uses the Codex backend rather than plain ChatGPT auth.

The backend call is wrapped in a timeout (`RATE_LIMIT_RESET_REQUEST_TIMEOUT`, 10 seconds by default). In debug builds, that timeout can be overridden via `CODEX_TEST_RATE_LIMIT_RESET_REQUEST_TIMEOUT_MS`, which is useful for tests or local fault injection. After the backend responds, the method translates `BackendConsumeRateLimitResetCreditCode` into the protocol enum `ConsumeAccountRateLimitResetCreditOutcome`, preserving the four distinct cases: `Reset`, `NothingToReset`, `NoCredit`, and `AlreadyRedeemed`.

The helper `rate_limit_reset_backend_client` centralizes auth validation and backend-client construction, returning user-facing `invalid_request` errors for missing/wrong auth mode and `internal_error` for client-construction failures. The main invariant is that this operation is only available to authenticated Codex-backend users and is always idempotency-keyed.

#### Function details

##### `AccountRequestProcessor::consume_account_rate_limit_reset_credit`  (lines 9–49)

```
async fn consume_account_rate_limit_reset_credit(
        &self,
        params: ConsumeAccountRateLimitResetCreditParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Consumes one rate-limit reset credit through the backend and returns the resulting outcome as a protocol response.

**Data flow**: Takes `ConsumeAccountRateLimitResetCreditParams`, rejects empty `idempotency_key` with `invalid_request`, awaits `rate_limit_reset_backend_client()`, chooses a timeout from the constant or debug env override, wraps `client.consume_rate_limit_reset_credit(&params.idempotency_key)` in `tokio::time::timeout`, maps timeout/backend failures to internal errors, converts the backend response code into `ConsumeAccountRateLimitResetCreditOutcome`, wraps it in `ConsumeAccountRateLimitResetCreditResponse`, converts that into `ClientResponsePayload`, and returns it inside `Some`.

**Call relations**: Called by the account request dispatcher when the client invokes the rate-limit reset credit consumption API.

*Call graph*: calls 1 internal fn (rate_limit_reset_backend_client); 2 external calls (var, timeout).


##### `AccountRequestProcessor::rate_limit_reset_backend_client`  (lines 51–65)

```
async fn rate_limit_reset_backend_client(&self) -> Result<BackendClient, JSONRPCErrorError>
```

**Purpose**: Builds an authenticated backend client for rate-limit reset operations after enforcing the required auth mode.

**Data flow**: Awaits `auth_manager.auth()`, returns `invalid_request` if no auth is present or if the auth does not use the Codex backend, otherwise constructs `BackendClient::from_auth(self.config.chatgpt_base_url.clone(), &auth)` and maps construction failures to `internal_error`.

**Call relations**: Used only by `consume_account_rate_limit_reset_credit` to centralize auth validation and client creation.

*Call graph*: called by 1 (consume_account_rate_limit_reset_credit); 1 external calls (from_auth).
