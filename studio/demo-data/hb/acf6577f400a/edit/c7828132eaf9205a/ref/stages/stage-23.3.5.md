# login workflow integration tests  `stage-23.3.5`

This stage is the safety net for the login system. It sits around the main login and logout work, checking that the whole journey works the way a real developer would experience it and that saved sign-in data is handled correctly.

At the top, all.rs and suite/mod.rs gather the many test pieces into one test program, so everything runs under a single harness. Several tests focus on the building blocks of authentication. access_token_tests.rs checks how the system tells one token format from another. personal_access_token_tests.rs makes sure personal tokens can be looked up against a fake auth service. storage_tests.rs verifies where sign-in data is stored, from files to secure system storage, including upgrade paths. auth_tests.rs ties many of these rules together, and bedrock_api_key_tests.rs checks API-key behavior and cleanup.

The larger journey tests then exercise full user flows. cli/tests/login.rs checks command-line login. device_code_login.rs covers the “enter this code on another device” flow. login_server_e2e.rs tests browser-based sign-in through a local callback server. auth_refresh.rs checks automatic token renewal. logout.rs confirms sign-out revokes tokens and removes saved credentials.

## Files in this stage

### Test harness structure
These files assemble the login crate's integration-test binary and register the suite modules that the end-to-end tests run under.

### `login/tests/all.rs`

`test` · `test run`

This file is the top-level entry point for login crate integration tests. Rather than maintaining multiple standalone integration test binaries in `tests/`, it declares one `suite` module and lets that module pull in the actual test cases from `tests/suite/`. The crate-level `#![allow(clippy::expect_used)]` attribute relaxes linting for test code, acknowledging that tests commonly use `expect` for concise failure reporting.

Its practical effect is on test organization and build behavior. Cargo treats each file in `tests/` as a separate integration test crate; by consolidating under `all.rs`, the project gets a single integration-test crate with shared module structure and potentially lower compile overhead. The actual assertions and fixtures live elsewhere, but this file is the root that causes them to be compiled and executed together.

There is no executable logic beyond module inclusion, but the design is intentional: it centralizes integration test discovery and keeps the suite layout explicit. Anyone adding a new login integration test module should wire it into `tests/suite/mod.rs`, not create another top-level test binary unless separate crate isolation is desired.


### `login/tests/suite/mod.rs`

`test` · `test run`

This module serves as the manifest for the login crate’s integration test suite. It declares four submodules: `auth_refresh`, `device_code_login`, `login_server_e2e`, and `logout`. Each of those files contains the actual test cases, helpers, and assertions for a specific authentication workflow or server interaction path.

The file’s role is structural rather than behavioral. By listing these modules, it controls inclusion in the single integration test crate rooted at `tests/all.rs`. That means adding or removing a line here directly changes which test groups are built and run. The grouping also communicates the intended coverage areas: token refresh behavior, device-code login flow, end-to-end login server behavior, and logout semantics.

A subtle but important design point is that this arrangement allows test modules to share crate-level context and helper visibility through the common suite hierarchy, unlike fully separate integration test crates. There is no runtime state or control flow in this file itself; its significance is in test composition and discoverability.


### Auth primitives and storage
These tests establish the lower-level authentication building blocks, from token classification and hydration to persistence backends and broad auth-manager behavior.

### `login/src/auth/access_token_tests.rs`

`test` · `unit test execution`

This file contains a single focused regression test for `classify_codex_access_token`. It imports the parent module items and uses `matches!` assertions to check both branches of the classifier. The first assertion passes a token beginning with `at-` and expects the `CodexAccessToken::PersonalAccessToken` variant carrying the original string. The second passes a JWT-shaped string with dot-separated segments and expects `CodexAccessToken::AgentIdentityJwt`.

The test is intentionally narrow because the production logic is intentionally narrow: classification is based only on the prefix, not on JWT parsing or token validation. By asserting exact enum variants and borrowed payloads, the test documents that the classifier preserves the original token string unchanged and that non-`at-` inputs are routed to the JWT path regardless of whether they are actually valid JWTs.

#### Function details

##### `classifies_personal_access_tokens_by_prefix`  (lines 4–13)

```
fn classifies_personal_access_tokens_by_prefix()
```

**Purpose**: Verifies that `at-` tokens are classified as personal access tokens and other token-shaped strings are classified as agent-identity JWTs.

**Data flow**: Calls `classify_codex_access_token` twice with fixed string literals and asserts, via `matches!`, that each returned enum variant and borrowed payload match the expected branch.

**Call relations**: This is the direct unit test for the classifier in the sibling source file.

*Call graph*: 1 external calls (assert!).


### `login/src/auth/personal_access_token_tests.rs`

`test` · `test execution`

This test file validates the network-facing hydration logic for personal access tokens without contacting the real auth API. A small `response` helper builds the JSON body expected from the whoami endpoint, parameterizing only the `email` field so tests can exercise both valid and invalid payloads while keeping the rest of the metadata stable.

The success test starts a `wiremock` server, mounts a single expected GET request to `WHOAMI_PATH` with an exact `Authorization: Bearer at-example` header, and responds with a complete metadata body. It then calls `hydrate_personal_access_token` using `create_client()` and the mock server URI, asserting that the returned `PersonalAccessTokenAuth` exactly matches the expected token string and nested metadata values. The failure test uses the same endpoint but returns `email: null`; because the production metadata struct requires `email: String`, deserialization should fail. The test asserts that the resulting error message contains the decode-failure prefix, proving malformed metadata is rejected rather than silently accepted. Both tests verify the mock server expectations to ensure the request was actually issued.

#### Function details

##### `response`  (lines 11–19)

```
fn response(email: Option<&str>) -> serde_json::Value
```

**Purpose**: Builds the mock whoami JSON payload used by PAT hydration tests.

**Data flow**: It takes an optional email string and returns a `serde_json::Value` object containing that email plus fixed user id, account id, plan type, and FedRAMP fields.

**Call relations**: Both PAT hydration tests call this helper to generate the response body they mount on the mock server.

*Call graph*: called by 2 (hydrate_rejects_missing_email, hydrate_sends_bearer_token_and_preserves_metadata); 1 external calls (json!).


##### `hydrate_sends_bearer_token_and_preserves_metadata`  (lines 22–50)

```
async fn hydrate_sends_bearer_token_and_preserves_metadata()
```

**Purpose**: Verifies that PAT hydration sends the expected bearer token and returns the exact metadata from the whoami response.

**Data flow**: It starts a `wiremock` server, mounts a GET expectation on `WHOAMI_PATH` requiring the `authorization` header `Bearer at-example`, and responds with `response(Some("user@example.com"))`. It then awaits `hydrate_personal_access_token(&create_client(), &server.uri(), "at-example")`, unwraps success, and asserts the returned `PersonalAccessTokenAuth` exactly matches the expected token and metadata struct before verifying the mock server.

**Call relations**: This is the positive integration test for `hydrate_personal_access_token`, covering request construction, bearer auth, JSON decoding, and object assembly.

*Call graph*: calls 1 internal fn (response); 7 external calls (given, start, new, assert_eq!, header, method, path).


##### `hydrate_rejects_missing_email`  (lines 53–71)

```
async fn hydrate_rejects_missing_email()
```

**Purpose**: Verifies that PAT hydration rejects malformed metadata where the required email field is missing/null.

**Data flow**: It starts a mock server, mounts a GET responder on `WHOAMI_PATH` returning `response(None)`, then awaits `hydrate_personal_access_token(&create_client(), &server.uri(), "at-example")` and expects an error. It asserts the error string contains `failed to decode personal access token metadata` and verifies the mock server.

**Call relations**: This negative test exercises the JSON-decoding failure path in `hydrate_personal_access_token`, proving schema validation is enforced by deserialization.

*Call graph*: calls 1 internal fn (response); 6 external calls (given, start, new, assert!, method, path).


### `login/src/auth/storage_tests.rs`

`test` · `test`

This test module validates the storage layer defined in `storage.rs` with concrete end-to-end scenarios. The early tests cover `FileAuthStorage` round trips for API-key auth, agent-identity JWTs, and personal access tokens, plus deletion of `auth.json`. Ephemeral mode is verified to keep state only in memory and never create the fallback file.

Several helper functions seed encrypted secrets storage using `SecretsManager`, create stale fallback files to verify cleanup, and assert that secrets-backed saves persist the encrypted payload while removing plaintext `auth.json`. The helpers also check migration details: secrets-backed storage should use the secrets backend’s keyring account rather than the legacy direct keyring key, while direct keyring mode should still write the legacy entry. `id_token_with_prefix`, `auth_with_prefix`, and `jwt_with_payload` generate realistic token and JWT fixtures whose claims can be distinguished across test cases.

The backend-specific tests verify direct keyring save/load/delete, secrets-backed save/load/delete, deletion of legacy direct-keyring entries when using the secrets backend, and factory selection between direct and secrets modes. `AutoAuthStorage` tests confirm its policy decisions: prefer keyring values over file values, use file when keyring is empty, fall back to file when keyring operations error, prefer keyring on save, and delete both secure and fallback copies. Together these tests document the intended migration and fallback semantics of the auth persistence subsystem.

#### Function details

##### `file_storage_load_returns_auth_dot_json`  (lines 18–38)

```
async fn file_storage_load_returns_auth_dot_json() -> anyhow::Result<()>
```

**Purpose**: Verifies that a saved `AuthDotJson` can be loaded back unchanged from file storage.

**Data flow**: Creates a temp `codex_home`, constructs `FileAuthStorage`, builds an `AuthDotJson` with API-key mode and `Utc::now()` for `last_refresh`, saves it, loads it, and asserts equality.

**Call relations**: This test drives the normal `FileAuthStorage::save` → `FileAuthStorage::load` path to confirm basic file persistence semantics.

*Call graph*: calls 1 internal fn (new); 3 external calls (now, assert_eq!, tempdir).


##### `file_storage_save_persists_auth_dot_json`  (lines 41–64)

```
async fn file_storage_save_persists_auth_dot_json() -> anyhow::Result<()>
```

**Purpose**: Checks that file storage writes the expected serialized auth record to disk.

**Data flow**: Creates temp storage and an `AuthDotJson`, computes the auth file path with `get_auth_file`, saves the record, then reads it back directly with `try_read_auth_json` and asserts equality.

**Call relations**: Unlike the previous test, this one explicitly validates the on-disk file contents through the lower-level file-reading helper.

*Call graph*: calls 1 internal fn (new); 3 external calls (now, assert_eq!, tempdir).


##### `file_storage_round_trips_agent_identity_auth`  (lines 67–94)

```
async fn file_storage_round_trips_agent_identity_auth() -> anyhow::Result<()>
```

**Purpose**: Ensures file storage preserves agent-identity auth records containing a JWT string.

**Data flow**: Builds a synthetic JWT with `jwt_with_payload`, stores it in an `AuthDotJson` with `AuthMode::AgentIdentity`, saves via `FileAuthStorage`, reloads, and asserts the full record matches.

**Call relations**: This test covers a non-token auth mode and confirms the storage layer treats the agent identity JWT as ordinary persisted data.

*Call graph*: calls 2 internal fn (new, jwt_with_payload); 3 external calls (assert_eq!, json!, tempdir).


##### `file_storage_round_trips_personal_access_token_auth`  (lines 97–115)

```
async fn file_storage_round_trips_personal_access_token_auth() -> anyhow::Result<()>
```

**Purpose**: Ensures file storage preserves personal-access-token auth records.

**Data flow**: Creates temp file storage, builds an `AuthDotJson` with `AuthMode::PersonalAccessToken` and a PAT string, saves it, reloads it, and asserts equality.

**Call relations**: This complements the agent-identity test by covering another alternate auth mode stored in `AuthDotJson`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, tempdir).


##### `file_storage_loads_agent_identity_as_jwt`  (lines 118–146)

```
async fn file_storage_loads_agent_identity_as_jwt() -> anyhow::Result<()>
```

**Purpose**: Confirms that an auth file containing an `agent_identity` JWT string is loaded as that same raw JWT string.

**Data flow**: Creates a temp auth file manually with pretty JSON containing `auth_mode: agentIdentity` and a generated JWT, then calls `storage.load()` and asserts `loaded.agent_identity.as_deref()` equals the original JWT.

**Call relations**: This test validates deserialization compatibility for manually written auth files and documents that the storage layer does not eagerly decode or transform the JWT on load.

*Call graph*: calls 2 internal fn (new, jwt_with_payload); 5 external calls (assert_eq!, json!, to_string_pretty, write, tempdir).


##### `file_storage_delete_removes_auth_file`  (lines 149–172)

