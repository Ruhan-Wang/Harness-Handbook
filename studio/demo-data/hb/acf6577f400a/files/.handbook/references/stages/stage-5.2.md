# Provider and backend auth adaptation  `stage-5.2`

This stage is shared behind-the-scenes support. It prepares the “ID badges” that later network clients attach to HTTP, websocket, and RPC requests. The model-provider front door and provider definition describe what a model service needs: its address, credentials, models, and features. The auth files then turn saved logins, provider API keys, external token commands, account routing IDs, and FedRAMP markers into bearer-token headers.

For Amazon Bedrock, the Bedrock files choose between a simple bearer token and AWS SigV4, Amazon’s method of signing a request to prove who sent it and that it was not changed. The AWS helper files load credentials and region settings, check they are usable, and add those signatures.

Agent identity files create or read cryptographic keys, register the running agent task, verify identity tokens, and build signed headers proving which agent made a request. The API auth and attestation files give the rest of the system one simple plug-in point for auth and optional proof metadata. Remote-control and MCP auth files decide when ChatGPT, bearer, or OAuth login is needed. The rate-limit reset processor uses backend auth to safely call an account action.

## Files in this stage

### Provider runtime surface
Defines the public model-provider API and the main runtime wiring that selects and configures generic versus Bedrock-backed providers.

### `model-provider/src/lib.rs`

`other` · `cross-cutting library interface`

This file does not contain the provider logic itself. Instead, it works like the reception desk of the crate, which is Rust’s name for a library package. It names the internal modules that make up model-provider, such as authentication, bearer-token authentication, Amazon Bedrock support, model endpoint access, and the core provider code.

Its main job is to provide a clean public interface. The internal files can stay organized by topic, while users of this library can import the important items from one place. For example, outside code can ask for `ModelProvider`, `create_model_provider`, or `BearerAuthProvider` without needing to know which internal source file defines them.

This matters because it keeps the rest of the project from depending on the library’s private folder layout. If the implementation moves around later, callers do not have to change as long as this public surface stays the same. It also makes intentional choices about what is public: account types, provider state and capability types, authentication helpers, and provider construction are exposed, while lower-level details remain inside their modules.


### `model-provider/src/provider.rs`

`domain_logic` · `cross-cutting: provider setup, request preparation, account display, and model catalog refresh`

Codex can talk to more than one kind of model service. This file is the shared front desk for those services. Instead of the rest of the app needing to know every provider’s quirks, it can ask a `ModelProvider` for the same basic things: provider settings, login information, account state, feature limits, the base URL to call, and a model catalog manager.

The key idea is a trait, `ModelProvider`, which is like a contract: every provider must be able to answer these questions, though it may answer them differently. The default `ConfiguredModelProvider` covers normal configured OpenAI-compatible providers. Amazon Bedrock is special, so `create_model_provider` detects it and builds an Amazon Bedrock provider instead.

The file also defines provider capabilities, such as whether web search or image generation should be exposed. These are upper bounds: the provider can say “this is not supported,” and the app must not show that feature even if another setting would allow it.

Authentication is central here. The provider can return an authentication manager, fetch current credentials, translate those credentials into API-client form, and describe the user-visible account state. For model lists, it either uses a static catalog supplied by configuration or creates a manager that fetches models from a provider endpoint. The tests check these important boundaries, especially account reporting, Bedrock behavior, and token use.

#### Function details

##### `ProviderCapabilities::default`  (lines 36–42)

```
fn default() -> Self
```

**Purpose**: Creates the normal capability set for a provider. By default, Codex assumes provider-backed tools such as namespace tools, image generation, and web search are allowed unless a provider says otherwise.

**Data flow**: No outside input is needed. It builds a `ProviderCapabilities` value with all three feature flags set to true, then returns that value.

**Call relations**: The default `ModelProvider::capabilities` method calls this when a provider has not supplied stricter limits. Provider implementations can override the default if some features should be hidden.

*Call graph*: called by 1 (capabilities).


##### `ProviderAccountError::fmt`  (lines 60–75)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns account-state errors into clear human-readable messages. This matters because callers may need to show why Codex cannot describe or use a provider account.

**Data flow**: It receives one specific `ProviderAccountError` value and a formatter. It chooses the matching message, writes that message into the formatter, and returns the formatting result.

**Call relations**: This is used through Rust’s standard display mechanism whenever an account error is printed or converted to text. It delegates the actual text writing to the formatter.

*Call graph*: 1 external calls (write!).


##### `ModelProvider::capabilities`  (lines 104–106)

```
fn capabilities(&self) -> ProviderCapabilities
```

**Purpose**: Gives callers the provider’s feature limits. The default answer is that all optional provider-backed features are available.

**Data flow**: It reads no provider-specific data in the default implementation. It asks `ProviderCapabilities::default` for the standard all-enabled capability set and returns it.

**Call relations**: Code that wants to decide whether to expose provider-backed features can call this through the `ModelProvider` trait. Special providers can replace this default with a narrower answer.

*Call graph*: calls 1 internal fn (default).


##### `ModelProvider::approval_review_preferred_model`  (lines 111–113)

```
fn approval_review_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the model name Codex should prefer for automatic approval review when the provider does not need a special backend-specific model ID.

**Data flow**: It takes the provider object as context but reads no stored fields in the default implementation. It returns the shared default approval-review model string.

**Call relations**: Callers use this through the provider abstraction when choosing a model for approval review. Providers with different model naming rules can override it.


##### `ModelProvider::memory_extraction_preferred_model`  (lines 118–120)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the default model name Codex should use when extracting useful memory from interactions. It gives ordinary providers a common fallback.

**Data flow**: It receives the provider object but does not inspect it by default. It returns the shared default memory-extraction model string.

**Call relations**: Memory-related code can ask the active provider for this preference without knowing what kind of provider it is. Providers may override it when their model IDs differ.


##### `ModelProvider::memory_consolidation_preferred_model`  (lines 125–127)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Returns the default model name Codex should use when combining or cleaning up stored memories. It supplies a provider-neutral fallback.

**Data flow**: It uses no input other than being called on a provider. It returns the shared default memory-consolidation model string.

**Call relations**: Memory consolidation code calls this through the provider interface. Providers that require special model IDs can provide their own answer.


##### `ModelProvider::supports_attestation`  (lines 130–132)

```
fn supports_attestation(&self) -> bool
```

**Purpose**: Says whether requests through this provider should include attestation, which is extra proof about the client or session. The default is no.

**Data flow**: It reads no provider data in the default implementation. It simply returns false.

**Call relations**: Request-building code can ask this before adding attestation data. `ConfiguredModelProvider` overrides it for ChatGPT-style authentication.


##### `ModelProvider::api_provider`  (lines 149–155)

```
fn api_provider(&self) -> ModelProviderFuture<'_, codex_protocol::error::Result<Provider>>
```

**Purpose**: Builds the provider configuration in the form expected by the API client. It combines static provider settings with the current authentication mode.

**Data flow**: It starts with the provider object. When awaited, it fetches current auth, extracts the auth mode if auth exists, asks the provider info to convert itself into API-client settings, and returns either that configuration or an error.

**Call relations**: This default trait method is available to all provider implementations. It packages the work as an asynchronous future so callers can await it during request setup.

*Call graph*: 1 external calls (pin).


##### `ModelProvider::runtime_base_url`  (lines 158–162)

```
fn runtime_base_url(
        &self,
    ) -> ModelProviderFuture<'_, codex_protocol::error::Result<Option<String>>>
```

**Purpose**: Returns the base URL that requests should use for this provider at runtime. The default is the URL stored in provider configuration.

**Data flow**: It reads the provider info’s `base_url` field, clones that optional string, wraps it in a successful result, and returns it asynchronously.

**Call relations**: Request setup code can call this through any `ModelProvider`. Providers with dynamic endpoint rules can override it.

*Call graph*: 1 external calls (pin).


##### `ModelProvider::api_auth`  (lines 165–172)

```
fn api_auth(
        &self,
    ) -> ModelProviderFuture<'_, codex_protocol::error::Result<SharedAuthProvider>>
```

**Purpose**: Creates the credential-attaching object used by the API client. In plain terms, it decides how requests will prove they are allowed to use the provider.

**Data flow**: When awaited, it fetches current provider auth, reads provider metadata, passes both to `resolve_provider_auth`, and returns either a shared auth provider or an error.

**Call relations**: This default trait method is part of request preparation. It hands off the provider-specific credential decision to the auth helper so the API client receives a uniform auth object.

*Call graph*: 2 external calls (pin, resolve_provider_auth).


##### `create_model_provider`  (lines 188–197)

```
fn create_model_provider(
    provider_info: ModelProviderInfo,
    auth_manager: Option<Arc<AuthManager>>,
) -> SharedModelProvider
```

**Purpose**: Builds the runtime provider object for configured provider settings. It is the main factory that chooses between the special Amazon Bedrock implementation and the normal configured provider.

**Data flow**: It receives provider metadata and an optional authentication manager. It checks whether the metadata describes Amazon Bedrock; if so, it constructs an Amazon Bedrock provider, otherwise it constructs a `ConfiguredModelProvider`. In both cases it returns the result behind a shared reference-counted handle so many parts of the app can use it safely.

**Call relations**: Many tests call this because it is the public doorway into this file’s behavior. In production, higher-level setup code would call it after loading provider configuration, then pass the shared provider through the rest of the system.

*Call graph*: calls 3 internal fn (is_amazon_bedrock, new, new); called by 15 (amazon_bedrock_provider_creates_static_models_manager, amazon_bedrock_provider_returns_bedrock_account_state, configured_bedrock_catalog_only_allows_default_service_tier, configured_provider_models_manager_uses_provider_bearer_token, configured_provider_runtime_base_url_uses_configured_base_url, configured_provider_uses_default_approval_review_preferred_model, configured_provider_uses_default_capabilities, create_model_provider_builds_command_auth_manager_without_base_manager, create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider, create_model_provider_uses_managed_auth_for_amazon_bedrock_provider (+5 more)); 1 external calls (new).


##### `ConfiguredModelProvider::new`  (lines 207–213)

```
fn new(provider_info: ModelProviderInfo, auth_manager: Option<Arc<AuthManager>>) -> Self
```

**Purpose**: Creates the standard provider implementation from provider metadata and optional authentication. It also adapts the authentication manager so it matches this specific provider’s rules.

**Data flow**: It receives `ModelProviderInfo` and maybe an `AuthManager`. It asks `auth_manager_for_provider` whether that manager should be used, replaced, or omitted for this provider, then stores the provider info and resulting auth manager in a new `ConfiguredModelProvider`.

**Call relations**: `create_model_provider` calls this for non-Bedrock providers. It is the setup step that keeps later provider methods from needing to repeat auth-manager selection logic.

*Call graph*: calls 1 internal fn (auth_manager_for_provider); called by 1 (create_model_provider).


##### `ConfiguredModelProvider::info`  (lines 217–219)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Returns the stored provider metadata for a configured provider. This metadata contains settings such as name, base URL, auth requirements, retry limits, and protocol style.

**Data flow**: It receives the provider object and returns a shared reference to its stored `ModelProviderInfo`. Nothing is copied or changed.

**Call relations**: This fulfills the required `ModelProvider::info` contract for `ConfiguredModelProvider`. Default trait methods such as API provider and base URL resolution rely on this information.


##### `ConfiguredModelProvider::auth_manager`  (lines 221–223)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Returns the authentication manager attached to this provider, if it has one. The manager is the object that can cache, refresh, or fetch credentials.

**Data flow**: It reads the provider’s optional auth manager, clones the shared handle if present, and returns it. The underlying manager is not duplicated; the clone is another pointer to the same shared object.

**Call relations**: Callers and tests use this through the `ModelProvider` trait to inspect whether a provider has provider-scoped authentication available.


##### `ConfiguredModelProvider::supports_attestation`  (lines 225–230)

```
fn supports_attestation(&self) -> bool
```

**Purpose**: Reports whether this configured provider should include attestation with requests. It returns true only when cached authentication is ChatGPT-style auth.

**Data flow**: It looks for an auth manager, asks it for cached auth, and checks whether that auth is ChatGPT authentication. If any piece is missing or the auth is a different kind, it returns false.

**Call relations**: This overrides the trait’s default false answer. Request-building code can ask the active provider and only attach attestation when this method says it is supported.


##### `ConfiguredModelProvider::auth`  (lines 232–239)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Fetches the current authentication value for this provider. If the provider has no auth manager, it reports that no auth is available.

**Data flow**: It creates an asynchronous operation. When awaited, that operation checks whether an auth manager exists; if it does, it awaits the manager’s current auth value, otherwise it returns `None`.

**Call relations**: Default trait methods such as `api_provider` and `api_auth` use provider auth to prepare requests. This implementation supplies that value for ordinary configured providers.

*Call graph*: 1 external calls (pin).


##### `ConfiguredModelProvider::account_state`  (lines 241–281)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Builds the account information that the app can show for this provider. It distinguishes no-auth state, API-key state, ChatGPT account state, and unsupported Bedrock API-key use.

**Data flow**: It first checks whether this provider requires OpenAI authentication. If not, it returns no account and marks auth as not required. If auth is required, it reads cached auth only when there is no refresh failure. API keys become an API-key account, ChatGPT-like auth must provide both email and plan type, and Bedrock API-key auth becomes an error. The result is a `ProviderAccountState` or a specific account error.

**Call relations**: UI or status code can call this through the provider to describe the active account. The tests exercise the main paths: unauthenticated OpenAI, API key, incomplete ChatGPT details, wrong Bedrock auth, and non-OpenAI providers.


##### `ConfiguredModelProvider::models_manager`  (lines 283–305)

```
fn models_manager(
        &self,
        codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> SharedModelsManager
```

**Purpose**: Creates the object that knows how to list models for this configured provider. It chooses between a fixed catalog from configuration and a live OpenAI-compatible `/models` endpoint.

**Data flow**: It receives the Codex home directory and an optional model catalog. If a catalog is provided, it builds a static manager around that catalog. If not, it builds an `OpenAiModelsEndpoint` from provider info and auth, then creates an `OpenAiModelsManager` that can fetch and cache models using that endpoint. It returns the chosen manager behind a shared handle.

**Call relations**: Model discovery code asks the provider for this manager after provider setup. Tests verify that configured providers use provider tokens correctly and that catalog choices behave as expected.

*Call graph*: calls 3 internal fn (new, new, new); 2 external calls (new, clone).


##### `tests::provider_info_with_command_auth`  (lines 330–345)

```
fn provider_info_with_command_auth() -> ModelProviderInfo
```

**Purpose**: Creates test provider metadata that uses an external command to obtain authentication. This lets tests verify command-based auth setup without needing a real provider.

**Data flow**: It starts from OpenAI-style provider defaults, fills in command-auth settings such as command name, timeout, refresh interval, and current working directory, and returns the completed `ModelProviderInfo`.

**Call relations**: The command-auth test calls this helper, then passes the result to `create_model_provider` to check that a provider-scoped auth manager is created.

*Call graph*: calls 1 internal fn (create_openai_provider); 3 external calls (new, new, current_dir).


##### `tests::test_codex_home`  (lines 347–349)

```
fn test_codex_home() -> std::path::PathBuf
```

**Purpose**: Builds a temporary Codex home path for tests. It keeps model-manager test files away from a real user’s configuration.

**Data flow**: It reads the system temporary directory and the current process ID, combines them into a unique-looking directory name, and returns that path.

**Call relations**: Model-manager tests call this when they need a home directory argument. It is test plumbing, not production behavior.

*Call graph*: 2 external calls (format!, temp_dir).


##### `tests::provider_for`  (lines 351–371)

```
fn provider_for(base_url: String) -> ModelProviderInfo
```

**Purpose**: Creates simple provider metadata for a mock HTTP server. Tests use it when they need a provider with a known base URL and no real authentication requirement.

**Data flow**: It receives a base URL string, fills a `ModelProviderInfo` with that URL and predictable test settings such as zero retries, and returns the metadata.

**Call relations**: Runtime-base-URL and remote-model-catalog tests use this helper before calling `create_model_provider`.


##### `tests::remote_model`  (lines 373–398)

```
fn remote_model(slug: &str) -> ModelInfo
```

**Purpose**: Creates a realistic model entry for tests from a short model slug. This avoids repeating a large model JSON object in every test.

**Data flow**: It receives a slug string, inserts it into a JSON value with all required model fields, parses that JSON into a `ModelInfo`, and returns the parsed model. If the test data is invalid, the test fails immediately.

**Call relations**: The provider-token model-manager test uses this helper to prepare the fake server’s `/models` response.

*Call graph*: 2 external calls (json!, from_value).


##### `tests::bedrock_api_key_auth`  (lines 400–405)

```
fn bedrock_api_key_auth() -> CodexAuth
```

**Purpose**: Creates a fake Amazon Bedrock API-key authentication value for tests. It gives tests a consistent Bedrock credential without using a real secret.

**Data flow**: It constructs a `CodexAuth::BedrockApiKey` value with a test API key and AWS region, then returns it.

**Call relations**: Tests use this helper when checking Bedrock auth behavior and when verifying that ordinary OpenAI providers reject Bedrock API-key account state.

*Call graph*: 1 external calls (BedrockApiKey).


##### `tests::configured_provider_uses_default_capabilities`  (lines 408–415)

```
fn configured_provider_uses_default_capabilities()
```

**Purpose**: Checks that a normal configured provider uses the standard capability set. This protects the default behavior that optional provider-backed features start enabled.

**Data flow**: It creates OpenAI-style provider info, builds a provider with no auth manager, asks for capabilities, and compares the result to `ProviderCapabilities::default`.

**Call relations**: This test goes through `create_model_provider`, so it verifies the public construction path rather than directly constructing the implementation.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::configured_provider_uses_default_approval_review_preferred_model`  (lines 418–428)

```
fn configured_provider_uses_default_approval_review_preferred_model()
```

**Purpose**: Checks that a normal configured provider returns the shared default model for approval review. This catches accidental changes to the provider default.

**Data flow**: It builds an OpenAI-style provider, asks it for the approval-review preferred model, and compares the answer to the default constant.

**Call relations**: The test uses `create_model_provider` and then calls the trait method as production code would.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::configured_provider_runtime_base_url_uses_configured_base_url`  (lines 431–444)

```
async fn configured_provider_runtime_base_url_uses_configured_base_url()
```

**Purpose**: Checks that the runtime base URL comes from provider configuration for a normal provider. This is important because requests must go to the user-configured endpoint.

**Data flow**: It creates provider metadata with `https://example.test/v1`, builds a provider, awaits `runtime_base_url`, and verifies that the same URL comes back.

**Call relations**: This test exercises the default trait method through a provider made by `create_model_provider`.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (assert_eq!, provider_for).


##### `tests::create_model_provider_builds_command_auth_manager_without_base_manager`  (lines 447–458)

```
fn create_model_provider_builds_command_auth_manager_without_base_manager()
```

**Purpose**: Checks that command-based provider auth works even when no general auth manager is supplied. This supports providers whose tokens come from an external command.

**Data flow**: It creates provider info with command auth, builds a provider with no base auth manager, retrieves the provider’s auth manager, and asserts that it reports external auth support.

**Call relations**: The test connects `provider_info_with_command_auth`, `create_model_provider`, and `ConfiguredModelProvider::new` behavior through the public trait interface.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (assert!, provider_info_with_command_auth).


##### `tests::create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider`  (lines 461–473)

```
fn create_model_provider_does_not_use_openai_auth_manager_for_amazon_bedrock_provider()
```

**Purpose**: Checks that an OpenAI API-key auth manager is not incorrectly reused for an Amazon Bedrock provider configured for AWS-managed credentials. This prevents credentials for one service from leaking into another.

**Data flow**: It creates Bedrock provider info with AWS profile settings and supplies an OpenAI API-key auth manager. After building the provider, it checks that the provider exposes no auth manager.

**Call relations**: This test verifies the Bedrock branch in `create_model_provider` and the special auth rules of the Amazon Bedrock provider.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_amazon_bedrock_provider, create_model_provider); 1 external calls (assert!).


##### `tests::create_model_provider_uses_managed_auth_for_amazon_bedrock_provider`  (lines 476–484)

```
async fn create_model_provider_uses_managed_auth_for_amazon_bedrock_provider()
```

**Purpose**: Checks that Amazon Bedrock can use a managed Bedrock API-key auth value when that is the auth supplied. This protects the supported Bedrock API-key path.

**Data flow**: It creates fake Bedrock API-key auth, wraps it in a test auth manager, builds a Bedrock provider, awaits provider auth, and compares the returned auth to the original value.

**Call relations**: The test uses `bedrock_api_key_auth` and `create_model_provider` to confirm that Bedrock-specific provider construction preserves appropriate auth.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_amazon_bedrock_provider, create_model_provider); 2 external calls (assert_eq!, bedrock_api_key_auth).


##### `tests::openai_provider_returns_unauthenticated_openai_account_state`  (lines 487–500)

```
fn openai_provider_returns_unauthenticated_openai_account_state()
```

**Purpose**: Checks what account state an OpenAI provider reports when no auth is available. The expected state is that auth is required but no account is currently known.

**Data flow**: It builds an OpenAI provider with no auth manager, calls `account_state`, and compares the result to an empty account with `requires_openai_auth` set to true.

**Call relations**: This test exercises `ConfiguredModelProvider::account_state` through the normal provider factory.