```
fn file_storage_delete_removes_auth_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that deleting file-backed auth removes `auth.json` and reports success.

**Data flow**: Creates a temp directory, saves an API-key auth record through `create_auth_storage(...File...)`, asserts the file exists, then constructs `FileAuthStorage`, calls `delete`, and asserts both the boolean result and file absence.

**Call relations**: This test exercises the file backend’s delete path and the shared `get_auth_file` location convention.

*Call graph*: calls 2 internal fn (default, new); 2 external calls (assert!, tempdir).


##### `ephemeral_storage_save_load_delete_is_in_memory_only`  (lines 175–202)

```
fn ephemeral_storage_save_load_delete_is_in_memory_only() -> anyhow::Result<()>
```

**Purpose**: Checks that ephemeral storage stores auth only in memory and never creates `auth.json`.

**Data flow**: Creates an ephemeral backend via `create_auth_storage`, saves an `AuthDotJson`, loads and compares it, deletes it, verifies subsequent load returns `None`, and asserts the auth file path does not exist.

**Call relations**: This test documents the contract of `EphemeralAuthStorage`: same API as persistent backends, but no disk side effects.

*Call graph*: calls 1 internal fn (default); 4 external calls (now, assert!, assert_eq!, tempdir).


##### `seed_secrets_backend_and_fallback_auth_file_for_delete`  (lines 204–223)

```
fn seed_secrets_backend_and_fallback_auth_file_for_delete(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    auth: &AuthDotJson,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Test helper that seeds encrypted auth storage and creates a stale fallback file to validate delete cleanup.

**Data flow**: Builds a `SecretsManager` using the mock keyring and `LocalSecretsNamespace::CodexAuth`, stores serialized `auth` under `CODEX_AUTH_SECRET_NAME`, writes `"stale"` to `auth.json`, and returns the fallback file path.

**Call relations**: Called by delete-oriented tests for secrets-backed and auto storage to set up the exact mixed-state condition those delete methods are expected to clean up.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 3 (auto_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry); 5 external calls (new, to_path_buf, clone, to_string, write).


##### `seed_secrets_backend_with_auth`  (lines 225–242)

```
fn seed_secrets_backend_with_auth(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    auth: &AuthDotJson,
) -> anyhow::Result<()>
```

**Purpose**: Test helper that seeds only the encrypted secrets backend with a serialized auth record.

**Data flow**: Constructs a `SecretsManager` with the mock keyring and writes `serde_json::to_string(auth)` to the global `CODEX_AUTH` secret.

**Call relations**: Used by load tests and keyring-error fallback tests to prepare a secrets-backed auth value without creating a fallback file.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 3 (auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, secrets_keyring_auth_storage_load_returns_deserialized_auth); 4 external calls (new, to_path_buf, clone, to_string).


##### `assert_keyring_saved_auth_and_removed_fallback`  (lines 244–277)

```
fn assert_keyring_saved_auth_and_removed_fallback(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    expected: &AuthDotJson,
) -> anyhow::Result<()>
```

**Purpose**: Shared assertion helper that verifies secrets-backed save behavior, including encrypted persistence, legacy-key avoidance, and fallback-file removal.

**Data flow**: Reads the saved encrypted auth via `SecretsManager`, compares it to `serde_json::to_string(expected)`, computes the legacy direct key with `compute_store_key` and asserts no value exists there, computes the secrets keyring account and asserts a passphrase exists, checks the encrypted auth file exists, and asserts `auth.json` does not.

**Call relations**: Called by secrets-backed save tests and auto-save preference tests to enforce the intended migration and cleanup invariants after a successful secure save.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 2 (auto_auth_storage_save_prefers_keyring, secrets_keyring_auth_storage_save_persists_and_removes_fallback_file); 7 external calls (new, to_path_buf, assert!, assert_eq!, compute_keyring_account, clone, to_string).


##### `encrypted_auth_file`  (lines 279–281)

```
fn encrypted_auth_file(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the path of the encrypted auth payload file used by the local secrets backend.

**Data flow**: Returns `codex_home.join("secrets").join("codex_auth.age")`.

**Call relations**: Used by tests that need to distinguish encrypted secrets storage artifacts from the plaintext fallback file.

*Call graph*: 1 external calls (join).


##### `id_token_with_prefix`  (lines 283–307)

```
fn id_token_with_prefix(prefix: &str) -> IdTokenInfo
```

**Purpose**: Builds a parseable fake ChatGPT ID token whose claims are tagged with a caller-provided prefix.

**Data flow**: Constructs a JWT header and payload JSON containing prefixed email and account identifiers, base64url-encodes header/payload/signature, formats a fake JWT string, and parses it with `parse_chatgpt_jwt_claims` into `IdTokenInfo`.

**Call relations**: Used by `auth_with_prefix` so tests can generate distinct but realistic `TokenData` values and verify which backend copy was loaded.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 1 (auth_with_prefix); 3 external calls (format!, json!, to_vec).


##### `auth_with_prefix`  (lines 309–324)

```
fn auth_with_prefix(prefix: &str) -> AuthDotJson
```

**Purpose**: Creates a complete `AuthDotJson` fixture with distinguishable token and API-key values derived from a prefix.

**Data flow**: Builds an `AuthDotJson` in `ApiKey` mode, fills `openai_api_key`, `TokenData.id_token`, `access_token`, `refresh_token`, and `account_id` using the prefix, and returns the record.

**Call relations**: This is the main fixture generator used across direct keyring, secrets, and auto-storage tests to make expected values easy to compare.

*Call graph*: calls 1 internal fn (id_token_with_prefix); called by 11 (auto_auth_storage_delete_removes_keyring_and_file, auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, auto_auth_storage_load_uses_file_when_keyring_empty, auto_auth_storage_save_falls_back_when_keyring_errors, auto_auth_storage_save_prefers_keyring, direct_keyring_auth_storage_delete_removes_keyring_and_file, direct_keyring_auth_storage_saves_legacy_keyring_entry, factory_uses_secrets_backend_only_when_requested, secrets_keyring_auth_storage_delete_removes_keyring_and_file (+1 more)); 1 external calls (format!).


##### `jwt_with_payload`  (lines 326–332)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Creates a simple JWT string from an arbitrary JSON payload for tests that need raw JWT storage.

**Data flow**: Base64url-encodes a fixed header, the provided serialized payload, and a dummy signature, then concatenates them with dots into a JWT string.

**Call relations**: Used by agent-identity file-storage tests to generate JWT-shaped values without requiring signing infrastructure.

*Call graph*: called by 2 (file_storage_loads_agent_identity_as_jwt, file_storage_round_trips_agent_identity_auth); 2 external calls (format!, to_vec).


##### `secrets_keyring_auth_storage_load_returns_deserialized_auth`  (lines 335–356)

```
fn secrets_keyring_auth_storage_load_returns_deserialized_auth() -> anyhow::Result<()>
```

**Purpose**: Verifies that the secrets-backed backend loads and deserializes auth previously stored in encrypted storage.

**Data flow**: Creates temp home and mock keyring, constructs `SecretsKeyringAuthStorage`, seeds encrypted auth with `seed_secrets_backend_with_auth`, loads from storage, and asserts the loaded value equals the expected `AuthDotJson`.

**Call relations**: This test directly exercises `SecretsKeyringAuthStorage::load` independent of the auto backend.

*Call graph*: calls 2 internal fn (new, seed_secrets_backend_with_auth); 4 external calls (new, assert_eq!, default, tempdir).


##### `keyring_auth_storage_compute_store_key_for_home_directory`  (lines 359–366)

```
fn keyring_auth_storage_compute_store_key_for_home_directory() -> anyhow::Result<()>
```

**Purpose**: Locks down the deterministic hash-derived key format for a representative home-directory path.

**Data flow**: Builds `PathBuf::from("~/.codex")`, calls `compute_store_key`, and asserts the exact expected `cli|...` string.

**Call relations**: This test documents the stable key derivation contract relied on by direct keyring and ephemeral storage.

*Call graph*: 2 external calls (from, assert_eq!).


##### `direct_keyring_auth_storage_saves_legacy_keyring_entry`  (lines 369–394)

```
fn direct_keyring_auth_storage_saves_legacy_keyring_entry() -> anyhow::Result<()>
```

**Purpose**: Checks that direct keyring storage writes the legacy keyring entry, removes stale fallback files, and can load the saved auth back.

**Data flow**: Creates temp home and mock keyring, writes a stale `auth.json`, builds an auth fixture, saves through `DirectKeyringAuthStorage`, reads the saved keyring value via `compute_store_key`, asserts serialized equality, verifies no encrypted auth file exists and fallback file was removed, then loads and compares the auth.

**Call relations**: This test captures the intended behavior of the legacy direct backend and distinguishes it from the newer secrets-backed backend.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 6 external calls (new, assert!, assert_eq!, default, write, tempdir).


##### `direct_keyring_auth_storage_delete_removes_keyring_and_file`  (lines 397–425)

```
fn direct_keyring_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that deleting direct keyring auth removes both the keyring entry and any fallback file.

**Data flow**: Creates direct keyring storage, saves an auth fixture, writes a stale fallback file, calls `delete`, then asserts the delete result is true, subsequent `load()` returns `None`, the legacy keyring entry is absent, and neither fallback nor encrypted files remain.

**Call relations**: This test exercises `DirectKeyringAuthStorage::delete` and its combined cleanup semantics.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 6 external calls (new, assert!, assert_eq!, default, write, tempdir).


##### `factory_uses_secrets_backend_only_when_requested`  (lines 428–463)

```
fn factory_uses_secrets_backend_only_when_requested() -> anyhow::Result<()>
```

**Purpose**: Ensures the storage factory selects direct or secrets-backed keyring behavior strictly according to `AuthKeyringBackendKind`.

**Data flow**: Creates one backend with `Direct`, saves auth, and asserts the legacy direct key exists and no encrypted file exists; then creates another backend with `Secrets`, saves auth, and asserts the secrets keyring account exists and the encrypted auth file exists.

**Call relations**: This test validates `create_auth_storage_with_store` and `create_keyring_auth_storage` backend selection rather than any single backend implementation.

*Call graph*: calls 1 internal fn (auth_with_prefix); 4 external calls (new, assert!, default, tempdir).


##### `secrets_keyring_auth_storage_save_persists_and_removes_fallback_file`  (lines 466–494)

```
fn secrets_keyring_auth_storage_save_persists_and_removes_fallback_file() -> anyhow::Result<()>
```

**Purpose**: Checks that secrets-backed save persists encrypted auth and removes a stale plaintext fallback file.

**Data flow**: Creates temp home and mock keyring, writes a stale `auth.json`, builds a ChatGPT-mode `AuthDotJson`, saves through `SecretsKeyringAuthStorage`, then delegates verification to `assert_keyring_saved_auth_and_removed_fallback`.

**Call relations**: This test focuses on the secure-save path of `SecretsKeyringAuthStorage`, especially the cleanup invariant after successful persistence.

*Call graph*: calls 2 internal fn (new, assert_keyring_saved_auth_and_removed_fallback); 6 external calls (new, default, now, default, write, tempdir).


##### `secrets_keyring_auth_storage_delete_removes_keyring_and_file`  (lines 497–520)

```
fn secrets_keyring_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that deleting secrets-backed auth removes the encrypted secret and any fallback file.

**Data flow**: Seeds encrypted auth plus a stale fallback file with `seed_secrets_backend_and_fallback_auth_file_for_delete`, calls `storage.delete()`, and asserts removal succeeded, subsequent load returns `None`, and the fallback file no longer exists.

**Call relations**: This test exercises the normal delete path of `SecretsKeyringAuthStorage` without involving legacy direct-keyring migration state.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry`  (lines 523–556)

```
fn secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry() -> anyhow::Result<()>
```

**Purpose**: Ensures secrets-backed delete also cleans up an older direct-keyring auth entry left from previous backend usage.

**Data flow**: Creates and saves auth through `DirectKeyringAuthStorage`, then seeds encrypted auth plus fallback file, deletes through `SecretsKeyringAuthStorage`, and asserts encrypted auth is gone, direct storage now loads `None`, and the fallback file is removed.

**Call relations**: This test documents the migration-cleanup responsibility embedded in `SecretsKeyringAuthStorage::delete`.

*Call graph*: calls 4 internal fn (new, new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_prefers_keyring_value`  (lines 559–576)

```
fn auto_auth_storage_load_prefers_keyring_value() -> anyhow::Result<()>
```

**Purpose**: Verifies that auto mode returns the keyring-backed auth when both keyring and file copies exist.

**Data flow**: Creates `AutoAuthStorage`, seeds encrypted auth in the secrets backend, saves a different auth fixture to `file_storage`, loads through auto storage, and asserts the keyring value wins.

**Call relations**: This test captures the primary read precedence rule implemented by `AutoAuthStorage::load`.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_with_auth); 4 external calls (new, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_uses_file_when_keyring_empty`  (lines 579–594)

```
fn auto_auth_storage_load_uses_file_when_keyring_empty() -> anyhow::Result<()>
```

**Purpose**: Checks that auto mode falls back to file storage when the keyring backend has no auth entry.

**Data flow**: Creates `AutoAuthStorage` with an empty mock keyring, saves an auth fixture only to `file_storage`, loads through auto storage, and asserts the file value is returned.

**Call relations**: This test covers the `Ok(None)` branch of `AutoAuthStorage::load`.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 4 external calls (new, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_falls_back_when_keyring_errors`  (lines 597–617)

```
fn auto_auth_storage_load_falls_back_when_keyring_errors() -> anyhow::Result<()>
```

**Purpose**: Checks that auto mode logs past keyring failures and still returns file-backed auth.

**Data flow**: Creates auto storage, seeds encrypted auth, injects a mock keyring error for the secrets keyring account, saves a different fallback auth to `file_storage`, loads through auto storage, and asserts the fallback file value is returned.

**Call relations**: This test covers the error branch of `AutoAuthStorage::load`, documenting resilience when secure storage is broken.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_with_auth); 6 external calls (new, Invalid, assert_eq!, compute_keyring_account, default, tempdir).


##### `auto_auth_storage_save_prefers_keyring`  (lines 620–636)

```
fn auto_auth_storage_save_prefers_keyring() -> anyhow::Result<()>
```

**Purpose**: Verifies that auto mode writes to secure storage when possible and removes stale fallback files.

**Data flow**: Creates auto storage, seeds a stale file-backed auth in `file_storage`, saves a new auth through auto storage, and then uses `assert_keyring_saved_auth_and_removed_fallback` to confirm secure persistence and file cleanup.

**Call relations**: This test exercises the success branch of `AutoAuthStorage::save`, where keyring-backed storage remains authoritative.

*Call graph*: calls 3 internal fn (new, assert_keyring_saved_auth_and_removed_fallback, auth_with_prefix); 3 external calls (new, default, tempdir).


##### `auto_auth_storage_save_falls_back_when_keyring_errors`  (lines 639–668)

```
fn auto_auth_storage_save_falls_back_when_keyring_errors() -> anyhow::Result<()>
```

**Purpose**: Checks that auto mode writes `auth.json` when keyring save fails.

**Data flow**: Creates auto storage, injects a mock keyring save error, saves an auth fixture through auto storage, asserts `auth.json` now exists, loads it from `file_storage`, compares it to the expected auth, and confirms the keyring contains no saved value.

**Call relations**: This test covers the degraded write path of `AutoAuthStorage::save` and documents the fallback-to-file policy.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 7 external calls (new, Invalid, assert!, assert_eq!, compute_keyring_account, default, tempdir).


##### `auto_auth_storage_delete_removes_keyring_and_file`  (lines 671–695)

```
fn auto_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that deleting auto storage removes both secure storage and any fallback file.

**Data flow**: Seeds encrypted auth plus a stale fallback file, calls `storage.delete()`, and asserts the delete result is true, subsequent auto load returns `None`, and the fallback file is gone.

**Call relations**: This test confirms that `AutoAuthStorage::delete` correctly delegates cleanup to the underlying keyring-backed backend.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### `login/src/auth/auth_tests.rs`

`test` · `unit and integration-style auth test execution`

This file is the main behavioral test harness for the login/auth subsystem. It exercises both persisted and environment-sourced credentials across API keys, ChatGPT OAuth token bundles, personal access tokens, and agent-identity JWTs. The tests use `tempdir`-backed Codex homes, `wiremock` servers for auth and JWKS endpoints, and helper constructors that synthesize `auth.json` contents, unsigned JWT-like strings, and properly signed agent-identity JWTs. Workspace restriction behavior is a major theme: multiple tests verify that login or auth loading rejects credentials whose account/workspace ID is not in an allowed list, and that `enforce_login_restrictions` logs out by deleting `auth.json` on mismatches.

The file also covers persistence semantics in detail: refreshing tokens without a new ID token preserves the old JWT; logging in with an API key clears stale token state; logging in with an access token writes only the relevant token field and clears incompatible auth modes. Another cluster of tests targets `AuthManager`, including unauthorized recovery naming, refresh-failure scoping to an unchanged auth snapshot, and external bearer-only providers backed by a temporary script that emits rotating tokens. Supporting helpers are substantial: `ProviderAuthScript` writes platform-specific scripts and token files, `write_auth_file` emits realistic auth JSON with timestamped refresh metadata, and `EnvVarGuard` safely mutates process environment during tests. The final section verifies plan-type mapping from both stored ChatGPT ID-token claims and agent-identity JWT claims, including aliases like `hc` and `education`.

#### Function details

##### `refresh_without_id_token`  (lines 31–60)

```
async fn refresh_without_id_token()
```

**Purpose**: Verifies that refreshing stored tokens without a replacement ID token preserves the existing raw JWT while updating access and refresh tokens.

**Data flow**: Creates a temp Codex home, writes an auth file with a fake JWT, constructs file-backed auth storage, calls `persist_tokens` with `id_token = None` and new access/refresh tokens, extracts the updated token bundle, and asserts the old JWT is retained while the other token strings are replaced.

**Call relations**: This test targets the token-persistence update path and specifically the branch where no new ID token is supplied.

*Call graph*: calls 2 internal fn (default, write_auth_file); 3 external calls (assert_eq!, persist_tokens, tempdir).


##### `login_with_api_key_overwrites_existing_auth_json`  (lines 63–95)

```
fn login_with_api_key_overwrites_existing_auth_json()
```

**Purpose**: Verifies that API-key login replaces stale token-based auth state and clears the `tokens` section.

**Data flow**: Creates a temp directory, writes a handcrafted stale `auth.json` containing both API key and token fields, calls `login_with_api_key`, reloads the file through `FileAuthStorage`, and asserts the new API key is present while `tokens` is `None`.

**Call relations**: This checks that API-key login is destructive with respect to incompatible prior auth modes.

*Call graph*: calls 2 internal fn (default, new); 7 external calls (assert!, assert_eq!, json!, to_string_pretty, write, login_with_api_key, tempdir).


##### `login_with_access_token_writes_only_token`  (lines 98–136)

```
async fn login_with_access_token_writes_only_token()
```

**Purpose**: Verifies that logging in with a valid agent-identity JWT persists only agent-identity auth fields and clears token/API-key state.

**Data flow**: Creates a temp home, synthesizes an `AgentIdentityAuthRecord` and signed JWT, starts a mock server serving JWKS, calls `login_with_access_token` with the JWT and mock ChatGPT base URL, reloads `auth.json`, and asserts `auth_mode` is `AgentIdentity`, `agent_identity` contains the JWT, and both `tokens` and `openai_api_key` are absent.

**Call relations**: This exercises the agent-identity branch selected after access-token classification and JWT validation.

*Call graph*: calls 5 internal fn (default, agent_identity_record, signed_agent_identity_jwt, test_jwks_body, new); 11 external calls (given, start, new, assert!, assert_eq!, format!, json!, login_with_access_token, tempdir, method (+1 more)).


##### `login_with_access_token_writes_only_personal_access_token`  (lines 140–188)

```
async fn login_with_access_token_writes_only_personal_access_token()
```

**Purpose**: Verifies that logging in with a personal access token persists only the PAT field and omits legacy `auth_mode` serialization.

**Data flow**: Starts a mock auth API returning whoami metadata for `at-login-test`, sets `CODEX_AUTHAPI_BASE_URL`, calls `login_with_access_token` with an allowed workspace list, reloads `auth.json`, asserts the full `AuthDotJson` matches a PAT-only structure, checks `resolved_mode()` is `PersonalAccessToken`, and parses the raw file to confirm `auth_mode` is absent.

**Call relations**: This covers the PAT branch of access-token login and its persistence format.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new); 12 external calls (given, start, new, assert!, assert_eq!, from_str, read_to_string, login_with_access_token, tempdir, header (+2 more)).


##### `login_with_access_token_rejects_personal_access_token_workspace_mismatch`  (lines 192–225)

```
async fn login_with_access_token_rejects_personal_access_token_workspace_mismatch()
```

**Purpose**: Verifies that PAT login fails with `PermissionDenied` when the token belongs to a workspace outside the allowed list and does not write `auth.json`.

**Data flow**: Mocks whoami to return a disallowed workspace, sets the auth API base URL override, calls `login_with_access_token` with a single allowed workspace, captures the error, asserts `ErrorKind::PermissionDenied`, and checks the auth file path does not exist.

**Call relations**: This tests workspace restriction enforcement during PAT login before persistence occurs.

*Call graph*: calls 3 internal fn (set, default, personal_access_token_whoami); 10 external calls (given, start, new, assert!, assert_eq!, login_with_access_token, tempdir, header, method, path).


##### `login_with_access_token_rejects_invalid_personal_access_token`  (lines 229–257)

```
async fn login_with_access_token_rejects_invalid_personal_access_token()
```

**Purpose**: Verifies that a PAT rejected by the auth API is surfaced as an error and does not persist auth state.

**Data flow**: Mocks `GET /v1/user-auth-credential/whoami` to return 403, sets the auth API base URL override, calls `login_with_access_token` with an `at-` token, asserts `ErrorKind::Other`, and confirms no auth file was written.

**Call relations**: This covers the invalid-PAT validation path after prefix-based classification.

*Call graph*: calls 2 internal fn (set, default); 9 external calls (given, start, new, assert!, assert_eq!, login_with_access_token, tempdir, method, path).


##### `login_with_access_token_rejects_invalid_jwt`  (lines 260–279)

```
async fn login_with_access_token_rejects_invalid_jwt()
```

**Purpose**: Verifies that a non-`at-` token that is not a valid JWT is rejected and not persisted.

**Data flow**: Creates a temp home, calls `login_with_access_token` with `not-a-jwt`, asserts `ErrorKind::Other`, and checks that `auth.json` was not created.

**Call relations**: This covers the malformed JWT branch reached after classification routes non-`at-` tokens to agent-identity handling.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert!, assert_eq!, login_with_access_token, tempdir).


##### `login_with_access_token_rejects_unsigned_jwt`  (lines 282–311)

```
async fn login_with_access_token_rejects_unsigned_jwt()
```

**Purpose**: Verifies that an unsigned fake agent-identity JWT is rejected even when JWKS are available.

**Data flow**: Creates a fake unsigned JWT from a generated record, serves JWKS from a mock backend, calls `login_with_access_token`, expects an error, and asserts no auth file was written.

**Call relations**: This tests signature verification in the agent-identity login path.

*Call graph*: calls 4 internal fn (default, agent_identity_record, fake_agent_identity_jwt, test_jwks_body); 9 external calls (given, start, new, assert!, format!, login_with_access_token, tempdir, method, path).


##### `missing_auth_json_returns_none`  (lines 315–327)

```
async fn missing_auth_json_returns_none()
```

**Purpose**: Verifies that loading auth from storage returns `None` when no auth file exists and no access-token env var is set.

**Data flow**: Creates a temp home, removes the access-token env var via guard, calls `CodexAuth::from_auth_storage`, and asserts the result is `None`.

**Call relations**: This is the empty-state baseline for auth loading.

*Call graph*: calls 3 internal fn (default, remove_access_token_env_var, from_auth_storage); 2 external calls (assert_eq!, tempdir).


##### `pro_account_with_no_api_key_uses_chatgpt_auth`  (lines 331–390)

```
async fn pro_account_with_no_api_key_uses_chatgpt_auth()
```

**Purpose**: Verifies that stored OAuth-style tokens with a Pro plan and no API key load as ChatGPT auth and preserve expected metadata.

**Data flow**: Writes an auth file containing a fake JWT with `chatgpt_plan_type = pro`, removes the access-token env var, calls `load_auth`, asserts the resulting auth has no API key, uses `AuthMode::Chatgpt`, exposes the expected user ID, then inspects the current `AuthDotJson` snapshot and asserts all token and metadata fields match the seeded values plus a recorded `last_refresh`.

**Call relations**: This covers the stored ChatGPT-token loading path and metadata extraction from the ID token.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `loads_api_key_from_auth_json`  (lines 394–419)

```
async fn loads_api_key_from_auth_json()
```

**Purpose**: Verifies that a stored API key in `auth.json` loads as API-key auth and does not expose token data.

**Data flow**: Writes a minimal auth file containing `OPENAI_API_KEY`, removes the access-token env var, calls `load_auth`, asserts `auth_mode()` is `ApiKey`, `api_key()` returns the stored key, and `get_token_data()` returns an error.

**Call relations**: This is the basic persisted API-key loading test.

*Call graph*: calls 1 internal fn (remove_access_token_env_var); 5 external calls (assert!, assert_eq!, write, load_auth, tempdir).


##### `logout_removes_auth_file`  (lines 422–448)

```
fn logout_removes_auth_file() -> Result<(), std::io::Error>
```

**Purpose**: Verifies that `logout` deletes the persisted auth file and reports success.

**Data flow**: Creates a temp home, constructs an `AuthDotJson` with an API key, saves it via `save_auth`, asserts the auth file exists, calls `logout`, and asserts both the boolean result and file removal.

**Call relations**: This covers the persistence cleanup path used when logging out or enforcing restrictions.

*Call graph*: calls 2 internal fn (default, get_auth_file); 3 external calls (assert!, save_auth, tempdir).


##### `unauthorized_recovery_reports_mode_and_step_names`  (lines 452–479)

```
async fn unauthorized_recovery_reports_mode_and_step_names()
```

**Purpose**: Verifies the human-readable names reported by `UnauthorizedRecovery` for managed and external modes and their current steps.

**Data flow**: Creates a shared `AuthManager`, constructs one `UnauthorizedRecovery` in managed/reload state and another in external/external-refresh state, and asserts `mode_name()` and `step_name()` return the expected strings.

**Call relations**: This is a naming/telemetry-oriented test for unauthorized recovery state reporting.

*Call graph*: calls 2 internal fn (default, shared); 3 external calls (clone, assert_eq!, tempdir).


##### `refresh_failure_is_scoped_to_the_matching_auth_snapshot`  (lines 483–535)

```
async fn refresh_failure_is_scoped_to_the_matching_auth_snapshot()
```

**Purpose**: Verifies that a recorded permanent refresh failure applies only to the exact auth snapshot it was recorded against, not to a later modified snapshot.

**Data flow**: Writes a token-based auth file, loads auth, clones and mutates the current `AuthDotJson` to change access and refresh tokens, rebuilds a `CodexAuth` from the modified snapshot, creates an `AuthManager` from the original auth, records a `RefreshTokenFailedError` against the original auth, and asserts the manager returns that error for the original auth but `None` for the updated auth.

**Call relations**: This tests snapshot identity semantics inside refresh-failure tracking.

*Call graph*: calls 5 internal fn (remove_access_token_env_var, write_auth_file, from_auth_for_testing, from_auth_dot_json, new); 3 external calls (assert_eq!, load_auth, tempdir).


##### `external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth`  (lines 538–548)

```
fn external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth()
```

**Purpose**: Verifies that bearer-only external auth tokens lacking ChatGPT metadata cannot be converted into ChatGPT auth state.

**Data flow**: Builds `ExternalAuthTokens::access_token_only("test-access-token")`, calls `AuthDotJson::from_external_tokens`, expects an error, and asserts the exact error message about missing ChatGPT metadata.

**Call relations**: This covers a validation guard in external-token seeding logic.

*Call graph*: calls 1 internal fn (access_token_only); 2 external calls (assert_eq!, from_external_tokens).


##### `external_bearer_only_auth_manager_uses_cached_provider_token`  (lines 551–568)

```
async fn external_bearer_only_auth_manager_uses_cached_provider_token()
```

**Purpose**: Verifies that an external bearer-only `AuthManager` caches the first provider token instead of re-running the provider command on repeated reads.

**Data flow**: Creates a `ProviderAuthScript` that would emit `provider-token` then `next-token`, builds an external bearer-only manager from its config, calls `manager.auth()` twice, extracts API keys from both results, and asserts both are `provider-token` along with the manager's auth mode metadata.

**Call relations**: This tests the caching behavior of external bearer-only auth providers.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 1 external calls (assert_eq!).


##### `external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero`  (lines 571–588)

```
async fn external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero()
```

**Purpose**: Verifies that setting `refresh_interval_ms = 0` disables automatic refresh for external bearer-only auth.

**Data flow**: Creates a rotating `ProviderAuthScript`, mutates its auth config to set `refresh_interval_ms` to zero, builds the manager, calls `auth()` twice, and asserts both returned API keys remain the initial token.

**Call relations**: This covers the no-auto-refresh configuration branch for external providers.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 1 external calls (assert_eq!).


##### `external_bearer_only_auth_manager_returns_none_when_command_fails`  (lines 591–596)

```
async fn external_bearer_only_auth_manager_returns_none_when_command_fails()
```

**Purpose**: Verifies that an external bearer-only manager yields no auth when the provider command exits unsuccessfully.

**Data flow**: Creates a failing provider script, builds the manager from its config, calls `manager.auth().await`, and asserts the result is `None`.

**Call relations**: This covers the provider-command failure path.

*Call graph*: calls 2 internal fn (new_failing, external_bearer_only); 1 external calls (assert_eq!).


##### `unauthorized_recovery_uses_external_refresh_for_bearer_manager`  (lines 599–626)

```
async fn unauthorized_recovery_uses_external_refresh_for_bearer_manager()
```

**Purpose**: Verifies that unauthorized recovery for an external bearer-only manager performs an external refresh step and updates cached auth state.

**Data flow**: Creates a provider script that emits `provider-token` then `refreshed-provider-token`, disables auto-refresh, builds the manager, captures the initial token, obtains `unauthorized_recovery`, asserts it has a next step named `external_refresh` in `external` mode, awaits `next()`, asserts `auth_state_changed() == Some(true)`, then reads auth again and confirms the token changed to the refreshed value.

**Call relations**: This tests the external unauthorized-recovery flow rather than the managed OAuth refresh path.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 2 external calls (assert!, assert_eq!).


##### `ProviderAuthScript::new`  (lines 635–701)

```
fn new(tokens: &[&str]) -> std::io::Result<Self>
```

**Purpose**: Creates a temporary platform-specific script that prints the first token from a file and rotates the remaining tokens forward on each invocation.

**Data flow**: Creates a tempdir and `tokens.txt`, writes the provided token list with platform-appropriate line endings, then on Unix writes an executable `print-token.sh` that prints the first line and rewrites the file without it; on Windows writes a `print-token.cmd` with equivalent behavior and command-line wrapper args. Returns `ProviderAuthScript { tempdir, command, args }`.

**Call relations**: Used by external-provider tests that need deterministic token rotation across repeated command executions.

*Call graph*: called by 3 (external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero, external_bearer_only_auth_manager_uses_cached_provider_token, unauthorized_recovery_uses_external_refresh_for_bearer_manager); 8 external calls (new, new, cfg!, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthScript::new_failing`  (lines 703–740)

```
fn new_failing() -> std::io::Result<Self>
```

**Purpose**: Creates a temporary platform-specific script or command that always exits with failure.

**Data flow**: Creates a tempdir, writes an executable Unix `fail.sh` or configures a Windows `cmd.exe` invocation that exits 1, and returns the resulting `ProviderAuthScript`.

**Call relations**: Used by the external-provider failure test to simulate a broken auth command.

*Call graph*: called by 1 (external_bearer_only_auth_manager_returns_none_when_command_fails); 6 external calls (new, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthScript::auth_config`  (lines 742–753)

```
fn auth_config(&self) -> ModelProviderAuthInfo
```

**Purpose**: Builds a `ModelProviderAuthInfo` configuration object pointing at the temporary provider script.

**Data flow**: Serializes a JSON object containing `command`, `args`, `timeout_ms`, `refresh_interval_ms`, and `cwd = self.tempdir.path()`, then deserializes it into `ModelProviderAuthInfo` with `serde_json::from_value`.

**Call relations**: External-provider tests pass this config into `AuthManager::external_bearer_only`.

*Call graph*: 2 external calls (json!, from_value).


##### `write_auth_file`  (lines 762–777)

```
fn write_auth_file(params: AuthFileParams, codex_home: &Path) -> std::io::Result<String>
```

**Purpose**: Writes a realistic `auth.json` fixture containing a fake ID token, access token, refresh token, and current refresh timestamp.

**Data flow**: Builds a fake JWT from `AuthFileParams`, computes the auth file path with `get_auth_file`, constructs JSON containing optional API key, token bundle, and `Utc::now()` as `last_refresh`, pretty-serializes it, writes it to disk, and returns the fake JWT string.

**Call relations**: Many tests use this helper to seed persisted ChatGPT-style auth state before calling auth-loading or restriction-enforcement code.

*Call graph*: calls 2 internal fn (fake_jwt_for_auth_file_params, get_auth_file); called by 11 (enforce_login_restrictions_allows_any_matching_workspace_in_list, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_logs_out_for_workspace_mismatch, missing_plan_type_maps_to_unknown, plan_type_maps_enterprise_cbp_usage_based_plan, plan_type_maps_known_plan, plan_type_maps_self_serve_business_usage_based_plan, plan_type_maps_unknown_to_unknown, pro_account_with_no_api_key_uses_chatgpt_auth, refresh_failure_is_scoped_to_the_matching_auth_snapshot (+1 more)); 3 external calls (json!, to_string_pretty, write).


##### `fake_jwt_for_auth_file_params`  (lines 779–813)

```
fn fake_jwt_for_auth_file_params(params: &AuthFileParams) -> std::io::Result<String>
```

**Purpose**: Synthesizes an unsigned JWT-like string whose payload contains the requested ChatGPT metadata fields for auth-file fixtures.

**Data flow**: Builds a header `{alg:"none", typ:"JWT"}`, constructs an auth payload with fixed user IDs plus optional `chatgpt_plan_type` and `chatgpt_account_id`, wraps it in a larger payload containing email fields, base64url-encodes header, payload, and a dummy signature, and returns the three-part token string.

**Call relations**: Used only by `write_auth_file` to generate deterministic ID-token fixtures.

*Call graph*: called by 1 (write_auth_file); 4 external calls (format!, String, json!, to_vec).


##### `build_config`  (lines 815–828)

```
async fn build_config(
    codex_home: &Path,
    forced_login_method: Option<ForcedLoginMethod>,
    forced_chatgpt_workspace_id: Option<Vec<String>>,
) -> AuthConfig
```

**Purpose**: Constructs an `AuthConfig` fixture for restriction-enforcement tests.

**Data flow**: Copies the provided Codex home path into a `PathBuf` and returns `AuthConfig` with file-backed storage, direct keyring backend, the supplied forced login method and workspace list, and `chatgpt_base_url = None`.

**Call relations**: Restriction tests use this helper to avoid repeating boilerplate config construction.

*Call graph*: called by 6 (enforce_login_restrictions_allows_any_matching_workspace_in_list, enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required, enforce_login_restrictions_logs_out_for_method_mismatch, enforce_login_restrictions_logs_out_for_workspace_mismatch); 1 external calls (to_path_buf).


##### `EnvVarGuard::set`  (lines 840–846)

```
fn set(key: &'static str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while preserving its original value.

**Data flow**: Reads the original value with `env::var_os`, unsafely sets the new value, and returns `EnvVarGuard { key, original }`.

**Call relations**: Many tests use this to inject auth-related environment variables such as access tokens and auth API base URLs.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::remove`  (lines 848–854)

```
fn remove(key: &'static str) -> Self
```

**Purpose**: Temporarily removes an environment variable for a test while preserving its original value.

**Data flow**: Reads the original value with `env::var_os`, unsafely removes the variable, and returns `EnvVarGuard { key, original }`.

**Call relations**: Used heavily to ensure env-based auth does not interfere with file-based auth tests.

*Call graph*: 2 external calls (remove_var, var_os).


##### `EnvVarGuard::drop`  (lines 859–866)

```
fn drop(&mut self)
```

**Purpose**: Restores the original environment variable state when the guard is dropped.

**Data flow**: On drop, restores the saved value with `env::set_var` if one existed, otherwise removes the variable.

**Call relations**: Provides cleanup for all tests that mutate process environment.

*Call graph*: 2 external calls (remove_var, set_var).


##### `remove_access_token_env_var`  (lines 869–871)

```
fn remove_access_token_env_var() -> EnvVarGuard
```

**Purpose**: Convenience helper that removes the Codex access-token environment variable for the duration of a test.

**Data flow**: Calls `EnvVarGuard::remove(CODEX_ACCESS_TOKEN_ENV_VAR)` and returns the guard.

**Call relations**: Many tests call this first to force auth loading to use persisted state instead of env precedence.

*Call graph*: called by 17 (auth_manager_rejects_stored_personal_access_token_workspace_mismatch, enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, enforce_login_restrictions_logs_out_for_method_mismatch, enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch, enforce_login_restrictions_logs_out_for_workspace_mismatch, loads_api_key_from_auth_json, missing_auth_json_returns_none (+7 more)); 1 external calls (remove).


##### `load_auth_reads_access_token_from_env`  (lines 875–923)

```
async fn load_auth_reads_access_token_from_env()
```

**Purpose**: Verifies that an agent-identity JWT supplied via environment is loaded as agent-identity auth without writing `auth.json`.

**Data flow**: Creates a signed agent-identity JWT and mock JWKS plus task-registration endpoints, sets the access-token env var and agent-identity auth API base URL override, calls `load_auth`, pattern-matches the result as `CodexAuth::AgentIdentity`, asserts the loaded record and process task ID, and confirms no auth file was created.

**Call relations**: This covers env-precedence loading for agent-identity credentials.

*Call graph*: calls 4 internal fn (set, agent_identity_record, signed_agent_identity_jwt, test_jwks_body); 12 external calls (given, start, new, assert!, assert_eq!, format!, json!, panic!, load_auth, tempdir (+2 more)).


##### `load_auth_reads_personal_access_token_from_env`  (lines 927–979)

```
async fn load_auth_reads_personal_access_token_from_env()
```

**Purpose**: Verifies that a PAT supplied via environment loads correctly in both file and ephemeral storage modes and exposes account metadata from whoami.

**Data flow**: Mocks PAT whoami responses, sets auth API base URL and access-token env vars, loops over file and ephemeral storage modes, calls `load_auth`, and asserts auth mode, exposed token, account ID, user ID, email, plan type, and FedRAMP flag. It also confirms no auth file was written.

**Call relations**: This covers env-precedence loading for PAT credentials across storage modes.

*Call graph*: calls 3 internal fn (set, default, personal_access_token_whoami); 10 external calls (given, start, new, assert!, assert_eq!, load_auth, tempdir, header, method, path).


##### `auth_manager_rejects_env_personal_access_token_workspace_mismatch`  (lines 983–1013)

```
async fn auth_manager_rejects_env_personal_access_token_workspace_mismatch()
```

**Purpose**: Verifies that `AuthManager` refuses to expose env-sourced PAT auth when the token's workspace is outside the allowed list.

**Data flow**: Mocks whoami with a disallowed workspace, sets auth API base URL and access-token env vars, constructs an `AuthManager` with workspace restriction, calls `manager.auth().await`, and asserts it returns `None`.

**Call relations**: This tests workspace filtering at manager load time for env PATs.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new_with_workspace_restriction); 9 external calls (given, start, new, assert_eq!, tempdir, vec!, header, method, path).


##### `auth_manager_rejects_stored_personal_access_token_workspace_mismatch`  (lines 1017–1065)

```
async fn auth_manager_rejects_stored_personal_access_token_workspace_mismatch()
```

**Purpose**: Verifies that stored PAT auth is also filtered out by `AuthManager` when workspace restrictions do not match.

**Data flow**: Mocks whoami with a disallowed workspace, removes the access-token env var, loops over file and ephemeral storage modes, logs in with the PAT to seed storage, constructs a restricted `AuthManager`, and asserts `manager.auth().await` is `None` in each mode.

**Call relations**: This is the persisted counterpart to the env PAT workspace-mismatch test.

*Call graph*: calls 5 internal fn (set, default, personal_access_token_whoami, remove_access_token_env_var, new_with_workspace_restriction); 10 external calls (given, start, new, assert_eq!, login_with_access_token, tempdir, vec!, header, method, path).


##### `personal_access_token_does_not_offer_unauthorized_recovery`  (lines 1069–1104)

```
async fn personal_access_token_does_not_offer_unauthorized_recovery()
```

**Purpose**: Verifies that PAT-based auth does not expose unauthorized-recovery steps and that refresh attempts are effectively no-ops.

**Data flow**: Mocks PAT whoami, sets env vars, constructs an `AuthManager`, obtains `unauthorized_recovery`, asserts `has_next()` is false and `unavailable_reason()` is `not_refreshable_auth`, then calls `refresh_token_from_authority()` expecting success.

**Call relations**: This checks that PAT auth is treated as non-refreshable in recovery logic.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new); 9 external calls (new, given, start, new, assert!, assert_eq!, tempdir, method, path).


##### `load_auth_keeps_codex_api_key_env_precedence`  (lines 1108–1128)

```
async fn load_auth_keeps_codex_api_key_env_precedence()
```

**Purpose**: Verifies that when both an access token and `CODEX_API_KEY` are present, the API key wins if env API-key loading is enabled.

**Data flow**: Creates a fake agent-identity JWT, sets both access-token and API-key env vars, calls `load_auth` with `enable_codex_api_key_env = true`, and asserts the resulting auth exposes `sk-env` as the API key.

**Call relations**: This covers precedence ordering between two environment-based auth sources.

*Call graph*: calls 3 internal fn (set, agent_identity_record, fake_agent_identity_jwt); 3 external calls (assert_eq!, load_auth, tempdir).


##### `enforce_login_restrictions_logs_out_for_method_mismatch`  (lines 1132–1158)

```
async fn enforce_login_restrictions_logs_out_for_method_mismatch()
```

**Purpose**: Verifies that enforcing a required ChatGPT login method logs out stored API-key auth and returns an explanatory error.

**Data flow**: Seeds API-key auth in a temp home, builds an `AuthConfig` requiring `ForcedLoginMethod::Chatgpt`, calls `enforce_login_restrictions`, asserts the error mentions ChatGPT login being required, and confirms `auth.json` was removed.