*Call graph*: calls 2 internal fn (create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_returns_api_key_account_state`  (lines 503–518)

```
fn openai_provider_returns_api_key_account_state()
```

**Purpose**: Checks that an OpenAI provider using an API key reports an API-key account state. This lets the app show a sensible account status without exposing the key itself.

**Data flow**: It creates a test OpenAI API-key auth manager, builds an OpenAI provider, calls `account_state`, and expects `ProviderAccount::ApiKey` with OpenAI auth required.

**Call relations**: The test goes through `create_model_provider`, then verifies the API-key branch inside `ConfiguredModelProvider::account_state`.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_rejects_chatgpt_account_state_without_email`  (lines 521–533)

```
fn openai_provider_rejects_chatgpt_account_state_without_email()
```

**Purpose**: Checks that ChatGPT-style auth is not shown as a complete account unless it includes required account details. Email and plan type are needed for the app-visible account record.

**Data flow**: It builds an OpenAI provider with dummy ChatGPT auth that lacks full account details, calls `account_state`, and expects the missing-details error.

**Call relations**: This protects the validation path in `ConfiguredModelProvider::account_state` for ChatGPT-like authentication.

*Call graph*: calls 4 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_openai_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::openai_provider_rejects_bedrock_api_key_account_state`  (lines 536–546)

```
fn openai_provider_rejects_bedrock_api_key_account_state()
```

**Purpose**: Checks that a normal OpenAI provider does not accept Bedrock API-key auth as its account state. This prevents mixing incompatible credential types.

**Data flow**: It creates a provider with OpenAI settings but supplies fake Bedrock API-key auth. Calling `account_state` should return the unsupported-Bedrock-auth error.

**Call relations**: The test uses `bedrock_api_key_auth` and the standard factory to exercise the rejection branch in `ConfiguredModelProvider::account_state`.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_openai_provider, create_model_provider); 2 external calls (assert_eq!, bedrock_api_key_auth).


##### `tests::custom_non_openai_provider_returns_no_account_state`  (lines 549–568)

```
fn custom_non_openai_provider_returns_no_account_state()
```

**Purpose**: Checks that a custom provider that does not require OpenAI auth reports no OpenAI account state. This matters for local or third-party providers that do not use OpenAI login.

**Data flow**: It creates custom provider metadata with `requires_openai_auth` set to false, builds a provider, calls `account_state`, and expects no account and no OpenAI-auth requirement.

**Call relations**: This test verifies the non-auth-required branch of `ConfiguredModelProvider::account_state` through `create_model_provider`.

*Call graph*: calls 1 internal fn (create_model_provider); 2 external calls (default, assert_eq!).


##### `tests::amazon_bedrock_provider_returns_bedrock_account_state`  (lines 571–587)

```
fn amazon_bedrock_provider_returns_bedrock_account_state()
```

**Purpose**: Checks that an Amazon Bedrock provider reports an Amazon Bedrock account state using AWS-managed credentials. This gives the app a provider-specific account description.

**Data flow**: It creates default Bedrock provider info, builds the provider, calls `account_state`, and expects an Amazon Bedrock account with AWS-managed credential source and no OpenAI-auth requirement.

**Call relations**: This test verifies that `create_model_provider` chooses the Bedrock implementation and that the Bedrock provider supplies its own account-state behavior.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 1 external calls (assert_eq!).


##### `tests::amazon_bedrock_provider_creates_static_models_manager`  (lines 590–615)

```
async fn amazon_bedrock_provider_creates_static_models_manager()
```

**Purpose**: Checks that Amazon Bedrock uses a static model catalog with the expected Bedrock model IDs and default model. This avoids trying to fetch models from an OpenAI-style endpoint for Bedrock.

**Data flow**: It builds a Bedrock provider, asks it for a models manager, requests the raw catalog online, collects model IDs, and verifies the expected Bedrock IDs. It also lists models and checks that the default model is the expected one.

**Call relations**: This test exercises the Bedrock provider returned by `create_model_provider`, while using `test_codex_home` only as safe test storage.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 2 external calls (assert_eq!, test_codex_home).


##### `tests::configured_bedrock_catalog_only_allows_default_service_tier`  (lines 618–649)

```
async fn configured_bedrock_catalog_only_allows_default_service_tier()
```

**Purpose**: Checks that when a configured catalog is used for Bedrock, extra service-tier choices are stripped away. This matters because Bedrock only supports the default service tier in this path.

**Data flow**: It loads bundled model data, selects a model that has speed and service tiers, builds a Bedrock provider, gives that model as a configured catalog, then reads the resulting catalog and verifies that additional speed tiers, service tiers, and default service tier were removed.

**Call relations**: The test combines bundled catalog data, `create_model_provider`, and the provider’s `models_manager` behavior to protect Bedrock-specific catalog adaptation.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, create_model_provider); 5 external calls (assert!, assert_eq!, bundled_models_response, test_codex_home, vec!).


##### `tests::configured_provider_models_manager_uses_provider_bearer_token`  (lines 652–689)

```
async fn configured_provider_models_manager_uses_provider_bearer_token()
```

**Purpose**: Checks that a configured provider’s model-list request uses the bearer token set on that provider. This ensures model discovery authenticates with the provider’s own token rather than unrelated user auth.

**Data flow**: It starts a mock HTTP server, sets an expectation for `GET /models` with an `Authorization: Bearer provider-token` header, and makes the server return a fake model catalog. It then builds provider info with that bearer token, creates a provider, asks its models manager for the catalog, and verifies that the returned models include the fake provider model.

**Call relations**: This test drives the full configured-provider model-list path: mock server, provider metadata from `provider_for`, `create_model_provider`, `ConfiguredModelProvider::models_manager`, and the OpenAI-compatible models endpoint.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, create_model_provider); 10 external calls (given, start, new, assert!, provider_for, test_codex_home, vec!, header_regex, method, path).


### Generic provider authentication
Builds the reusable auth primitives and identity-backed token sources used by non-Bedrock model providers.

### `agent-identity/src/lib.rs`

`domain_logic` · `startup, identity setup, task registration, and request authorization`

This file is the security toolkit for agent identity. Without it, the agent could not safely prove who it is, register a task with the backend, or attach trustworthy authorization to later task requests. The basic idea is like issuing an employee badge and then requiring signed slips for each job: the badge identifies the agent, and each signed slip proves the agent is allowed to act for a specific task.

The file works with two main kinds of proof. First, it reads an Agent Identity JWT, which is a signed JSON token from the server containing facts such as the agent runtime id, account id, user email, plan type, and private key. If trusted public keys are available, it verifies the token signature and checks that the issuer and audience are the expected ones. Second, it uses the agent private key to sign short pieces of text, such as task registration requests and per-task authorization assertions.

It also creates new Ed25519 key material, converts public keys into SSH public key format, derives a Curve25519 key for decrypting encrypted task ids, and builds the backend URLs used for registration and public key lookup. The tests at the bottom check the most sensitive behavior: signatures, JWT decoding and verification, rejected bad keys, and URL shape.

#### Function details

##### `authorization_header_for_agent_task`  (lines 106–126)

```
fn authorization_header_for_agent_task(
    key: AgentIdentityKey<'_>,
    target: AgentTaskAuthorizationTarget<'_>,
) -> Result<String>
```

**Purpose**: Builds the HTTP authorization header used when an agent makes a request for a specific task. It proves both the agent runtime id and the task id by signing them with the stored private key.

**Data flow**: It receives stored agent key information and a target task. It first checks that both refer to the same agent runtime id, adds the current time, signs the agent id, task id, and timestamp, serializes that bundle, and returns a string beginning with `AgentAssertion`. If the ids do not match or signing fails, it returns an error instead.

**Call relations**: This is the public entry point for making a task-scoped proof. It calls `sign_agent_assertion_payload` to make the signature and `serialize_agent_assertion` to pack the proof into a header-safe token. The tests call it to confirm both the happy path and the mismatch rejection.

*Call graph*: calls 2 internal fn (serialize_agent_assertion, sign_agent_assertion_payload); called by 2 (authorization_header_for_agent_task_rejects_mismatched_runtime, authorization_header_for_agent_task_serializes_signed_agent_assertion); 3 external calls (now, ensure!, format!).


##### `fetch_agent_identity_jwks`  (lines 128–145)

```
async fn fetch_agent_identity_jwks(
    client: &reqwest::Client,
    chatgpt_base_url: &str,
) -> Result<JwkSet>
```

**Purpose**: Downloads the trusted public keys used to verify agent identity JWTs. JWKS means JSON Web Key Set, a standard JSON document that lists public signing keys.

**Data flow**: It receives an HTTP client and the ChatGPT base URL. It builds the correct JWKS URL, sends a GET request with a short timeout, checks that the server returned success, decodes the JSON body, and returns the key set.

**Call relations**: This function gets the trusted keys that can later be passed to `decode_agent_identity_jwt`. It relies on `agent_identity_jwks_url` so callers do not have to know the exact backend path.

*Call graph*: calls 1 internal fn (agent_identity_jwks_url); 1 external calls (get).


##### `decode_agent_identity_jwt`  (lines 147–171)

```
fn decode_agent_identity_jwt(
    jwt: &str,
    jwks: Option<&JwkSet>,
) -> Result<AgentIdentityJwtClaims>
```

**Purpose**: Reads an agent identity JWT and returns its claims, meaning the facts carried inside the token. When trusted public keys are supplied, it also verifies that the token was signed by a trusted server and was meant for this app.

**Data flow**: It receives the JWT text and optionally a JWKS key set. Without keys, it only decodes the payload JSON. With keys, it reads the token header, finds the matching trusted key by key id, builds a verification key, checks the signature, issuer, and audience, and returns the decoded claims.

**Call relations**: This is the main JWT reader. It falls back to `decode_agent_identity_jwt_payload` when no JWKS is available, and otherwise uses the JWT library for full verification. Several tests call it to check plain decoding, plan mapping, trusted verification, untrusted key rejection, and required issuer/audience checks.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt_payload); called by 4 (decode_agent_identity_jwt_maps_raw_plan_aliases, decode_agent_identity_jwt_reads_claims, decode_agent_identity_jwt_rejects_untrusted_kid, decode_agent_identity_jwt_requires_issuer_and_audience); 3 external calls (from_jwk, new, decode_header).


##### `decode_agent_identity_jwt_payload`  (lines 173–185)

```
fn decode_agent_identity_jwt_payload(jwt: &str) -> Result<T>
```

**Purpose**: Decodes only the middle payload section of a JWT, without checking its signature. This is useful when the caller only wants to inspect the token contents or when verification keys are not available.

**Data flow**: It receives a JWT string, splits it into its three dot-separated parts, decodes the payload from base64url, parses the bytes as JSON, and returns the requested data type. Bad format, bad base64, or invalid JSON becomes an error.

**Call relations**: It is the lightweight helper used by `decode_agent_identity_jwt` when no JWKS is provided. It deliberately does not verify trust; it only extracts the payload.

*Call graph*: called by 1 (decode_agent_identity_jwt); 3 external calls (bail!, ensure!, from_slice).


##### `sign_task_registration_payload`  (lines 187–194)

```
fn sign_task_registration_payload(
    key: AgentIdentityKey<'_>,
    timestamp: &str,
) -> Result<String>
```

**Purpose**: Signs the message used to register a new task for an agent. The signature lets the backend confirm that the request came from someone who has the agent private key.

**Data flow**: It receives the stored agent key and a timestamp. It decodes the private signing key, builds the text `agent_runtime_id:timestamp`, signs that text, base64-encodes the signature, and returns it.

**Call relations**: It is called by `register_agent_task` just before sending the task registration request. It depends on `signing_key_from_private_key_pkcs8_base64` to turn the stored key text back into a usable signing key.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64); called by 1 (register_agent_task); 1 external calls (format!).


##### `register_agent_task`  (lines 196–232)

```
async fn register_agent_task(
    client: &reqwest::Client,
    chatgpt_base_url: &str,
    key: AgentIdentityKey<'_>,
) -> Result<String>
```

**Purpose**: Asks the ChatGPT backend to create or register a task for this agent runtime. It sends a signed request so the server can trust that the agent is the one making the request.

**Data flow**: It receives an HTTP client, a base URL, and the agent key. It creates a timestamp, signs the registration payload, builds the task registration URL, sends a JSON POST request, reports non-success responses with a trimmed response body, decodes the JSON response, and returns the task id.

**Call relations**: This is the network-facing task registration flow. It calls `sign_task_registration_payload` for proof, `agent_task_registration_url` for the endpoint, and `task_id_from_register_task_response` to extract or decrypt the returned task id.

*Call graph*: calls 3 internal fn (agent_task_registration_url, sign_task_registration_payload, task_id_from_register_task_response); 4 external calls (now, bail!, post, format!).


##### `task_id_from_register_task_response`  (lines 234–246)

```
fn task_id_from_register_task_response(
    key: AgentIdentityKey<'_>,
    response: RegisterTaskResponse,
) -> Result<String>
```

**Purpose**: Pulls the task id out of a registration response, including older or alternate field names. If the server encrypted the task id, it decrypts it before returning it.

**Data flow**: It receives the agent key and the parsed server response. It first looks for a plain `task_id` value, accepting both snake_case and camelCase names. If none is present, it looks for an encrypted task id and passes it through decryption. If no task id is present at all, it returns an error.

**Call relations**: It is called by `register_agent_task` after the HTTP response has been decoded. It hands encrypted ids to `decrypt_task_id_response` so the rest of the code receives a normal task id string.

*Call graph*: calls 1 internal fn (decrypt_task_id_response); called by 1 (register_agent_task).


##### `decrypt_task_id_response`  (lines 248–260)

```
fn decrypt_task_id_response(
    key: AgentIdentityKey<'_>,
    encrypted_task_id: &str,
) -> Result<String>
```

**Purpose**: Decrypts an encrypted task id returned by the backend. This protects the task id in transit while still letting the intended agent read it.

**Data flow**: It receives the stored agent key and a base64 encrypted task id. It decodes the private signing key, decodes the encrypted bytes, derives a Curve25519 decryption key from the signing key, opens the encrypted message, converts the decrypted bytes to UTF-8 text, and returns the task id.

**Call relations**: It is used by `task_id_from_register_task_response` only when the server sends an encrypted task id. It shares key-decoding work with `signing_key_from_private_key_pkcs8_base64` and key-derivation work with `curve25519_secret_key_from_signing_key`.

*Call graph*: calls 2 internal fn (curve25519_secret_key_from_signing_key, signing_key_from_private_key_pkcs8_base64); called by 1 (task_id_from_register_task_response); 1 external calls (from_utf8).


##### `generate_agent_key_material`  (lines 262–276)

```
fn generate_agent_key_material() -> Result<GeneratedAgentKeyMaterial>
```

**Purpose**: Creates a fresh private/public key pair for an agent identity. The private key is stored for signing, and the public key can be shared with a service that needs to recognize the agent.

**Data flow**: It fills 32 random bytes from the operating system’s secure random source, turns them into an Ed25519 signing key, encodes the private key as PKCS#8 DER and then base64, converts the public key into SSH public key text, and returns both values.

**Call relations**: This is used when new agent identity key material is needed. It calls `encode_ssh_ed25519_public_key` so the public half is in the standard SSH-style format expected by other systems.

*Call graph*: calls 1 internal fn (encode_ssh_ed25519_public_key); 1 external calls (from_bytes).


##### `public_key_ssh_from_private_key_pkcs8_base64`  (lines 278–283)

```
fn public_key_ssh_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<String>
```

**Purpose**: Recreates the SSH-formatted public key from a stored private key. This is useful when only the private key was saved but the public key needs to be shown or registered again.

**Data flow**: It receives a base64 PKCS#8 private key, decodes it into a signing key, extracts the verifying public key, encodes that public key as SSH text, and returns it.

**Call relations**: It combines `signing_key_from_private_key_pkcs8_base64` and `encode_ssh_ed25519_public_key`. It is a convenience path for callers that need public key text from stored private key material.

*Call graph*: calls 2 internal fn (encode_ssh_ed25519_public_key, signing_key_from_private_key_pkcs8_base64).


##### `verifying_key_from_private_key_pkcs8_base64`  (lines 285–290)

```
fn verifying_key_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<VerifyingKey>
```

**Purpose**: Extracts the public verifying key from a stored private signing key. A verifying key is the public half used to check signatures.

**Data flow**: It receives the base64 PKCS#8 private key, decodes it into a signing key, takes the public verifying key from it, and returns that key object.

**Call relations**: It relies on `signing_key_from_private_key_pkcs8_base64` for parsing. Other code can use the returned verifying key to validate signatures made by the matching private key.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64).


##### `curve25519_secret_key_from_private_key_pkcs8_base64`  (lines 292–297)

```
fn curve25519_secret_key_from_private_key_pkcs8_base64(
    private_key_pkcs8_base64: &str,
) -> Result<Curve25519SecretKey>
```

**Purpose**: Derives a Curve25519 secret key from the stored Ed25519 private key. Curve25519 is the key type used here for decrypting sealed messages, while Ed25519 is used for signatures.

**Data flow**: It receives the stored base64 PKCS#8 private key, decodes it into a signing key, transforms that signing key into a Curve25519 secret key, and returns it.

**Call relations**: It is the public wrapper around `curve25519_secret_key_from_signing_key`. It shares the same private-key parser used by the signing functions.

*Call graph*: calls 2 internal fn (curve25519_secret_key_from_signing_key, signing_key_from_private_key_pkcs8_base64).


##### `agent_registration_url`  (lines 299–302)

```
fn agent_registration_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the backend URL for registering an agent. It hides the exact path so callers only need to provide the base URL.

**Data flow**: It receives a ChatGPT base URL, removes any trailing slash, appends `/v1/agent/register`, and returns the full URL string.

**Call relations**: This is a small URL helper used by code that needs the agent registration endpoint. It follows the same trimming pattern as the other URL builders in this file.

*Call graph*: 1 external calls (format!).


##### `agent_task_registration_url`  (lines 304–307)

```
fn agent_task_registration_url(chatgpt_base_url: &str, agent_runtime_id: &str) -> String
```

**Purpose**: Builds the backend URL for registering a task under a specific agent runtime id.

**Data flow**: It receives a base URL and an agent runtime id. It trims a trailing slash from the base URL, inserts the runtime id into the task registration path, and returns the full URL.

**Call relations**: It is called by `register_agent_task` before sending the POST request. This keeps URL construction in one place instead of scattering path strings through the code.

*Call graph*: called by 1 (register_agent_task); 1 external calls (format!).


##### `agent_identity_biscuit_url`  (lines 309–312)

```
fn agent_identity_biscuit_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the URL used for the agent identity authentication flow named `authenticate_app_v2`. The name “biscuit” here refers to a backend authentication step, not a browser cookie.

**Data flow**: It receives a base URL, removes any trailing slash, appends `/authenticate_app_v2`, and returns the result.

**Call relations**: This helper gives other parts of the system a single reliable way to reach the identity authentication endpoint.

*Call graph*: 1 external calls (format!).


##### `agent_identity_jwks_url`  (lines 314–321)

```
fn agent_identity_jwks_url(chatgpt_base_url: &str) -> String
```

**Purpose**: Builds the URL where trusted JWT public keys can be fetched. It accounts for two different backend URL layouts.

**Data flow**: It receives a base URL and trims a trailing slash. If the URL already points at `/backend-api`, it appends `/wham/agent-identities/jwks`; otherwise it appends `/agent-identities/jwks`.

**Call relations**: It is called by `fetch_agent_identity_jwks`, and tests check both URL layouts. This prevents callers from having to know which backend shape they are using.

*Call graph*: called by 1 (fetch_agent_identity_jwks); 1 external calls (format!).


##### `agent_identity_request_id`  (lines 323–332)

```
fn agent_identity_request_id() -> Result<String>
```

**Purpose**: Creates a unique request id for an agent identity request. This helps trace or match requests without exposing meaningful user data.

**Data flow**: It generates 16 secure random bytes, encodes them in URL-safe base64 without padding, prefixes them with `codex-agent-identity-`, and returns the string.

**Call relations**: This is a standalone helper for identity request setup. It uses the operating system random source in the same spirit as key generation.

*Call graph*: 1 external calls (format!).


##### `build_abom`  (lines 334–349)

```
fn build_abom(session_source: SessionSource) -> AgentBillOfMaterials
```

**Purpose**: Builds an agent bill of materials, a short description of what agent build is running and where it is running. This helps the backend understand the client environment.

**Data flow**: It receives the session source, reads the crate version compiled into the program, chooses a harness id such as `codex-app` or `codex-cli`, combines the session source with the operating system name, and returns an `AgentBillOfMaterials` value.

**Call relations**: This is used when identity or registration flows need to describe the running agent. It translates internal session source values into the simpler labels expected by the backend.

*Call graph*: 2 external calls (env!, format!).


##### `encode_ssh_ed25519_public_key`  (lines 351–356)

```
fn encode_ssh_ed25519_public_key(verifying_key: &VerifyingKey) -> String
```

**Purpose**: Formats an Ed25519 public key as an SSH public key string. This is the familiar `ssh-ed25519 ...` form used by many systems.

**Data flow**: It receives a verifying public key, builds the SSH binary blob by writing the key type and key bytes with length prefixes, base64-encodes that blob, prefixes it with `ssh-ed25519`, and returns the text.

**Call relations**: It is called when generating new key material and when reconstructing a public key from a stored private key. It uses `append_ssh_string` to write the SSH length-prefixed pieces correctly.

*Call graph*: calls 1 internal fn (append_ssh_string); called by 2 (generate_agent_key_material, public_key_ssh_from_private_key_pkcs8_base64); 3 external calls (with_capacity, as_bytes, format!).


##### `sign_agent_assertion_payload`  (lines 358–366)

```
fn sign_agent_assertion_payload(
    key: AgentIdentityKey<'_>,
    task_id: &str,
    timestamp: &str,
) -> Result<String>
```

**Purpose**: Creates the cryptographic signature inside an agent task authorization assertion. The signature ties together the agent runtime id, task id, and timestamp.

**Data flow**: It receives the stored key, task id, and timestamp. It decodes the private signing key, builds the text `agent_runtime_id:task_id:timestamp`, signs those bytes, base64-encodes the signature, and returns it.

**Call relations**: It is called by `authorization_header_for_agent_task` when building the final header. It uses `signing_key_from_private_key_pkcs8_base64` so all private-key parsing follows one path.

*Call graph*: calls 1 internal fn (signing_key_from_private_key_pkcs8_base64); called by 1 (authorization_header_for_agent_task); 1 external calls (format!).


##### `serialize_agent_assertion`  (lines 368–377)

```
fn serialize_agent_assertion(envelope: &AgentAssertionEnvelope) -> Result<String>
```

**Purpose**: Packs an agent assertion into a compact token safe to put in an HTTP header. It uses a predictable field order so the serialized form is stable.

**Data flow**: It receives an assertion envelope containing agent id, task id, timestamp, and signature. It places those values into an ordered map, serializes the map as JSON bytes, base64url-encodes the bytes without padding, and returns the token string.

**Call relations**: It is called by `authorization_header_for_agent_task` after the signature has been made. Its output becomes the part after `AgentAssertion ` in the final header.

*Call graph*: called by 1 (authorization_header_for_agent_task); 2 external calls (from, to_vec).


##### `curve25519_secret_key_from_signing_key`  (lines 379–387)

```
fn curve25519_secret_key_from_signing_key(signing_key: &SigningKey) -> Curve25519SecretKey
```

**Purpose**: Converts an Ed25519 signing key into a Curve25519 secret key for decryption. This lets one stored private key support both signing and encrypted task-id delivery.

**Data flow**: It receives an Ed25519 signing key, hashes its private bytes with SHA-512, takes and clamps the first 32 bytes in the way Curve25519 expects, and returns a Curve25519 secret key.

**Call relations**: It is used by `decrypt_task_id_response` and by the public wrapper `curve25519_secret_key_from_private_key_pkcs8_base64`. It is the low-level bridge between the signing-key world and the encryption-key world.

*Call graph*: called by 2 (curve25519_secret_key_from_private_key_pkcs8_base64, decrypt_task_id_response); 3 external calls (from, digest, to_bytes).


##### `append_ssh_string`  (lines 389–392)

```
fn append_ssh_string(buf: &mut Vec<u8>, value: &[u8])
```

**Purpose**: Writes one length-prefixed byte string in the format SSH public keys expect. A length prefix tells the reader exactly how many bytes belong to the next value.

**Data flow**: It receives a mutable byte buffer and a byte slice. It appends the value length as four big-endian bytes, then appends the value bytes themselves, changing the buffer in place.

**Call relations**: It is a small helper used by `encode_ssh_ed25519_public_key` to build the SSH public key blob correctly.

*Call graph*: called by 1 (encode_ssh_ed25519_public_key).


##### `signing_key_from_private_key_pkcs8_base64`  (lines 394–400)

```
fn signing_key_from_private_key_pkcs8_base64(private_key_pkcs8_base64: &str) -> Result<SigningKey>
```

**Purpose**: Turns the stored private key text back into an Ed25519 signing key object. PKCS#8 is a standard wrapper format for private keys.

**Data flow**: It receives base64 text, decodes it into bytes, parses those bytes as a PKCS#8 private key, and returns a signing key. Invalid base64 or invalid key format becomes an error with context.

**Call relations**: This is the shared private-key parser for signing, public-key extraction, decryption setup, and verifying-key extraction. Many higher-level functions call it so key parsing behavior stays consistent.

*Call graph*: called by 6 (curve25519_secret_key_from_private_key_pkcs8_base64, decrypt_task_id_response, public_key_ssh_from_private_key_pkcs8_base64, sign_agent_assertion_payload, sign_task_registration_payload, verifying_key_from_private_key_pkcs8_base64); 1 external calls (from_pkcs8_der).


##### `tests::authorization_header_for_agent_task_serializes_signed_agent_assertion`  (lines 416–465)

```
fn authorization_header_for_agent_task_serializes_signed_agent_assertion()
```

**Purpose**: Checks that a task authorization header contains the expected agent id and task id and that its signature is real.

**Data flow**: The test creates a fixed signing key, builds an authorization header, decodes the header payload, compares the visible fields, decodes the signature, and verifies the signature against the original message.

**Call relations**: It exercises `authorization_header_for_agent_task` as a caller would use it, then independently checks the cryptographic result with the verifying key.

*Call graph*: calls 1 internal fn (authorization_header_for_agent_task); 5 external calls (from_slice, from_bytes, assert_eq!, format!, from_slice).


##### `tests::authorization_header_for_agent_task_rejects_mismatched_runtime`  (lines 468–490)

```
fn authorization_header_for_agent_task_rejects_mismatched_runtime()
```

**Purpose**: Checks that the code refuses to create a task assertion when the stored agent id and requested task agent id are different.

**Data flow**: The test creates key material for `agent-123` but asks for a header targeting `agent-456`. It expects an error and compares the error message to the intended explanation.

**Call relations**: It calls `authorization_header_for_agent_task` on the failure path. This protects against accidentally signing authorization for the wrong agent runtime.

*Call graph*: calls 1 internal fn (authorization_header_for_agent_task); 2 external calls (from_bytes, assert_eq!).


##### `tests::decode_agent_identity_jwt_reads_claims`  (lines 493–526)

```
fn decode_agent_identity_jwt_reads_claims()
```

**Purpose**: Checks that an unsigned test JWT payload can be decoded into the expected agent identity claims when verification keys are not supplied.

**Data flow**: The test builds a JWT-like string with known JSON fields, decodes it with `decode_agent_identity_jwt`, and compares the returned claims to the expected struct.

**Call relations**: It covers the no-JWKS branch of `decode_agent_identity_jwt`, which internally uses the payload-only decoder.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 3 external calls (jwt_with_payload, assert_eq!, json!).


##### `tests::decode_agent_identity_jwt_maps_raw_plan_aliases`  (lines 529–547)

```
fn decode_agent_identity_jwt_maps_raw_plan_aliases()
```

**Purpose**: Checks that a raw plan value from the token can be mapped to the project’s known plan type. In this case, `hc` becomes the enterprise plan.

**Data flow**: The test creates a JWT payload with `plan_type` set to `hc`, decodes it, and verifies that the resulting plan type is enterprise.

**Call relations**: It calls `decode_agent_identity_jwt` and confirms that deserialization of the claims matches the plan naming rules from the protocol crate.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 3 external calls (jwt_with_payload, assert_eq!, json!).


##### `tests::decode_agent_identity_jwt_verifies_when_jwks_is_present`  (lines 550–601)

```
fn decode_agent_identity_jwt_verifies_when_jwks_is_present()
```

**Purpose**: Checks the full trusted JWT path: the token is signed, the matching public key is present, and the claims are accepted.

**Data flow**: The test builds a JWKS containing a test key id, creates claims, signs a JWT with the matching RSA private key, decodes it with the JWKS, and compares the verified claims to the expected values.

**Call relations**: It exercises `decode_agent_identity_jwt` with real signature verification. It uses the test helpers `test_jwks`, `test_jwt_header`, and `test_rsa_encoding_key` to assemble the trusted token setup.

*Call graph*: 7 external calls (Known, test_jwks, test_jwt_header, test_rsa_encoding_key, assert_eq!, encode, json!).


##### `tests::decode_agent_identity_jwt_rejects_untrusted_kid`  (lines 604–627)

```
fn decode_agent_identity_jwt_rejects_untrusted_kid()
```

**Purpose**: Checks that a signed JWT is rejected when its key id is not found in the trusted key set.

**Data flow**: The test creates a JWKS with one key id, signs a JWT whose header names a different key id, and expects decoding to fail.

**Call relations**: It calls `decode_agent_identity_jwt` on the untrusted-key path. This confirms that the code does not accept any valid signature unless the signing key is explicitly trusted.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 5 external calls (test_jwks, test_jwt_header, test_rsa_encoding_key, encode, json!).


##### `tests::decode_agent_identity_jwt_requires_issuer_and_audience`  (lines 630–650)

```
fn decode_agent_identity_jwt_requires_issuer_and_audience()
```

**Purpose**: Checks that verified JWTs must include the expected issuer and audience fields. These fields say who issued the token and who it is meant for.

**Data flow**: The test creates a signed JWT that omits issuer and audience, then tries to decode it with trusted keys and expects an error.

**Call relations**: It calls `decode_agent_identity_jwt` to confirm the validation settings are strict enough, not just signature-based.

*Call graph*: calls 1 internal fn (decode_agent_identity_jwt); 5 external calls (test_jwks, test_jwt_header, test_rsa_encoding_key, encode, json!).


##### `tests::test_jwt_header`  (lines 652–656)

```
fn test_jwt_header(kid: &str) -> Header
```

**Purpose**: Creates a JWT header for tests using RSA SHA-256 signing and a chosen key id.

**Data flow**: It receives a key id string, creates a JWT header with the RS256 algorithm, stores the key id in the header, and returns it.

**Call relations**: It is a test helper used by the JWT verification tests to make signed tokens that point at a specific JWKS key.

*Call graph*: 1 external calls (new).


##### `tests::test_rsa_encoding_key`  (lines 658–690)

```
fn test_rsa_encoding_key() -> EncodingKey
```

**Purpose**: Loads a fixed RSA private key for signing test JWTs. The key is hard-coded because it is only used inside tests.

**Data flow**: It parses the embedded PEM-formatted private key text and returns a JWT encoding key. If the test key cannot be parsed, the test fails immediately.

**Call relations**: It is used by the signed-JWT tests together with `test_jwt_header` and `test_jwks` to create tokens that can be verified.

*Call graph*: 1 external calls (from_rsa_pem).


##### `tests::test_jwks`  (lines 692–704)

```
fn test_jwks(kid: &str) -> jsonwebtoken::jwk::JwkSet
```

**Purpose**: Builds a test JWKS containing the public half of the fixed RSA key under a chosen key id.

**Data flow**: It receives a key id, constructs a JSON Web Key Set as JSON, parses it into the JWT library’s JWKS type, and returns it.

**Call relations**: It supports the JWT verification tests by providing either a matching trusted key id or a deliberately mismatched one.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::agent_identity_jwks_url_uses_backend_api_base_url`  (lines 707–716)

```
fn agent_identity_jwks_url_uses_backend_api_base_url()
```

**Purpose**: Checks that JWKS URLs are built correctly when the base URL points at the ChatGPT backend API path.

**Data flow**: The test calls the URL builder with backend-api URLs with and without a trailing slash, then compares both results to the expected `/wham/agent-identities/jwks` path.

**Call relations**: It protects the special branch inside `agent_identity_jwks_url` for backend-api-style base URLs.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::agent_identity_jwks_url_uses_codex_api_base_url`  (lines 719–728)

```
fn agent_identity_jwks_url_uses_codex_api_base_url()
```

**Purpose**: Checks that JWKS URLs are built correctly for the Codex API base URL shape.

**Data flow**: The test calls the URL builder with Codex API URLs with and without a trailing slash, then compares both results to the expected `/agent-identities/jwks` path.

**Call relations**: It protects the non-backend-api branch inside `agent_identity_jwks_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::jwt_with_payload`  (lines 730–736)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Creates a simple JWT-like string for tests that only need payload decoding. It is not meant to represent a trusted signed token.

**Data flow**: It receives a JSON payload, base64url-encodes a fixed `alg: none` header, the payload bytes, and a dummy signature, joins the three parts with dots, and returns the string.

**Call relations**: It is used by payload-decoding tests for `decode_agent_identity_jwt`, letting those tests focus on claim parsing without setting up real cryptographic signing.

*Call graph*: 2 external calls (format!, to_vec).


### `login/src/auth/agent_identity.rs`

`domain_logic` · `authentication startup and later request authentication`

This file is part of the login system for “agent identity” authentication. A stored record already contains account details and private key material. This file wraps that record in an `AgentIdentityAuth` object and, during loading, contacts the auth API to register the current agent task. Think of it like checking in at a front desk: the stored credential proves who you are, and the returned process task ID is the badge for this running session.

The main work happens in `AgentIdentityAuth::load`. It chooses the auth API address, builds an HTTP client, turns the stored record into the key format expected by the agent identity library, and asks that library to register the task. If registration succeeds, the file keeps both the original record and the new task ID together.

Most other methods are simple read-only accessors. They expose account ID, user ID, email, plan type, FedRAMP status, and the registered process task ID to code that later adds authentication headers to network requests.

A small helper chooses the auth API base URL. It normally uses the production OpenAI URL, but tests or special deployments can override it with an environment variable. The test helper `EnvVarGuard` safely restores environment variables after tests, so one test does not accidentally affect another.

#### Function details

##### `AgentIdentityAuth::load`  (lines 20–33)

```
async fn load(record: AgentIdentityAuthRecord) -> std::io::Result<Self>
```

**Purpose**: Creates a usable `AgentIdentityAuth` from a stored agent identity record. It also registers this running process as an agent task with the auth service, which produces the process task ID needed for later authenticated requests.

**Data flow**: It receives an `AgentIdentityAuthRecord` containing account details and private key data. It chooses the auth API URL, builds an HTTP client, extracts the key fields from the record, and sends them to the agent identity registration service. If that succeeds, it returns a new `AgentIdentityAuth` containing the original record plus the returned process task ID; if it fails, it returns an I/O-style error.

**Call relations**: `from_agent_identity_jwt` calls this when a stored agent identity login needs to become active. Inside, it asks `agent_identity_authapi_base_url` where to send registration, uses `key` to shape the credential data, uses `build_reqwest_client` for HTTP, and hands the request to the external `register_agent_task` function.

*Call graph*: calls 3 internal fn (agent_identity_authapi_base_url, key, build_reqwest_client); called by 1 (from_agent_identity_jwt); 1 external calls (register_agent_task).


##### `AgentIdentityAuth::record`  (lines 35–37)

```
fn record(&self) -> &AgentIdentityAuthRecord
```

**Purpose**: Gives read-only access to the full stored authentication record. This is useful when later code needs more than one field from the original login data.

**Data flow**: It reads the `record` field already stored inside `AgentIdentityAuth` and returns a shared reference to it. Nothing is copied or changed.

**Call relations**: `add_auth_headers` calls this when preparing outbound request headers and needs the original authentication details. This method is a simple doorway to the saved record.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::process_task_id`  (lines 39–41)

```
fn process_task_id(&self) -> &str
```

**Purpose**: Returns the process task ID that was assigned when this agent process registered with the auth service. Later requests use this value to identify this particular running agent session.

**Data flow**: It reads the `process_task_id` string stored during `AgentIdentityAuth::load` and returns it as text. It does not change the authentication object.

**Call relations**: `add_auth_headers` calls this while building authentication headers for network requests. The value it returns is one of the pieces that ties a request back to the registered agent task.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::account_id`  (lines 43–45)

```
fn account_id(&self) -> &str
```

**Purpose**: Returns the account ID from the stored agent identity record. This tells other code which account the agent identity belongs to.

**Data flow**: It reads `account_id` from the embedded record and returns it as text. The stored record remains unchanged.

**Call relations**: `add_auth_headers` calls this when it needs to include account identity information in outgoing authentication headers.

*Call graph*: called by 1 (add_auth_headers).


##### `AgentIdentityAuth::chatgpt_user_id`  (lines 47–49)

```
fn chatgpt_user_id(&self) -> &str
```

**Purpose**: Returns the ChatGPT user ID associated with this agent identity. This identifies the user side of the account record.

**Data flow**: It reads `chatgpt_user_id` from the stored record and returns it as text. No data is modified.

**Call relations**: This accessor is available to any code that needs the user ID from the agent identity record. In this call graph, no direct caller is shown, so it is likely provided for nearby auth code or future use.


##### `AgentIdentityAuth::email`  (lines 51–53)

```
fn email(&self) -> &str
```

**Purpose**: Returns the email address stored with the agent identity. This can be used for display, logging, or account-related decisions where the user’s email is needed.

**Data flow**: It reads the `email` field from the embedded record and returns it as text. The object is left unchanged.

**Call relations**: This is a read-only convenience method for code that needs the account email. The provided call graph does not show a current caller.


##### `AgentIdentityAuth::plan_type`  (lines 55–57)

```
fn plan_type(&self) -> AccountPlanType
```

**Purpose**: Returns the account plan type, such as the subscription or account category represented by the stored record. Other code can use this to adjust behavior based on account capabilities.

**Data flow**: It reads `plan_type` from the stored record and returns that value. Because the plan type is copied out, the original record is not changed.

**Call relations**: This method exposes plan information to the rest of the authentication system. The provided call graph does not show a direct caller in this slice.


##### `AgentIdentityAuth::is_fedramp_account`  (lines 59–61)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Reports whether this account is marked as a FedRAMP account. FedRAMP is a U.S. government security compliance program, so this flag can affect which services or headers are allowed.

**Data flow**: It reads the boolean `chatgpt_account_is_fedramp` from the stored record and returns true or false. It does not change any state.

**Call relations**: `add_auth_headers` calls this when building request headers, so outgoing requests can carry or respect the account’s FedRAMP status.

*Call graph*: called by 1 (add_auth_headers).


##### `agent_identity_authapi_base_url`  (lines 64–70)

```
fn agent_identity_authapi_base_url() -> String
```

**Purpose**: Chooses which auth API base URL should be used for agent identity registration. It normally returns the production OpenAI auth URL, but allows an environment variable to override it.

**Data flow**: It reads the `CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL` environment variable. If the variable exists, it trims whitespace and removes trailing slashes, then uses it if it is not empty. If the variable is missing or empty after trimming, it returns the built-in production URL.

**Call relations**: `AgentIdentityAuth::load` calls this before registering the agent task, so registration goes to the correct auth API. The tests in this file check both the override path and the default production path.

*Call graph*: called by 1 (load); 1 external calls (var).


##### `key`  (lines 72–77)

```
fn key(record: &AgentIdentityAuthRecord) -> AgentIdentityKey<'_>
```

**Purpose**: Builds the key object needed by the agent identity registration library from the stored authentication record. It selects only the two pieces registration needs: the runtime ID and the private key.

**Data flow**: It receives an `AgentIdentityAuthRecord`, borrows `agent_runtime_id` and `agent_private_key` from it, and returns an `AgentIdentityKey` that points at those values. It does not copy or alter the sensitive key material.

**Call relations**: `AgentIdentityAuth::load` calls this right before calling the external `register_agent_task` function. It acts as a small adapter between this project’s stored record format and the agent identity library’s expected input.

*Call graph*: called by 1 (load).


##### `tests::agent_identity_authapi_base_url_prefers_env_value`  (lines 86–95)

```
fn agent_identity_authapi_base_url_prefers_env_value()
```

**Purpose**: Checks that the auth API URL helper respects the environment variable override. This protects test, staging, or custom deployments from accidentally using the production URL when an override was provided.

**Data flow**: It temporarily sets `CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL` to a test URL with a trailing slash. Then it calls `agent_identity_authapi_base_url` and verifies that the returned URL matches the test value with the trailing slash removed.

**Call relations**: This test uses `tests::EnvVarGuard::set` to change the environment safely for the duration of the test. The serial test marker makes sure environment-changing tests do not run at the same time and interfere with each other.

*Call graph*: calls 1 internal fn (set); 1 external calls (assert_eq!).


##### `tests::agent_identity_authapi_base_url_uses_prod_authapi_by_default`  (lines 99–105)

```
fn agent_identity_authapi_base_url_uses_prod_authapi_by_default()
```

**Purpose**: Checks that the helper falls back to the production auth API URL when no override is set. This confirms the normal runtime behavior.

**Data flow**: It temporarily removes the auth API environment variable. Then it calls `agent_identity_authapi_base_url` and verifies that the result is the built-in production URL.

**Call relations**: This test uses `tests::EnvVarGuard::remove` to clear the environment variable and restore it afterward. Like the other environment test, it runs serially to avoid cross-test interference.

*Call graph*: 2 external calls (remove, assert_eq!).


##### `tests::EnvVarGuard::set`  (lines 113–119)

```
fn set(key: &'static str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its previous value. This prevents a test from leaving the process environment in a changed state.

**Data flow**: It receives an environment variable name and a new value. It first reads and stores the original value, then sets the variable to the requested value, and returns an `EnvVarGuard` that knows how to restore the original later.

**Call relations**: `tests::agent_identity_authapi_base_url_prefers_env_value` uses this before checking URL override behavior. When the guard is dropped at the end of the test, `tests::EnvVarGuard::drop` restores the environment.

*Call graph*: 2 external calls (set_var, var_os).


##### `tests::EnvVarGuard::remove`  (lines 121–127)

```
fn remove(key: &'static str) -> Self
```

**Purpose**: Temporarily removes an environment variable for a test while remembering whether it existed before. This lets a test simulate a missing setting without permanently changing the test process.

**Data flow**: It receives an environment variable name. It reads and stores the current value, removes the variable, and returns an `EnvVarGuard` that can restore the old value or keep it removed as appropriate.

**Call relations**: `tests::agent_identity_authapi_base_url_uses_prod_authapi_by_default` uses this to test the default production URL path. Cleanup is handled later by `tests::EnvVarGuard::drop`.

*Call graph*: 2 external calls (remove_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 131–138)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when an `EnvVarGuard` goes out of scope. This is the cleanup step that keeps environment-based tests from leaking changes into each other.

**Data flow**: It looks at the original value saved in the guard. If there was an original value, it sets the variable back to that value; if there was none, it removes the variable again.

**Call relations**: This runs automatically after tests that created an `EnvVarGuard` with `set` or `remove`. It completes the temporary-environment-change story by putting the process environment back the way it was.

*Call graph*: 2 external calls (remove_var, set_var).


### `login/src/auth/external_bearer.rs`

`domain_logic` · `cross-cutting during authentication lookup and token refresh`

Some model providers do not store a fixed API key in the app. Instead, they expect the app to ask another tool for a short-lived bearer token, which is a string used as proof that the user is allowed to make requests. This file is the adapter for that style of authentication.

The main type, `BearerTokenRefresher`, is like a small ticket office. When the rest of the app asks for credentials, it first checks whether it already has a recent ticket in its cache. If the cached token is still fresh, it reuses it. If not, it runs the configured provider command, reads the command's standard output, trims it, and treats that text as the access token.

The file is careful about failures. It sets a timeout so a stuck command cannot hang forever. It captures error output so failures can explain what went wrong. It rejects non-text output and empty tokens, because those would not be usable credentials.

One important detail is that cache misses hold a mutex, which is a lock that stops two tasks touching the same cached value at once, while the command runs. That is intentional: if several requests arrive together, only one external command should be launched instead of many duplicate token refreshes.

#### Function details

##### `BearerTokenRefresher::new`  (lines 23–27)

```
fn new(config: ModelProviderAuthInfo) -> Self
```

**Purpose**: Creates a new token refresher from the provider authentication configuration. Someone uses this when they want the login system to obtain tokens by running the configured external command.

**Data flow**: It receives `ModelProviderAuthInfo`, which contains details such as the command, arguments, working directory, timeout, and refresh interval. It builds an `ExternalBearerAuthState` around that configuration, wraps it in shared ownership so clones can point to the same cache, and returns a ready-to-use `BearerTokenRefresher`.

**Call relations**: In the known flow, `external_bearer_only` calls this to set up external bearer authentication. This constructor immediately hands the configuration to `ExternalBearerAuthState::new`, so later resolve and refresh calls all share the same cached token.

*Call graph*: calls 1 internal fn (new); called by 1 (external_bearer_only); 1 external calls (new).


##### `BearerTokenRefresher::auth_mode`  (lines 73–75)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Tells the rest of the authentication system what broad kind of credential this refresher supplies. Here it reports `ApiKey`, meaning the token is used like a single secret value attached to requests.

**Data flow**: It takes the refresher object but does not need to read its stored configuration or cache. It simply returns the fixed authentication mode `AuthMode::ApiKey`.

**Call relations**: The external authentication manager can ask this method when it needs to label or route credentials. It does not call other project code; it just answers with the mode expected by the surrounding authentication interface.


##### `BearerTokenRefresher::resolve`  (lines 77–79)

```
fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Provides an access token for normal use, reusing a cached token when it is still valid and running the provider command when it is missing or too old. This avoids unnecessary external command calls while still keeping credentials fresh.

**Data flow**: It starts with the shared state: configuration plus an optional cached token. If a cached token exists and the configured refresh interval says it is still fresh, it returns that token wrapped as `ExternalAuthTokens`. Otherwise it runs `run_provider_auth_command`, stores the new token with the current time, and returns the new token. If the external command fails, the error is passed back instead of a token.

**Call relations**: When the authentication manager asks for credentials, this method is exposed through the `ExternalAuth` trait as a pinned future, which is Rust's way of returning an asynchronous operation that can be waited on. On a cache miss it delegates the real token fetching to `run_provider_auth_command`, then packages the result with `ExternalAuthTokens::access_token_only`.

*Call graph*: calls 2 internal fn (run_provider_auth_command, access_token_only); 2 external calls (pin, now).


##### `BearerTokenRefresher::refresh`  (lines 81–86)

```
fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Forces a fresh access token to be fetched, even if a cached one already exists. This is useful after a request fails because the old token may have expired or been rejected.

**Data flow**: It receives a refresh context, though this implementation does not use the context details. It runs the configured provider command, replaces the cached token with the new value and the current fetch time, and returns the new value as `ExternalAuthTokens`. Any command or output error becomes an I/O error returned to the caller.

**Call relations**: The external authentication manager calls this through the `ExternalAuth` trait when it wants a deliberate refresh. Like `resolve`, it is returned as an asynchronous pinned future and relies on `run_provider_auth_command` to do the actual command execution.

*Call graph*: calls 2 internal fn (run_provider_auth_command, access_token_only); 2 external calls (pin, now).


##### `BearerTokenRefresher::fmt`  (lines 90–93)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a safe debug representation of the refresher. It lets logs or developer tools identify the object without printing sensitive token values or command details.

**Data flow**: It receives a formatter from Rust's debug-printing system. It writes a non-exhaustive debug struct named `BearerTokenRefresher`, intentionally leaving internal fields out, and returns the formatting result.

**Call relations**: This is called automatically when code tries to debug-print a `BearerTokenRefresher`. It uses the standard formatter's `debug_struct` helper and does not interact with the token fetching path.

*Call graph*: 1 external calls (debug_struct).


##### `ExternalBearerAuthState::new`  (lines 102–107)

```
fn new(config: ModelProviderAuthInfo) -> Self
```

**Purpose**: Builds the shared internal state used by a bearer token refresher. It keeps the provider configuration and starts with no cached token.

**Data flow**: It receives the provider authentication configuration. It stores that configuration and creates a mutex-protected empty cache, then returns the state object.

**Call relations**: `BearerTokenRefresher::new` calls this during setup. After that, `BearerTokenRefresher::resolve` and `BearerTokenRefresher::refresh` read the configuration from this state and update its cached token.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `run_provider_auth_command`  (lines 115–171)

```
async fn run_provider_auth_command(config: &ModelProviderAuthInfo) -> io::Result<String>
```

**Purpose**: Runs the configured external authentication command and turns its output into an access token. This is the bridge between this app and whatever outside tool knows how to issue provider credentials.

**Data flow**: It receives `ModelProviderAuthInfo`. First it resolves the command path with `resolve_provider_auth_program`. Then it starts the command with the configured arguments and working directory, gives it no input, captures its output, and enforces the configured timeout. If the command times out, fails to start, exits unsuccessfully, writes non-UTF-8 text, or prints an empty token, it returns a clear I/O error. If everything succeeds, it trims standard output and returns that string as the access token.

**Call relations**: `BearerTokenRefresher::resolve` calls this when the cache cannot be used, and `BearerTokenRefresher::refresh` calls it whenever a forced refresh is needed. Before launching the process, it asks `resolve_provider_auth_program` to interpret the configured command relative to the configured working directory when appropriate.

*Call graph*: calls 1 internal fn (resolve_provider_auth_program); called by 2 (refresh, resolve); 10 external calls (null, piped, from_utf8, from_utf8_lossy, new, new, other, timeout, format!, timeout).


##### `resolve_provider_auth_program`  (lines 173–184)

```
fn resolve_provider_auth_program(command: &str, cwd: &Path) -> io::Result<PathBuf>
```

**Purpose**: Decides what program path should be used for the provider authentication command. This makes relative command names behave predictably with the configured working directory.

**Data flow**: It receives the command string and the configured current working directory. If the command is an absolute path, it returns that path unchanged. If the command contains path components, such as `scripts/get-token`, it joins it to the working directory. If it is just a bare program name, such as `get-token`, it leaves it as a plain program name so the operating system can find it through the normal command search path.

**Call relations**: `run_provider_auth_command` calls this before spawning the external process. Its result becomes the executable path passed into the asynchronous process runner.

*Call graph*: called by 1 (run_provider_auth_command); 3 external calls (join, new, from).


### `model-provider/src/bearer_auth_provider.rs`

`io_transport` · `request handling`

When this project talks to a model provider over HTTP, the provider often needs proof of who is making the request. This file supplies that proof by implementing a small authentication provider called `BearerAuthProvider`. A bearer token is like a temporary badge: the client puts it in the request, and the server uses it to decide whether the request is allowed.

The main struct stores three pieces of information: an optional token, an optional account ID, and a flag saying whether the account should be routed as a FedRAMP account. FedRAMP is a U.S. government security compliance program, so those accounts may need special routing.

The important behavior is in `add_auth_headers`. Given a mutable set of HTTP headers, it adds an `Authorization` header in the form `Bearer <token>` when a token is available. If an account ID is available, it also adds `ChatGPT-Account-ID`. If the FedRAMP flag is set, it adds `X-OpenAI-Fedramp: true`.

The file is deliberately careful: it only inserts headers when the values can be turned into valid HTTP header values. If a token or account ID is missing, it simply leaves that header out rather than failing. The tests confirm that telemetry can detect when an auth header will be attached, that normal auth and account headers are added, and that the FedRAMP routing header appears for FedRAMP accounts.

#### Function details

##### `BearerAuthProvider::new`  (lines 14–20)

```
fn new(token: String) -> Self
```

**Purpose**: Creates a normal bearer authentication provider from a token string. This is used when the system has an access token and needs an object that can later add it to outgoing HTTP requests.

**Data flow**: A token string goes in. The function stores it as the provider's token, leaves the account ID empty, sets the FedRAMP flag to false, and returns the ready-to-use `BearerAuthProvider`.

**Call relations**: This constructor is called by `bearer_auth_for_provider` when the larger provider setup needs a simple bearer-token auth provider. It prepares the data that `BearerAuthProvider::add_auth_headers` will later turn into HTTP headers.

*Call graph*: called by 1 (bearer_auth_for_provider).


##### `BearerAuthProvider::for_test`  (lines 22–28)

```
fn for_test(token: Option<&str>, account_id: Option<&str>) -> Self
```

**Purpose**: Builds a `BearerAuthProvider` from optional string slices for use in tests. It lets tests easily try cases with or without a token and with or without an account ID.

**Data flow**: Optional borrowed strings for the token and account ID go in. The function copies any provided values into owned strings, sets the FedRAMP flag to false, and returns a provider shaped for the test case.

**Call relations**: This helper is called by tests such as `bearer_auth_provider_adds_auth_headers`, and also by another telemetry-related test elsewhere. It exists so tests can quickly set up the provider state before calling code that reads or adds auth headers.

*Call graph*: called by 2 (auth_request_telemetry_context_tracks_attached_auth_and_retry_phase, bearer_auth_provider_adds_auth_headers).


##### `BearerAuthProvider::add_auth_headers`  (lines 32–46)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds authentication and routing headers to an outgoing HTTP request header map. This is the core action that turns stored auth information into the actual headers the model provider will receive.

**Data flow**: A `BearerAuthProvider` and a mutable HTTP header map go in. The function checks whether a token exists, formats it as `Bearer <token>`, and inserts it as the `Authorization` header if it is a valid header value. It then does the same kind of safe insertion for the optional account ID, and adds `X-OpenAI-Fedramp: true` when the FedRAMP flag is set. The same header map comes out changed in place.

**Call relations**: This method fulfills the `AuthProvider` trait, meaning other request-building code can treat this provider as a standard source of auth headers. Its behavior is exercised by the tests in this file, which check the normal bearer header, the account ID header, and the FedRAMP routing header.

*Call graph*: 4 external calls (insert, from_static, from_str, format!).


##### `tests::bearer_auth_provider_reports_when_auth_header_will_attach`  (lines 55–69)

```
fn bearer_auth_provider_reports_when_auth_header_will_attach()
```

**Purpose**: Checks that shared auth telemetry can see that this provider will attach an authorization header. Telemetry here means reporting information about what the auth layer is doing, without sending the request itself.

**Data flow**: The test creates a provider with a token and no account ID. It passes that provider to `codex_api::auth_header_telemetry`, then compares the returned telemetry with the expected result: an auth header is attached, and its name is `authorization`.

**Call relations**: This test calls into the broader `codex_api` telemetry helper rather than calling `add_auth_headers` directly. It verifies that `BearerAuthProvider` works correctly with the common `AuthProvider` interface used elsewhere in the system.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::bearer_auth_provider_adds_auth_headers`  (lines 72–90)

```
fn bearer_auth_provider_adds_auth_headers()
```

**Purpose**: Confirms that a provider with both a token and an account ID writes the expected HTTP headers. This protects the basic request-authentication behavior from accidental changes.

**Data flow**: The test builds a provider using `BearerAuthProvider::for_test`, creates an empty header map, and asks the provider to add its headers. It then reads the header map back and checks that `Authorization` contains `Bearer access-token` and `ChatGPT-Account-ID` contains `workspace-123`.

**Call relations**: This test uses the test constructor to set up a clear scenario, then exercises `BearerAuthProvider::add_auth_headers`. It proves that the main method produces the exact headers later request-sending code depends on.

*Call graph*: calls 1 internal fn (for_test); 2 external calls (new, assert_eq!).


##### `tests::bearer_auth_provider_adds_fedramp_routing_header_for_fedramp_accounts`  (lines 93–109)

```
fn bearer_auth_provider_adds_fedramp_routing_header_for_fedramp_accounts()
```

**Purpose**: Confirms that FedRAMP accounts get the special routing header. This matters because those requests may need to be directed through a different compliant path.

**Data flow**: The test creates a provider with a token, an account ID, and `is_fedramp_account` set to true. It starts with an empty header map, calls `add_auth_headers`, and then checks that the map contains `X-OpenAI-Fedramp` with the value `true`.

**Call relations**: This test directly exercises the FedRAMP branch inside `BearerAuthProvider::add_auth_headers`. It makes sure the special routing signal is added only through the same header-writing path used for real outgoing requests.

*Call graph*: 2 external calls (new, assert_eq!).


### `model-provider/src/auth.rs`

`io_transport` · `provider setup and request preparation`

Different model providers expect different proof that a request is allowed. OpenAI-style services often use a bearer token, which is a secret string placed in an Authorization header. Some local or test providers need no authentication at all. Agent identity auth is more specialized: it signs a request for a particular agent task, like writing a tamper-resistant permission slip for that task.

This file is the small switchboard that picks the right kind of authentication for a provider. First it checks for provider-specific secrets, such as an API key configured directly on the provider. Those override the general Codex login. If there is no provider-specific secret, it uses the supplied Codex login snapshot. If there is no login and the provider does not require one, it returns an auth provider that deliberately adds nothing.

It also prevents one important mistake: a Bedrock API key is rejected here unless the actual Amazon Bedrock provider is being used. Without that guard, the system might send the wrong kind of credential to the wrong service.

The result is always a shared auth provider object. Later, when an HTTP request is being prepared, that object is asked to add the correct headers.

#### Function details

##### `AgentIdentityAuthProvider::add_auth_headers`  (lines 26–53)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds the special HTTP headers needed when Codex is acting with an agent identity. This proves both which agent runtime is making the request and which task it is authorized for.

**Data flow**: It reads the stored agent identity record, including the runtime id and private key, and combines that with the current task id. It asks the agent identity library to create an Authorization header, then places that header into the request if it can be built safely. It also adds the ChatGPT account id, and adds a FedRAMP marker header when the account is a FedRAMP account.

**Call relations**: The HTTP layer calls this through the shared AuthProvider interface when it is preparing request headers. This function gathers details from the agent auth object, delegates the signing work to authorization_header_for_agent_task, and writes the finished headers back into the HeaderMap used for the outgoing request.

*Call graph*: calls 4 internal fn (account_id, is_fedramp_account, process_task_id, record); 4 external calls (insert, from_static, from_str, authorization_header_for_agent_task).


##### `UnauthenticatedAuthProvider::add_auth_headers`  (lines 62–62)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Intentionally adds no authentication headers. It is used for providers such as local open-source model servers or tests where sending credentials would be unnecessary or wrong.

**Data flow**: It receives the request header collection, ignores it, and leaves it unchanged. The before and after are the same: no auth information is added.

**Call relations**: The request-building code calls this through the AuthProvider interface just like any other auth provider. It exists so the rest of the system can use one common path for authenticated and unauthenticated providers without adding special cases later.


##### `unauthenticated_auth_provider`  (lines 65–67)

```
fn unauthenticated_auth_provider() -> SharedAuthProvider
```

**Purpose**: Creates a reusable shared auth provider that represents “send no credentials.” This gives callers a standard object even when no login is needed.

**Data flow**: It takes no input, wraps an UnauthenticatedAuthProvider in a shared reference-counted pointer, and returns it. The returned object can be cloned and used wherever a normal auth provider is expected.

**Call relations**: resolve_provider_auth calls this when there is no Codex auth snapshot and no provider-specific bearer token or API key. It hands back the no-op provider so later request preparation can proceed normally.

*Call graph*: called by 1 (resolve_provider_auth); 1 external calls (new).


##### `auth_manager_for_provider`  (lines 72–80)

```
fn auth_manager_for_provider(
    auth_manager: Option<Arc<AuthManager>>,
    provider: &ModelProviderInfo,
) -> Option<Arc<AuthManager>>
```

**Purpose**: Chooses which auth manager should be used for a specific provider. If the provider declares its own command-backed authentication, this function creates a provider-scoped manager for that; otherwise it keeps the caller’s existing manager.

**Data flow**: It receives an optional base AuthManager and the provider description. If the provider has custom auth configuration, it builds a new AuthManager that only supplies an external bearer token. If not, it returns the original manager unchanged.

**Call relations**: Provider construction code calls this during setup, from its new flow, to decide where future credentials should come from. It delegates custom command-backed auth setup to AuthManager::external_bearer_only.

*Call graph*: calls 1 internal fn (external_bearer_only); called by 1 (new).


##### `resolve_provider_auth`  (lines 82–100)

```
fn resolve_provider_auth(
    auth: Option<&CodexAuth>,
    provider: &ModelProviderInfo,
) -> codex_protocol::error::Result<SharedAuthProvider>
```

**Purpose**: Picks the final authentication strategy for one provider. It decides between provider-specific bearer auth, normal Codex auth, no auth, or an error for an unsupported credential type.

**Data flow**: It receives an optional Codex auth snapshot and the provider description. First it rejects Bedrock API key auth in this non-Bedrock path. Then it checks whether the provider itself supplies an API key or bearer token. If so, it returns a BearerAuthProvider for that. If not, it converts the Codex auth snapshot into an auth provider, or returns the unauthenticated provider when there is no auth.

**Call relations**: Tests call this directly to verify the key behaviors. In normal use, provider setup calls it before requests are made. It hands off provider-specific secret lookup to bearer_auth_for_provider, Codex login conversion to auth_provider_from_auth, and no-auth creation to unauthenticated_auth_provider.

*Call graph*: calls 3 internal fn (auth_provider_from_auth, bearer_auth_for_provider, unauthenticated_auth_provider); called by 2 (openai_provider_rejects_bedrock_api_key_auth, unauthenticated_auth_provider_adds_no_headers); 3 external calls (new, matches!, UnsupportedOperation).


##### `bearer_auth_for_provider`  (lines 102–114)

```
fn bearer_auth_for_provider(
    provider: &ModelProviderInfo,
) -> codex_protocol::error::Result<Option<BearerAuthProvider>>
```

**Purpose**: Looks for authentication secrets that are configured directly on the model provider. These provider-level secrets take priority over the general Codex login.

**Data flow**: It reads the provider description. If the provider exposes an API key, it wraps that key in a BearerAuthProvider. If there is no API key but there is an experimental bearer token, it wraps that token instead. If neither exists, it returns None.

**Call relations**: resolve_provider_auth calls this early in its decision process. When this function finds a provider-specific secret, resolve_provider_auth uses it immediately and does not fall back to the broader Codex auth snapshot.

*Call graph*: calls 2 internal fn (api_key, new); called by 1 (resolve_provider_auth).


##### `auth_provider_from_auth`  (lines 117–132)

```
fn auth_provider_from_auth(auth: &CodexAuth) -> SharedAuthProvider
```

**Purpose**: Turns a saved Codex authentication snapshot into the kind of object that can add HTTP auth headers. It is the bridge between login state and outgoing request headers.

**Data flow**: It receives a CodexAuth value. For agent identity auth, it clones the agent identity data into an AgentIdentityAuthProvider. For API-key, ChatGPT, token, or personal-access-token auth, it extracts the token, account id, and FedRAMP status and stores them in a BearerAuthProvider. Bedrock API key auth is marked unreachable here because resolve_provider_auth is expected to reject it before this point.

**Call relations**: resolve_provider_auth calls this after provider-specific auth has been ruled out. The returned shared provider is then used later by request-building code to add the correct headers.

*Call graph*: calls 3 internal fn (get_account_id, get_token, is_fedramp_account); called by 1 (resolve_provider_auth); 3 external calls (new, clone, unreachable!).


##### `tests::unauthenticated_auth_provider_adds_no_headers`  (lines 144–150)

```
fn unauthenticated_auth_provider_adds_no_headers()
```

**Purpose**: Checks that a provider which does not require OpenAI authentication really sends no auth headers. This protects local or open-source provider support from accidentally leaking credentials.

**Data flow**: It creates a local-style provider, asks resolve_provider_auth to choose auth with no Codex login supplied, then converts the result into headers. The expected output is an empty header set.

**Call relations**: This test exercises resolve_provider_auth’s no-auth branch. It confirms that resolve_provider_auth reaches unauthenticated_auth_provider and that the resulting provider leaves the header map empty.

*Call graph*: calls 1 internal fn (resolve_provider_auth); 2 external calls (assert!, create_oss_provider_with_base_url).


##### `tests::openai_provider_rejects_bedrock_api_key_auth`  (lines 153–167)

```
fn openai_provider_rejects_bedrock_api_key_auth()
```

**Purpose**: Checks that a Bedrock API key is not accepted for an OpenAI provider. This prevents a credential meant for Amazon Bedrock from being used in the wrong place.

**Data flow**: It creates an OpenAI provider and a fake Bedrock API key auth value, then asks resolve_provider_auth to resolve it. The expected result is an UnsupportedOperation error containing the specific Bedrock-only message; any success or different error fails the test.

**Call relations**: This test exercises the early rejection path inside resolve_provider_auth. It verifies that the function stops before building any auth provider and returns the documented error message.

*Call graph*: calls 2 internal fn (create_openai_provider, resolve_provider_auth); 3 external calls (assert_eq!, BedrockApiKey, panic!).


### Bedrock and AWS signing
Implements Bedrock-specific endpoint resolution and auth selection on top of AWS config loading and SigV4 request signing.

### `aws-auth/src/config.rs`

`config` · `config load`

AWS clients need a few pieces of information before they can talk to AWS: which service is being used, which account credentials to sign requests with, and which AWS region to target. This file is the bridge between the project’s own `AwsAuthConfig` and the official AWS SDK setup machinery.

The main flow starts by checking that the configured AWS service name is not blank. That matters because AWS request signing depends on the service name; without it, the system would not know what kind of AWS request it is preparing. Then it builds an SDK loader using the AWS SDK’s current behavior rules. If the user supplied an AWS profile, like a named section in an AWS credentials file, it tells the loader to use that. If the user supplied a region, it tells the loader to use that too. Finally, it asks the SDK to load the full configuration, which may include reading environment variables, local AWS config files, or other standard AWS sources.

After loading, the helper functions pull out the credential provider and resolved region. A credential provider is like a safe key dispenser: it knows how to fetch usable AWS credentials when needed. If either credentials or region are missing, this file returns clear project-specific errors instead of letting the failure appear later in a more confusing place.

#### Function details

##### `load_sdk_config`  (lines 9–23)

```
async fn load_sdk_config(config: &AwsAuthConfig) -> Result<SdkConfig, AwsAuthError>
```

**Purpose**: Builds an AWS SDK configuration from the project’s AWS authentication settings. It refuses to continue if the AWS service name is empty, because request signing needs a real service name.

**Data flow**: It receives an `AwsAuthConfig`, reads the service name, optional profile, and optional region, then creates an AWS SDK configuration loader. It adds the profile and region when they are present, waits for the SDK to load the full configuration, and returns either that completed `SdkConfig` or an `AwsAuthError` if the service name was blank.

**Call relations**: This is called by `load` when the broader authentication setup begins. Inside, it relies on the AWS SDK’s default configuration loader, using the latest SDK behavior rules and creating a region value when the caller supplied one.

*Call graph*: called by 1 (load); 3 external calls (latest, new, defaults).


##### `credentials_provider`  (lines 25–31)

```
fn credentials_provider(
    sdk_config: &SdkConfig,
) -> Result<SharedCredentialsProvider, AwsAuthError>
```

**Purpose**: Extracts the AWS credential provider from an already-loaded SDK configuration. This confirms that the SDK knows where to get credentials before the rest of the authentication code tries to sign requests.

**Data flow**: It receives an `SdkConfig`, asks it for its credential provider, and returns that provider if one exists. If the SDK configuration has no credential provider, it returns a `MissingCredentialsProvider` error instead.

**Call relations**: This is called by `load` after the SDK configuration has been loaded. It hands back the credential source that later authentication work needs in order to obtain AWS signing credentials.

*Call graph*: called by 1 (load); 1 external calls (credentials_provider).


##### `resolved_region`  (lines 33–38)

```
fn resolved_region(sdk_config: &SdkConfig) -> Result<String, AwsAuthError>
```

**Purpose**: Finds the final AWS region chosen by the SDK configuration and returns it as plain text. This makes sure the system has a concrete region to use for AWS signing and requests.

**Data flow**: It receives an `SdkConfig`, reads the region that the SDK resolved from explicit settings, environment variables, or AWS config files, and converts it to a string. If no region was found, it returns a `MissingRegion` error.

**Call relations**: This is called by `load` after configuration loading is complete. It supplies the resolved region to the rest of the authentication setup, so later code does not have to guess or repeat the SDK lookup.

*Call graph*: called by 1 (load); 1 external calls (region).


### `aws-auth/src/signing.rs`

`domain_logic` · `request signing`

AWS services usually do not accept a plain request with just a password-like token. Instead, the client must add a special cryptographic signature to the request. This file is the small bridge between this project’s request type and Amazon’s official Signature Version 4 signing library. Think of it like sealing an envelope with a tamper-proof stamp: the request still has the same destination and content, but now it carries proof of who sent it and when.

The main function takes AWS credentials, the target region, the AWS service name, the request to send, and the time to use for signing. It first converts the request headers into a form the AWS signing library can read. If any header contains text that cannot safely be used, it returns an error instead of producing a bad signature. It then builds a signable version of the request, creates signing settings, asks the AWS library to calculate the signature, and applies the resulting header changes to an HTTP request object.

The result is not the full request body again. It returns the signed URL and signed headers, which are the parts needed by the rest of the system to send an authenticated request. The file also includes a tiny test-only helper for reading header values as strings.

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

**Purpose**: Adds AWS Signature Version 4 authentication information to a request. Someone uses this when they have a request ready to send to AWS and need AWS to trust that it came from the owner of the supplied credentials.

**Data flow**: It receives AWS credentials, a region such as where the AWS service lives, a service name, a request containing method, URL, headers, and body, plus the time to sign with. It converts the headers and body into the AWS signing library’s expected shape, builds signing parameters, asks the library to compute the signature, and applies the resulting changes to a temporary HTTP request. It returns a new signed request containing the final URL and headers, or an error if any part could not be converted, signed, or rebuilt safely.

**Call relations**: This function is called by sign_at, which supplies the exact signing time. Inside, it relies on outside library builders and signing routines to do the cryptographic work rather than implementing the signature math itself. After the external signing function produces instructions, this function applies those instructions to the HTTP request so the rest of the project can send it as an authenticated AWS request.

*Call graph*: called by 1 (sign_at); 8 external calls (clone, Bytes, new, default, from_str, sign, builder, builder).


##### `header_value`  (lines 71–76)

```
fn header_value(headers: &http::HeaderMap, name: &str) -> Option<String>
```

**Purpose**: Reads one header from a header map and returns it as ordinary text, but only in test builds. It is a convenience helper for tests that need to check whether signing added the expected header value.

**Data flow**: It receives a collection of HTTP headers and the name of the header to look up. It searches for that header, tries to interpret its value as valid text, and returns that text as a String if everything succeeds. If the header is missing or cannot be read as text, it returns nothing.

**Call relations**: This helper is only compiled for tests. It uses the header map’s lookup operation to make assertions easier, so tests can focus on the meaning of a signed header instead of repeatedly writing the same conversion code.

*Call graph*: 1 external calls (get).


### `aws-auth/src/lib.rs`

`io_transport` · `startup and request handling`

AWS services usually require requests to be signed with SigV4, Amazon’s request-signing scheme that proves who sent the request and that it was not changed in transit. This file gives the rest of the project a small, simple wrapper around that process. Without it, callers would need to know how to find AWS credentials, choose a region, build the right signing inputs, and decide which failures are worth retrying.

The main type is AwsAuthContext. Think of it like a stamped envelope kit: once it has loaded the right credentials, region, and service name, callers can hand it an HTTP request and get back the same request with the AWS signature headers added. AwsAuthConfig is the setup form for that kit: optional profile, optional region, and the AWS service name. AwsRequestToSign and AwsSignedRequest are plain containers for the request before and after signing.

The file also defines AwsAuthError, which turns many possible setup and signing failures into clear project-level errors. One important detail is retry behavior: temporary credential-provider failures may be worth trying again, but broken inputs such as an invalid URL or missing region are treated as fixed problems that retrying will not solve.

The tests use fixed credentials and time values so the signing behavior is predictable. They check that existing headers survive, signature headers are added, session tokens are included, and empty service names are rejected.

#### Function details

##### `AwsAuthContext::fmt`  (lines 71–76)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This controls how an AwsAuthContext is shown in debug output. It deliberately shows the region and service, but not the credentials, so logs can be useful without leaking secrets.

**Data flow**: It receives the authentication context and a debug formatter. It writes a short debug view containing the region and service, then returns the formatter result. The hidden credential provider is not printed.

**Call relations**: This is called automatically by Rust’s debug-printing machinery when someone formats AwsAuthContext for diagnostics. It hands the work to the standard debug builder so the output looks like other Rust debug output.

*Call graph*: 1 external calls (debug_struct).


##### `AwsAuthContext::load`  (lines 80–90)

```
async fn load(config: AwsAuthConfig) -> Result<Self, AwsAuthError>
```

**Purpose**: This builds a ready-to-use AWS authentication context from user configuration. Callers use it before sending signed AWS requests.

**Data flow**: It takes an AwsAuthConfig containing an optional profile, optional region, and service name. It asks the config module to load AWS SDK settings, extracts a credentials provider and resolved region, trims the service name, and returns an AwsAuthContext. If credentials, region, or service setup cannot be resolved, it returns an AwsAuthError instead.

**Call relations**: This is the setup step used by higher-level authentication selection, including resolve_auth_method. In tests, load_rejects_empty_service_name calls it to confirm invalid service names fail early. Internally it relies on load_sdk_config, credentials_provider, and resolved_region to do the AWS SDK-specific setup.

*Call graph*: calls 3 internal fn (credentials_provider, load_sdk_config, resolved_region); called by 2 (load_rejects_empty_service_name, resolve_auth_method).


##### `AwsAuthContext::region`  (lines 92–94)

```
fn region(&self) -> &str
```

**Purpose**: This returns the AWS region stored in the loaded authentication context. It lets other code inspect which region will be used for signing.

**Data flow**: It reads the region string already stored in the context and returns it as borrowed text. It does not change anything.

**Call relations**: This is a small accessor for callers that need to report or use the resolved region after AwsAuthContext::load has completed.


##### `AwsAuthContext::service`  (lines 96–98)

```
fn service(&self) -> &str
```

**Purpose**: This returns the AWS service name stored in the loaded authentication context. The service name is part of the AWS signature, so callers may need to inspect it for diagnostics or routing.

**Data flow**: It reads the service string already stored in the context and returns it as borrowed text. It does not change the context.

**Call relations**: This is a small accessor used after the context has been loaded, giving other parts of the program a safe read-only view of the service name.


##### `AwsAuthContext::sign`  (lines 100–102)

```
async fn sign(&self, request: AwsRequestToSign) -> Result<AwsSignedRequest, AwsAuthError>
```

**Purpose**: This signs an outgoing HTTP request using the current time. It is the normal method callers use right before sending a request to AWS.

**Data flow**: It takes an unsigned request containing method, URL, headers, and body. It gets the current system time, passes the request and time to sign_at, and returns the signed URL and headers or an authentication error.

**Call relations**: This is called by apply_auth during request preparation. It delegates the real work to sign_at so production code can use the current time while tests can use a fixed time.

*Call graph*: calls 1 internal fn (sign_at); called by 1 (apply_auth); 1 external calls (now).


##### `AwsAuthContext::sign_at`  (lines 104–111)

```
async fn sign_at(
        &self,
        request: AwsRequestToSign,
        time: SystemTime,
    ) -> Result<AwsSignedRequest, AwsAuthError>
```

**Purpose**: This does the actual signing work for a request at a specific time. The fixed time makes signing testable and repeatable.

**Data flow**: It receives an unsigned request and a timestamp. It asks the stored credentials provider for AWS credentials, then passes those credentials, the context’s region and service, the request, and the time to the signing module. The result is a signed request or an AwsAuthError.

**Call relations**: AwsAuthContext::sign calls this with the current time. The unit tests call it directly with a fixed timestamp so they can make stable assertions. It hands the low-level SigV4 work to signing::sign_request after credentials have been fetched.

*Call graph*: calls 1 internal fn (sign_request); called by 1 (sign); 1 external calls (provide_credentials).


##### `AwsAuthError::is_retryable`  (lines 116–133)

```
fn is_retryable(&self) -> bool
```

**Purpose**: This answers a practical question: if authentication failed, is it worth trying the request again? It marks temporary credential-provider problems as retryable and fixed input/configuration problems as not retryable.

**Data flow**: It reads the specific AwsAuthError variant. If the error came from loading credentials, it checks whether the credential provider timed out or reported a provider-side problem. It returns true for those temporary-looking cases and false for all deterministic failures such as bad URLs, missing region, or signing construction errors.

**Call relations**: aws_auth_error_to_auth_error calls this when converting AWS authentication failures into the project’s broader authentication error type. That lets higher-level retry logic make a sensible decision without knowing AWS-specific error details.

*Call graph*: called by 1 (aws_auth_error_to_auth_error); 1 external calls (matches!).


##### `tests::test_context`  (lines 147–159)

```
fn test_context(session_token: Option<&str>) -> AwsAuthContext
```

**Purpose**: This builds a fake AwsAuthContext for tests using known example credentials. It avoids depending on real AWS accounts or local machine configuration.

**Data flow**: It receives an optional session token. It creates static AWS credentials, wraps them in a shared credentials provider, and returns an AwsAuthContext for region us-east-1 and service bedrock.

**Call relations**: The signing tests call this helper when they need a predictable context. It supplies the credentials that sign_at later uses, making the tests self-contained.

*Call graph*: 2 external calls (new, new).


##### `tests::test_request`  (lines 161–174)

```
fn test_request() -> AwsRequestToSign
```

**Purpose**: This creates a sample HTTP request for signing tests. It includes a JSON body and a couple of existing headers so tests can check that signing does not erase caller-provided headers.

**Data flow**: It creates a new header map, inserts content-type and x-test-header values, then returns an AwsRequestToSign with POST method, a Bedrock Runtime URL, those headers, and a small JSON body.

**Call relations**: The signing tests call this helper before passing the request to sign_at. It provides a consistent before-signing request shape for assertions.

*Call graph*: 3 external calls (from_static, new, from_static).


##### `tests::sign_adds_sigv4_headers_and_preserves_existing_headers`  (lines 177–203)

```
async fn sign_adds_sigv4_headers_and_preserves_existing_headers()
```

**Purpose**: This test proves that signing adds the AWS SigV4 headers while keeping headers that were already present. It protects against a common bug where authentication code accidentally rebuilds a request and drops user headers.

**Data flow**: It builds a test context without a session token and a sample request. It signs the request at a fixed time, then checks that content-type and x-test-header are still present, the URL is unchanged, an Authorization header was added, and an x-amz-date header exists.

**Call relations**: This test uses tests::test_context and tests::test_request to set up predictable inputs. It exercises AwsAuthContext::sign_at, which then calls the real signing path.

*Call graph*: 5 external calls (from_secs, assert!, assert_eq!, test_context, test_request).


##### `tests::credentials_provider_failures_are_retryable`  (lines 206–215)

```
fn credentials_provider_failures_are_retryable()
```

**Purpose**: This test confirms that temporary credential-loading problems are marked as retryable. That matters because a later attempt might succeed if a provider was briefly unavailable or slow.

**Data flow**: It creates two credential errors: one provider error and one timeout. It wraps each in AwsAuthError::Credentials and checks that is_retryable returns true.

**Call relations**: This test directly exercises AwsAuthError::is_retryable. It supports the higher-level retry behavior used when AWS authentication errors are converted for the rest of the system.

*Call graph*: 1 external calls (assert!).


##### `tests::deterministic_aws_auth_errors_are_not_retryable`  (lines 218–231)

```
fn deterministic_aws_auth_errors_are_not_retryable()
```

**Purpose**: This test confirms that fixed problems are not treated as retryable. Retrying cannot fix an empty service name, missing credential source, invalid configuration, or unexpected credential error classified as non-temporary.

**Data flow**: It creates several deterministic authentication errors and checks that is_retryable returns false for each one.

**Call relations**: This test directly exercises AwsAuthError::is_retryable. It guards the boundary between useful retries and pointless repeated failures.

*Call graph*: 1 external calls (assert!).


##### `tests::sign_includes_session_token_when_credentials_have_one`  (lines 234–247)

```
async fn sign_includes_session_token_when_credentials_have_one()
```

**Purpose**: This test checks that temporary AWS credentials include their session token in the signed request. AWS rejects temporary credentials if the token is missing, even when the access key and signature are present.

**Data flow**: It builds a test context with a session token, signs a sample request at a fixed time, and verifies that the signed headers contain x-amz-security-token with the expected token value.

**Call relations**: This test uses tests::test_context and tests::test_request, then exercises AwsAuthContext::sign_at. It verifies that the signing module receives and preserves session-token information from the credentials.

*Call graph*: 4 external calls (from_secs, assert_eq!, test_context, test_request).


##### `tests::load_rejects_empty_service_name`  (lines 250–260)

```
async fn load_rejects_empty_service_name()
```

**Purpose**: This test makes sure an all-whitespace AWS service name is rejected during context loading. The service name is required for SigV4 signing, so accepting an empty one would cause confusing failures later.

**Data flow**: It calls AwsAuthContext::load with no profile, no region, and a service string containing only spaces. It expects loading to fail and checks that the error message says the AWS service name must not be empty.

**Call relations**: This test calls AwsAuthContext::load directly. Through that path it verifies that the setup code refuses invalid service configuration before any request signing happens.

*Call graph*: calls 1 internal fn (load); 1 external calls (assert_eq!).


### `model-provider/src/amazon_bedrock/auth.rs`

`io_transport` · `startup and request handling`

Amazon Bedrock can accept more than one kind of authentication. This file is the switchboard that chooses the right one and prepares outgoing requests so Bedrock will trust them. First it looks for a managed Bedrock API key that was already supplied by the login/config system. If that is not present, it checks the AWS_BEARER_TOKEN_BEDROCK environment variable. If neither bearer-token path is available, it falls back to AWS SDK-style authentication, where credentials are found from the normal AWS setup and each request is signed with SigV4.

The bearer-token path is like showing a pass at the door: the request gets an Authorization: Bearer ... header. For that mode, the code must also know the AWS region, so it looks in provider config first, then AWS_REGION, then AWS_DEFAULT_REGION.

The SigV4 path is stricter. Before signing, the file removes headers containing underscores because Bedrock Mantle does not preserve those headers before checking the signature. If Codex signed headers that Bedrock later dropped, the signature would no longer match and the request would fail. Then it prepares the body as raw bytes, asks the AWS auth context to sign the method, URL, headers, and body, and replaces the request with the signed version.

#### Function details

##### `resolve_auth_method`  (lines 33–54)

```
async fn resolve_auth_method(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<BedrockAuthMethod>
```

**Purpose**: Chooses the concrete authentication method Codex should use for Amazon Bedrock. It prefers an explicitly managed Bedrock API key, then an environment bearer token, and finally AWS SDK credential signing.

**Data flow**: It receives optional managed Bedrock login data and AWS provider settings. It checks those inputs and selected environment variables, builds either a bearer-token choice with a region or loads an AWS authentication context, then returns the chosen BedrockAuthMethod or a fatal error if AWS auth cannot be loaded.

**Call relations**: resolve_provider_auth calls this when it needs an actual auth provider object. Another Bedrock flow, resolve_region, also calls it when it needs to know which auth route and region apply. Inside, it uses non_empty_env_var_from to read clean environment values, bearer_token_region to find a region for token auth, aws_auth_config to build AWS settings, and AwsAuthContext::load to initialize AWS signing.

*Call graph*: calls 4 internal fn (load, bearer_token_region, non_empty_env_var_from, aws_auth_config); called by 2 (resolve_provider_auth, resolve_region).


##### `resolve_provider_auth`  (lines 56–71)

```
async fn resolve_provider_auth(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<SharedAuthProvider>
```

**Purpose**: Turns the chosen Bedrock authentication method into the shared AuthProvider object used by the request-sending code. This hides whether Bedrock is using a bearer token or SigV4 signing from the rest of the client.

**Data flow**: It receives the same managed-auth and AWS configuration inputs as resolve_auth_method. After resolve_auth_method returns a choice, it wraps a BearerAuthProvider for token auth or creates a BedrockMantleSigV4AuthProvider for AWS signing, then returns it behind a shared pointer so other code can use it uniformly.

**Call relations**: This is the bridge between auth selection and request sending. It calls resolve_auth_method first, then either hands off to BearerAuthProvider for simple Authorization headers or to BedrockMantleSigV4AuthProvider::new for per-request AWS signing.

*Call graph*: calls 2 internal fn (new, resolve_auth_method); 1 external calls (new).


##### `non_empty_env_var_from`  (lines 73–81)

```
fn non_empty_env_var_from(
    name: &'static str,
    env_var: impl Fn(&'static str) -> std::result::Result<String, std::env::VarError>,
) -> Option<String>
```

**Purpose**: Reads an environment variable only if it exists and has real content after trimming spaces. This prevents blank variables from being mistaken for useful credentials or settings.

**Data flow**: It receives an environment variable name and a function that can read environment variables. It tries to read the value, trims leading and trailing whitespace, rejects an empty result, and returns either the cleaned string or nothing.

**Call relations**: resolve_auth_method uses this to look for AWS_BEARER_TOKEN_BEDROCK. bearer_token_region also uses the same helper indirectly through its own environment lookups for AWS_REGION and AWS_DEFAULT_REGION.

*Call graph*: called by 1 (resolve_auth_method).


##### `bearer_token_region`  (lines 83–97)

```
fn bearer_token_region(
    aws: &ModelProviderAwsAuthInfo,
    env_var: impl Fn(&'static str) -> std::result::Result<String, std::env::VarError> + Copy,
) -> Result<String>
```

**Purpose**: Finds the AWS region needed when Bedrock is authenticated with a bearer token. Without a region, the Bedrock bearer-token setup is incomplete and the code reports a clear fatal error.

**Data flow**: It receives AWS provider settings and an environment-reading function. It checks the configured region first, then AWS_REGION, then AWS_DEFAULT_REGION, trimming blank values along the way; it returns the first usable region or a fatal error explaining what must be set.

**Call relations**: resolve_auth_method calls this after finding an environment bearer token. The tests call it directly to prove the priority order and the missing-region error. It depends on region_from_config to read and normalize the provider configuration value.

*Call graph*: calls 1 internal fn (region_from_config); called by 5 (resolve_auth_method, bedrock_bearer_auth_prefers_configured_region_and_uses_header, bedrock_bearer_auth_rejects_missing_configured_region, bedrock_bearer_auth_uses_aws_default_region_env, bedrock_bearer_auth_uses_aws_region_env).


##### `aws_auth_error_to_codex_error`  (lines 99–101)

```
fn aws_auth_error_to_codex_error(error: AwsAuthError) -> CodexErr
```

**Purpose**: Converts an AWS authentication setup failure into the project’s general fatal error type. This gives users a Bedrock-specific message instead of leaking a lower-level AWS error shape.

**Data flow**: It receives an AwsAuthError. It formats that error into a sentence saying Amazon Bedrock auth could not be resolved, then returns it as a fatal CodexErr.

**Call relations**: resolve_auth_method uses this when AwsAuthContext::load fails while preparing AWS SDK-style signing.

*Call graph*: 2 external calls (format!, Fatal).


##### `aws_auth_error_to_auth_error`  (lines 103–109)

```
fn aws_auth_error_to_auth_error(error: AwsAuthError) -> AuthError
```

**Purpose**: Converts an AWS signing error into the auth error type used while sending requests. It keeps an important distinction: retryable problems are temporary, while non-retryable problems mean the request could not be built correctly.

**Data flow**: It receives an AwsAuthError and asks whether it is retryable. If yes, it returns a transient AuthError; otherwise it returns a build AuthError. In both cases, the original AWS error text is preserved for diagnosis.

**Call relations**: BedrockMantleSigV4AuthProvider::apply_auth uses this after asking the AWS auth context to sign a request.

*Call graph*: calls 1 internal fn (is_retryable); 3 external calls (to_string, Build, Transient).


##### `remove_headers_not_preserved_by_bedrock_mantle`  (lines 111–124)

```
fn remove_headers_not_preserved_by_bedrock_mantle(headers: &mut HeaderMap)
```

**Purpose**: Removes request headers with underscores in their names before AWS signing. This prevents Bedrock Mantle from rejecting requests because the signed headers do not match what Bedrock actually receives.

**Data flow**: It receives a mutable header map. It finds every header name containing an underscore, collects those names, removes them from the map, and leaves all other headers untouched.

**Call relations**: BedrockMantleSigV4AuthProvider::apply_auth calls this immediately before preparing and signing a request. The dedicated test calls it directly to confirm underscore headers are removed while normal hyphenated headers remain.

*Call graph*: called by 2 (apply_auth, bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle); 2 external calls (keys, remove).


##### `BedrockMantleSigV4AuthProvider::new`  (lines 133–135)

```
fn new(context: AwsAuthContext) -> Self
```

**Purpose**: Creates the Bedrock SigV4 auth provider around an already-loaded AWS authentication context. The context is the object that knows how to sign requests using AWS credentials.

**Data flow**: It receives an AwsAuthContext and stores it inside a new BedrockMantleSigV4AuthProvider. The result is ready to sign outgoing Bedrock Mantle requests.

**Call relations**: resolve_provider_auth calls this when resolve_auth_method selected AWS SDK authentication instead of bearer-token authentication.

*Call graph*: called by 1 (resolve_provider_auth).


##### `BedrockMantleSigV4AuthProvider::add_auth_headers`  (lines 161–161)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Does nothing because SigV4 authentication cannot be added as a simple static header. The signature depends on the full request, including method, URL, headers, and body.

**Data flow**: It receives a mutable header map but deliberately leaves it unchanged. No value is returned beyond completing the method call.

**Call relations**: This satisfies the AuthProvider interface, which supports simple header-based auth providers too. For this provider, the real work happens later in BedrockMantleSigV4AuthProvider::apply_auth, when the whole request is available.


##### `BedrockMantleSigV4AuthProvider::apply_auth`  (lines 163–165)

```
fn apply_auth(&self, request: Request) -> codex_api::AuthProviderFuture<'_>
```

**Purpose**: Signs a full outgoing Bedrock Mantle request using AWS SigV4. This is needed because AWS verifies the signature against the exact request content it receives.

**Data flow**: It receives a Request. It removes unsupported underscore headers, prepares the body as bytes, sends the method, URL, headers, and body bytes to the AWS signing context, then replaces the request URL and headers with the signed versions, stores the prepared raw body, disables compression, and returns the signed request or an auth error.

**Call relations**: The request-sending layer calls this through the AuthProvider trait when a Bedrock request is about to be sent. It uses remove_headers_not_preserved_by_bedrock_mantle before signing, prepare_body_for_send so the body bytes are stable, and the AWS context’s sign operation to produce the final authenticated request.

*Call graph*: calls 3 internal fn (sign, prepare_body_for_send, remove_headers_not_preserved_by_bedrock_mantle); 1 external calls (pin).


##### `tests::missing_env_var`  (lines 176–178)

```
fn missing_env_var(_: &'static str) -> std::result::Result<String, std::env::VarError>
```

**Purpose**: Provides a fake environment-variable reader that always says the variable is missing. Tests use it to check the missing-region error path without depending on the real machine environment.

**Data flow**: It receives an environment variable name and ignores it. It always returns a NotPresent error.

**Call relations**: tests::bedrock_bearer_auth_rejects_missing_configured_region passes this helper into bearer_token_region to simulate a completely unset environment.


##### `tests::bedrock_bearer_auth_prefers_configured_region_and_uses_header`  (lines 181–210)

```
fn bedrock_bearer_auth_prefers_configured_region_and_uses_header()
```

**Purpose**: Checks that a region written in provider configuration wins over AWS_REGION, and that bearer-token authentication creates an Authorization header. This protects the intended priority order for user settings.

**Data flow**: The test builds fake AWS provider settings with a configured region and a fake environment containing a different AWS_REGION. It calls bearer_token_region, creates a BearerAuthProvider with a test token, asks it to add headers, and asserts that the chosen region is the configured one and the Authorization header starts with the expected Bearer token text.

**Call relations**: This test directly exercises bearer_token_region and the bearer provider behavior that resolve_provider_auth would use after token auth is selected.

*Call graph*: calls 1 internal fn (bearer_token_region); 3 external calls (assert!, assert_eq!, new).


##### `tests::bedrock_bearer_auth_uses_aws_region_env`  (lines 213–227)

```
fn bedrock_bearer_auth_uses_aws_region_env()
```

**Purpose**: Checks that AWS_REGION is used when no region is set in the provider configuration. This confirms the normal AWS environment convention works for Bedrock bearer-token auth.

**Data flow**: The test provides AWS settings with no region and a fake environment where AWS_REGION has a value with extra spaces. It calls bearer_token_region and asserts the returned region is trimmed and correct.

**Call relations**: This test focuses on one fallback branch inside bearer_token_region, the same branch resolve_auth_method uses after finding an environment bearer token.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_bearer_auth_uses_aws_default_region_env`  (lines 230–244)

```
fn bedrock_bearer_auth_uses_aws_default_region_env()
```

**Purpose**: Checks that AWS_DEFAULT_REGION is used as a backup when neither provider config nor AWS_REGION supplies a region. This matches common AWS tooling behavior.

**Data flow**: The test provides AWS settings with no region and a fake environment where only AWS_DEFAULT_REGION is present. It calls bearer_token_region and asserts that this default-region value is returned.

**Call relations**: This test covers the final successful fallback inside bearer_token_region before it would produce an error.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_bearer_auth_rejects_missing_configured_region`  (lines 247–262)

```
fn bedrock_bearer_auth_rejects_missing_configured_region()
```

**Purpose**: Checks that bearer-token authentication fails clearly when no region can be found. This matters because silently guessing a region would send requests to the wrong place or fail later with a harder-to-understand error.

**Data flow**: The test provides AWS settings with no region and an environment reader that reports every variable as missing. It calls bearer_token_region, expects an error, and checks that the message tells the user exactly which config or environment variables can fix it.

**Call relations**: This test uses tests::missing_env_var to force bearer_token_region into its error path.

*Call graph*: calls 1 internal fn (bearer_token_region); 1 external calls (assert_eq!).


##### `tests::bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle`  (lines 265–295)

```
fn bedrock_mantle_sigv4_strips_headers_not_preserved_by_mantle()
```

**Purpose**: Checks that headers with underscores are removed before signing, while normal headers are kept. This guards against a subtle Bedrock Mantle signature failure.

**Data flow**: The test builds a header map containing several underscore-style headers and one hyphenated request-id header. It calls remove_headers_not_preserved_by_bedrock_mantle, then asserts that the underscore headers are gone and the hyphenated header still has its original value.

**Call relations**: This test directly verifies the cleanup step that BedrockMantleSigV4AuthProvider::apply_auth performs before calling AWS SigV4 signing.

*Call graph*: calls 1 internal fn (remove_headers_not_preserved_by_bedrock_mantle); 4 external calls (new, from_static, assert!, assert_eq!).


### `model-provider/src/amazon_bedrock/mantle.rs`

`io_transport` · `provider setup and request preparation`

Amazon Bedrock Mantle is exposed through region-specific web addresses, so Codex cannot send every request to one fixed URL. This file is the small map and rulebook for that connection. It names the AWS service as `bedrock-mantle`, lists the regions that are allowed, turns user AWS settings into an authentication configuration, and builds the final OpenAI-compatible base URL for the selected region.

The flow is like choosing the right branch office before mailing a package. First, the code looks at the user or managed login settings to decide which AWS region should be used. If the user wrote a region with extra spaces, it trims those spaces. Then it checks the region against Mantle’s supported-region list. If the region is valid, it returns a URL such as `https://bedrock-mantle.ap-northeast-1.api.aws/openai/v1`. If not, it stops with a clear fatal error instead of letting a later network request fail in a confusing way.

The file also supports different authentication paths: managed bearer tokens, environment-provided bearer tokens, or AWS SDK credentials. No matter which path is used, this file extracts the region and turns it into the endpoint Codex should call.

#### Function details

##### `aws_auth_config`  (lines 26–32)

```
fn aws_auth_config(aws: &ModelProviderAwsAuthInfo) -> AwsAuthConfig
```

**Purpose**: Builds the AWS authentication settings needed when Codex signs requests for Bedrock Mantle. It preserves the chosen AWS profile, cleans up the configured region, and always uses the Mantle service name.

**Data flow**: It receives `ModelProviderAwsAuthInfo`, which may contain an AWS profile name and a region. It copies the profile, asks `region_from_config` to normalize the region, adds the fixed service name `bedrock-mantle`, and returns an `AwsAuthConfig` ready for the authentication layer.

**Call relations**: This is called by `resolve_auth_method` when the broader Bedrock authentication code decides it needs AWS SDK-style authentication. It hands back the exact AWS signing settings that the rest of the authentication flow can use.

*Call graph*: calls 1 internal fn (region_from_config); called by 1 (resolve_auth_method).


##### `region_from_config`  (lines 34–40)

```
fn region_from_config(aws: &ModelProviderAwsAuthInfo) -> Option<String>
```

**Purpose**: Extracts a usable AWS region from provider settings. It treats missing, blank, or all-space regions as no region at all.

**Data flow**: It receives AWS provider settings. It looks at the optional region string, trims spaces from both ends, discards it if it becomes empty, and otherwise returns the cleaned region as `Some(...)`; if there is no usable region, it returns `None`.

**Call relations**: This helper is used by `aws_auth_config` when building AWS signing settings and by `bearer_token_region` elsewhere in the Bedrock authentication code. It keeps region cleanup consistent across authentication paths.

*Call graph*: called by 2 (bearer_token_region, aws_auth_config).


##### `base_url`  (lines 42–50)

```
fn base_url(region: &str) -> Result<String>
```

**Purpose**: Turns a supported AWS region into the Bedrock Mantle API base URL. It also blocks unsupported regions with a clear error message.

**Data flow**: It receives a region string. It checks whether that region is in the fixed supported-region list. If it is, it formats and returns the Mantle OpenAI-compatible URL for that region; if not, it returns a fatal Codex error explaining that Mantle does not support the region.

**Call relations**: This is used by `runtime_base_url` after the region has been resolved. It is also exercised by tests and by provider-level checks that make sure configured bearer-token regions produce the expected endpoint.

*Call graph*: called by 3 (runtime_base_url, base_url_rejects_unsupported_region, api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint); 2 external calls (format!, Fatal).


##### `runtime_base_url`  (lines 52–58)

```
async fn runtime_base_url(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<String>
```

**Purpose**: Finds the correct Bedrock Mantle base URL at runtime, after taking the active authentication method into account. This is the main async entry point in this file for code that needs to know where to send requests.

**Data flow**: It receives optional managed API-key authentication plus AWS provider settings. It asks `resolve_region` to determine the effective region, then passes that region to `base_url`; the result is either a ready-to-use URL string or an error if the region is unsupported or authentication resolution fails.

**Call relations**: Provider setup code calls this when it needs the final endpoint for Bedrock Mantle. Internally it delegates region choice to `resolve_region` and endpoint construction to `base_url`, keeping those two decisions separate.

*Call graph*: calls 2 internal fn (base_url, resolve_region); called by 2 (api_provider, runtime_base_url).


##### `resolve_region`  (lines 60–69)

```
async fn resolve_region(
    managed_auth: Option<&BedrockApiKeyAuth>,
    aws: &ModelProviderAwsAuthInfo,
) -> Result<String>
```

**Purpose**: Determines which AWS region should be used, based on the authentication method that is actually active. Different login methods store or discover the region in different places, and this function hides that difference.

**Data flow**: It receives optional managed bearer-token authentication and AWS provider settings. It calls `resolve_auth_method`, then pattern-matches the result: bearer-token methods already include a region, while AWS SDK authentication carries a context object whose region is read and converted to text. It returns the resolved region string.

**Call relations**: This function is called by `runtime_base_url` before the endpoint URL can be built. It depends on `resolve_auth_method`, which makes the larger decision about whether Codex is using a managed token, an environment token, or AWS SDK credentials.

*Call graph*: calls 1 internal fn (resolve_auth_method); called by 1 (runtime_base_url).


##### `tests::base_url_uses_region_endpoint`  (lines 78–83)

```
fn base_url_uses_region_endpoint()
```

**Purpose**: Checks that a known supported region is turned into the exact expected Mantle URL. This protects the URL format from accidental changes.

**Data flow**: The test gives `base_url` the region `ap-northeast-1`. It expects a successful result and compares the returned string with the exact region-specific URL.

**Call relations**: This test directly exercises `base_url`, confirming the happy path that production code uses after `runtime_base_url` has resolved a region.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::base_url_rejects_unsupported_region`  (lines 86–93)

```
fn base_url_rejects_unsupported_region()
```

**Purpose**: Checks that unsupported regions are rejected with a clear fatal error. This ensures users get an understandable message instead of a mysterious failed network call later.

**Data flow**: The test calls `base_url` with `us-west-1`, which is not in the supported list. It expects an error, converts that error to text, and compares it with the exact message.

**Call relations**: This test covers the failure path inside `base_url`, the same guard that `runtime_base_url` relies on before any Mantle request is attempted.

*Call graph*: calls 1 internal fn (base_url); 1 external calls (assert_eq!).


##### `tests::aws_auth_config_uses_profile_and_mantle_service`  (lines 96–108)

```
fn aws_auth_config_uses_profile_and_mantle_service()
```

**Purpose**: Checks that AWS authentication settings keep the configured profile and use the correct Mantle service name when no region is configured.

**Data flow**: The test builds provider AWS settings with profile `codex-bedrock` and no region. It calls `aws_auth_config` and compares the result with an `AwsAuthConfig` containing that profile, no region, and service `bedrock-mantle`.

**Call relations**: This test verifies the data that `aws_auth_config` hands to the broader `resolve_auth_method` authentication flow when AWS SDK credentials are used.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::aws_auth_config_uses_configured_region`  (lines 111–123)

```
fn aws_auth_config_uses_configured_region()
```

**Purpose**: Checks that a configured region is cleaned before being placed into AWS authentication settings. This prevents harmless extra spaces in configuration from breaking authentication.

**Data flow**: The test creates provider AWS settings with the region string ` us-west-2 `. It calls `aws_auth_config` and expects the returned config to contain `us-west-2` without surrounding spaces, along with the Mantle service name.

**Call relations**: This test confirms that `aws_auth_config` correctly relies on `region_from_config`, which is also used elsewhere for consistent region cleanup.

*Call graph*: 1 external calls (assert_eq!).


### `model-provider/src/amazon_bedrock/mod.rs`

`domain_logic` · `provider setup and request handling`

Amazon Bedrock can be reached in two different ways here: with a Codex-managed Bedrock API key, or with normal AWS-managed credentials such as an AWS profile and region. This file is the adapter that hides that choice from the rest of the application. A useful analogy is a travel plug adapter: the app speaks one familiar “OpenAI-style” shape, and this provider makes it fit Bedrock’s socket.

The central type is `AmazonBedrockModelProvider`. It stores the provider’s general information, Bedrock-specific AWS settings, and optionally an `AuthManager`, which is the part of the system that remembers login credentials. When asked for authentication, it deliberately accepts only Bedrock API-key credentials from that manager. If the cached login is an OpenAI key, ChatGPT login, personal access token, or another unrelated credential, it is ignored so that secrets for one service are not accidentally sent to another.

When the app needs to call Bedrock, this provider builds the correct runtime base URL from the selected region, prepares the right authorization method, reports the account state, and supplies a static model catalog. It also tells the rest of the system which hosted tools are supported: namespace tools are allowed, but image generation and web search are disabled for this provider.

#### Function details

##### `AmazonBedrockModelProvider::new`  (lines 42–58)

```
fn new(
        provider_info: ModelProviderInfo,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Creates a Bedrock model provider from general provider settings and an optional login manager. It also extracts the AWS profile and region settings, falling back to empty AWS settings if none were supplied.

**Data flow**: It receives `ModelProviderInfo` and maybe an `AuthManager`. It reads the AWS-specific section from the provider info, or creates a default with no profile and no region. It returns an `AmazonBedrockModelProvider` containing the original provider info, the chosen AWS settings, and the optional auth manager.

**Call relations**: This is the starting point used by the wider provider factory, `create_model_provider`, when Bedrock is selected. The tests also call it to build providers with different credential setups before checking authentication, capabilities, and preferred model behavior.

*Call graph*: called by 5 (approval_review_preferred_model_uses_bedrock_gpt_5_4, capabilities_disable_unsupported_hosted_tools, managed_auth_takes_precedence_over_aws_auth, openai_auth_is_not_exposed_to_bedrock, create_model_provider).


##### `AmazonBedrockModelProvider::managed_auth`  (lines 60–72)

```
fn managed_auth(&self) -> Option<BedrockApiKeyAuth>
```

**Purpose**: Looks inside the optional login manager and returns a Bedrock API-key login only if one is present. It protects against accidentally treating other kinds of login, such as an OpenAI API key, as Bedrock credentials.

**Data flow**: It reads the cached authentication from `auth_manager`, if there is one. If the cached value is `CodexAuth::BedrockApiKey`, it returns that Bedrock API-key data. For every other login type, or if no login manager/cache exists, it returns nothing.

**Call relations**: This is the provider’s credential gatekeeper. The account-state, auth, auth-manager exposure, endpoint-building, API-provider-building, and API-auth-building paths all call it first so they can decide whether Codex-managed Bedrock credentials should take priority over AWS-managed credentials.

*Call graph*: called by 6 (account_state, api_auth, api_provider, auth, auth_manager, runtime_base_url).


##### `AmazonBedrockModelProvider::info`  (lines 100–102)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Returns the provider’s stored description and configuration information. Other parts of the system use this when they need to inspect what provider this is and how it was configured.

**Data flow**: It takes the provider object as input and reads its `info` field. It returns a shared reference to that existing information without changing anything.

**Call relations**: This fulfills the common `ModelProvider` interface, so generic provider code can ask any provider for its basic information in the same way.


##### `AmazonBedrockModelProvider::capabilities`  (lines 104–110)

```
fn capabilities(&self) -> ProviderCapabilities
```

**Purpose**: Tells the rest of the app which optional hosted features Bedrock supports through this provider. In this implementation, namespace tools are allowed, while image generation and web search are not.

**Data flow**: It reads no external data. It returns a fixed `ProviderCapabilities` value with `namespace_tools` set to true and both `image_generation` and `web_search` set to false.

**Call relations**: Generic model-provider code can call this before enabling features. The `capabilities_disable_unsupported_hosted_tools` test checks that unsupported hosted tools stay disabled.


##### `AmazonBedrockModelProvider::approval_review_preferred_model`  (lines 112–114)

```
fn approval_review_preferred_model(&self) -> &'static str
```

**Purpose**: Chooses the Bedrock model the system should prefer for approval review tasks. Approval review is a special internal use case, so the provider names a known Bedrock GPT model for it.

**Data flow**: It takes no dynamic input and returns the constant Bedrock GPT 5.4 model ID. It does not modify provider state.

**Call relations**: The broader system can call this when it needs a default model for approval review work. The `approval_review_preferred_model_uses_bedrock_gpt_5_4` test verifies that this provider returns the expected Bedrock model ID.


##### `AmazonBedrockModelProvider::memory_extraction_preferred_model`  (lines 116–118)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Chooses the Bedrock model the system should prefer when extracting useful memory from text. It uses the same Bedrock GPT 5.4 model as the provider’s other internal memory-related defaults.

**Data flow**: It receives only the provider object and returns a fixed model ID constant. Nothing is read from external services, and no state changes.

**Call relations**: The memory subsystem can call this through the shared `ModelProvider` interface when it needs a suitable Bedrock model for memory extraction.


##### `AmazonBedrockModelProvider::memory_consolidation_preferred_model`  (lines 120–122)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Chooses the Bedrock model the system should prefer when consolidating or summarizing stored memories. It points to the provider’s standard Bedrock GPT 5.4 model.

**Data flow**: It returns a fixed model ID constant and does not depend on runtime configuration. The provider remains unchanged.

**Call relations**: The memory subsystem can call this through the common provider interface when it needs a default Bedrock model for memory consolidation.


##### `AmazonBedrockModelProvider::auth_manager`  (lines 124–127)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Exposes the login manager only when it actually contains Bedrock API-key credentials. This prevents unrelated credentials from being treated as usable Bedrock login state.

**Data flow**: It first asks `managed_auth` whether a Bedrock API-key login is cached. If yes, it returns a shared pointer to the original auth manager. If no, it returns nothing.

**Call relations**: This method is part of the common provider interface. It relies on `managed_auth` as a safety check, and the authentication tests use it to confirm that Bedrock credentials are exposed while OpenAI credentials are not.

*Call graph*: calls 1 internal fn (managed_auth).


##### `AmazonBedrockModelProvider::auth`  (lines 129–131)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Returns the provider’s current Bedrock authentication, if Codex is managing a Bedrock API key. It presents the result in the asynchronous shape expected by the shared provider interface.

**Data flow**: It checks `managed_auth`. If Bedrock API-key data exists, it wraps that data as `CodexAuth::BedrockApiKey`; otherwise it produces no authentication. The trait method boxes and pins the asynchronous work so callers can await it uniformly.

**Call relations**: Generic provider code calls this when it wants to know the provider’s login state. Internally it depends on `managed_auth`, and the tests check both the Bedrock-key case and the unrelated OpenAI-key case.

*Call graph*: calls 1 internal fn (managed_auth); 1 external calls (pin).


##### `AmazonBedrockModelProvider::account_state`  (lines 133–143)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Reports what kind of Bedrock account access is currently being used. It says whether credentials come from Codex-managed Bedrock auth or from AWS-managed credential lookup.

**Data flow**: It asks `managed_auth` whether a Bedrock API key is cached. If one exists, it marks the credential source as `CodexManaged`; otherwise it marks it as `AwsManaged`. It returns a `ProviderAccountState` for Amazon Bedrock and says OpenAI authentication is not required.

**Call relations**: This is called by account/status flows that need to display or reason about provider login state. Its decision is grounded in `managed_auth`, and the tests verify both managed-Bedrock and ignored-OpenAI credential paths.

*Call graph*: calls 1 internal fn (managed_auth).


##### `AmazonBedrockModelProvider::api_provider`  (lines 145–147)

```
fn api_provider(&self) -> ModelProviderFuture<'_, Result<Provider>>
```

**Purpose**: Builds the API-provider object that the rest of the app can use to talk to Bedrock’s OpenAI-compatible endpoint. It fills in the correct Bedrock Mantle base URL at runtime before converting the provider info into the generic API shape.

**Data flow**: It checks for managed Bedrock auth, clones the stored provider info, computes the runtime Bedrock base URL from credentials and AWS settings, inserts that URL into the cloned info, and converts the result into a `Provider`. The trait method returns this work as an awaitable future.

**Call relations**: Request-building code calls this when it needs a concrete provider endpoint. It calls `managed_auth` to know whether a managed Bedrock region should be used, then calls the Mantle URL resolver before handing back the generic API provider.

*Call graph*: calls 2 internal fn (managed_auth, runtime_base_url); 2 external calls (pin, clone).


##### `AmazonBedrockModelProvider::runtime_base_url`  (lines 149–151)

```
fn runtime_base_url(&self) -> ModelProviderFuture<'_, Result<Option<String>>>
```

**Purpose**: Computes the actual Bedrock Mantle endpoint URL that should be used at runtime. This matters because the URL depends on the Bedrock region, which may come from managed Bedrock auth or AWS settings.

**Data flow**: It checks `managed_auth`, passes the optional managed credentials and stored AWS settings to the Mantle URL resolver, and wraps the resulting URL in `Some`. The trait method exposes the asynchronous computation as a pinned future.

**Call relations**: This is used when callers need just the URL, and it is also part of the flow used by `api_provider`. Tests confirm that managed Bedrock auth chooses the managed auth region for the endpoint.

*Call graph*: calls 2 internal fn (managed_auth, runtime_base_url); 1 external calls (pin).


##### `AmazonBedrockModelProvider::api_auth`  (lines 153–155)

```
fn api_auth(&self) -> ModelProviderFuture<'_, Result<SharedAuthProvider>>
```

**Purpose**: Creates the authorization provider used when making API calls to Bedrock. It chooses between Codex-managed Bedrock API-key authorization and AWS-based authorization.

**Data flow**: It asks `managed_auth` for a Bedrock API key if one exists. It then passes that optional key and the AWS settings into `resolve_provider_auth`, which returns a shared authorization provider capable of producing request headers or signing behavior. The trait method returns the result asynchronously.

**Call relations**: API request code calls this before sending traffic to Bedrock. The method delegates the detailed credential resolution to `resolve_provider_auth`, and the managed-auth test checks that a managed Bedrock key becomes a Bearer authorization header.

*Call graph*: calls 1 internal fn (managed_auth); 2 external calls (pin, resolve_provider_auth).


##### `AmazonBedrockModelProvider::models_manager`  (lines 157–166)

```
fn models_manager(
        &self,
        _codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> SharedModelsManager
```

**Purpose**: Supplies the list of models available for this Bedrock provider. It uses a static model list, optionally adjusted by a model catalog supplied from configuration.

**Data flow**: It receives the Codex home path and an optional configured model catalog. The path is not used here. If a catalog is supplied, it is transformed so only the default service tier is used; otherwise the built-in static Bedrock catalog is used. It returns a shared `StaticModelsManager` built from that catalog.

**Call relations**: The wider system calls this when it needs model metadata for Bedrock. Instead of fetching models live from a service, this provider hands off a fixed catalog through `StaticModelsManager`.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint`  (lines 177–190)

```
fn api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint()
```

**Purpose**: Checks that a Bedrock provider configured for a specific region produces the expected Mantle endpoint URL. This protects the region-to-URL mapping for bearer-token style Bedrock access.

**Data flow**: The test creates Bedrock provider info, sets its base URL to the Mantle URL for `eu-central-1`, converts that info into a generic API provider, and compares the resulting base URL to the expected string.

**Call relations**: This test exercises the lower-level provider-info conversion and Mantle URL helper rather than constructing the full runtime provider. It supports the same endpoint-building behavior used by `AmazonBedrockModelProvider::api_provider` and `AmazonBedrockModelProvider::runtime_base_url`.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, base_url); 1 external calls (assert_eq!).


##### `tests::managed_auth_takes_precedence_over_aws_auth`  (lines 193–243)

```
async fn managed_auth_takes_precedence_over_aws_auth()
```

**Purpose**: Verifies that a Codex-managed Bedrock API key wins over AWS profile and region settings. This is important because a user who explicitly logged in with a Bedrock key should not silently use some other AWS credential source.

**Data flow**: The test builds managed Bedrock auth with an API key and `us-east-1`, then creates a provider that also has AWS settings for a different profile and region. It checks that the provider exposes the managed auth manager, returns the managed Bedrock auth, reports `CodexManaged`, builds a `us-east-1` endpoint, and produces a Bearer authorization header with the managed key.

**Call relations**: This test calls `AmazonBedrockModelProvider::new` to set up the scenario, then drives the same public methods used in real provider flows: `auth_manager`, `auth`, `account_state`, `runtime_base_url`, and `api_auth`.

*Call graph*: calls 3 internal fn (from_auth_for_testing, create_amazon_bedrock_provider, new); 3 external calls (assert!, assert_eq!, BedrockApiKey).


##### `tests::openai_auth_is_not_exposed_to_bedrock`  (lines 246–265)

```
async fn openai_auth_is_not_exposed_to_bedrock()
```

**Purpose**: Checks that an OpenAI API key stored in the auth manager is ignored by the Bedrock provider. This prevents credentials for one service from leaking into requests for another service.

**Data flow**: The test creates an auth manager containing an OpenAI API key, builds a Bedrock provider with it, and then checks that the provider exposes no auth manager, returns no Bedrock auth, and reports that Bedrock credentials should come from AWS-managed sources instead.

**Call relations**: This test focuses on the safety filter inside `managed_auth`, as observed through public methods like `auth_manager`, `auth`, and `account_state`.

*Call graph*: calls 4 internal fn (from_auth_for_testing, from_api_key, create_amazon_bedrock_provider, new); 2 external calls (assert!, assert_eq!).


##### `tests::capabilities_disable_unsupported_hosted_tools`  (lines 268–282)

```
fn capabilities_disable_unsupported_hosted_tools()
```

**Purpose**: Confirms that the Bedrock provider advertises only the hosted features it supports. In particular, it keeps image generation and web search turned off.

**Data flow**: The test creates a default Bedrock provider and calls `capabilities`. It compares the returned capability flags to the expected values: namespace tools enabled, image generation disabled, and web search disabled.

**Call relations**: This test protects the behavior of `AmazonBedrockModelProvider::capabilities`, which feature-selection code relies on before enabling provider-specific tools.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, new); 1 external calls (assert_eq!).


##### `tests::approval_review_preferred_model_uses_bedrock_gpt_5_4`  (lines 285–295)

```
fn approval_review_preferred_model_uses_bedrock_gpt_5_4()
```

**Purpose**: Checks that the provider’s preferred model for approval review is the expected Bedrock GPT 5.4 model. This keeps internal review tasks pointed at the intended model.

**Data flow**: The test creates a default Bedrock provider, calls `approval_review_preferred_model`, and compares the returned model ID to the Bedrock GPT 5.4 constant.

**Call relations**: This test directly verifies `AmazonBedrockModelProvider::approval_review_preferred_model`, which higher-level approval-review flows can call through the common provider interface.

*Call graph*: calls 2 internal fn (create_amazon_bedrock_provider, new); 1 external calls (assert_eq!).


### Client auth abstractions
Provides shared auth interfaces and attestation boundaries that downstream HTTP-style clients use when attaching credentials to requests.

### `core/src/attestation.rs`

`data_model` · `request handling`

Some requests may need an extra HTTP header called `x-oai-attestation`. An HTTP header is a small named piece of metadata sent with a web request. In this case, the header value is not built directly by the core system. Instead, the surrounding host integration decides whether attestation is needed and, if so, produces the value just in time.

This file is the boundary between those two worlds. It names the header, defines the request information the host is allowed to see, and describes the trait, `AttestationProvider`, that a host must implement if it wants to supply attestations. The context currently contains the `thread_id`, so the provider can make a decision based on which conversation or request thread is being sent upstream.

The result is asynchronous: creating the header may require waiting on another service, secure hardware, or some host-specific check. That is why the provider returns a future, which is a value representing work that will finish later. The future produces either a header value or `None`, meaning no attestation should be sent.

Without this file, the core request code would have to know host-specific attestation rules. This keeps that policy outside the core, like a security desk that decides whether to stamp a package before it leaves the building.


### `codex-api/src/auth.rs`

`io_transport` · `outbound API request preparation and telemetry`

When the API client sends a request, it often needs proof that the caller is allowed to use the service, such as an Authorization header. This file is the small “authentication adapter” layer that makes that possible without every caller needing to know the details.

The main piece is AuthProvider, a trait, which is Rust’s way of saying “anything that promises to provide these methods.” Simple providers can just add headers, like putting a badge on an envelope before mailing it. More advanced providers can inspect and sign the whole request, including the final URL, headers, and body, before it is sent.

The file also defines AuthError, which separates two kinds of authentication failure: a build problem, meaning the request could not be prepared correctly, and a transient problem, meaning something temporary went wrong. Those errors can be turned into the transport layer’s error type so the rest of the request-sending code can treat authentication failures like other send-time failures.

Finally, auth_header_telemetry checks whether an authentication header would be attached, without exposing the secret value. That is useful for logging or metrics: the system can know “auth was present” without recording sensitive credentials.

#### Function details

##### `TransportError::from`  (lines 18–23)

```
fn from(error: AuthError) -> Self
```

**Purpose**: This converts an authentication error into the broader transport error type used when sending requests. It matters because callers higher up can deal with one common kind of send failure instead of learning every auth-specific error.

**Data flow**: It receives an AuthError. If the problem was building authentication data, it turns that into a transport build error. If the problem was temporary, it turns that into a network-style transport error. The output is a TransportError that can travel through the normal request-sending error path.

**Call relations**: This function is used whenever an AuthError needs to be treated as a TransportError. It hands the failure off to the transport layer’s existing error categories, using Build for preparation failures and Network for temporary authentication failures.

*Call graph*: 2 external calls (Build, Network).


##### `AuthProvider::to_auth_headers`  (lines 38–42)

```
fn to_auth_headers(&self) -> HeaderMap
```

**Purpose**: This creates and returns a fresh set of authentication headers from an auth provider. It is useful when code needs just the headers, not a full request.

**Data flow**: It starts with no headers. It asks the auth provider to add whatever authentication headers it can provide cheaply. It returns the filled HeaderMap, which may contain headers such as Authorization or may be empty.

**Call relations**: This is a default helper built on top of AuthProvider::add_auth_headers. Code that needs header-only authentication can call this instead of preparing a whole request, while each provider still controls exactly which headers get added.

*Call graph*: 1 external calls (new).


##### `AuthProvider::apply_auth`  (lines 55–61)

```
fn apply_auth(&self, request: Request) -> AuthProviderFuture<'_>
```

**Purpose**: This applies authentication to a complete outgoing request and returns the request that should actually be sent. The default behavior is simple: add authentication headers and leave the rest of the request unchanged.

**Data flow**: It receives an owned Request, meaning it can safely modify it. The default implementation adds auth headers to the request’s header collection, then returns the updated request inside an asynchronous result. If a provider overrides this method, it may inspect or replace the whole request before returning it.

**Call relations**: The transport path calls this before sending a request. Header-only providers rely on this default implementation, while request-signing providers can override it when they need the final URL, headers, and body bytes before deciding how to authenticate.

*Call graph*: 1 external calls (pin).


##### `auth_header_telemetry`  (lines 76–86)

```
fn auth_header_telemetry(auth: &dyn AuthProvider) -> AuthHeaderTelemetry
```

**Purpose**: This checks whether an auth provider would attach an Authorization header, without recording the header’s secret value. It supports safe telemetry: the system can report that authentication was attached without leaking credentials.

**Data flow**: It creates an empty header map, asks the auth provider to add its usual headers, and then checks whether the standard Authorization header is present. It returns AuthHeaderTelemetry with attached set to true or false, and with the header name set to "authorization" only when that header exists.

**Call relations**: Telemetry code can call this when it wants to describe authentication behavior safely. It uses the provider’s add_auth_headers method, just like normal header-only authentication, but it only keeps the fact that the header exists, not the sensitive contents.

*Call graph*: 2 external calls (new, add_auth_headers).


### Remote and MCP auth flows
Adapts authentication state for remote-control transport and MCP servers, including OAuth capability detection and status synthesis.

### `app-server-transport/src/transport/remote_control/auth.rs`

`domain_logic` · `remote-control setup, enrollment, and reconnect/recovery`

Remote control needs a real ChatGPT account, not just an API key. This file is the gatekeeper for that rule. Before pairing, enrolling, refreshing enrollment, or sending remote-control management requests, other parts of the system ask it to load usable authentication. It checks the current login state, gives the login manager one chance to reload stale information, rejects API-key-only authentication, and returns the two things remote control needs: an auth provider that can supply credentials, and the ChatGPT account id.

The file also helps when the server rejects a request as unauthorized. Instead of immediately giving up, it can run the next available recovery step from `UnauthorizedRecovery`, which is a helper that may refresh or repair the saved login. If recovery changes the auth state, the file carefully marks that expected change as already seen in a `watch` channel. A watch channel is like a notice board that wakes listeners when a value changes. This avoids making the outer reconnect loop wake up again for the very change it just caused, while still preserving any separate auth changes that happened at the same time.

Without this file, remote control could start with the wrong kind of login, miss the account id it needs for enrollment, or reconnect too much after recovery.

#### Function details

##### `load_remote_control_auth`  (lines 16–59)

```
async fn load_remote_control_auth(
    auth_manager: &Arc<AuthManager>,
) -> io::Result<RemoteControlConnectionAuth>
```

**Purpose**: This function loads the authentication needed to open or maintain a remote-control connection. It enforces the important rule that remote control requires ChatGPT account authentication and cannot use API-key-only authentication.

**Data flow**: It receives a shared `AuthManager`, which is the component that knows the current saved login. It asks for the current auth state; if none is available, or if the account id may be stale, it reloads once and checks again. It then rejects unsupported auth, builds an auth provider from the accepted login, extracts the account id, and returns both wrapped in `RemoteControlConnectionAuth`. If the login is missing or unsuitable, it returns an I/O-style error explaining what is wrong.

**Call relations**: Remote-control actions such as pairing, enrollment, preference persistence, and client-management requests call this before they proceed. It hands them a ready-to-use credential provider and account id, so those higher-level flows do not each need to repeat the same login checks.

*Call graph*: called by 11 (pairing_status, persist_preference, start_pairing, send_client_management_request, enable, resolve_persisted_preference, enroll_pairing_server, refresh_pairing_enrollment, resolve_unknown_desired_state, prepare_remote_control_enrollment (+1 more)); 2 external calls (new, auth_provider_from_auth).


##### `recover_remote_control_auth`  (lines 61–91)

```
async fn recover_remote_control_auth(
    auth_recovery: &mut UnauthorizedRecovery,
    auth_change_rx: &mut watch::Receiver<u64>,
) -> bool
```

**Purpose**: This function tries one step of authentication recovery after remote control hits an unauthorized error. It lets the system refresh or repair login state instead of immediately failing the whole remote-control operation.

**Data flow**: It receives an `UnauthorizedRecovery` object, which knows possible recovery steps, and a watch receiver that tracks auth-state revisions. It first checks whether another recovery step exists. If so, it records the current auth revision, runs the next recovery step, logs whether it succeeded, and returns `true` on success or `false` on failure. When the recovery step says it changed auth state, it also updates the watch receiver so the expected recovery-triggered change is not treated as a separate outside change.

**Call relations**: Remote-control request and enrollment flows call this when authorization fails. When recovery reports that auth changed, this function delegates to `mark_recovery_auth_change_seen` to keep the surrounding reconnect logic from reacting twice to the same recovery event.

*Call graph*: calls 5 internal fn (mark_recovery_auth_change_seen, has_next, mode_name, next, step_name); called by 5 (send_client_management_request, enroll_pairing_server, refresh_pairing_enrollment, enroll_and_persist_remote_control_server, prepare_remote_control_enrollment); 3 external calls (borrow, info!, warn!).


##### `mark_recovery_auth_change_seen`  (lines 93–105)

```
fn mark_recovery_auth_change_seen(
    auth_change_rx: &mut watch::Receiver<u64>,
    auth_change_revision_before_recovery: u64,
)
```

**Purpose**: This function marks exactly one expected auth-change notification as already seen after recovery changes the login state. Its job is to prevent a needless reconnect wake-up without hiding later, separate auth changes.

**Data flow**: It receives the watch receiver and the auth revision number from before recovery began. It compares that old revision with the receiver’s current revision. If the current value is exactly one step newer, it treats that single change as the recovery’s own update and marks it seen. If the value has moved further, it leaves the notification pending because another auth change may have arrived while recovery was running.

**Call relations**: It is called by `recover_remote_control_auth` after a successful recovery step that changed auth state. Tests also exercise it directly to confirm the careful behavior: mark only the recovery revision, but do not swallow a racing external auth change.

*Call graph*: called by 3 (recover_remote_control_auth, mark_recovery_auth_change_seen_marks_only_recovery_revision_seen, mark_recovery_auth_change_seen_preserves_racing_auth_change); 2 external calls (borrow, borrow_and_update).


### `rmcp-client/src/auth_status.rs`

`domain_logic` · `MCP server connection setup and authentication checks`

When the client is about to connect to an MCP server over HTTP, it needs to answer a practical question: “Do we already have credentials, do we need to ask the user to log in, or is login not available?” This file is that decision point.

It checks the simplest cases first. If the server configuration names a bearer token environment variable, or if the configured HTTP headers already include an Authorization header, the server is treated as using a bearer token. A bearer token is like a pre-issued pass that gets shown with each request.

If no bearer token is present, the file asks the OAuth token store whether there is already a usable saved OAuth token. OAuth is a standard way for a user to approve access without directly sharing a password. If a saved token is usable, the server is marked as OAuth-authenticated. If the token store says user approval is required, the server is marked as not logged in.

If no saved token exists, the file tries OAuth discovery. It sends short timed HTTP requests to standard “well-known” URLs and looks for metadata containing both an authorization endpoint and a token endpoint. Those are the two basic addresses needed to start and finish an OAuth login. It also cleans up advertised scopes, which are permission names, by trimming blanks and removing duplicates. If discovery fails or finds nothing, the server is treated as unsupported for OAuth login.

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

**Purpose**: Decides the current authentication state for one streamable HTTP MCP server. It answers whether the client should use a bearer token, use an existing OAuth login, ask the user to log in, or treat OAuth as unavailable.

**Data flow**: It receives the server name, server URL, possible bearer-token configuration, configured HTTP headers, and settings for where OAuth tokens are stored. It first checks for bearer-token evidence, then checks the saved OAuth token store, then tries live OAuth discovery against the server. It returns an McpAuthStatus value and does not change the server; it only reads configuration, stored token status, and possible discovery responses.

**Call relations**: This is the main public decision function in the file. The tests call it to confirm bearer-token cases. During its work it asks build_default_headers to combine header configuration, oauth_token_status to inspect saved login state, and discover_streamable_http_oauth_with_headers to see whether the server advertises OAuth support. If discovery errors, it logs a debug message and chooses the safe fallback of Unsupported.

*Call graph*: calls 3 internal fn (discover_streamable_http_oauth_with_headers, oauth_token_status, build_default_headers); called by 2 (determine_auth_status_uses_bearer_token_when_authorization_header_present, determine_auth_status_uses_bearer_token_when_env_authorization_header_present); 1 external calls (debug!).


##### `supports_oauth_login`  (lines 71–77)

```
async fn supports_oauth_login(url: &str) -> Result<bool>
```

**Purpose**: Checks whether a server appears to support OAuth login at all. It is a simpler yes-or-no wrapper for callers that do not need the full authentication status.

**Data flow**: It receives a server URL. It runs OAuth discovery without extra headers, then turns “some discovery metadata was found” into true and “nothing was found” into false. Errors from discovery are passed back to the caller.

**Call relations**: This function sits above discover_streamable_http_oauth as a convenience layer. The test supports_oauth_login_does_not_require_scopes_supported calls it to verify that a server can count as OAuth-capable even if it does not list permission scopes.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); called by 1 (supports_oauth_login_does_not_require_scopes_supported).


##### `discover_streamable_http_oauth`  (lines 79–86)

```
async fn discover_streamable_http_oauth(
    url: &str,
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
) -> Result<Option<StreamableHttpOAuth
```

**Purpose**: Looks for OAuth discovery metadata for a server, while allowing the caller to provide normal or environment-based HTTP headers. Use this when you want the discovered details, not just a yes-or-no answer.

**Data flow**: It receives a URL and optional header maps. It builds a final set of default headers, then passes the URL and those headers to the lower-level discovery function. It returns either discovery details, no discovery result, or an error if header building or discovery fails.

**Call relations**: This is the public discovery entry point. supports_oauth_login calls it for a boolean check, and discovery-focused tests call it to confirm scope cleanup. It delegates header preparation to build_default_headers and actual network probing to discover_streamable_http_oauth_with_headers.

*Call graph*: calls 2 internal fn (discover_streamable_http_oauth_with_headers, build_default_headers); called by 3 (supports_oauth_login, discover_streamable_http_oauth_ignores_empty_scopes, discover_streamable_http_oauth_returns_normalized_scopes).


##### `discover_streamable_http_oauth_with_headers`  (lines 88–141)

```
async fn discover_streamable_http_oauth_with_headers(
    url: &str,
    default_headers: &HeaderMap,
) -> Result<Option<StreamableHttpOAuthDiscovery>>
```

**Purpose**: Performs the actual HTTP probing for OAuth discovery metadata. It tries the standard OAuth discovery paths and accepts a server as OAuth-capable only when the metadata contains both authorization and token endpoints.

**Data flow**: It receives a URL and already-built default headers. It parses the URL, creates a short-timeout HTTP client with those headers, computes possible discovery paths, and sends GET requests with the MCP protocol-version discovery header. For each successful OK response, it parses JSON metadata and checks for the two required OAuth endpoint fields. If found, it returns discovery details with cleaned scopes; otherwise it returns None after trying all paths. It records and logs request or JSON parse failures but keeps trying other paths.

**Call relations**: This is the engine used by both the full authentication decision and the public discovery function. It relies on discovery_paths to know where to look, apply_default_headers to attach configured headers to the HTTP client, and normalize_scopes to tidy the permission list before returning it.

*Call graph*: calls 3 internal fn (discovery_paths, normalize_scopes, apply_default_headers); called by 2 (determine_streamable_http_auth_status, discover_streamable_http_oauth); 3 external calls (parse, builder, debug!).


##### `normalize_scopes`  (lines 153–173)

```
fn normalize_scopes(scopes_supported: Option<Vec<String>>) -> Option<Vec<String>>
```

**Purpose**: Cleans up the OAuth permission names advertised by a server. This keeps later code from seeing duplicate scopes or scopes that are only blank spaces.

**Data flow**: It receives an optional list of scope strings. If there is no list, it returns None. If there is a list, it trims whitespace from each item, skips empty items, keeps only the first copy of each unique scope, and returns the cleaned list. If nothing meaningful remains, it returns None.

**Call relations**: discover_streamable_http_oauth_with_headers calls this after it has accepted valid OAuth metadata. The discovery tests exercise this behavior by serving duplicated, padded, and empty scope values.

*Call graph*: called by 1 (discover_streamable_http_oauth_with_headers); 1 external calls (new).


##### `discovery_paths`  (lines 179–199)

```
fn discovery_paths(base_path: &str) -> Vec<String>
```

**Purpose**: Builds the list of well-known URL paths where OAuth discovery metadata might live for a given server path. This follows the standard OAuth discovery rule while also trying practical alternatives for MCP servers mounted under a path.

**Data flow**: It receives the path part of the server URL. It removes leading and trailing slashes, then creates one or more candidate discovery paths. For a root server it returns only the canonical well-known path. For a server under a path, it returns unique candidates that place the well-known OAuth path before, inside, and at the root.

**Call relations**: discover_streamable_http_oauth_with_headers calls this before sending network requests. It acts like a small route planner: given the server’s base address, it tells the probing code which doors to knock on.

*Call graph*: called by 1 (discover_streamable_http_oauth_with_headers); 3 external calls (new, format!, vec!).


##### `tests::TestServer::drop`  (lines 219–221)

```
fn drop(&mut self)
```

**Purpose**: Stops a temporary test web server when the test helper object goes away. This prevents background test servers from continuing to run after a test is finished.

**Data flow**: It reads the stored background task handle inside the TestServer helper. When the helper is dropped, it aborts that task. It returns nothing, but it changes the running test environment by stopping the spawned server task.

**Call relations**: This is used automatically by Rust when a TestServer value leaves scope. The test server is created by tests::spawn_oauth_discovery_server, and this drop behavior is the cleanup step for those tests.

*Call graph*: 1 external calls (abort).


##### `tests::spawn_oauth_discovery_server`  (lines 224–247)

```
async fn spawn_oauth_discovery_server(metadata: serde_json::Value) -> TestServer
```

**Purpose**: Starts a tiny local HTTP server for tests that need fake OAuth discovery metadata. It lets tests check discovery behavior without depending on an external network service.

**Data flow**: It receives a JSON value to serve as OAuth metadata. It binds a local TCP port, creates a route at the expected well-known discovery path, spawns the server in the background, and returns a TestServer containing the URL and task handle. The caller can then point discovery code at that URL.

**Call relations**: The OAuth discovery tests call this to set up controlled server responses. The returned TestServer later triggers tests::TestServer::drop for cleanup.

*Call graph*: 7 external calls (new, clone, get, serve, format!, bind, spawn).


##### `tests::EnvVarGuard::set`  (lines 255–264)

```
fn set(key: &str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its previous value. This keeps tests from permanently changing the process environment.

**Data flow**: It receives an environment variable name and value. It reads the original value, sets the new value, and returns an EnvVarGuard containing both the key and the original value. The changed environment remains in place until the guard is dropped.

**Call relations**: The environment-header bearer-token test calls this before running determine_streamable_http_auth_status. Its companion cleanup happens in tests::EnvVarGuard::drop.

*Call graph*: 2 external calls (set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 268–278)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable after a test changed it. This protects other tests from being affected by leftover environment settings.

**Data flow**: It reads the key and saved original value stored in the guard. If the variable existed before, it sets it back to that value. If it did not exist before, it removes the variable. It returns nothing, but it restores the process environment.

**Call relations**: Rust calls this automatically when the EnvVarGuard leaves scope. It completes the temporary setup started by tests::EnvVarGuard::set.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::determine_auth_status_uses_bearer_token_when_authorization_header_present`  (lines 282–299)

```
async fn determine_auth_status_uses_bearer_token_when_authorization_header_present()
```

**Purpose**: Verifies that an explicit Authorization HTTP header makes the server count as bearer-token authenticated. This protects the shortcut that avoids unnecessary OAuth checks when a token is already configured.

**Data flow**: It builds a header map containing an Authorization value and calls determine_streamable_http_auth_status with an intentionally invalid URL. Because the header should be enough, the function should not need to parse or contact that URL. The test expects the returned status to be BearerToken.

**Call relations**: This test directly exercises determine_streamable_http_auth_status. It confirms that build_default_headers and the early bearer-token check happen before any OAuth discovery work.

*Call graph*: calls 2 internal fn (default, determine_streamable_http_auth_status); 2 external calls (from, assert_eq!).


##### `tests::determine_auth_status_uses_bearer_token_when_env_authorization_header_present`  (lines 303–321)

```
async fn determine_auth_status_uses_bearer_token_when_env_authorization_header_present()
```

**Purpose**: Verifies that an Authorization header whose value comes from an environment variable also counts as bearer-token authentication. This covers the common pattern of keeping secrets out of static config files.

**Data flow**: It temporarily sets an environment variable to a bearer-token value, configures the Authorization header to read from that variable, and calls determine_streamable_http_auth_status. The expected result is BearerToken. After the test, the environment variable is restored by the guard.

**Call relations**: This test uses tests::EnvVarGuard::set for safe environment setup and then calls determine_streamable_http_auth_status. It checks the path where build_default_headers resolves environment-based header values before the main function checks for Authorization.

*Call graph*: calls 3 internal fn (set, default, determine_streamable_http_auth_status); 2 external calls (from, assert_eq!).


##### `tests::discover_streamable_http_oauth_returns_normalized_scopes`  (lines 324–345)

```
async fn discover_streamable_http_oauth_returns_normalized_scopes()
```

**Purpose**: Verifies that OAuth discovery returns a cleaned scope list. It makes sure duplicate scopes, padded spaces, and blank entries do not leak into the result.

**Data flow**: It starts a local test server that returns valid OAuth metadata with messy scopes. It calls discover_streamable_http_oauth against that server URL. The expected discovery result contains only profile and email, with whitespace removed and the duplicate profile removed.

**Call relations**: This test uses tests::spawn_oauth_discovery_server to provide fake metadata, then drives discover_streamable_http_oauth. Through that path it also verifies the behavior of discover_streamable_http_oauth_with_headers and normalize_scopes.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); 3 external calls (assert_eq!, spawn_oauth_discovery_server, json!).


##### `tests::discover_streamable_http_oauth_ignores_empty_scopes`  (lines 348–366)

```
async fn discover_streamable_http_oauth_ignores_empty_scopes()
```

**Purpose**: Verifies that a server listing only blank scopes is treated as having no useful scope list. This keeps meaningless permission names out of the discovery result.

**Data flow**: It starts a local test server with valid OAuth endpoints but scopes that are empty strings or only spaces. It calls discover_streamable_http_oauth and expects discovery to succeed, while scopes_supported is None.

**Call relations**: This test again uses the local discovery server helper and the public discovery function. It specifically protects the branch in normalize_scopes that turns an empty cleaned list into None.

*Call graph*: calls 1 internal fn (discover_streamable_http_oauth); 3 external calls (assert_eq!, spawn_oauth_discovery_server, json!).


##### `tests::supports_oauth_login_does_not_require_scopes_supported`  (lines 369–381)

```
async fn supports_oauth_login_does_not_require_scopes_supported()
```

**Purpose**: Verifies that a server can support OAuth login even if it does not advertise scopes. The required evidence is the authorization endpoint and token endpoint, not a permission list.

**Data flow**: It starts a local test server returning OAuth metadata with the two required endpoints and no scopes_supported field. It calls supports_oauth_login and expects true.

**Call relations**: This test calls supports_oauth_login, which in turn calls discover_streamable_http_oauth. It confirms the higher-level yes-or-no check is based on OAuth endpoint discovery rather than optional scope metadata.

*Call graph*: calls 1 internal fn (supports_oauth_login); 3 external calls (assert!, spawn_oauth_discovery_server, json!).


### `codex-mcp/src/mcp/auth.rs`

`domain_logic` · `auth setup and server status checking`

MCP servers can be reached in different ways. Some run locally over standard input/output, while others are remote HTTP services that may need a bearer token or an OAuth login. This file is the project’s “auth checker” for those servers. Without it, the rest of the system would not know whether a server is already usable, needs OAuth, has a token, or cannot be authenticated through this flow.

The file first defines small data shapes for describing OAuth login support, where scopes came from, and the final authentication status for a server. A scope is a named permission requested during OAuth, like asking for “read files” rather than “full access.”

For a single HTTP transport, `oauth_login_support` asks the remote service whether it advertises OAuth support. It refuses OAuth when the config already says to use a bearer token from an environment variable, because that is a different auth path. `discover_supported_scopes` is a lighter helper that only returns the scopes discovered from the server.

When scopes can come from several places, `resolve_oauth_scopes` applies a clear priority: caller-provided scopes first, then configured scopes, then discovered non-empty scopes, then no scopes. `should_retry_without_scopes` adds one practical fallback: if server-discovered scopes are rejected by the OAuth provider, try again without them.

Finally, `compute_auth_statuses` checks many servers at once and records each server’s config plus its current auth status. It delegates each individual decision to `compute_auth_status`, which separates unsupported local servers, disabled servers, runtime Codex auth, bearer-token HTTP, and OAuth-capable HTTP.

#### Function details

##### `oauth_login_support`  (lines 55–81)

```
async fn oauth_login_support(transport: &McpServerTransportConfig) -> McpOAuthLoginSupport
```

**Purpose**: Checks whether one MCP server transport can use OAuth login. It only supports streamable HTTP transports without a preconfigured bearer-token environment variable, then asks the server whether it advertises OAuth details.

**Data flow**: It receives a transport configuration. If the transport is not streamable HTTP, or if it already uses a bearer token from an environment variable, it returns “unsupported.” Otherwise it sends the URL and any configured HTTP headers to OAuth discovery; a successful discovery becomes a login config with the URL, headers, and discovered scopes, no discovery becomes “unsupported,” and a discovery failure becomes “unknown” with the error attached.

**Call relations**: This is the deeper check used by `discover_supported_scopes` when code only wants to know which scopes the server says it supports. It hands the network discovery work to `discover_streamable_http_oauth`, then wraps the result in this file’s simpler support categories.

*Call graph*: called by 1 (discover_supported_scopes); 3 external calls (Supported, Unknown, discover_streamable_http_oauth).


##### `discover_supported_scopes`  (lines 83–90)

```
async fn discover_supported_scopes(
    transport: &McpServerTransportConfig,
) -> Option<Vec<String>>
```

**Purpose**: Returns the OAuth scopes advertised by a server, if OAuth discovery succeeds. It is a convenience wrapper for callers that do not need the full login-support result.

**Data flow**: It receives a transport configuration and passes it to `oauth_login_support`. If OAuth is supported, it extracts the discovered scopes from the returned login config. If OAuth is unsupported or discovery failed, it returns nothing.

**Call relations**: This function sits one level above `oauth_login_support`. It calls that fuller checker, then narrows the answer down to just the optional list of scopes for later OAuth login decisions.

*Call graph*: calls 1 internal fn (oauth_login_support).


##### `resolve_oauth_scopes`  (lines 92–124)

```
fn resolve_oauth_scopes(
    explicit_scopes: Option<Vec<String>>,
    configured_scopes: Option<Vec<String>>,
    discovered_scopes: Option<Vec<String>>,
) -> ResolvedMcpOAuthScopes
```

**Purpose**: Chooses which OAuth scopes to request when several possible sources exist. This keeps scope selection predictable and makes it clear whether the scopes were chosen by the caller, the user’s config, server discovery, or not at all.

**Data flow**: It receives three optional scope lists: explicit scopes, configured scopes, and discovered scopes. It returns the first valid choice in priority order: explicit scopes if present, otherwise configured scopes if present, otherwise discovered scopes only if that list is not empty, otherwise an empty list. The result also records which source won.

**Call relations**: The test functions in this file call it to lock down its priority rules. Other OAuth login code can rely on this helper so every caller follows the same “who gets to decide permissions” rule.

*Call graph*: called by 5 (resolve_oauth_scopes_falls_back_to_empty, resolve_oauth_scopes_prefers_configured_over_discovered, resolve_oauth_scopes_prefers_explicit, resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes, resolve_oauth_scopes_uses_discovered_when_needed); 1 external calls (new).


##### `should_retry_without_scopes`  (lines 126–129)

```
fn should_retry_without_scopes(scopes: &ResolvedMcpOAuthScopes, error: &anyhow::Error) -> bool
```

**Purpose**: Decides whether an OAuth login should be tried again with no scopes. This is a safety valve for the case where the server advertised scopes, but the OAuth provider rejects them.

**Data flow**: It receives the previously resolved scopes and an error from a failed OAuth attempt. It returns true only when the scopes came from discovery and the error is specifically an OAuth provider error. It returns false for user-configured scopes, explicit scopes, empty scopes, or unrelated errors.

**Call relations**: This function is tested by `tests::should_retry_without_scopes_only_for_discovered_provider_errors`. It is meant to be used after a failed OAuth attempt, so the caller can distinguish “server guessed badly” from “the user asked for these scopes and they failed.”


##### `compute_auth_statuses`  (lines 131–186)

```
async fn compute_auth_statuses(
    servers: I,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    auth: Option<&CodexAuth>,
) -> HashMap<String, McpAuthS
```

**Purpose**: Computes the authentication status for many MCP servers at once. It produces the status snapshot used by higher-level features that need to show or act on server auth state.

**Data flow**: It receives an iterable collection of server names and effective server definitions, plus OAuth credential storage settings, keyring settings, and optional Codex login information. For each server, it keeps a copy of the configured server config if one exists, works out whether special runtime Codex auth applies, then asks `compute_auth_status` for the server’s status. If status detection fails, it logs a warning and marks that server unsupported. It returns a map from server name to an entry containing the config and status.

**Call relations**: This is called by higher-level flows such as `collect_mcp_server_status_snapshot_with_detail` and `read_mcp_resource` when they need current auth information. Inside, it fans out checks for all servers and waits for them together with `join_all`, like sending several inspectors out at once and collecting their reports.

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

**Purpose**: Determines the authentication status for one configured MCP server. It is the single-server decision point used by the bulk status checker.

**Data flow**: It receives the server name, its config, credential storage settings, keyring backend kind, and a flag saying whether runtime Codex auth is already available. If the server is disabled, it returns unsupported. If runtime auth applies, it returns bearer-token status. For local stdio servers it returns unsupported because this OAuth/bearer-token check is for HTTP auth. For streamable HTTP servers, it passes the URL, bearer-token setting, headers, and credential settings to the lower-level HTTP auth status detector and returns that result.

**Call relations**: This function is called from `compute_auth_statuses` for each server that has a config. It delegates the HTTP-specific probing to `determine_streamable_http_auth_status`, while keeping the project-specific rules about disabled servers, local transports, and Codex runtime auth in one place.

*Call graph*: 1 external calls (determine_streamable_http_auth_status).


##### `tests::resolve_oauth_scopes_prefers_explicit`  (lines 237–251)

```
fn resolve_oauth_scopes_prefers_explicit()
```

**Purpose**: Checks that explicitly supplied scopes win over every other source. This protects the rule that the immediate caller’s choice has the highest priority.

**Data flow**: It builds three possible scope lists: explicit, configured, and discovered. It passes them to `resolve_oauth_scopes` and verifies that the result contains only the explicit scope and marks the source as explicit.

**Call relations**: This test calls `resolve_oauth_scopes` directly. It confirms the first branch of that function’s priority order.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_prefers_configured_over_discovered`  (lines 254–268)

```
fn resolve_oauth_scopes_prefers_configured_over_discovered()
```

**Purpose**: Checks that configured scopes win over scopes discovered from the server. This matters because user or project configuration should override what the server advertises.

**Data flow**: It passes no explicit scopes, but provides both configured and discovered scopes. It verifies that `resolve_oauth_scopes` returns the configured list and records the source as configured.

**Call relations**: This test calls `resolve_oauth_scopes` to confirm the second priority level: when there is no explicit request, the saved configuration is trusted before discovery.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_uses_discovered_when_needed`  (lines 271–285)

```
fn resolve_oauth_scopes_uses_discovered_when_needed()
```

**Purpose**: Checks that discovered scopes are used when no explicit or configured scopes exist. This lets the system benefit from the server’s advertised defaults when nothing stronger is provided.

**Data flow**: It passes no explicit scopes and no configured scopes, but provides discovered scopes. It verifies that `resolve_oauth_scopes` returns the discovered list and marks the source as discovered.

**Call relations**: This test calls `resolve_oauth_scopes` to confirm the fallback path where server discovery is the best available source of permission information.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 2 external calls (assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes`  (lines 288–302)

```
fn resolve_oauth_scopes_preserves_explicitly_empty_configured_scopes()
```

**Purpose**: Checks that an intentionally empty configured scope list is respected. This is important because “the user configured no scopes” is different from “there was no configuration.”

**Data flow**: It passes no explicit scopes, an empty configured list, and a discovered list that would otherwise be usable. It verifies that `resolve_oauth_scopes` returns an empty list with the source marked as configured, proving the discovered scopes were ignored.

**Call relations**: This test calls `resolve_oauth_scopes` to protect a subtle behavior: an empty configured list still counts as a real configuration choice.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 3 external calls (new, assert_eq!, vec!).


##### `tests::resolve_oauth_scopes_falls_back_to_empty`  (lines 305–318)

```
fn resolve_oauth_scopes_falls_back_to_empty()
```

**Purpose**: Checks the final fallback when no scope source is available. The expected behavior is to request no scopes and clearly record that the source is empty.

**Data flow**: It passes no explicit, configured, or discovered scopes. It verifies that `resolve_oauth_scopes` returns an empty list and marks the source as empty.

**Call relations**: This test calls `resolve_oauth_scopes` to confirm the last branch of the selection logic, where there is nothing to choose from.

*Call graph*: calls 1 internal fn (resolve_oauth_scopes); 1 external calls (assert_eq!).


##### `tests::should_retry_without_scopes_only_for_discovered_provider_errors`  (lines 321–342)

```
fn should_retry_without_scopes_only_for_discovered_provider_errors()
```

**Purpose**: Checks that retrying without scopes is allowed only in the narrow safe case: discovered scopes failed because the OAuth provider rejected them. It prevents the fallback from hiding other kinds of problems.

**Data flow**: It creates a resolved scope list whose source is discovered and an OAuth provider error, then verifies that `should_retry_without_scopes` returns true. It then tries configured scopes with the same provider error and discovered scopes with an unrelated timeout-style error, and verifies both return false.

**Call relations**: This test exercises `should_retry_without_scopes` around its intended boundary. It shows that the retry rule is only for scopes learned from discovery, not for scopes the user configured and not for unrelated login failures.

*Call graph*: 3 external calls (anyhow!, assert!, vec!).


### Backend-authenticated account action
Uses the adapted backend authentication machinery to execute an authenticated account rate-limit reset operation.

### `app-server/src/request_processors/account_processor/rate_limit_resets.rs`

`domain_logic` · `request handling`

This file exists for a very specific user-facing action: a signed-in account can use a saved credit to reset a rate limit. Think of the credit like a one-use coupon. The server must make sure the coupon request has a label that prevents accidental double-spending, confirm the user is authenticated in the right way, ask the backend to redeem the coupon, and report what happened.

The main method first rejects an empty idempotency key. An idempotency key is a unique request label that lets systems safely recognize repeat attempts, so a retry does not accidentally spend the same thing twice. It then builds a backend client from the current account authentication. If there is no Codex/ChatGPT-style backend authentication, the request is rejected because the server cannot safely redeem the credit.

The backend call is wrapped in a timeout, normally ten seconds. In debug builds, an environment variable can override that timeout, which is useful for tests. If the backend is too slow or returns an error, this file turns that into an internal JSON-RPC error. If the backend succeeds, its result is translated into one of four plain outcomes: the rate limit was reset, there was nothing to reset, there was no credit, or the credit was already redeemed.

#### Function details

##### `AccountRequestProcessor::consume_account_rate_limit_reset_credit`  (lines 9–49)

```
async fn consume_account_rate_limit_reset_credit(
        &self,
        params: ConsumeAccountRateLimitResetCreditParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: This is the request handler for spending a rate-limit reset credit. It validates the request, asks the backend to redeem the credit, and returns a clear outcome to the client.

**Data flow**: It receives request parameters containing an idempotency key. If that key is empty, it immediately returns a client-facing invalid-request error. Otherwise it gets an authenticated backend client, waits up to the configured timeout while asking the backend to consume the credit, converts backend failures or timeouts into internal errors, and finally turns the backend's status code into a response payload for the client.

**Call relations**: This function is the top-level flow for this account action. When it needs a backend connection, it calls AccountRequestProcessor::rate_limit_reset_backend_client to build one from the current authentication. It then hands the actual redemption request to the backend client and uses the timeout wrapper so one slow backend call does not leave the request hanging forever.

*Call graph*: calls 1 internal fn (rate_limit_reset_backend_client); 2 external calls (var, timeout).


##### `AccountRequestProcessor::rate_limit_reset_backend_client`  (lines 51–65)

```
async fn rate_limit_reset_backend_client(&self) -> Result<BackendClient, JSONRPCErrorError>
```

**Purpose**: This helper creates the backend client needed to redeem rate-limit reset credits. It also enforces that the current user is authenticated with the kind of account that the backend can use for this feature.

**Data flow**: It reads the current authentication state from the account processor. If there is no authentication, or if the authentication is not for the Codex backend, it returns an invalid-request error. If the authentication is acceptable, it combines the configured ChatGPT backend base URL with the auth information to build a BackendClient; construction failures become internal errors.

**Call relations**: AccountRequestProcessor::consume_account_rate_limit_reset_credit calls this before contacting the backend. This helper keeps the authentication checks and client construction in one place, then hands back a ready-to-use BackendClient for the redemption request.

*Call graph*: called by 1 (consume_account_rate_limit_reset_credit); 1 external calls (from_auth).