**Call relations**: This tests restriction enforcement's method-mismatch branch and its logout side effect.

*Call graph*: calls 3 internal fn (default, build_config, remove_access_token_env_var); 3 external calls (assert!, enforce_login_restrictions, tempdir).


##### `enforce_login_restrictions_logs_out_for_workspace_mismatch`  (lines 1162–1193)

```
async fn enforce_login_restrictions_logs_out_for_workspace_mismatch()
```

**Purpose**: Verifies that stored ChatGPT auth is logged out when its workspace ID is not in the allowed list.

**Data flow**: Writes an auth file whose fake JWT contains a disallowed workspace ID, builds an `AuthConfig` with a single allowed workspace, calls `enforce_login_restrictions`, asserts the error mentions the allowed workspace list, and confirms `auth.json` was removed.

**Call relations**: This covers workspace restriction enforcement for stored ChatGPT-token auth.

*Call graph*: calls 3 internal fn (build_config, remove_access_token_env_var, write_auth_file); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch`  (lines 1197–1242)

```
async fn enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch()
```

**Purpose**: Verifies that stored PAT auth is logged out when workspace restrictions no longer match.

**Data flow**: Mocks PAT whoami with a disallowed workspace, removes the access-token env var, logs in with the PAT to seed storage, constructs an `AuthConfig` with an allowed workspace list, calls `enforce_login_restrictions`, asserts the error mentions the current disallowed workspace, and confirms `auth.json` was removed.

**Call relations**: This is the PAT-specific restriction-enforcement test.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, remove_access_token_env_var); 10 external calls (given, start, new, assert!, enforce_login_restrictions, login_with_access_token, tempdir, vec!, method, path).


##### `enforce_login_restrictions_allows_matching_workspace`  (lines 1246–1273)

```
async fn enforce_login_restrictions_allows_matching_workspace()
```

**Purpose**: Verifies that restriction enforcement succeeds and preserves `auth.json` when stored ChatGPT auth belongs to an allowed workspace.

**Data flow**: Writes an auth file with an allowed workspace ID, builds a matching `AuthConfig`, calls `enforce_login_restrictions`, and asserts the auth file still exists.

**Call relations**: This is the positive counterpart to workspace-mismatch logout for stored ChatGPT auth.

*Call graph*: calls 3 internal fn (build_config, remove_access_token_env_var, write_auth_file); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_allows_any_matching_workspace_in_list`  (lines 1277–1302)

```
async fn enforce_login_restrictions_allows_any_matching_workspace_in_list()
```

**Purpose**: Verifies that restriction enforcement accepts auth when any one workspace in the allowed list matches the stored workspace.

**Data flow**: Writes an auth file with `WORKSPACE_ID_ALLOWED`, builds an `AuthConfig` whose allowed list contains a different workspace plus the matching one, and asserts `enforce_login_restrictions` succeeds.

**Call relations**: This checks list-membership semantics rather than exact single-value matching.

*Call graph*: calls 2 internal fn (build_config, write_auth_file); 3 external calls (enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch`  (lines 1306–1366)

```
async fn enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch()
```

**Purpose**: Verifies that stored agent-identity auth is logged out when its account/workspace ID is outside the allowed list.

**Data flow**: Creates a signed agent-identity JWT for a disallowed workspace, mocks JWKS and task registration, removes the access-token env var, seeds storage with `save_auth`, builds an `AuthConfig` containing the mock ChatGPT base URL and allowed workspace list, calls `enforce_login_restrictions`, asserts the error mentions the disallowed workspace, and confirms `auth.json` was removed.

**Call relations**: This covers workspace restriction enforcement for persisted agent-identity auth.

*Call graph*: calls 6 internal fn (set, default, agent_identity_record, remove_access_token_env_var, signed_agent_identity_jwt, test_jwks_body); 11 external calls (given, start, new, assert!, format!, json!, enforce_login_restrictions, tempdir, vec!, method (+1 more)).


##### `enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set`  (lines 1370–1396)

```
async fn enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set()
```

**Purpose**: Verifies that API-key auth is still allowed when only workspace restrictions are configured and no forced login method is set.

**Data flow**: Seeds API-key auth, removes the access-token env var, builds an `AuthConfig` with `forced_login_method = None` and a workspace list, calls `enforce_login_restrictions`, and asserts the auth file remains.

**Call relations**: This tests that workspace restrictions do not implicitly ban API-key auth unless a ChatGPT login method is explicitly required.

*Call graph*: calls 3 internal fn (default, build_config, remove_access_token_env_var); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required`  (lines 1400–1419)

```
async fn enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required()
```

**Purpose**: Verifies that an environment API key does not satisfy a forced ChatGPT login requirement.

**Data flow**: Sets `CODEX_API_KEY`, removes the access-token env var, builds an `AuthConfig` requiring ChatGPT login, calls `enforce_login_restrictions`, and asserts the error message explains that an API key is currently being used.

**Call relations**: This covers restriction enforcement against env-sourced API-key auth.

*Call graph*: calls 3 internal fn (set, build_config, remove_access_token_env_var); 3 external calls (assert!, enforce_login_restrictions, tempdir).


##### `agent_identity_record`  (lines 1421–1433)

```
fn agent_identity_record(account_id: &str) -> AgentIdentityAuthRecord
```

**Purpose**: Builds a realistic `AgentIdentityAuthRecord` fixture with generated key material and supplied account/workspace ID.

**Data flow**: Calls `codex_agent_identity::generate_agent_key_material`, then constructs and returns `AgentIdentityAuthRecord` with fixed runtime ID, generated private key, supplied account ID, fixed user/email values, `AccountPlanType::Pro`, and `chatgpt_account_is_fedramp = false`.

**Call relations**: Many agent-identity tests use this helper as the canonical source record before generating JWTs.

*Call graph*: called by 6 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_keeps_codex_api_key_env_precedence, load_auth_reads_access_token_from_env, login_with_access_token_rejects_unsigned_jwt, login_with_access_token_writes_only_token); 1 external calls (generate_agent_key_material).


##### `fake_agent_identity_jwt`  (lines 1435–1437)

```
fn fake_agent_identity_jwt(record: &AgentIdentityAuthRecord) -> std::io::Result<String>
```

**Purpose**: Creates an unsigned JWT-like agent-identity token using the record's actual plan type.

**Data flow**: Serializes `record.plan_type` to JSON and forwards to `fake_agent_identity_jwt_with_plan_type`, returning its string result.

**Call relations**: Used by tests that need a structurally correct but unsigned token to verify rejection paths.

*Call graph*: calls 1 internal fn (fake_agent_identity_jwt_with_plan_type); called by 2 (load_auth_keeps_codex_api_key_env_precedence, login_with_access_token_rejects_unsigned_jwt); 1 external calls (to_value).


##### `fake_agent_identity_jwt_with_plan_type`  (lines 1439–1461)

```
fn fake_agent_identity_jwt_with_plan_type(
    record: &AgentIdentityAuthRecord,
    plan_type: serde_json::Value,
) -> std::io::Result<String>
```

**Purpose**: Synthesizes an unsigned JWT-like agent-identity token with a caller-specified plan-type JSON value.

**Data flow**: Builds a fixed EdDSA-style header, constructs a payload containing issuer/audience/timestamps plus all record fields and the supplied `plan_type`, base64url-encodes header, payload, and a dummy signature, and returns the three-part token string.

**Call relations**: This is the low-level helper behind unsigned agent-identity JWT fixtures.

*Call graph*: called by 1 (fake_agent_identity_jwt); 3 external calls (format!, json!, to_vec).


##### `signed_agent_identity_jwt`  (lines 1463–1486)

```
fn signed_agent_identity_jwt(
    record: &AgentIdentityAuthRecord,
    plan_type: serde_json::Value,
) -> jsonwebtoken::errors::Result<String>
```

**Purpose**: Creates a properly signed RSA agent-identity JWT fixture using the embedded test private key and a caller-specified plan-type claim.

**Data flow**: Builds a `jsonwebtoken::Header` with algorithm `RS256` and `kid = test-key`, constructs the payload JSON from the record plus supplied plan type, loads an `EncodingKey` from the embedded PEM, and returns the encoded JWT.

**Call relations**: Used by positive-path agent-identity tests and plan-type alias tests that require signature verification to succeed.

*Call graph*: called by 4 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_reads_access_token_from_env, login_with_access_token_writes_only_token); 4 external calls (json!, from_rsa_pem, new, encode).


##### `test_jwks_body`  (lines 1488–1499)

```
fn test_jwks_body() -> serde_json::Value
```

**Purpose**: Returns the JWKS document corresponding to the embedded RSA private key used for signed agent-identity JWT fixtures.

**Data flow**: Constructs and returns a `serde_json::Value` containing one RSA JWK with `kid = test-key`, modulus `n`, and exponent `e`.

**Call relations**: Mock JWKS endpoints use this helper so JWT verification can succeed in tests.

*Call graph*: called by 5 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_reads_access_token_from_env, login_with_access_token_rejects_unsigned_jwt, login_with_access_token_writes_only_token); 1 external calls (json!).


##### `personal_access_token_whoami`  (lines 1501–1509)

```
fn personal_access_token_whoami(account_id: &str) -> serde_json::Value
```

**Purpose**: Builds a mock whoami response body for personal access token validation.

**Data flow**: Returns JSON containing fixed email and user ID plus the supplied `chatgpt_account_id`, `chatgpt_plan_type = business`, and `chatgpt_account_is_fedramp = true`.

**Call relations**: PAT login, loading, and restriction tests use this helper to keep mock auth API responses consistent.

*Call graph*: called by 7 (auth_manager_rejects_env_personal_access_token_workspace_mismatch, auth_manager_rejects_stored_personal_access_token_workspace_mismatch, enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch, load_auth_reads_personal_access_token_from_env, login_with_access_token_rejects_personal_access_token_workspace_mismatch, login_with_access_token_writes_only_personal_access_token, personal_access_token_does_not_offer_unauthorized_recovery); 1 external calls (json!).


##### `agent_identity_plan_type_maps_raw_enterprise_alias`  (lines 1542–1544)

```
async fn agent_identity_plan_type_maps_raw_enterprise_alias()
```

**Purpose**: Verifies that the raw agent-identity plan-type alias `hc` maps to `AccountPlanType::Enterprise`.

**Data flow**: Calls `assert_agent_identity_plan_alias` with JSON string `hc` and expected `Enterprise`.

**Call relations**: This is a thin wrapper around the shared alias-assertion helper.

*Call graph*: calls 1 internal fn (assert_agent_identity_plan_alias); 1 external calls (json!).


##### `agent_identity_plan_type_maps_raw_education_alias`  (lines 1548–1550)

```
async fn agent_identity_plan_type_maps_raw_education_alias()
```

**Purpose**: Verifies that the raw agent-identity plan-type alias `education` maps to `AccountPlanType::Edu`.

**Data flow**: Calls `assert_agent_identity_plan_alias` with JSON string `education` and expected `Edu`.

**Call relations**: This is the second alias-specific wrapper around the shared helper.

*Call graph*: calls 1 internal fn (assert_agent_identity_plan_alias); 1 external calls (json!).


##### `assert_agent_identity_plan_alias`  (lines 1552–1582)

```
async fn assert_agent_identity_plan_alias(
    plan_type: serde_json::Value,
    expected_plan_type: AccountPlanType,
)
```

**Purpose**: Shared helper that verifies a signed agent-identity JWT with a given raw `plan_type` claim is interpreted as the expected internal account plan type.

**Data flow**: Creates an agent-identity record, signs a JWT with the supplied `plan_type` JSON, serves JWKS and task-registration responses from a mock backend, sets the agent-identity auth API base URL override, calls `CodexAuth::from_agent_identity_jwt`, and asserts the resulting auth reports the expected `account_plan_type()`.

**Call relations**: Both alias-specific tests delegate here to avoid duplicating JWT and mock-server setup.

*Call graph*: calls 5 internal fn (set, agent_identity_record, signed_agent_identity_jwt, test_jwks_body, from_agent_identity_jwt); called by 2 (agent_identity_plan_type_maps_raw_education_alias, agent_identity_plan_type_maps_raw_enterprise_alias); 8 external calls (given, start, new, format!, json!, assert_eq!, method, path).


##### `plan_type_maps_known_plan`  (lines 1586–1612)

```
async fn plan_type_maps_known_plan()
```

**Purpose**: Verifies that a stored ChatGPT ID token with `chatgpt_plan_type = pro` maps to `AccountPlanType::Pro`.

**Data flow**: Writes an auth file with plan type `pro`, removes the access-token env var, loads auth, and asserts `account_plan_type()` returns `Some(AccountPlanType::Pro)`.

**Call relations**: This is the baseline stored-token plan-type mapping test.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_self_serve_business_usage_based_plan`  (lines 1616–1645)

```
async fn plan_type_maps_self_serve_business_usage_based_plan()
```

**Purpose**: Verifies mapping of the stored plan-type string `self_serve_business_usage_based` to the corresponding internal enum variant.

**Data flow**: Writes an auth file with that plan-type string, removes the access-token env var, loads auth, and asserts `account_plan_type()` equals `Some(AccountPlanType::SelfServeBusinessUsageBased)`.

**Call relations**: This covers one of the specialized usage-based plan mappings.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_enterprise_cbp_usage_based_plan`  (lines 1649–1678)

```
async fn plan_type_maps_enterprise_cbp_usage_based_plan()
```

**Purpose**: Verifies mapping of the stored plan-type string `enterprise_cbp_usage_based` to the corresponding internal enum variant.

**Data flow**: Writes an auth file with that plan-type string, removes the access-token env var, loads auth, and asserts `account_plan_type()` equals `Some(AccountPlanType::EnterpriseCbpUsageBased)`.

**Call relations**: This covers another specialized usage-based plan mapping.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_unknown_to_unknown`  (lines 1682–1708)

```
async fn plan_type_maps_unknown_to_unknown()
```

**Purpose**: Verifies that an unrecognized stored plan-type string maps to `AccountPlanType::Unknown`.

**Data flow**: Writes an auth file with `chatgpt_plan_type = mystery-tier`, removes the access-token env var, loads auth, and asserts `account_plan_type()` is `Some(AccountPlanType::Unknown)`.

**Call relations**: This covers the fallback branch for unknown stored plan types.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `missing_plan_type_maps_to_unknown`  (lines 1712–1738)

```
async fn missing_plan_type_maps_to_unknown()
```

**Purpose**: Verifies that absence of a stored plan-type claim also maps to `AccountPlanType::Unknown`.

**Data flow**: Writes an auth file with no `chatgpt_plan_type`, removes the access-token env var, loads auth, and asserts `account_plan_type()` is `Some(AccountPlanType::Unknown)`.

**Call relations**: This covers the missing-claim branch of stored plan-type mapping.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


### `login/src/auth/bedrock_api_key_tests.rs`

`test` · `test execution`

This test file verifies that Bedrock credentials behave as a first-class auth mode in storage and in `AuthManager`. It starts with small fixture builders that produce exact `AuthDotJson` snapshots for OpenAI API-key auth, a Bedrock-only payload lacking an explicit `auth_mode`, and the reusable `BedrockApiKeyAuth` value used in assertions. Those fixtures let the tests check both explicit writes and backward-compatible mode inference.

The async tests use temporary Codex home directories and `FileAuthStorage` so each scenario operates on isolated on-disk state. One test confirms that calling `login_with_bedrock_api_key` overwrites an existing OpenAI API-key record, updates `auth_mode` to `BedrockApiKey`, and causes `AuthManager::new` to cache `CodexAuth::BedrockApiKey`. Another verifies that `AuthManager::logout` removes the stored file and clears the in-memory cache. A third checks that if storage contains only the `bedrock_api_key` field with `auth_mode: None`, manager initialization still resolves the primary auth mode as Bedrock. The final test confirms the inverse replacement path: a later OpenAI API-key login clears the Bedrock field entirely. Together these tests pin down the invariant that only one primary auth mechanism should remain serialized at a time.

#### Function details

##### `api_key_auth`  (lines 14–24)

```
fn api_key_auth() -> AuthDotJson
```

**Purpose**: Creates the canonical `AuthDotJson` fixture for plain OpenAI API-key auth. The fixture is used to seed storage and to compare expected replacement behavior.

**Data flow**: It takes no arguments and returns a newly constructed `AuthDotJson` with `auth_mode` set to `Some(AuthMode::ApiKey)`, `openai_api_key` populated with a fixed test key, and every token- or Bedrock-related field set to `None`.

**Call relations**: This helper is consumed by the replacement test to pre-populate storage with non-Bedrock auth before invoking the Bedrock login path.

*Call graph*: called by 1 (login_with_bedrock_api_key_replaces_openai_auth).


##### `bedrock_only_auth`  (lines 26–36)

```
fn bedrock_only_auth() -> AuthDotJson
```

**Purpose**: Builds a storage fixture that contains only the Bedrock credential field and omits explicit `auth_mode`. It exists to verify mode inference during auth loading.

**Data flow**: It takes no inputs, calls `bedrock_auth` to obtain the nested credential payload, and returns an `AuthDotJson` whose `bedrock_api_key` is `Some(...)` while all other auth fields, including `auth_mode`, are `None`.

**Call relations**: The mode-inference test writes this fixture directly to storage, then initializes `AuthManager` to confirm that downstream loading resolves it as Bedrock auth.

*Call graph*: calls 1 internal fn (bedrock_auth); called by 1 (bedrock_only_auth_storage_creates_primary_auth).


##### `bedrock_auth`  (lines 38–43)

```
fn bedrock_auth() -> BedrockApiKeyAuth
```

**Purpose**: Returns the reusable Bedrock credential fixture used across tests. It centralizes the exact API key and region strings expected in assertions.

**Data flow**: It has no inputs and returns a `BedrockApiKeyAuth` with fixed `api_key` and `region` values as owned strings.

**Call relations**: Other fixture builders and assertions call this helper so all Bedrock comparisons use the same concrete payload.

*Call graph*: called by 2 (bedrock_only_auth, login_with_bedrock_api_key_replaces_openai_auth).


##### `login_with_bedrock_api_key_replaces_openai_auth`  (lines 47–92)

```
async fn login_with_bedrock_api_key_replaces_openai_auth() -> anyhow::Result<()>
```

**Purpose**: Verifies that a Bedrock login fully replaces previously stored OpenAI API-key auth and that `AuthManager` exposes the new mode and cached variant correctly.

**Data flow**: The test creates a temporary Codex home, instantiates `FileAuthStorage`, saves the `api_key_auth` fixture, then calls `login_with_bedrock_api_key` with file-backed storage settings. After asynchronously constructing an `AuthManager`, it loads the raw stored auth from disk and compares it to an expected `AuthDotJson` containing only Bedrock fields; it also inspects `auth_manager.auth_mode()` and pattern-matches `auth_manager.auth_cached()` to extract the `CodexAuth::BedrockApiKey` payload. It returns `anyhow::Result<()>`, propagating setup failures with `?`.

**Call relations**: This test drives the full write-then-load path: fixture creation seeds old auth, the Bedrock login helper overwrites it, and `AuthManager::new` reconstructs the runtime auth snapshot from storage.

*Call graph*: calls 5 internal fn (default, api_key_auth, bedrock_auth, new, new); 2 external calls (assert_eq!, tempdir).


##### `logout_removes_bedrock_auth`  (lines 96–120)

```
async fn logout_removes_bedrock_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that manager logout deletes persisted Bedrock credentials and clears the manager’s cached auth state.

**Data flow**: It creates a temporary home and file storage, writes Bedrock auth via `login_with_bedrock_api_key`, then initializes `AuthManager`. The test awaits `auth_manager.logout()`, asserts the call returned true, then verifies `storage.load()?` is `None` and `auth_manager.auth_cached()` is also `None`.

**Call relations**: The test covers the interaction between Bedrock-auth storage and the generic logout path implemented by `AuthManager`, ensuring Bedrock mode participates in the same deletion semantics as other auth types.

*Call graph*: calls 3 internal fn (default, new, new); 3 external calls (assert!, assert_eq!, tempdir).


##### `bedrock_only_auth_storage_creates_primary_auth`  (lines 124–151)

```
async fn bedrock_only_auth_storage_creates_primary_auth() -> anyhow::Result<()>
```

**Purpose**: Ensures that a stored payload with only `bedrock_api_key` and no explicit mode still becomes active Bedrock auth when loaded.

**Data flow**: It creates a temporary home and file storage, saves the `bedrock_only_auth` fixture directly, then awaits `AuthManager::new`. The assertions check both the top-level mode (`Some(AuthMode::BedrockApiKey)`) and the cached enum variant by matching `CodexAuth::BedrockApiKey` and comparing the inner value to `bedrock_auth()`.

**Call relations**: This test specifically exercises the manager’s auth-loading logic rather than the Bedrock login helper, proving that `AuthDotJson` mode resolution treats the dedicated Bedrock field as authoritative.

*Call graph*: calls 4 internal fn (default, bedrock_only_auth, new, new); 2 external calls (assert_eq!, tempdir).


##### `login_with_api_key_clears_bedrock_api_key`  (lines 154–174)

```
async fn login_with_api_key_clears_bedrock_api_key() -> anyhow::Result<()>
```

**Purpose**: Verifies the reverse replacement path: switching to OpenAI API-key auth removes any previously stored Bedrock credentials.

**Data flow**: The test creates a temporary home and file storage, writes Bedrock auth first, then calls `crate::auth::login_with_api_key` with a test OpenAI key. It finally loads storage and asserts the result equals `Some(api_key_auth())`.

**Call relations**: This scenario complements the Bedrock replacement test by proving that the shared auth-writing helpers always serialize a single active auth mode, regardless of which mode was stored first.

*Call graph*: calls 2 internal fn (default, new); 3 external calls (assert_eq!, login_with_api_key, tempdir).


### Login journey integrations
These integration tests cover the main user login entry points, from CLI invocation through device-code and browser-based server flows.

### `cli/tests/login.rs`

`test` · `authentication flows`

This file tests authentication-related CLI behavior against both local files and a mocked OAuth/device-auth server. The shared `codex_command` helper launches the compiled binary under a temporary `CODEX_HOME`; `write_file_auth_config` forces credential storage into `auth.json` by writing `cli_auth_credentials_store = "file"` to `config.toml`; and `read_auth_json` parses the resulting auth file into `serde_json::Value` for assertions. The API-key test feeds `sk-test` on stdin to `login --with-api-key` while forcing the API login method via `-c forced_login_method="api"`, then verifies `auth.json` contains `OPENAI_API_KEY` and omits token and agent identity fields. The invalid access-token test sends `not-a-jwt` to `login --with-access-token` and checks for a failure message. The async device-auth test is more involved: it starts a `wiremock::MockServer`, mounts expected POST handlers for revoke, user-code, device token, and OAuth token endpoints, seeds `auth.json` with existing refresh credentials, overrides the revoke URL via `REVOKE_TOKEN_URL_OVERRIDE_ENV_VAR`, clears ambient auth env vars, runs `login --device-auth --experimental_issuer <issuer>`, then inspects received requests to prove revocation happened first and with the expected JSON body containing `CLIENT_ID`. Finally it confirms the stored refresh token was replaced with the new one.

#### Function details

##### `codex_command`  (lines 18–22)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Builds an `assert_cmd::Command` for the `codex` binary and scopes it to a temporary home directory.

**Data flow**: Takes `codex_home`, resolves the executable path with `cargo_bin`, creates the command, sets `CODEX_HOME`, and returns the configured subprocess handle.

**Call relations**: All three login scenario tests call this helper before adding login-specific arguments and environment overrides.

*Call graph*: called by 3 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_access_token_rejects_invalid_jwt, login_with_api_key_reads_stdin_and_writes_auth_json); 2 external calls (new, cargo_bin).


##### `write_file_auth_config`  (lines 24–30)

```
fn write_file_auth_config(codex_home: &Path) -> Result<()>
```

**Purpose**: Configures the test home directory to store CLI auth credentials in a file-backed `auth.json`.

**Data flow**: Accepts the `codex_home` path, joins `config.toml`, writes the single-line TOML setting `cli_auth_credentials_store = "file"`, and returns `Ok(())` on success.

**Call relations**: Each login test invokes this helper during setup so subsequent login commands persist credentials to disk in a predictable location that the tests can inspect.

*Call graph*: called by 3 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_access_token_rejects_invalid_jwt, login_with_api_key_reads_stdin_and_writes_auth_json); 2 external calls (join, write).


##### `read_auth_json`  (lines 32–35)

```
fn read_auth_json(codex_home: &Path) -> Result<Value>
```

**Purpose**: Loads and parses the `auth.json` file produced by login commands for assertion-friendly inspection.

**Data flow**: Takes `codex_home`, reads `auth.json` as a string from disk, parses it with `serde_json::from_str` into `serde_json::Value`, and returns that value.

**Call relations**: The API-key and device-auth tests call this helper after successful login to verify the exact persisted authentication fields.

*Call graph*: called by 2 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_api_key_reads_stdin_and_writes_auth_json); 3 external calls (join, from_str, read_to_string).


##### `login_with_api_key_reads_stdin_and_writes_auth_json`  (lines 38–60)

```
fn login_with_api_key_reads_stdin_and_writes_auth_json() -> Result<()>
```

**Purpose**: Verifies that API-key login reads the key from stdin, succeeds, and writes only the API-key-based auth fields to `auth.json`.

**Data flow**: Creates a temp home, writes file-auth config, builds a command with `codex_command`, runs `-c forced_login_method="api" login --with-api-key`, writes `sk-test` to stdin, asserts success and a success message on stderr, reads `auth.json` via `read_auth_json`, and checks that `OPENAI_API_KEY` equals `sk-test` while `tokens` and `agent_identity` are absent.

**Call relations**: This test combines both local helpers: `write_file_auth_config` establishes file persistence and `read_auth_json` validates the result. It exercises the stdin-driven API login branch of the CLI.

*Call graph*: calls 3 internal fn (codex_command, read_auth_json, write_file_auth_config); 4 external calls (new, assert!, assert_eq!, contains).


##### `login_with_access_token_rejects_invalid_jwt`  (lines 63–75)

```
fn login_with_access_token_rejects_invalid_jwt() -> Result<()>
```

**Purpose**: Ensures that the access-token login path rejects malformed JWT input and reports an error.

**Data flow**: Creates a temp home, writes file-auth config, constructs a command with `codex_command`, runs `login --with-access-token`, sends `not-a-jwt` on stdin, and asserts command failure with stderr containing `Error logging in with access token`.

**Call relations**: This test uses the shared command and config helpers but does not inspect `auth.json`, because the expected behavior is early validation failure before any credentials are persisted.

*Call graph*: calls 2 internal fn (codex_command, write_file_auth_config); 2 external calls (new, contains).


##### `device_login_revokes_existing_auth_before_requesting_new_tokens`  (lines 78–176)

```
async fn device_login_revokes_existing_auth_before_requesting_new_tokens() -> Result<()>
```

**Purpose**: Checks that device-auth login revokes an existing refresh token before starting the new device-auth exchange, then stores the newly issued tokens.

**Data flow**: Starts a `wiremock::MockServer`, mounts four POST mocks for `/oauth/revoke`, `/api/accounts/deviceauth/usercode`, `/api/accounts/deviceauth/token`, and `/oauth/token` with fixed JSON responses, creates a temp home, writes file-auth config, seeds `auth.json` with existing ChatGPT-mode tokens including `old-refresh`, builds a command with `codex_command`, sets the revoke URL override and no-proxy env vars, removes ambient token env vars, runs `login --device-auth --experimental_issuer <issuer>`, asserts success, fetches all received mock requests, extracts their URL paths to assert exact ordering, parses the first request body as JSON to assert it contains the old refresh token and `CLIENT_ID`, then reads `auth.json` and asserts the stored refresh token is now `new-refresh`.

**Call relations**: This is the most comprehensive test in the file. It uses `write_file_auth_config` and `read_auth_json` for local state, `codex_command` for process setup, and wiremock to stand in for the remote issuer. Its core role is to validate cross-step sequencing: revoke first, then device-auth endpoints, then token exchange, followed by persisted credential replacement.

*Call graph*: calls 3 internal fn (codex_command, read_auth_json, write_file_auth_config); 12 external calls (given, start, new, new, assert_eq!, format!, json!, contains, to_vec, write (+2 more)).


### `login/tests/suite/device_code_login.rs`

`test` · `integration test execution`

This suite drives `run_device_code_login` through realistic HTTP interactions using WireMock. The helpers model each stage of the device flow: `mock_usercode_success` and `mock_usercode_failure` control the initial `/api/accounts/deviceauth/usercode` response; `mock_poll_token_two_step` simulates polling `/api/accounts/deviceauth/token` where the first attempt fails (typically 404 to indicate not ready) and the second returns authorization-code material; `mock_poll_token_single` injects a one-shot polling response for error cases; and `mock_oauth_token_single` returns final OAuth tokens including an ID token JWT. `make_jwt` creates unsigned JWTs with namespaced OpenAI auth claims so tests can control `chatgpt_account_id`. `server_opts` centralizes `ServerOptions` construction with a temp Codex home, issuer override, disabled browser launch, and chosen credential-store mode. The success path verifies that auth.json is written with access token, refresh token, raw ID token, and extracted `account_id`. Workspace mismatch tests set `forced_chatgpt_workspace_id` and confirm login fails with `PermissionDenied` and no auth.json. Additional tests ensure HTTP failures from the user-code endpoint bubble up clearly, successful login can persist tokens even without any API-key exchange, and polling error payloads prevent auth persistence. All tests are gated by `skip_if_no_network!` despite using local mock servers, matching the suite's broader environment expectations.

#### Function details

##### `make_jwt`  (lines 30–36)

```
fn make_jwt(payload: serde_json::Value) -> String
```

**Purpose**: Constructs a minimal unsigned JWT from an arbitrary JSON payload for device-login tests.

**Data flow**: Accepts `serde_json::Value` payload → serializes a fixed `{alg:"none", typ:"JWT"}` header and the payload → base64url-no-pad encodes header, payload, and `sig` → formats and returns the JWT string.

**Call relations**: Used by tests that need final OAuth token responses with controlled ID-token claims, especially workspace IDs.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 3 external calls (format!, json!, to_vec).


##### `mock_usercode_success`  (lines 38–49)

```
async fn mock_usercode_success(server: &MockServer)
```

**Purpose**: Registers a successful device user-code endpoint response on the mock server.

**Data flow**: Accepts `&MockServer` → mounts a POST matcher for `/api/accounts/deviceauth/usercode` → responds with JSON containing `device_auth_id`, `user_code`, and `interval: "0"`.

**Call relations**: Called by the success and downstream-failure tests to satisfy the first step of the device-code flow without introducing polling delays.

*Call graph*: called by 4 (device_code_login_integration_handles_error_payload, device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 5 external calls (given, new, json!, method, path).


##### `mock_usercode_failure`  (lines 51–57)

```
async fn mock_usercode_failure(server: &MockServer, status: u16)
```

**Purpose**: Registers a failing user-code endpoint response with a caller-selected HTTP status.

**Data flow**: Accepts `&MockServer` and `status: u16` → mounts a POST matcher for `/api/accounts/deviceauth/usercode` → responds with that status and no body requirements.

**Call relations**: Used only by the test that verifies user-code HTTP failures bubble out of `run_device_code_login`.

*Call graph*: called by 1 (device_code_login_integration_handles_usercode_http_failure); 4 external calls (given, new, method, path).


##### `mock_poll_token_two_step`  (lines 59–82)

```
async fn mock_poll_token_two_step(
    server: &MockServer,
    counter: Arc<AtomicUsize>,
    first_response_status: u16,
)
```

**Purpose**: Simulates a polling endpoint that fails once and then succeeds on the second attempt with authorization-code material.

**Data flow**: Accepts `&MockServer`, an `Arc<AtomicUsize>` counter, and the first response status → mounts a POST matcher for `/api/accounts/deviceauth/token` → closure increments the counter and returns either the first-status response or a 200 JSON body containing `authorization_code`, `code_challenge`, and `code_verifier` → expects exactly two calls.

**Call relations**: Used by the main success-path tests to mimic the normal polling progression from not-ready to authorized.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 3 external calls (given, method, path).


##### `mock_poll_token_single`  (lines 84–90)

```
async fn mock_poll_token_single(server: &MockServer, endpoint: &str, response: ResponseTemplate)
```

**Purpose**: Registers a one-shot polling response for a specified endpoint and response template.

**Data flow**: Accepts `&MockServer`, endpoint path string, and `ResponseTemplate` → mounts a POST matcher for that path → returns the provided response.

**Call relations**: Used by the error-payload test to inject a specific polling failure without the two-step retry behavior.

*Call graph*: called by 1 (device_code_login_integration_handles_error_payload); 3 external calls (given, method, path).


##### `mock_oauth_token_single`  (lines 92–102)

```
async fn mock_oauth_token_single(server: &MockServer, jwt: String)
```

**Purpose**: Registers the final OAuth token exchange response containing an ID token plus access and refresh tokens.

**Data flow**: Accepts `&MockServer` and a JWT string → mounts a POST matcher for `/oauth/token` → responds with JSON containing cloned `id_token`, fixed `access_token`, and fixed `refresh_token`.

**Call relations**: Used by tests that drive the flow all the way through token exchange after device authorization succeeds.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 5 external calls (given, new, json!, method, path).


##### `server_opts`  (lines 104–119)

```
fn server_opts(
    codex_home: &tempfile::TempDir,
    issuer: String,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
) -> ServerOptions
```

**Purpose**: Builds a `ServerOptions` value tailored for device-code login tests.

**Data flow**: Accepts a temp Codex home, issuer URL, and credential-store mode → constructs `ServerOptions::new(...)` with fixed client id and no forced workspace → mutates `issuer` and `open_browser` fields → returns the configured options.

**Call relations**: Shared setup helper for tests that invoke `run_device_code_login` with standard defaults.

*Call graph*: calls 2 internal fn (default, new); called by 3 (device_code_login_integration_handles_usercode_http_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 1 external calls (path).


##### `device_code_login_integration_succeeds`  (lines 122–166)

```
async fn device_code_login_integration_succeeds() -> anyhow::Result<()>
```

**Purpose**: Exercises the full happy-path device-code login flow and verifies persisted token data.

**Data flow**: Creates temp home and mock server → mounts successful user-code, two-step polling, and OAuth token responses with an allowed workspace JWT → builds options via `server_opts` → runs `run_device_code_login` → loads auth.json and asserts access token, refresh token, raw ID token, and extracted `account_id`.

**Call relations**: This is the primary end-to-end success test, composing all helper mocks and then validating on-disk auth state.

*Call graph*: calls 6 internal fn (default, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success, server_opts); 9 external calls (new, new, start, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


##### `device_code_login_rejects_workspace_mismatch`  (lines 169–213)

```
async fn device_code_login_rejects_workspace_mismatch() -> anyhow::Result<()>
```

**Purpose**: Verifies that device-code login fails when the ID token's workspace/account id is not in the forced allowed list.

**Data flow**: Sets up successful user-code and polling mocks plus an OAuth token response whose JWT contains a disallowed workspace id → builds options with `forced_chatgpt_workspace_id = Some([allowed])` → runs login expecting an error → asserts `PermissionDenied` and that auth.json was not created.

**Call relations**: Exercises workspace validation after token exchange, using the same mocked flow as success but with mismatched claims.

*Call graph*: calls 6 internal fn (default, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success, server_opts); 11 external calls (new, new, start, assert!, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir (+1 more)).


##### `device_code_login_integration_handles_usercode_http_failure`  (lines 216–248)

```
async fn device_code_login_integration_handles_usercode_http_failure() -> anyhow::Result<()>
```

**Purpose**: Checks that an HTTP failure from the initial user-code request aborts login and leaves no auth.json behind.

**Data flow**: Creates temp home and mock server → mounts a failing user-code response with status 503 → builds options via `server_opts` → runs login expecting an error whose text mentions device-code request failure → loads auth.json and asserts it is absent.

**Call relations**: Covers the earliest failure point in the device-code flow before polling or token exchange begins.

*Call graph*: calls 3 internal fn (default, mock_usercode_failure, server_opts); 6 external calls (start, assert!, load_auth_dot_json, run_device_code_login, skip_if_no_network!, tempdir).


##### `device_code_login_integration_persists_without_api_key_on_exchange_failure`  (lines 251–301)

```
async fn device_code_login_integration_persists_without_api_key_on_exchange_failure() -> anyhow::Result<()>
```

**Purpose**: Ensures successful device login still persists tokens even when no API-key exchange occurs, leaving `openai_api_key` unset.

**Data flow**: Sets up successful user-code, two-step polling, and OAuth token mocks with an empty JWT payload → manually constructs `ServerOptions`, runs login, loads auth.json, asserts `openai_api_key` is `None`, and verifies persisted access token, refresh token, and raw ID token.

**Call relations**: Exercises the modern token-persistence path independent of any legacy API-key acquisition.

*Call graph*: calls 6 internal fn (default, new, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success); 10 external calls (new, new, start, assert!, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


##### `device_code_login_integration_handles_error_payload`  (lines 304–360)

```
async fn device_code_login_integration_handles_error_payload() -> anyhow::Result<()>
```

**Purpose**: Verifies that an error payload returned by the polling endpoint aborts the flow and does not persist auth.

**Data flow**: Creates temp home and mock server → mounts successful user-code plus a single polling response with HTTP 401 and `authorization_declined` payload → runs login expecting an error mentioning either the payload or status → loads auth.json and asserts it is absent.

**Call relations**: Covers a mid-flow authorization failure after user-code issuance but before OAuth token exchange.

*Call graph*: calls 4 internal fn (default, new, mock_poll_token_single, mock_usercode_success); 8 external calls (start, new, assert!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


### `login/tests/suite/login_server_e2e.rs`

`test` · `integration/end-to-end test execution`

This suite validates `run_login_server` as a live HTTP service. The helper `start_mock_issuer` binds a random localhost port, serves `/oauth/token`, and returns a JSON token payload whose `id_token` is synthesized inline with a configurable `chatgpt_account_id`; all other paths return 404. Tests then create temporary Codex homes, build `ServerOptions`, start the login server, and simulate browser callbacks with `reqwest`. The main success case seeds a stale auth.json, confirms the generated auth URL includes forced workspace restrictions, hits `/auth/callback?code=...&state=...`, waits for shutdown, and verifies auth.json was overwritten with fresh tokens and account id; it also documents the legacy behavior where `OPENAI_API_KEY` mirrors the access token. Other tests confirm the server creates a missing Codex home directory, encodes multiple forced workspace IDs as a single comma-separated `allowed_workspace_id` query parameter, and blocks login when the returned workspace id is disallowed, surfacing a `PermissionDenied` error and no auth.json. Two denial tests verify user-facing HTML/body text for `access_denied`, distinguishing the entitlement-specific `missing_codex_entitlement` copy from generic OAuth denial messaging. The final tests cover listener behavior: falling back from the default registered port to the fallback port when occupied, and canceling a previous login server instance when a new one starts on the same port.

#### Function details

##### `start_mock_issuer`  (lines 28–89)

```
fn start_mock_issuer(chatgpt_account_id: &str) -> (SocketAddr, thread::JoinHandle<()>)
```

**Purpose**: Starts a tiny local HTTP server that emulates the OAuth issuer's token endpoint and returns a JWT embedding a chosen workspace/account id.

**Data flow**: Accepts `chatgpt_account_id: &str` → binds a random localhost TCP listener, wraps it in `tiny_http::Server`, spawns a thread that serves requests, and for `/oauth/token` reads the request body, builds a JWT with email, plan `pro`, and the provided account id, then responds with JSON tokens; other paths get 404 → returns the bound socket address and thread handle.

**Call relations**: Used by all login-server tests as the upstream issuer backing `run_login_server`; it isolates callback handling from real external OAuth infrastructure.

*Call graph*: called by 8 (cancels_previous_login_server_when_port_is_in_use, creates_missing_codex_home_dir, end_to_end_login_flow_persists_auth_json, falls_back_to_registered_fallback_port_when_default_port_is_in_use, forced_chatgpt_workspace_id_mismatch_blocks_login, login_server_includes_forced_workspaces_as_one_query_param, oauth_access_denied_missing_entitlement_blocks_login_with_clear_error, oauth_access_denied_unknown_reason_uses_generic_error_page); 3 external calls (bind, spawn, from_listener).


##### `end_to_end_login_flow_persists_auth_json`  (lines 92–169)

```
async fn end_to_end_login_flow_persists_auth_json() -> Result<()>
```

**Purpose**: Runs the full browser-login callback flow and verifies stale auth.json is replaced with fresh persisted credentials.

**Data flow**: Starts mock issuer, creates temp Codex home, writes stale auth.json, builds `ServerOptions` with forced workspace restriction and fixed state, starts login server, asserts auth URL contains `allowed_workspace_id`, sends callback request with matching code/state, waits for server completion, reads auth.json, parses JSON, and asserts API key/access token/refresh token/account id values.

**Call relations**: This is the primary end-to-end success test for `run_login_server`, combining issuer emulation, callback HTTP traffic, and on-disk verification.

*Call graph*: calls 1 internal fn (start_mock_issuer); 14 external calls (assert!, assert_eq!, builder, run_login_server, limited, format!, from_str, json!, to_string_pretty, skip_if_no_network! (+4 more)).


##### `creates_missing_codex_home_dir`  (lines 172–213)

```
async fn creates_missing_codex_home_dir() -> Result<()>
```

**Purpose**: Checks that the login server creates the Codex home directory tree before writing auth.json.

**Data flow**: Starts mock issuer, chooses a non-existent subdirectory under a tempdir as `codex_home`, starts login server, sends a successful callback request, waits for completion, and asserts `codex_home/auth.json` now exists.

**Call relations**: Covers filesystem setup behavior around auth persistence rather than token contents.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 5 external calls (assert!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `login_server_includes_forced_workspaces_as_one_query_param`  (lines 216–255)

```
async fn login_server_includes_forced_workspaces_as_one_query_param() -> Result<()>
```

**Purpose**: Verifies that multiple forced workspace IDs are encoded into a single comma-separated `allowed_workspace_id` query parameter in the generated auth URL.

**Data flow**: Starts mock issuer, builds options with two allowed workspace IDs, starts login server, parses `server.auth_url` with `Url`, collects all `allowed_workspace_id` query values, and asserts there is exactly one combined value containing both IDs separated by a comma.

**Call relations**: Exercises auth-URL construction without needing to complete the callback flow.

*Call graph*: calls 1 internal fn (start_mock_issuer); 7 external calls (parse, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, vec!).


##### `forced_chatgpt_workspace_id_mismatch_blocks_login`  (lines 258–316)

```
async fn forced_chatgpt_workspace_id_mismatch_blocks_login() -> Result<()>
```

**Purpose**: Ensures the login server rejects a callback whose exchanged ID token belongs to a disallowed workspace.

**Data flow**: Starts mock issuer configured with a disallowed account id, starts login server with a single allowed workspace id, asserts auth URL contains the restriction, sends callback request, checks the HTTP body mentions the workspace restriction, awaits server completion expecting `PermissionDenied`, and asserts auth.json was not written.

**Call relations**: Covers post-exchange workspace validation and the user-visible error page/body generated by the login server.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 7 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, vec!).


##### `oauth_access_denied_missing_entitlement_blocks_login_with_clear_error`  (lines 319–385)

```
async fn oauth_access_denied_missing_entitlement_blocks_login_with_clear_error() -> Result<()>
```

**Purpose**: Verifies that an OAuth callback with `access_denied` and the known `missing_codex_entitlement` reason produces entitlement-specific guidance for the user.

**Data flow**: Starts mock issuer and login server, sends `/auth/callback` containing `state`, `error=access_denied`, and `error_description=missing_codex_entitlement`, reads the success-status HTML body, asserts it contains the Codex-access denial title and admin guidance while omitting the raw entitlement code, then awaits server completion expecting `PermissionDenied` with matching guidance and no auth.json.

**Call relations**: Exercises the denial-page mapping logic for a known OAuth error reason.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 6 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `oauth_access_denied_unknown_reason_uses_generic_error_page`  (lines 388–466)

```
async fn oauth_access_denied_unknown_reason_uses_generic_error_page() -> Result<()>
```

**Purpose**: Checks that unknown OAuth denial reasons use the generic sign-in failure page while preserving raw error details.

**Data flow**: Starts mock issuer and login server, sends callback with `error=access_denied` and `error_description=some_other_reason`, reads body text, asserts generic title/help text plus inclusion of both OAuth error code and description, then awaits server completion expecting `PermissionDenied` and no auth.json.

**Call relations**: Complements the entitlement-specific denial test by covering the generic fallback rendering path.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 6 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `falls_back_to_registered_fallback_port_when_default_port_is_in_use`  (lines 469–533)

```
async fn falls_back_to_registered_fallback_port_when_default_port_is_in_use() -> Result<()>
```

**Purpose**: Verifies that when the default login port is occupied, the server binds the registered fallback port and advertises that port in the redirect URI.

**Data flow**: Ensures the fallback port is free, binds the default port with a dummy tiny_http server, starts mock issuer, builds `ServerOptions::new` with default port behavior, calls `run_login_server`, unblocks and joins the dummy server, then asserts `actual_port == FALLBACK_LOGIN_PORT`, checks the auth URL's encoded redirect URI, cancels the server, and waits for shutdown.

**Call relations**: Exercises listener startup and port-selection logic rather than OAuth callback handling.

*Call graph*: calls 3 internal fn (default, new, start_mock_issuer); 13 external calls (new, from_secs, bind, assert!, assert_eq!, run_login_server, eprintln!, format!, skip_if_no_network!, tempdir (+3 more)).


##### `cancels_previous_login_server_when_port_is_in_use`  (lines 536–599)

```
async fn cancels_previous_login_server_when_port_is_in_use() -> Result<()>
```

**Purpose**: Checks that starting a second login server on an already-used login port cancels the first server instead of failing outright.

**Data flow**: Starts mock issuer, launches a first login server and spawns a task waiting on `block_until_done()`, sleeps briefly, starts a second login server explicitly on the first server's port, asserts it reused that port, awaits the first server task expecting an `Interrupted` cancellation error, sends `/cancel` to the second server, and asserts the second server also reports cancellation on shutdown.

**Call relations**: Covers inter-server coordination and cancellation semantics when multiple login attempts contend for the same local callback port.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 9 external calls (from_millis, assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, spawn, sleep).


### Session maintenance and logout
These tests follow authenticated state after login, validating token refresh behavior and the cleanup path that revokes and removes persisted auth on logout.

### `login/tests/suite/auth_refresh.rs`

`test` · `integration test execution`

This integration test suite models the full lifecycle around ChatGPT token refresh. Each test creates a temporary Codex home, points refresh traffic at a WireMock server via environment overrides, writes an `AuthDotJson` fixture, and then invokes `AuthManager` methods such as `auth()`, `refresh_token()`, `refresh_token_from_authority()`, or `unauthorized_recovery()`. The helper `RefreshTokenTestContext` encapsulates tempdir creation, refresh-endpoint override setup, `AuthManager::shared` construction, auth.json loading, and writing plus cache reload. JWT helpers generate minimal ID tokens and access tokens with synthetic `exp` claims so tests can precisely place tokens inside or outside the proactive refresh window. The suite checks that successful refreshes update both persisted auth.json and the in-memory cache, that unchanged auth permits refresh while changed-on-disk auth causes reload or skip behavior, and that account mismatches block refresh without contacting the authority. It also distinguishes stale `last_refresh` from actual access-token freshness, verifies that expired or near-expiry access tokens trigger refresh while fresh ones do not, and confirms permanent failures like `refresh_token_expired` or `refresh_token_reused` are memoized to avoid retries. Unauthorized recovery is tested as a two-step process: first reload changed disk auth, then attempt refresh, with explicit coverage for mismatch and non-ChatGPT auth modes. `EnvGuard` ensures process-wide environment overrides are restored safely between serial tests.

#### Function details

##### `refresh_token_succeeds_updates_storage`  (lines 37–110)

```
async fn refresh_token_succeeds_updates_storage() -> Result<()>
```

**Purpose**: Validates the direct authority refresh path when the refresh endpoint returns new access and refresh tokens. It confirms request payload contents, persisted auth.json updates, `last_refresh` advancement, and cache replacement.

**Data flow**: Sets client-id override and mock `/oauth/token` response → creates context and writes initial ChatGPT auth with stale `last_refresh` → calls `auth_manager.refresh_token_from_authority()` → inspects recorded HTTP request body, loads auth.json, compares stored tokens and timestamp, then reads cached auth and compares token data.

**Call relations**: Run by the async test harness; it uses `EnvGuard::set`, `RefreshTokenTestContext::new`, `build_tokens`, `write_auth`, and `load_auth` to drive the refresh path all the way through network, disk, and cache.

*Call graph*: calls 3 internal fn (set, new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `refresh_token_refreshes_when_auth_is_unchanged`  (lines 114–176)

```
async fn refresh_token_refreshes_when_auth_is_unchanged() -> Result<()>
```

**Purpose**: Checks that the higher-level `refresh_token()` path performs a refresh when cached auth still matches disk state.

**Data flow**: Mocks a successful token endpoint, writes initial auth, invokes `auth_manager.refresh_token()`, then loads auth.json and cached auth to assert both contain the refreshed access/refresh tokens and an advanced `last_refresh`.

**Call relations**: This test differs from the direct-authority case by exercising the wrapper logic that first decides whether refresh is still valid against current disk auth.

*Call graph*: calls 2 internal fn (new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `auth_refreshes_when_access_token_is_near_expiry`  (lines 180–238)

```
async fn auth_refreshes_when_access_token_is_near_expiry() -> Result<()>
```

**Purpose**: Verifies proactive refresh during `auth()` retrieval when the cached access token expires within the refresh window.

**Data flow**: Creates an access token whose `exp` is four minutes in the future, writes auth with current `last_refresh`, calls `auth_manager.auth()`, then asserts returned token data and persisted auth.json were replaced with the mock server's refreshed tokens and a newer refresh timestamp.

**Call relations**: Exercises the path where `auth()` internally consults token expiration and triggers refresh automatically rather than returning cached credentials unchanged.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 11 external calls (minutes, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `auth_skips_access_token_outside_refresh_window`  (lines 242–276)

```
async fn auth_skips_access_token_outside_refresh_window() -> Result<()>
```

**Purpose**: Ensures `auth()` does not refresh when the access token is still sufficiently fresh.

**Data flow**: Writes auth containing an access token expiring six minutes in the future and no mock refresh expectation → calls `auth_manager.auth()` → asserts returned token data equals the original tokens, auth.json is unchanged, and the mock server received no requests.

**Call relations**: Complements the near-expiry test by covering the branch where proactive refresh is intentionally skipped.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 6 external calls (minutes, start, now, assert!, assert_eq!, skip_if_no_network!).


##### `refresh_token_skips_refresh_when_auth_changed`  (lines 280–337)

```
async fn refresh_token_skips_refresh_when_auth_changed() -> Result<()>
```

**Purpose**: Checks that `refresh_token()` avoids contacting the authority if auth.json changed on disk since the manager cached it.

**Data flow**: Writes initial auth through the context, then overwrites auth.json directly with different disk tokens → calls `auth_manager.refresh_token()` → asserts stored auth remains the disk version, cached auth now reflects disk tokens, and no refresh HTTP request was sent.

**Call relations**: Exercises the cache-vs-disk reconciliation logic that prefers reloading changed auth over refreshing stale cached credentials.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 7 external calls (days, start, now, assert!, assert_eq!, save_auth, skip_if_no_network!).


##### `refresh_token_errors_on_account_mismatch`  (lines 341–412)

```
async fn refresh_token_errors_on_account_mismatch() -> Result<()>
```

**Purpose**: Verifies that refresh is rejected when disk auth belongs to a different account than the cached auth, preventing accidental cross-account token replacement.

**Data flow**: Writes initial cached auth, then saves disk auth with a different `account_id` → calls `auth_manager.refresh_token()` and captures the error → asserts failed reason is `Other`, disk auth remains untouched, no network request occurred, and cached tokens still equal the original cached account.

**Call relations**: Covers the protective mismatch branch in refresh orchestration, where reload is not considered safe enough to silently adopt.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `returns_fresh_tokens_as_is`  (lines 416–461)

```
async fn returns_fresh_tokens_as_is() -> Result<()>
```

**Purpose**: Confirms that a fresh access token is returned unchanged even if `last_refresh` is old enough that a refresh token might otherwise be considered stale.

**Data flow**: Writes auth with a one-hour-valid access token and a nine-day-old `last_refresh` → calls `auth_manager.auth()` → asserts cached token data and auth.json remain exactly as written and no refresh request is sent.

**Call relations**: Demonstrates that access-token freshness takes precedence over stale refresh bookkeeping in the `auth()` path.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 12 external calls (days, hours, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network! (+2 more)).


##### `refreshes_token_when_access_token_is_expired`  (lines 465–523)

```
async fn refreshes_token_when_access_token_is_expired() -> Result<()>
```

**Purpose**: Checks that `auth()` refreshes immediately when the access token has already expired.

**Data flow**: Writes auth with an access token whose `exp` is one hour in the past and a recent `last_refresh` → calls `auth_manager.auth()` → asserts returned and persisted tokens were replaced by the mock response and `last_refresh` advanced.

**Call relations**: Pairs with the near-expiry and fresh-token tests to cover the expired-token branch of proactive refresh.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 12 external calls (days, hours, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network! (+2 more)).


##### `auth_reloads_disk_auth_when_cached_auth_is_stale`  (lines 527–581)

```
async fn auth_reloads_disk_auth_when_cached_auth_is_stale() -> Result<()>
```

**Purpose**: Verifies that `auth()` reloads newer disk auth instead of using stale cached auth when the cached refresh metadata is old.

**Data flow**: Writes initial auth with a nine-day-old `last_refresh`, then overwrites auth.json with newer disk tokens and a one-day-old `last_refresh` → calls `auth_manager.auth()` → asserts returned token data and stored auth equal the disk version and no refresh request was made.

**Call relations**: Exercises stale-cache detection and disk reload without any authority call.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 7 external calls (days, start, now, assert!, assert_eq!, save_auth, skip_if_no_network!).


##### `auth_reloads_disk_auth_without_calling_expired_refresh_token`  (lines 585–647)

```
async fn auth_reloads_disk_auth_without_calling_expired_refresh_token() -> Result<()>
```

**Purpose**: Ensures stale cached auth is reloaded from disk before any attempt to use an expired refresh token, avoiding an unnecessary failing network call.

**Data flow**: Mocks `/oauth/token` to return `refresh_token_expired` but expects zero calls, writes stale cached auth, then saves fresher disk auth → calls `auth_manager.auth()` → asserts returned/stored auth equals disk auth and the mock endpoint was never hit.

**Call relations**: Specifically guards ordering: reload changed disk auth first, rather than trying to refresh stale cached credentials.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 11 external calls (days, given, start, new, now, assert_eq!, save_auth, json!, skip_if_no_network!, method (+1 more)).


##### `refresh_token_returns_permanent_error_for_expired_refresh_token`  (lines 651–702)

```
async fn refresh_token_returns_permanent_error_for_expired_refresh_token() -> Result<()>
```

**Purpose**: Checks that an authority response indicating `refresh_token_expired` is surfaced as a permanent refresh failure with the `Expired` reason.

**Data flow**: Mocks a 401 error payload with code `refresh_token_expired`, writes initial auth, calls `refresh_token_from_authority()`, captures the error, and asserts failed reason `Expired`; then verifies auth.json and cached tokens remain unchanged.

**Call relations**: Exercises the direct authority path's error classification for an unrecoverable expired refresh token.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_does_not_retry_after_permanent_failure`  (lines 706–771)

```
async fn refresh_token_does_not_retry_after_permanent_failure() -> Result<()>
```

**Purpose**: Verifies that once refresh fails permanently due to token reuse/exhaustion, subsequent `refresh_token()` calls fail from cached state without issuing another HTTP request.

**Data flow**: Mocks a single 401 `refresh_token_reused` response, writes initial auth, calls `refresh_token()` twice, asserts both errors report `Exhausted`, then checks auth.json and cached tokens are unchanged and only one request reached the server.

**Call relations**: Covers memoization of permanent refresh failure inside `AuthManager`.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_does_not_retry_after_bad_request_reused_failure`  (lines 775–840)

```
async fn refresh_token_does_not_retry_after_bad_request_reused_failure() -> Result<()>
```

**Purpose**: Confirms the same no-retry behavior when the reused-token failure arrives as HTTP 400 instead of 401.

**Data flow**: Mocks one 400 response with error code `refresh_token_reused`, writes initial auth, invokes `refresh_token()` twice, asserts both failures are `Exhausted`, and verifies only the first call contacted the server.

**Call relations**: Extends permanent-failure caching coverage across multiple HTTP status encodings of the same semantic error.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_reloads_changed_auth_after_permanent_failure`  (lines 844–928)

```
async fn refresh_token_reloads_changed_auth_after_permanent_failure() -> Result<()>
```

**Purpose**: Checks that a previously memoized permanent refresh failure does not block adoption of newly changed auth.json from disk.

**Data flow**: First triggers a permanent `refresh_token_reused` failure on cached auth, then writes fresher disk auth with different tokens and a newer `last_refresh`, calls `refresh_token()` again, and asserts the manager reloads disk auth without another network request.

**Call relations**: Exercises the interaction between permanent-failure memoization and disk-change detection: no retry, but reload is still allowed.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, hours, given, start, new, now, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `refresh_token_returns_transient_error_on_server_failure`  (lines 932–982)

```
async fn refresh_token_returns_transient_error_on_server_failure() -> Result<()>
```

**Purpose**: Verifies that server-side failures are treated as transient rather than permanent refresh exhaustion.

**Data flow**: Mocks a 500 response, writes initial auth, calls `refresh_token_from_authority()`, asserts the error matches `RefreshTokenError::Transient(_)` and has no failed reason, then confirms auth.json and cached tokens remain unchanged.

**Call relations**: Covers the error-classification branch distinct from permanent token-state failures.

*Call graph*: calls 2 internal fn (new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `unauthorized_recovery_reloads_then_refreshes_tokens`  (lines 986–1081)

```
async fn unauthorized_recovery_reloads_then_refreshes_tokens() -> Result<()>
```

**Purpose**: Tests the two-step unauthorized recovery iterator: first reload changed disk auth, then refresh those tokens from the authority.

**Data flow**: Writes initial cached auth, overwrites disk auth with different tokens, obtains `unauthorized_recovery()`, asserts `has_next()`, runs `next()` once to reload disk auth and checks no network call occurred, runs `next()` again to refresh via mock server, then verifies persisted and cached tokens contain the refreshed values and recovery is exhausted.

**Call relations**: Exercises the staged recovery flow exposed after unauthorized responses, including both reload and refresh phases.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `unauthorized_recovery_errors_on_account_mismatch`  (lines 1085–1167)

```
async fn unauthorized_recovery_errors_on_account_mismatch() -> Result<()>
```

**Purpose**: Ensures unauthorized recovery fails immediately when the changed disk auth belongs to a different account.

**Data flow**: Writes initial cached auth, saves disk auth with another `account_id`, starts recovery, calls `next()` and captures the error, asserts failed reason `Other`, verifies disk auth remains, no network request was sent, and cached tokens still reflect the original auth.

**Call relations**: Covers the same account-safety invariant as refresh tests, but through the unauthorized recovery API.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `unauthorized_recovery_requires_chatgpt_auth`  (lines 1171–1201)

```
async fn unauthorized_recovery_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: Checks that unauthorized recovery is unavailable for non-ChatGPT auth modes such as API-key auth.

**Data flow**: Writes an `AuthDotJson` with `AuthMode::ApiKey` and no tokens → creates recovery iterator → asserts `has_next()` is false, then calling `next()` yields an error with failed reason `Other`, and no network requests occur.

**Call relations**: Exercises the guard that recovery logic only applies to ChatGPT token-based auth.

*Call graph*: calls 1 internal fn (new); 4 external calls (start, assert!, assert_eq!, skip_if_no_network!).


##### `RefreshTokenTestContext::new`  (lines 1210–1230)

```
async fn new(server: &MockServer) -> Result<Self>
```

**Purpose**: Creates a temporary test environment wired to a mock refresh endpoint and a shared `AuthManager` instance.

**Data flow**: Accepts `&MockServer` → creates `TempDir`, formats the server `/oauth/token` URL, sets `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR` via `EnvGuard`, constructs `AuthManager::shared` with file-backed credentials and the temp home → returns `RefreshTokenTestContext` holding the tempdir, manager, and env guard.

**Call relations**: Called by nearly every integration test in this file to centralize setup of filesystem state, environment overrides, and manager construction.

*Call graph*: calls 3 internal fn (default, shared, set); called by 18 (auth_refreshes_when_access_token_is_near_expiry, auth_reloads_disk_auth_when_cached_auth_is_stale, auth_reloads_disk_auth_without_calling_expired_refresh_token, auth_skips_access_token_outside_refresh_window, refresh_token_does_not_retry_after_bad_request_reused_failure, refresh_token_does_not_retry_after_permanent_failure, refresh_token_errors_on_account_mismatch, refresh_token_refreshes_when_auth_is_unchanged, refresh_token_reloads_changed_auth_after_permanent_failure, refresh_token_returns_permanent_error_for_expired_refresh_token (+8 more)); 2 external calls (new, format!).


##### `RefreshTokenTestContext::load_auth`  (lines 1232–1240)

```
fn load_auth(&self) -> Result<AuthDotJson>
```

**Purpose**: Loads the current auth.json from the temporary Codex home and asserts it exists.

**Data flow**: Reads `self.codex_home.path()` and fixed credential-store settings → calls `load_auth_dot_json` → adds context for load failure and missing file → returns `Result<AuthDotJson>`.

**Call relations**: Used by tests after refresh/reload operations to inspect persisted state on disk.

*Call graph*: calls 1 internal fn (default); 2 external calls (path, load_auth_dot_json).


##### `RefreshTokenTestContext::write_auth`  (lines 1242–1251)

```
async fn write_auth(&self, auth_dot_json: &AuthDotJson) -> Result<()>
```

**Purpose**: Persists an `AuthDotJson` fixture into the temporary home and refreshes the manager's in-memory cache to match.

**Data flow**: Accepts `&AuthDotJson` → calls `save_auth` with file-backed settings → awaits `self.auth_manager.reload()` → returns `Ok(())`.

**Call relations**: Used by tests to seed initial auth state before invoking manager methods; it keeps disk and cache synchronized unless a test intentionally bypasses it.

*Call graph*: calls 1 internal fn (default); 2 external calls (path, save_auth).


##### `EnvGuard::set`  (lines 1260–1267)

```
fn set(key: &'static str, value: String) -> Self
```

**Purpose**: Temporarily overrides a process environment variable for a test and remembers the previous value for restoration.

**Data flow**: Accepts a static key and replacement string → reads original value with `std::env::var_os` → unsafely sets the new value with `std::env::set_var` → returns `EnvGuard { key, original }`.

**Call relations**: Used by context setup and selected tests to redirect client IDs or token endpoints; paired with `EnvGuard::drop` for cleanup.

*Call graph*: called by 6 (new, refresh_token_succeeds_updates_storage, auth_manager_logout_with_revoke_uses_cached_auth, logout_with_revoke_removes_auth_when_revoke_fails, logout_with_revoke_revokes_refresh_token_then_removes_auth, logout_with_revoke_uses_stored_auth_when_access_token_env_is_set); 2 external calls (set_var, var_os).


##### `EnvGuard::drop`  (lines 1271–1279)

```
fn drop(&mut self)
```

**Purpose**: Restores the original environment variable state when the guard goes out of scope.

**Data flow**: Reads `self.original` → if present, resets the variable with `set_var`; otherwise removes it with `remove_var` → writes process environment as cleanup side effect.

**Call relations**: Runs automatically at scope exit for every `EnvGuard::set` call, ensuring serial tests do not leak environment overrides.

*Call graph*: 2 external calls (remove_var, set_var).


##### `jwt_with_payload`  (lines 1282–1304)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Builds a syntactically valid JWT string from an arbitrary JSON payload for integration tests.

**Data flow**: Accepts `serde_json::Value` → serializes a fixed header and the payload to bytes → base64url-no-pad encodes header, payload, and `sig` → formats `header.payload.signature` and returns it.

**Call relations**: Shared helper used by `minimal_jwt` and `access_token_with_expiration` to create ID and access tokens for auth fixtures.

*Call graph*: called by 2 (access_token_with_expiration, minimal_jwt); 2 external calls (format!, to_vec).


##### `minimal_jwt`  (lines 1306–1308)

```
fn minimal_jwt() -> String
```

**Purpose**: Produces a minimal JWT containing only a `sub` claim for use as a placeholder ID token.

**Data flow**: Constructs `json!({ "sub": "user-123" })` → passes it to `jwt_with_payload` → returns the resulting token string.

**Call relations**: Called by `build_tokens` when tests need valid token structure without meaningful claims.

*Call graph*: calls 1 internal fn (jwt_with_payload); called by 1 (build_tokens); 1 external calls (json!).


##### `access_token_with_expiration`  (lines 1310–1312)

```
fn access_token_with_expiration(expires_at: chrono::DateTime<Utc>) -> String
```

**Purpose**: Creates a JWT access token whose `exp` claim is set to a caller-specified timestamp.

**Data flow**: Accepts `expires_at: DateTime<Utc>` → builds a payload with `sub` and `exp: expires_at.timestamp()` → delegates to `jwt_with_payload` → returns the token string.

**Call relations**: Used by tests that need to place access tokens before, inside, or after the proactive refresh window.

*Call graph*: calls 1 internal fn (jwt_with_payload); called by 4 (auth_refreshes_when_access_token_is_near_expiry, auth_skips_access_token_outside_refresh_window, refreshes_token_when_access_token_is_expired, returns_fresh_tokens_as_is); 1 external calls (json!).


##### `build_tokens`  (lines 1314–1325)

```
fn build_tokens(access_token: &str, refresh_token: &str) -> TokenData
```

**Purpose**: Constructs a `TokenData` fixture with a minimal ID token, caller-supplied access/refresh tokens, and a fixed account id.

**Data flow**: Accepts `access_token` and `refresh_token` strings → creates `IdTokenInfo` with `raw_jwt` from `minimal_jwt()` and other fields defaulted → builds and returns `TokenData` with cloned token strings and `account_id: Some("account-id")`.

**Call relations**: Used throughout the suite to create consistent token fixtures for both cached and disk auth states.

*Call graph*: calls 1 internal fn (minimal_jwt); called by 17 (auth_refreshes_when_access_token_is_near_expiry, auth_reloads_disk_auth_when_cached_auth_is_stale, auth_reloads_disk_auth_without_calling_expired_refresh_token, auth_skips_access_token_outside_refresh_window, refresh_token_does_not_retry_after_bad_request_reused_failure, refresh_token_does_not_retry_after_permanent_failure, refresh_token_errors_on_account_mismatch, refresh_token_refreshes_when_auth_is_unchanged, refresh_token_reloads_changed_auth_after_permanent_failure, refresh_token_returns_permanent_error_for_expired_refresh_token (+7 more)); 1 external calls (default).


### `login/tests/suite/logout.rs`

`test` · `integration test execution`

This integration test file focuses on `logout_with_revoke` and `AuthManager::logout_with_revoke`. It uses WireMock to emulate `/oauth/revoke`, temporary Codex homes for auth.json storage, and a small `EnvGuard` utility to override process environment variables such as the revoke endpoint, client id, and access-token env var. The helper `chatgpt_auth_with_refresh_token` builds a realistic `AuthDotJson` in ChatGPT mode with `TokenData`, a minimal raw JWT, fixed access token, caller-specified refresh token, and a stable account id; `chatgpt_auth` just supplies the default refresh token. Tests verify that successful revoke sends the expected JSON body (`token`, `token_type_hint`, `client_id`) and then deletes auth.json, that logout still uses stored auth even when an access token is present in the environment, and that auth removal proceeds even if the revoke endpoint returns a server error. The manager-specific test demonstrates cache semantics: after constructing `AuthManager` from one auth.json and then overwriting disk with a newer refresh token, `manager.logout_with_revoke()` still revokes the cached original refresh token, clears the manager cache, and removes auth.json. As in the refresh suite, `EnvGuard` restores environment state on drop so serial tests do not leak overrides.

#### Function details

##### `logout_with_revoke_revokes_refresh_token_then_removes_auth`  (lines 34–87)

```
async fn logout_with_revoke_revokes_refresh_token_then_removes_auth() -> Result<()>
```

**Purpose**: Verifies the happy path for standalone logout: revoke the stored refresh token with the configured client id, then delete auth.json.

**Data flow**: Sets client-id and revoke-URL environment overrides, mounts a successful `/oauth/revoke` mock, writes ChatGPT auth to a temp home, calls `logout_with_revoke(...)`, asserts it returned `true` and auth.json no longer exists, then inspects the single recorded revoke request body for the expected JSON payload.

**Call relations**: Exercises the top-level logout helper end to end, using `chatgpt_auth` for fixture creation and `EnvGuard::set` for endpoint/client-id overrides.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 13 external calls (given, start, new, new, assert!, assert_eq!, logout_with_revoke, save_auth, format!, json! (+3 more)).


##### `logout_with_revoke_uses_stored_auth_when_access_token_env_is_set`  (lines 91–129)

```
async fn logout_with_revoke_uses_stored_auth_when_access_token_env_is_set() -> Result<()>
```

**Purpose**: Checks that logout still revokes based on stored auth.json even when an access token is injected through the environment.

**Data flow**: Sets revoke-URL and `CODEX_ACCESS_TOKEN_ENV_VAR`, writes stored ChatGPT auth, calls `logout_with_revoke`, and asserts auth.json was removed and the mock revoke endpoint was hit once.

**Call relations**: Covers precedence rules between environment-provided access tokens and persisted refresh-token-based logout.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 11 external calls (given, start, new, new, assert!, logout_with_revoke, save_auth, format!, skip_if_no_network!, method (+1 more)).


##### `logout_with_revoke_removes_auth_when_revoke_fails`  (lines 133–172)

```
async fn logout_with_revoke_removes_auth_when_revoke_fails() -> Result<()>
```

**Purpose**: Ensures logout is best-effort: auth.json is removed even if the revoke HTTP request fails with a server error.

**Data flow**: Sets revoke-URL override, mounts a 500 `/oauth/revoke` response, writes stored ChatGPT auth, calls `logout_with_revoke`, and asserts it still returns `true` and deletes auth.json.

**Call relations**: Exercises the failure-tolerant cleanup branch of the standalone logout helper.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 12 external calls (given, start, new, new, assert!, logout_with_revoke, save_auth, format!, json!, skip_if_no_network! (+2 more)).


##### `auth_manager_logout_with_revoke_uses_cached_auth`  (lines 176–238)

```
async fn auth_manager_logout_with_revoke_uses_cached_auth() -> Result<()>
```

**Purpose**: Verifies that `AuthManager::logout_with_revoke` revokes the refresh token from its cached auth snapshot rather than re-reading newer disk auth.

**Data flow**: Sets revoke-URL override, writes auth with refresh token `REFRESH_TOKEN`, constructs `AuthManager`, overwrites auth.json with a newer refresh token, calls `manager.logout_with_revoke()`, asserts removal succeeded, manager cache is empty, auth.json is gone, and the recorded revoke request body still contains the original cached refresh token and default `CLIENT_ID`.

**Call relations**: Exercises manager-specific cache semantics and contrasts with the standalone helper's direct disk usage.

*Call graph*: calls 4 internal fn (default, new, set, chatgpt_auth_with_refresh_token); 12 external calls (given, start, new, new, assert!, assert_eq!, save_auth, format!, json!, skip_if_no_network! (+2 more)).


##### `chatgpt_auth`  (lines 240–242)

```
fn chatgpt_auth() -> AuthDotJson
```

**Purpose**: Convenience helper that builds a standard ChatGPT-mode auth fixture using the file's default refresh token constant.

**Data flow**: Calls `chatgpt_auth_with_refresh_token(REFRESH_TOKEN)` and returns the resulting `AuthDotJson`.

**Call relations**: Used by the standalone logout tests to avoid repeating fixture construction.

*Call graph*: calls 1 internal fn (chatgpt_auth_with_refresh_token); called by 3 (logout_with_revoke_removes_auth_when_revoke_fails, logout_with_revoke_revokes_refresh_token_then_removes_auth, logout_with_revoke_uses_stored_auth_when_access_token_env_is_set).


##### `chatgpt_auth_with_refresh_token`  (lines 244–262)

```
fn chatgpt_auth_with_refresh_token(refresh_token: &str) -> AuthDotJson
```

**Purpose**: Constructs a complete `AuthDotJson` fixture for ChatGPT auth with caller-controlled refresh token contents.

**Data flow**: Accepts `refresh_token: &str` → builds `AuthDotJson` with `auth_mode: Chatgpt`, no API key, `tokens: Some(TokenData { id_token: IdTokenInfo { raw_jwt: minimal_jwt(), ..Default::default() }, access_token: ACCESS_TOKEN, refresh_token, account_id: Some("account-id") })`, and other optional fields unset → returns the struct.

**Call relations**: Used by `chatgpt_auth` and the manager-cache test to create persisted auth fixtures with specific refresh-token values.

*Call graph*: calls 1 internal fn (minimal_jwt); called by 2 (auth_manager_logout_with_revoke_uses_cached_auth, chatgpt_auth); 1 external calls (default).


##### `minimal_jwt`  (lines 264–270)

```
fn minimal_jwt() -> String
```

**Purpose**: Creates a tiny syntactically valid JWT string for use as the stored raw ID token in logout fixtures.

**Data flow**: Base64url-no-pad encodes fixed header bytes, fixed payload bytes containing `sub`, and `sig` → formats `header.payload.signature` → returns the string.

**Call relations**: Called by `chatgpt_auth_with_refresh_token` so persisted token data looks structurally valid.

*Call graph*: called by 1 (chatgpt_auth_with_refresh_token); 1 external calls (format!).


##### `EnvGuard::set`  (lines 278–285)

```
fn set(key: &'static str, value: String) -> Self
```

**Purpose**: Temporarily overrides an environment variable for a test and records the previous value.

**Data flow**: Accepts a static key and replacement string → reads original value with `var_os` → unsafely sets the new value with `set_var` → returns an `EnvGuard` storing key and original value.

**Call relations**: Used by the logout tests to redirect revoke URLs, override client id, and inject access-token environment state.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvGuard::drop`  (lines 289–297)

```
fn drop(&mut self)
```

**Purpose**: Restores or removes the environment variable when the guard is dropped.

**Data flow**: Reads `self.original` → if `Some`, resets the variable with `set_var`; if `None`, removes it with `remove_var`.

**Call relations**: Runs automatically after each test scope to prevent environment leakage across serial auth tests.

*Call graph*: 2 external calls (remove_var, set_var).
