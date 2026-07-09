# login workflow integration tests  `stage-23.3.5`

This stage is the safety net for the login system. It runs during testing, not during normal use, and checks the full journey of signing in, staying signed in, and signing out. The test entry files gather the separate test modules so Rust can run them as one suite.

The smaller auth tests check the building blocks: whether different token text formats are recognized, whether personal access tokens fetch complete user data, whether API keys and environment settings are accepted safely, and whether Amazon Bedrock credentials can replace older OpenAI-style credentials. Storage tests make sure saved logins can move between files, memory, and the system keyring, which is the operating system’s secure password store.

The larger workflow tests act more like rehearsals. Command-line login tests check API-key and device-code login, where a terminal asks the user to approve access in a browser. Browser-server end-to-end tests exercise the local login server from the outside. Refresh tests confirm expired ChatGPT tokens are renewed without overwriting newer data. Logout tests ensure remote revocation is attempted and local credentials are cleaned up even if revocation fails.

## Files in this stage

### Test harness structure
These files assemble the login crate's integration-test binary and register the suite modules that the end-to-end tests run under.

### `login/tests/all.rs`

`test` · `test startup`

This file is small, but it plays an important organizing role. In Rust, an integration test file under `tests/` is compiled as its own test program. Here, `all.rs` acts like a front door for the login test suite: instead of putting all tests directly in this file, it imports a `suite` module, whose contents live in `tests/suite/`.

The line allowing `clippy::expect_used` tells the lint checker not to complain when tests use `.expect(...)`. That is common in tests, because a failing setup step should usually stop the test with a clear message.

Without this file, the tests under `tests/suite/` would not automatically be part of this particular integration test binary. Think of it like a table of contents: it does not contain the chapters itself, but it tells the test runner where to find them and makes sure they are included.


### `login/tests/suite/mod.rs`

`test` · `test discovery`

This file exists so the login system’s integration tests can be organized into separate, focused files while still being run together as one suite. Think of it like a table of contents for a test folder: it does not contain the tests itself, but it points the test runner to the files that do.

Each `mod` line includes another test module. These modules cover important login flows: refreshing authentication, logging in with a device code, end-to-end login server behavior, and logging out. Without this file, those separate test files would not be pulled into this particular test suite, so their checks might not run when expected.

There is no business logic here and no helper code. Its job is purely organizational. It keeps the test suite readable by letting each major login scenario live in its own file, while this small module ties them together for the Rust test system.


### Auth primitives and storage
These tests establish the lower-level authentication building blocks, from token classification and hydration to persistence backends and broad auth-manager behavior.

### `login/src/auth/access_token_tests.rs`

`test` · `test run`

This is a small test file for the authentication code. Its job is to prove that the token-classifying helper makes the right first decision when given a raw access token string. That matters because different token types usually need to be treated differently later, much like sorting mail into the right bins before delivery.

The test covers two examples. A token starting with `at-` is expected to be classified as a personal access token. A token shaped like three dot-separated parts, such as `header.payload.signature`, is expected to be classified as an agent identity JWT. A JWT, or JSON Web Token, is a compact signed token format often written as three text sections separated by dots.

The file does not implement the classifier itself. Instead, it imports the authentication module around it with `use super::*` and calls `classify_codex_access_token`. If the classifier ever changes in a way that breaks these expectations, this test will fail and alert the developers before the mistake reaches users.

#### Function details

##### `classifies_personal_access_tokens_by_prefix`  (lines 4–13)

```
fn classifies_personal_access_tokens_by_prefix()
```

**Purpose**: This test verifies that access token text is sorted into the correct token kind. It checks one personal access token example and one JWT-shaped agent identity token example.

**Data flow**: The test starts with two hard-coded token strings: `at-example` and `header.payload.signature`. It passes each string into `classify_codex_access_token`, then uses assertions to confirm that the returned category matches the expected enum variant and still contains the original text. Nothing is returned; the test either passes silently or fails if a result is wrong.

**Call relations**: The Rust test runner calls this function during the test suite. Inside the test, it calls the real token classifier from the surrounding authentication module, then hands the results to `assert!` checks so the test runner can report success or failure.

*Call graph*: 1 external calls (assert!).


### `login/src/auth/personal_access_token_tests.rs`

`test` · `test run`

This is a test file for the personal access token login path. A personal access token is a secret string a user can provide instead of going through an interactive login screen. The real code needs to contact a “who am I?” service, send the token as proof, and receive account details such as email, user ID, account ID, plan type, and whether the account is FedRAMP-related.

The tests use a mock web server, which is like a pretend version of the real service. That lets the test control exactly what the server returns and check exactly what request was sent. One test confirms the happy path: the code sends an HTTP GET request to the right path, includes an Authorization header in the form “Bearer <token>”, and keeps both the original token and the returned metadata. Another test checks a failure case: if the server response does not include an email, the hydration step should reject it instead of quietly creating an incomplete login record.

Without tests like these, a bug could let the program store bad account metadata, or send the token in the wrong format, causing real logins to fail or behave unpredictably.

#### Function details

##### `response`  (lines 11–19)

```
fn response(email: Option<&str>) -> serde_json::Value
```

**Purpose**: Builds a small fake JSON response that looks like the account metadata returned by the “who am I?” service. The tests use it so they can easily switch between a valid email and a missing email.

**Data flow**: It receives an optional email value. It places that email, plus fixed sample account fields, into a JSON object. The result is returned to the mock server as the body of its pretend response.

**Call relations**: Both test cases call this helper when setting up the mock server. It hands the prepared JSON body to the server response builder so each test can focus on the behavior being checked rather than repeating the same sample metadata.

*Call graph*: called by 2 (hydrate_rejects_missing_email, hydrate_sends_bearer_token_and_preserves_metadata); 1 external calls (json!).


##### `hydrate_sends_bearer_token_and_preserves_metadata`  (lines 22–50)

```
async fn hydrate_sends_bearer_token_and_preserves_metadata()
```

**Purpose**: Tests the successful personal access token flow. It proves that the login code sends the token as a Bearer token and turns the server’s account response into the expected authentication record.

**Data flow**: The test starts a mock server, teaches it to expect one GET request to the account-info path with the correct authorization header, and gives it a JSON response containing an email and metadata. It then runs the token hydration code with the sample token. The final result is compared against the exact expected authentication object, and the mock server verifies that the expected request really arrived.

**Call relations**: This test uses the shared response helper to create the fake server body. It also uses the mock server and request matchers to stand in for the real remote service, then checks that the production hydration path produces the right stored token and metadata.

*Call graph*: calls 1 internal fn (response); 7 external calls (given, start, new, assert_eq!, header, method, path).


##### `hydrate_rejects_missing_email`  (lines 53–71)

```
async fn hydrate_rejects_missing_email()
```

**Purpose**: Tests that personal access token hydration fails when the account service does not provide an email. This protects the rest of the system from accepting incomplete identity information.

**Data flow**: The test starts a mock server and configures it to return a successful HTTP response whose JSON body has no email. It then runs the token hydration code with a sample token. Instead of a valid authentication record, the test expects an error and checks that the error message says the metadata could not be decoded.

**Call relations**: This test calls the response helper with no email to create the malformed-but-realistic server reply. It then drives the same hydration path as the successful test, but confirms that the code stops and reports a decoding problem rather than passing bad metadata onward.

*Call graph*: calls 1 internal fn (response); 6 external calls (given, start, new, assert!, method, path).


### `login/src/auth/storage_tests.rs`

`test` · `test suite`

This is a test file for authentication storage. Authentication data is sensitive: it may include API keys, ChatGPT tokens, personal access tokens, or agent identity tokens. If this storage layer behaves wrongly, users could lose their login, keep using stale credentials, or leave secrets behind after logout. The tests create temporary Codex home folders and mock keyrings, so they can check behavior without touching a real user’s files or operating system keychain. The file covers several storage choices. File storage writes an auth.json file. Ephemeral storage keeps data only in memory, like a note written on a whiteboard that disappears when erased. Direct keyring storage saves the serialized auth data under an older keyring account name. Secrets keyring storage uses the newer secrets system, which writes an encrypted file and stores the encryption passphrase in the keyring. Auto storage tries the safer keyring path first, but can fall back to auth.json when needed. The helper functions build realistic fake auth records and fake JSON Web Tokens, seed the mock secrets backend, and assert that old fallback files are cleaned up. Overall, this file protects the login system’s promises: save credentials where requested, read the best available copy, and remove every copy during logout.

#### Function details

##### `file_storage_load_returns_auth_dot_json`  (lines 18–38)

```
async fn file_storage_load_returns_auth_dot_json() -> anyhow::Result<()>
```

**Purpose**: Checks that file-based auth storage can read back a complete auth.json record after it has been saved. This proves the simplest on-disk credential path works.

**Data flow**: It starts with a temporary Codex home folder and an AuthDotJson value containing an API key and refresh time. It saves that value through FileAuthStorage, loads from the same storage, and expects the loaded value to exactly match the original.

**Call relations**: The test runner calls this test. Inside it, FileAuthStorage::new creates the storage object, the storage save and load methods do the real work, and the final equality check confirms the round trip.

*Call graph*: calls 1 internal fn (new); 3 external calls (now, assert_eq!, tempdir).


##### `file_storage_save_persists_auth_dot_json`  (lines 41–64)

```
async fn file_storage_save_persists_auth_dot_json() -> anyhow::Result<()>
```

**Purpose**: Checks that saving through file storage actually writes the expected auth.json content to disk. It verifies not just that load works, but that the file itself contains the right data.

**Data flow**: It creates a temporary home folder, builds an AuthDotJson with an API key, saves it, then reads the auth.json file path directly using the storage’s lower-level read helper. The output is a comparison between the file contents and the original value.

**Call relations**: The test runner invokes it as an independent test. It uses FileAuthStorage::new for setup, get_auth_file to locate the file, and try_read_auth_json to inspect what save wrote.

*Call graph*: calls 1 internal fn (new); 3 external calls (now, assert_eq!, tempdir).


##### `file_storage_round_trips_agent_identity_auth`  (lines 67–94)

```
async fn file_storage_round_trips_agent_identity_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that file storage preserves agent identity authentication. Agent identity is represented as a JWT, a compact signed-looking token string made of encoded JSON parts.

**Data flow**: It builds a fake agent identity token from JSON claims, puts it into an AuthDotJson with agent identity mode, saves it to file storage, then loads it back. The before and after AuthDotJson values must be identical.

**Call relations**: The test runner calls this test. It relies on jwt_with_payload to build a realistic token string, then hands the record to FileAuthStorage save and load to prove this auth mode is not damaged.

*Call graph*: calls 2 internal fn (new, jwt_with_payload); 3 external calls (assert_eq!, json!, tempdir).


##### `file_storage_round_trips_personal_access_token_auth`  (lines 97–115)

```
async fn file_storage_round_trips_personal_access_token_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that file storage preserves personal access token authentication. This covers a different credential shape from an API key or ChatGPT token set.

**Data flow**: It creates a temporary home, builds an AuthDotJson whose auth mode is PersonalAccessToken, saves it, then loads it. The result should be the same record with the same access token string.

**Call relations**: The test runner calls it. The test uses FileAuthStorage::new for the storage path and then exercises the common save/load path for this specific auth mode.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, tempdir).


##### `file_storage_loads_agent_identity_as_jwt`  (lines 118–146)

```
async fn file_storage_loads_agent_identity_as_jwt() -> anyhow::Result<()>
```

**Purpose**: Checks that an auth.json file containing an agent identity token as a raw JWT string is loaded correctly. This protects compatibility with the JSON format written on disk.

**Data flow**: It creates a fake JWT, manually writes an auth.json file containing auth_mode and agent_identity fields, then asks FileAuthStorage to load it. The loaded record must contain the same JWT string in its agent_identity field.

**Call relations**: The test runner calls this test. Unlike the round-trip test, it bypasses save by writing JSON directly, then uses FileAuthStorage load to confirm the deserializer understands the stored format.

*Call graph*: calls 2 internal fn (new, jwt_with_payload); 5 external calls (assert_eq!, json!, to_string_pretty, write, tempdir).


##### `file_storage_delete_removes_auth_file`  (lines 149–172)

```
fn file_storage_delete_removes_auth_file() -> anyhow::Result<()>
```

**Purpose**: Checks that deleting file-based auth removes auth.json from disk and reports that something was removed. This is important for logout and cleanup.

**Data flow**: It creates an auth record, saves it through storage configured for file mode, confirms auth.json exists, then deletes through FileAuthStorage. Afterward, the return value should be true and the file should be gone.

**Call relations**: The test runner calls this test. It uses the storage factory to create the initial file-mode storage, then directly uses FileAuthStorage to test the file deletion behavior.

*Call graph*: calls 2 internal fn (default, new); 2 external calls (assert!, tempdir).


##### `ephemeral_storage_save_load_delete_is_in_memory_only`  (lines 175–202)

```
fn ephemeral_storage_save_load_delete_is_in_memory_only() -> anyhow::Result<()>
```

**Purpose**: Checks that ephemeral auth storage keeps credentials only in memory and never creates auth.json. This mode is useful when credentials should not persist after the process or test state is cleared.

**Data flow**: It creates ephemeral storage, saves an AuthDotJson, loads it back from memory, deletes it, and verifies loading then returns nothing. It also checks that no auth.json file was created in the temporary home folder.

**Call relations**: The test runner calls it. It goes through create_auth_storage in Ephemeral mode, then exercises the same save, load, and delete interface used by the other storage backends.

*Call graph*: calls 1 internal fn (default); 4 external calls (now, assert!, assert_eq!, tempdir).


##### `seed_secrets_backend_and_fallback_auth_file_for_delete`  (lines 204–223)

```
fn seed_secrets_backend_and_fallback_auth_file_for_delete(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    auth: &AuthDotJson,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Prepares a test situation where credentials exist in the newer encrypted secrets backend and a stale auth.json file also exists. Tests use this to verify deletion removes both copies.

**Data flow**: It receives a mock keyring, a Codex home path, and an auth record. It serializes the auth record into the secrets backend, writes a dummy stale auth.json file, and returns the path to that fallback file.

**Call relations**: Deletion tests call this helper before exercising delete. It hands them a pre-seeded secrets backend plus a leftover file, so they can confirm the storage layer cleans up both the primary and fallback locations.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 3 (auto_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry); 5 external calls (new, to_path_buf, clone, to_string, write).


##### `seed_secrets_backend_with_auth`  (lines 225–242)

```
fn seed_secrets_backend_with_auth(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    auth: &AuthDotJson,
) -> anyhow::Result<()>
```

**Purpose**: Writes a given auth record into the secrets-backed storage used by tests. It is a setup helper for tests that need keyring-backed credentials to already exist.

**Data flow**: It takes a mock keyring, Codex home path, and auth record. It creates a SecretsManager for the Codex auth namespace, serializes the auth as JSON, stores it as a global secret, and returns success or an error.

**Call relations**: Load-related tests call this helper before creating or using storage. It supplies the encrypted-secrets side of the world so tests can check whether storage loads it, prefers it, or falls back from it.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 3 (auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, secrets_keyring_auth_storage_load_returns_deserialized_auth); 4 external calls (new, to_path_buf, clone, to_string).


##### `assert_keyring_saved_auth_and_removed_fallback`  (lines 244–277)

```
fn assert_keyring_saved_auth_and_removed_fallback(
    mock_keyring: &MockKeyringStore,
    codex_home: &Path,
    expected: &AuthDotJson,
) -> anyhow::Result<()>
```

**Purpose**: Checks the expected end state after a successful secrets-backed keyring save. It verifies the auth data is stored in the new secrets system and that older or fallback storage locations are not left behind.

**Data flow**: It receives a mock keyring, Codex home path, and expected auth record. It reads the saved secret, compares it with the serialized expected auth, checks that the legacy keyring entry is empty, confirms the secrets keyring passphrase exists, confirms the encrypted file exists, and confirms auth.json was removed.

**Call relations**: Save tests call this helper after storage.save. It centralizes the detailed assertions for the newer secrets backend so those tests can focus on the scenario that triggered the save.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); called by 2 (auto_auth_storage_save_prefers_keyring, secrets_keyring_auth_storage_save_persists_and_removes_fallback_file); 7 external calls (new, to_path_buf, assert!, assert_eq!, compute_keyring_account, clone, to_string).


##### `encrypted_auth_file`  (lines 279–281)

```
fn encrypted_auth_file(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the expected path of the encrypted auth file used by the secrets backend. Tests use it to check whether encrypted credentials were or were not written.

**Data flow**: It receives the Codex home path and appends secrets/codex_auth.age. The result is a PathBuf pointing to where the encrypted auth file should live.

**Call relations**: Other tests and assertion helpers call this when they need to inspect the filesystem. It does not read or write anything; it only names the expected file.

*Call graph*: 1 external calls (join).


##### `id_token_with_prefix`  (lines 283–307)

```
fn id_token_with_prefix(prefix: &str) -> IdTokenInfo
```

**Purpose**: Creates a fake parsed ChatGPT ID token for tests. The prefix lets each test make distinct-looking users and account IDs without needing a real signed token.

**Data flow**: It takes a text prefix, builds a small JWT-style header and payload containing an email and account id, base64-url encodes the pieces, joins them into a fake token string, then parses that token into IdTokenInfo.

**Call relations**: auth_with_prefix calls this helper whenever it needs realistic token data. It hands off the fake JWT to parse_chatgpt_jwt_claims so the resulting object matches what production code expects.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 1 (auth_with_prefix); 3 external calls (format!, json!, to_vec).


##### `auth_with_prefix`  (lines 309–324)

```
fn auth_with_prefix(prefix: &str) -> AuthDotJson
```

**Purpose**: Builds a complete fake AuthDotJson record with predictable but unique values. Tests use it to avoid repeating large auth setup blocks.

**Data flow**: It receives a prefix string and uses it to create an API key, access token, refresh token, account id, and parsed ID token. It returns an AuthDotJson in API key mode with token data filled in.

**Call relations**: Many storage tests call this helper to create test credentials. It depends on id_token_with_prefix for the ID token portion, then passes the finished auth record into save, seed, or delete scenarios.

*Call graph*: calls 1 internal fn (id_token_with_prefix); called by 11 (auto_auth_storage_delete_removes_keyring_and_file, auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, auto_auth_storage_load_uses_file_when_keyring_empty, auto_auth_storage_save_falls_back_when_keyring_errors, auto_auth_storage_save_prefers_keyring, direct_keyring_auth_storage_delete_removes_keyring_and_file, direct_keyring_auth_storage_saves_legacy_keyring_entry, factory_uses_secrets_backend_only_when_requested, secrets_keyring_auth_storage_delete_removes_keyring_and_file (+1 more)); 1 external calls (format!).


##### `jwt_with_payload`  (lines 326–332)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Builds a fake JWT string from any JSON payload. Tests use it for agent identity values where the storage code only needs a correctly shaped token string.

**Data flow**: It takes a JSON value, base64-url encodes a fixed JWT header, the provided payload, and a dummy signature, then joins them with dots. The output is a JWT-looking string.

**Call relations**: Agent identity tests call this helper before saving or manually writing auth data. It supplies realistic input while avoiding any real cryptographic signing.

*Call graph*: called by 2 (file_storage_loads_agent_identity_as_jwt, file_storage_round_trips_agent_identity_auth); 2 external calls (format!, to_vec).


##### `secrets_keyring_auth_storage_load_returns_deserialized_auth`  (lines 335–356)

```
fn secrets_keyring_auth_storage_load_returns_deserialized_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that secrets-backed keyring storage can read a stored JSON auth secret and turn it back into an AuthDotJson value. This proves encrypted storage is usable after credentials are saved.

**Data flow**: It creates a temporary home, a mock keyring, and a SecretsKeyringAuthStorage. It seeds the secrets backend with an expected auth record, loads through storage, and compares the result with the expected record.

**Call relations**: The test runner calls this test. It uses seed_secrets_backend_with_auth for setup, then exercises SecretsKeyringAuthStorage::load as the behavior under test.

*Call graph*: calls 2 internal fn (new, seed_secrets_backend_with_auth); 4 external calls (new, assert_eq!, default, tempdir).


##### `keyring_auth_storage_compute_store_key_for_home_directory`  (lines 359–366)

```
fn keyring_auth_storage_compute_store_key_for_home_directory() -> anyhow::Result<()>
```

**Purpose**: Checks that the legacy direct-keyring account name is stable for a known Codex home path. Stable keys matter because changing them would make existing saved credentials unreachable.

**Data flow**: It starts with the path ~/.codex, asks compute_store_key to derive the keyring account string, and compares the result with the expected fixed value.

**Call relations**: The test runner calls this test. It focuses on the key-derivation helper used by direct keyring storage and by cleanup checks for legacy entries.

*Call graph*: 2 external calls (from, assert_eq!).


##### `direct_keyring_auth_storage_saves_legacy_keyring_entry`  (lines 369–394)

```
fn direct_keyring_auth_storage_saves_legacy_keyring_entry() -> anyhow::Result<()>
```

**Purpose**: Checks that direct keyring storage writes credentials into the older legacy keyring entry and removes any fallback auth.json file. This protects compatibility with the direct backend.

**Data flow**: It creates a temporary home and mock keyring, writes a stale auth.json file, builds fake auth data, and saves through DirectKeyringAuthStorage. It then checks the legacy keyring value, confirms no encrypted secrets file exists, confirms auth.json was removed, and verifies load returns the saved auth.

**Call relations**: The test runner calls it. It uses auth_with_prefix for the test auth and compute_store_key to inspect the exact mock keyring slot that direct storage should use.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 6 external calls (new, assert!, assert_eq!, default, write, tempdir).


##### `direct_keyring_auth_storage_delete_removes_keyring_and_file`  (lines 397–425)

```
fn direct_keyring_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Checks that deleting direct keyring auth removes both the legacy keyring entry and any fallback auth.json file. This prevents logout from leaving credentials behind.

**Data flow**: It saves auth through DirectKeyringAuthStorage, writes a stale auth.json file, then calls delete. After deletion, load should return nothing, the mock keyring should no longer have the legacy entry, auth.json should be gone, and no encrypted secrets file should exist.

**Call relations**: The test runner calls this test. It sets up direct keyring state using auth_with_prefix, then tests the direct storage delete path and its filesystem cleanup.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 6 external calls (new, assert!, assert_eq!, default, write, tempdir).


##### `factory_uses_secrets_backend_only_when_requested`  (lines 428–463)

```
fn factory_uses_secrets_backend_only_when_requested() -> anyhow::Result<()>
```

**Purpose**: Checks that the storage factory chooses the requested keyring backend. Direct mode should use the legacy keyring entry, while secrets mode should use the encrypted secrets backend.

**Data flow**: It creates one storage instance configured for Direct and saves auth, then checks the legacy keyring entry exists and no encrypted file exists. It creates another storage instance configured for Secrets and saves auth, then checks the secrets passphrase key exists and the encrypted file exists.

**Call relations**: The test runner calls it. It exercises create_auth_storage_with_store as the main behavior and uses auth_with_prefix plus path checks to prove the factory selected the right backend.

*Call graph*: calls 1 internal fn (auth_with_prefix); 4 external calls (new, assert!, default, tempdir).


##### `secrets_keyring_auth_storage_save_persists_and_removes_fallback_file`  (lines 466–494)

```
fn secrets_keyring_auth_storage_save_persists_and_removes_fallback_file() -> anyhow::Result<()>
```

**Purpose**: Checks that saving through the secrets-backed keyring storage writes encrypted credentials and deletes an old auth.json fallback file. This is the desired safe-storage behavior.

**Data flow**: It creates a temporary home, mock keyring, storage instance, and stale auth.json file. It saves a ChatGPT-style auth record, then uses the shared assertion helper to verify the secret was stored, the passphrase exists, the encrypted file exists, and the fallback file is gone.

**Call relations**: The test runner calls this test. After calling SecretsKeyringAuthStorage::save, it hands the detailed verification to assert_keyring_saved_auth_and_removed_fallback.

*Call graph*: calls 2 internal fn (new, assert_keyring_saved_auth_and_removed_fallback); 6 external calls (new, default, now, default, write, tempdir).


##### `secrets_keyring_auth_storage_delete_removes_keyring_and_file`  (lines 497–520)

```
fn secrets_keyring_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Checks that deleting secrets-backed auth removes the encrypted secret and any fallback auth.json file. This confirms logout cleans up the newer storage path.

**Data flow**: It creates storage and seeds both the secrets backend and a stale fallback file. It calls delete, then verifies deletion reported success, loading returns nothing, and the fallback file no longer exists.

**Call relations**: The test runner calls it. It uses seed_secrets_backend_and_fallback_auth_file_for_delete to create the mixed state, then exercises SecretsKeyringAuthStorage::delete.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry`  (lines 523–556)

```
fn secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry() -> anyhow::Result<()>
```

**Purpose**: Checks that deleting secrets-backed auth also removes an older direct-keyring credential if one exists. This matters during migration from the old backend to the newer secrets backend.

**Data flow**: It first saves legacy direct-keyring auth, then seeds secrets-backed auth and a stale fallback file. It deletes through SecretsKeyringAuthStorage and verifies the encrypted auth is gone, the direct keyring storage can no longer load credentials, and auth.json was removed.

**Call relations**: The test runner calls this test. It uses DirectKeyringAuthStorage to create legacy state, seed_secrets_backend_and_fallback_auth_file_for_delete for current state, and then tests the cleanup responsibility of SecretsKeyringAuthStorage::delete.

*Call graph*: calls 4 internal fn (new, new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_prefers_keyring_value`  (lines 559–576)

```
fn auto_auth_storage_load_prefers_keyring_value() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage loads the keyring-backed value when both keyring and auth.json contain credentials. This avoids using stale file credentials when safer stored credentials are available.

**Data flow**: It seeds the secrets backend with one auth record and saves a different auth record through the file storage inside AutoAuthStorage. When load is called, the result should be the keyring-backed record, not the file record.

**Call relations**: The test runner calls it. It sets up the two competing storage locations with seed_secrets_backend_with_auth and file_storage.save, then exercises AutoAuthStorage::load.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_with_auth); 4 external calls (new, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_uses_file_when_keyring_empty`  (lines 579–594)

```
fn auto_auth_storage_load_uses_file_when_keyring_empty() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage can still load auth.json when there is no keyring-backed value. This keeps file-based credentials usable as a fallback.

**Data flow**: It creates AutoAuthStorage with an empty mock keyring, saves an auth record only to the internal file storage, then calls load. The loaded result should be the file auth record.

**Call relations**: The test runner calls this test. It focuses on the fallback branch of AutoAuthStorage::load after the keyring path has no credentials to return.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 4 external calls (new, assert_eq!, default, tempdir).


##### `auto_auth_storage_load_falls_back_when_keyring_errors`  (lines 597–617)

```
fn auto_auth_storage_load_falls_back_when_keyring_errors() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage falls back to auth.json if reading the keyring-backed secret fails. This keeps users from being locked out when the system keyring has a temporary problem.

**Data flow**: It seeds encrypted auth, then tells the mock keyring to return an error for the secrets key. It saves a different fallback auth record to auth.json, calls load, and expects the fallback file record.

**Call relations**: The test runner calls it. The test uses seed_secrets_backend_with_auth to create the keyring-backed data, compute_keyring_account to target the mock error, and AutoAuthStorage::load to test the fallback decision.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_with_auth); 6 external calls (new, Invalid, assert_eq!, compute_keyring_account, default, tempdir).


##### `auto_auth_storage_save_prefers_keyring`  (lines 620–636)

```
fn auto_auth_storage_save_prefers_keyring() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage saves to the keyring-backed secrets backend when it can. It also confirms any stale auth.json file is removed after a successful safer save.

**Data flow**: It creates AutoAuthStorage, writes stale credentials to the file fallback, then saves a new auth record through AutoAuthStorage. The shared assertion helper confirms the new auth is in secrets-backed storage and the fallback file is gone.

**Call relations**: The test runner calls this test. It uses auth_with_prefix for both stale and new records, then relies on assert_keyring_saved_auth_and_removed_fallback to verify AutoAuthStorage::save chose the keyring path.

*Call graph*: calls 3 internal fn (new, assert_keyring_saved_auth_and_removed_fallback, auth_with_prefix); 3 external calls (new, default, tempdir).


##### `auto_auth_storage_save_falls_back_when_keyring_errors`  (lines 639–668)

```
fn auto_auth_storage_save_falls_back_when_keyring_errors() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage writes auth.json when saving to the keyring-backed secrets backend fails. This preserves credentials even if secure storage is unavailable.

**Data flow**: It configures the mock keyring to fail for the secrets account, then calls save with an auth record. Afterward, auth.json should exist and contain the auth record, while the keyring should not contain a saved value for the failing key.

**Call relations**: The test runner calls it. It uses compute_keyring_account to set up the simulated keyring error, then tests the fallback branch of AutoAuthStorage::save.

*Call graph*: calls 2 internal fn (new, auth_with_prefix); 7 external calls (new, Invalid, assert!, assert_eq!, compute_keyring_account, default, tempdir).


##### `auto_auth_storage_delete_removes_keyring_and_file`  (lines 671–695)

```
fn auto_auth_storage_delete_removes_keyring_and_file() -> anyhow::Result<()>
```

**Purpose**: Checks that automatic auth storage deletes both keyring-backed credentials and fallback auth.json. This gives logout one cleanup action that covers all storage locations.

**Data flow**: It seeds the secrets backend and a stale fallback auth.json file, then calls AutoAuthStorage::delete. The result should report removal, later load should return nothing, and the fallback file should be gone.

**Call relations**: The test runner calls this test. It uses seed_secrets_backend_and_fallback_auth_file_for_delete to prepare the mixed state, then verifies AutoAuthStorage::delete coordinates cleanup across keyring and file storage.

*Call graph*: calls 3 internal fn (new, auth_with_prefix, seed_secrets_backend_and_fallback_auth_file_for_delete); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### `login/src/auth/auth_tests.rs`

`test` · `test`

Authentication is the front door of the system, so this test file tries many ways a user or automation can prove who they are. It creates temporary home folders, fake auth files, fake JSON Web Tokens (JWTs, signed bundles of identity data), and mock web servers so the tests can act like ChatGPT or an auth service without using the real network. The tests verify that logging in with one credential type clears older credential types, invalid or unsigned tokens do not get saved, environment variables can provide temporary credentials without writing files, and logout really removes stored credentials. They also check policy rules, such as “only this workspace is allowed” or “ChatGPT login is required,” and confirm that bad credentials are removed instead of silently kept. Helper code builds fake auth files, fake agent identity records, signed test tokens, mock server responses, and temporary environment-variable guards. A useful analogy is a security desk drill: this file does not run the real building, but it rehearses many entry scenarios to make sure the guards accept the right badges, reject the wrong ones, and clean up stale passes.

#### Function details

##### `refresh_without_id_token`  (lines 31–60)

```
async fn refresh_without_id_token()
```

**Purpose**: Checks that refreshing stored tokens still keeps the old ID token when no replacement ID token is supplied. This protects user identity details from being accidentally erased during a token refresh.

**Data flow**: It creates a temporary auth file with a fake ID token, then asks the token persistence code to save only new access and refresh tokens. The result should contain the original ID token and the two new tokens.

**Call relations**: This test uses write_auth_file to prepare the stored credentials, then calls the real persist_tokens path to prove refresh updates only the parts it was given.

*Call graph*: calls 2 internal fn (default, write_auth_file); 3 external calls (assert_eq!, persist_tokens, tempdir).


##### `login_with_api_key_overwrites_existing_auth_json`  (lines 63–95)

```
fn login_with_api_key_overwrites_existing_auth_json()
```

**Purpose**: Verifies that logging in with a new API key replaces old mixed credentials. This matters because stale ChatGPT tokens should not remain beside a newly chosen API key.

**Data flow**: It writes an auth.json containing an old API key and old OAuth-style tokens, then runs API-key login with a new key. Reading the file afterward should show the new key and no token block.

**Call relations**: The test sets up the file directly, calls login_with_api_key, and reads it back through FileAuthStorage to confirm the storage layer sees the cleaned result.

*Call graph*: calls 2 internal fn (default, new); 7 external calls (assert!, assert_eq!, json!, to_string_pretty, write, login_with_api_key, tempdir).


##### `login_with_access_token_writes_only_token`  (lines 98–136)

```
async fn login_with_access_token_writes_only_token()
```

**Purpose**: Checks that an agent identity access token login stores only the agent identity credential. Agent identity is a machine-style credential, so old user tokens or API keys must be cleared.

**Data flow**: It builds a signed agent identity JWT, serves the matching public key from a mock server, and logs in with that token. The saved auth file should record AgentIdentity mode and the token, with no ChatGPT tokens or API key.

**Call relations**: This test uses agent_identity_record, signed_agent_identity_jwt, and test_jwks_body to build a realistic signed token flow, then exercises login_with_access_token.

*Call graph*: calls 5 internal fn (default, agent_identity_record, signed_agent_identity_jwt, test_jwks_body, new); 11 external calls (given, start, new, assert!, assert_eq!, format!, json!, login_with_access_token, tempdir, method (+1 more)).


##### `login_with_access_token_writes_only_personal_access_token`  (lines 140–188)

```
async fn login_with_access_token_writes_only_personal_access_token()
```

**Purpose**: Verifies that a personal access token login saves just that token and leaves the older auth mode field out. This keeps the saved file simple and avoids mixing credential types.

**Data flow**: It points the auth API environment variable at a mock server that accepts the token and returns user/workspace details. After login, auth.json should contain only the personal access token-related field and resolve to PersonalAccessToken mode.

**Call relations**: The test uses EnvVarGuard::set to redirect the auth service and personal_access_token_whoami to create the mock response before calling login_with_access_token.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new); 12 external calls (given, start, new, assert!, assert_eq!, from_str, read_to_string, login_with_access_token, tempdir, header (+2 more)).


##### `login_with_access_token_rejects_personal_access_token_workspace_mismatch`  (lines 192–225)

```
async fn login_with_access_token_rejects_personal_access_token_workspace_mismatch()
```

**Purpose**: Checks that a personal access token is rejected when it belongs to a workspace that is not allowed. This prevents saving credentials for the wrong organization.

**Data flow**: It makes the mock whoami endpoint report a disallowed workspace, then attempts login with an allowed-workspace list. The call should fail with permission denied and should not create auth.json.

**Call relations**: This test drives login_with_access_token through the personal-token validation path and uses the mock server to prove the workspace check happened.

*Call graph*: calls 3 internal fn (set, default, personal_access_token_whoami); 10 external calls (given, start, new, assert!, assert_eq!, login_with_access_token, tempdir, header, method, path).


##### `login_with_access_token_rejects_invalid_personal_access_token`  (lines 229–257)

```
async fn login_with_access_token_rejects_invalid_personal_access_token()
```

**Purpose**: Confirms that a personal access token rejected by the auth service is not saved. Bad credentials should fail loudly and leave no local auth file behind.

**Data flow**: It configures the mock whoami endpoint to return a forbidden response, then tries to log in. The result is an error and the temporary home directory remains without auth.json.

**Call relations**: The mock server stands in for the remote auth service, and login_with_access_token is the real code under test.

*Call graph*: calls 2 internal fn (set, default); 9 external calls (given, start, new, assert!, assert_eq!, login_with_access_token, tempdir, method, path).


##### `login_with_access_token_rejects_invalid_jwt`  (lines 260–279)

```
async fn login_with_access_token_rejects_invalid_jwt()
```

**Purpose**: Checks that a token that is not even shaped like a JWT is rejected. This prevents random strings from being treated as agent identity credentials.

**Data flow**: It passes the string not-a-jwt into access-token login. The function should return an error and leave storage untouched.

**Call relations**: This is the simplest negative path for login_with_access_token, with no mock server needed because parsing fails immediately.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert!, assert_eq!, login_with_access_token, tempdir).


##### `login_with_access_token_rejects_unsigned_jwt`  (lines 282–311)

```
async fn login_with_access_token_rejects_unsigned_jwt()
```

**Purpose**: Verifies that an agent identity-looking JWT is rejected if its signature is not valid. This matters because the signature is what proves the token came from a trusted issuer.

**Data flow**: It creates a fake agent identity JWT, serves the trusted public key from a mock endpoint, and tries to log in. Verification should fail and no auth file should be written.

**Call relations**: The test uses fake_agent_identity_jwt for the bad token and test_jwks_body for the trusted key, then confirms login_with_access_token refuses the mismatch.

*Call graph*: calls 4 internal fn (default, agent_identity_record, fake_agent_identity_jwt, test_jwks_body); 9 external calls (given, start, new, assert!, format!, login_with_access_token, tempdir, method, path).


##### `missing_auth_json_returns_none`  (lines 315–327)

```
async fn missing_auth_json_returns_none()
```

**Purpose**: Checks that no stored credentials is treated as “no auth,” not as an error. A clean install should be allowed to start without crashing.

**Data flow**: It creates an empty temporary home, removes the access-token environment variable, and asks CodexAuth to load from storage. The result should be None.

**Call relations**: This test calls CodexAuth::from_auth_storage after remove_access_token_env_var makes sure the environment cannot mask the missing file.

*Call graph*: calls 3 internal fn (default, remove_access_token_env_var, from_auth_storage); 2 external calls (assert_eq!, tempdir).


##### `pro_account_with_no_api_key_uses_chatgpt_auth`  (lines 331–390)

```
async fn pro_account_with_no_api_key_uses_chatgpt_auth()
```

**Purpose**: Verifies that stored ChatGPT token data without an API key loads as ChatGPT authentication. It also checks that user and plan details are decoded correctly.

**Data flow**: It writes an auth file containing a fake ID token for a Pro user and no API key, then loads auth. The loaded object should have ChatGPT mode, no API key, the expected user ID, and refreshed parsed token data.

**Call relations**: The test uses write_auth_file to seed storage and load_auth to exercise the normal loading path.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `loads_api_key_from_auth_json`  (lines 394–419)

```
async fn loads_api_key_from_auth_json()
```

**Purpose**: Checks that an API key saved in auth.json is loaded as API-key authentication. It also confirms token access fails because there are no token credentials.

**Data flow**: It writes a minimal auth.json with OPENAI_API_KEY, loads auth, and inspects the resulting auth object. The mode should be ApiKey and token data should be unavailable.

**Call relations**: This test bypasses helpers for the file content, then uses load_auth to verify the production parser understands that file.

*Call graph*: calls 1 internal fn (remove_access_token_env_var); 5 external calls (assert!, assert_eq!, write, load_auth, tempdir).


##### `logout_removes_auth_file`  (lines 422–448)

```
fn logout_removes_auth_file() -> Result<(), std::io::Error>
```

**Purpose**: Verifies that logout deletes the stored auth file. Without this, a user who logs out might still have usable credentials on disk.

**Data flow**: It saves an API-key auth record, confirms auth.json exists, then calls logout. Afterward the file should be gone and the function should report that something was removed.

**Call relations**: The test uses save_auth to create the same file production code writes, then checks logout against get_auth_file.

*Call graph*: calls 2 internal fn (default, get_auth_file); 3 external calls (assert!, save_auth, tempdir).


##### `unauthorized_recovery_reports_mode_and_step_names`  (lines 452–479)

```
async fn unauthorized_recovery_reports_mode_and_step_names()
```

**Purpose**: Checks the human-readable labels used for unauthorized recovery state. These names are useful for logs, metrics, and debugging.

**Data flow**: It builds two recovery objects, one managed and one external, then asks each for its mode and step names. The strings should match the expected stable names.

**Call relations**: The test creates an AuthManager and directly constructs UnauthorizedRecovery values to inspect their naming helpers.

*Call graph*: calls 2 internal fn (default, shared); 3 external calls (clone, assert_eq!, tempdir).


##### `refresh_failure_is_scoped_to_the_matching_auth_snapshot`  (lines 483–535)

```
async fn refresh_failure_is_scoped_to_the_matching_auth_snapshot()
```

**Purpose**: Ensures a permanent refresh failure is tied only to the exact auth snapshot that failed. Newer credentials should not inherit an old failure.

**Data flow**: It loads an auth record, creates a second version with different tokens, records a refresh failure for the first, and queries both. Only the original auth should report the stored failure.

**Call relations**: This test uses load_auth and CodexAuth::from_auth_dot_json to create two comparable auth states, then drives AuthManager’s failure tracking.

*Call graph*: calls 5 internal fn (remove_access_token_env_var, write_auth_file, from_auth_for_testing, from_auth_dot_json, new); 3 external calls (assert_eq!, load_auth, tempdir).


##### `external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth`  (lines 538–548)

```
fn external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth()
```

**Purpose**: Checks that a plain bearer token from an external source cannot be turned into full ChatGPT auth unless it includes ChatGPT identity metadata. This avoids pretending to know account details that are missing.

**Data flow**: It creates external tokens containing only an access token and asks AuthDotJson to build ChatGPT auth from them. The conversion should fail with a clear message.

**Call relations**: This test exercises AuthDotJson::from_external_tokens through the access_token_only helper.

*Call graph*: calls 1 internal fn (access_token_only); 2 external calls (assert_eq!, from_external_tokens).


##### `external_bearer_only_auth_manager_uses_cached_provider_token`  (lines 551–568)

```
async fn external_bearer_only_auth_manager_uses_cached_provider_token()
```

**Purpose**: Verifies that an external bearer-token provider is called once and its token is cached. This avoids repeatedly launching the provider command for every auth lookup.

**Data flow**: It creates a provider script that would return two different tokens on two calls, then asks the manager for auth twice. Both answers should use the first token.

**Call relations**: ProviderAuthScript::new supplies the fake command, and AuthManager::external_bearer_only is the production path being checked.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 1 external calls (assert_eq!).


##### `external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero`  (lines 571–588)

```
async fn external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero()
```

**Purpose**: Checks that setting the refresh interval to zero disables automatic token refresh. The cached token should remain stable.

**Data flow**: It builds a provider script with two possible tokens, sets refresh_interval_ms to zero, and asks for auth twice. Both reads should return the original token.

**Call relations**: The test modifies ProviderAuthScript::auth_config output before passing it to AuthManager::external_bearer_only.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 1 external calls (assert_eq!).


##### `external_bearer_only_auth_manager_returns_none_when_command_fails`  (lines 591–596)

```
async fn external_bearer_only_auth_manager_returns_none_when_command_fails()
```

**Purpose**: Checks that an external bearer-token manager returns no auth when the provider command fails. This is safer than inventing or reusing unknown credentials.

**Data flow**: It builds a provider script that exits with failure and asks the manager for auth. The manager should return None.

**Call relations**: ProviderAuthScript::new_failing creates the failing command, and AuthManager::external_bearer_only runs it through the real external-token path.

*Call graph*: calls 2 internal fn (new_failing, external_bearer_only); 1 external calls (assert_eq!).


##### `unauthorized_recovery_uses_external_refresh_for_bearer_manager`  (lines 599–626)

```
async fn unauthorized_recovery_uses_external_refresh_for_bearer_manager()
```

**Purpose**: Verifies that bearer-only external auth can recover from an unauthorized response by asking the external provider for a fresh token. This is the refresh path for credentials that Codex cannot refresh itself.

**Data flow**: It reads the first provider token, creates an unauthorized recovery object, runs its next step, and then reads auth again. The token should change from the first scripted token to the refreshed one.

**Call relations**: This test combines ProviderAuthScript::new, AuthManager::external_bearer_only, and the manager’s unauthorized_recovery flow.

*Call graph*: calls 2 internal fn (new, external_bearer_only); 2 external calls (assert!, assert_eq!).


##### `ProviderAuthScript::new`  (lines 635–701)

```
fn new(tokens: &[&str]) -> std::io::Result<Self>
```

**Purpose**: Creates a temporary command-line script that prints one token and then advances to the next token for future calls. Tests use it as a fake external credential provider.

**Data flow**: It receives a list of token strings, writes them to a temporary file, and writes a platform-specific script that prints and removes the first line. It returns a ProviderAuthScript containing the temporary directory, command, and arguments.

**Call relations**: The external bearer-token tests call this helper when they need a provider command that can simulate cached and refreshed tokens.

*Call graph*: called by 3 (external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero, external_bearer_only_auth_manager_uses_cached_provider_token, unauthorized_recovery_uses_external_refresh_for_bearer_manager); 8 external calls (new, new, cfg!, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthScript::new_failing`  (lines 703–740)

```
fn new_failing() -> std::io::Result<Self>
```

**Purpose**: Creates a temporary command that always fails. Tests use it to check how auth behaves when an external credential provider cannot supply a token.

**Data flow**: It creates a temporary directory and writes either a Unix shell script or Windows command setup that exits with an error. It returns the command description wrapped in ProviderAuthScript.

**Call relations**: external_bearer_only_auth_manager_returns_none_when_command_fails calls this helper before building the external bearer-only manager.

*Call graph*: called by 1 (external_bearer_only_auth_manager_returns_none_when_command_fails); 6 external calls (new, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthScript::auth_config`  (lines 742–753)

```
fn auth_config(&self) -> ModelProviderAuthInfo
```

**Purpose**: Turns the temporary provider script into the configuration object expected by the auth manager. This lets tests feed a real-looking external auth command into production code.

**Data flow**: It reads the script’s command, arguments, working directory, and timeout settings, packages them as JSON, and deserializes them into ModelProviderAuthInfo.

**Call relations**: Tests call this after ProviderAuthScript::new or new_failing, then pass the result into AuthManager::external_bearer_only.

*Call graph*: 2 external calls (json!, from_value).


##### `write_auth_file`  (lines 762–777)

```
fn write_auth_file(params: AuthFileParams, codex_home: &Path) -> std::io::Result<String>
```

**Purpose**: Writes a realistic auth.json file for tests. It avoids repeating file setup in every test that needs stored ChatGPT-style credentials.

**Data flow**: It receives desired auth-file parameters and a Codex home path, builds a fake ID token, writes auth.json with that token plus test access and refresh tokens, and returns the fake ID token string.

**Call relations**: Many loading, restriction, refresh, and plan-type tests call this helper; it delegates JWT construction to fake_jwt_for_auth_file_params.

*Call graph*: calls 2 internal fn (fake_jwt_for_auth_file_params, get_auth_file); called by 11 (enforce_login_restrictions_allows_any_matching_workspace_in_list, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_logs_out_for_workspace_mismatch, missing_plan_type_maps_to_unknown, plan_type_maps_enterprise_cbp_usage_based_plan, plan_type_maps_known_plan, plan_type_maps_self_serve_business_usage_based_plan, plan_type_maps_unknown_to_unknown, pro_account_with_no_api_key_uses_chatgpt_auth, refresh_failure_is_scoped_to_the_matching_auth_snapshot (+1 more)); 3 external calls (json!, to_string_pretty, write).


##### `fake_jwt_for_auth_file_params`  (lines 779–813)

```
fn fake_jwt_for_auth_file_params(params: &AuthFileParams) -> std::io::Result<String>
```

**Purpose**: Builds a fake JWT containing user, plan, and optional workspace details for auth-file tests. It is not meant for security; it is test data shaped like a token.

**Data flow**: It reads the requested plan and account ID, inserts them into a JSON payload, base64-url encodes the header, payload, and dummy signature, and returns the three-part token string.

**Call relations**: write_auth_file calls this so tests that load auth.json see token data that looks like production ChatGPT ID-token data.

*Call graph*: called by 1 (write_auth_file); 4 external calls (format!, String, json!, to_vec).


##### `build_config`  (lines 815–828)

```
async fn build_config(
    codex_home: &Path,
    forced_login_method: Option<ForcedLoginMethod>,
    forced_chatgpt_workspace_id: Option<Vec<String>>,
) -> AuthConfig
```

**Purpose**: Creates an AuthConfig for tests with common defaults and optional login restrictions. This keeps restriction tests focused on the rule being tested.

**Data flow**: It takes a Codex home path, an optional forced login method, and an optional allowed workspace list. It returns an AuthConfig using file storage, direct keyring mode, and no custom ChatGPT URL.

**Call relations**: The enforce_login_restrictions tests call this helper before invoking the real restriction checker.

*Call graph*: called by 6 (enforce_login_restrictions_allows_any_matching_workspace_in_list, enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required, enforce_login_restrictions_logs_out_for_method_mismatch, enforce_login_restrictions_logs_out_for_workspace_mismatch); 1 external calls (to_path_buf).


##### `EnvVarGuard::set`  (lines 840–846)

```
fn set(key: &'static str, value: &str) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test and remembers its previous value. This prevents one test’s environment changes from leaking into another.

**Data flow**: It reads the current value of the named variable, sets the variable to the requested value, and returns a guard object holding the old value.

**Call relations**: Tests that need fake auth service URLs or credential environment variables call this; EnvVarGuard::drop restores the old state later.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::remove`  (lines 848–854)

```
fn remove(key: &'static str) -> Self
```

**Purpose**: Temporarily removes an environment variable for a test and remembers what it used to be. This is used when tests need to prove behavior without environment-provided credentials.

**Data flow**: It reads the current value, removes the variable, and returns a guard containing the old value if there was one.

**Call relations**: remove_access_token_env_var wraps this helper for the common Codex access-token variable, and drop restores the environment.

*Call graph*: 2 external calls (remove_var, var_os).


##### `EnvVarGuard::drop`  (lines 859–866)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when the guard goes out of scope. This is cleanup code that keeps tests isolated.

**Data flow**: It checks whether the variable originally had a value. If it did, it sets that value back; otherwise it removes the variable again.

**Call relations**: Rust calls this automatically at the end of tests or scopes that created EnvVarGuard values through set or remove.

*Call graph*: 2 external calls (remove_var, set_var).


##### `remove_access_token_env_var`  (lines 869–871)

```
fn remove_access_token_env_var() -> EnvVarGuard
```

**Purpose**: Removes the Codex access-token environment variable for the duration of a test. This prevents environment auth from interfering with file-based auth scenarios.

**Data flow**: It calls EnvVarGuard::remove with the shared Codex access-token variable name and returns the guard. When the guard is dropped, the original environment is restored.

**Call relations**: Many tests call this before load_auth or enforce_login_restrictions so the stored auth file is the only credential source.

*Call graph*: called by 17 (auth_manager_rejects_stored_personal_access_token_workspace_mismatch, enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set, enforce_login_restrictions_allows_matching_workspace, enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, enforce_login_restrictions_logs_out_for_method_mismatch, enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch, enforce_login_restrictions_logs_out_for_workspace_mismatch, loads_api_key_from_auth_json, missing_auth_json_returns_none (+7 more)); 1 external calls (remove).


##### `load_auth_reads_access_token_from_env`  (lines 875–923)

```
async fn load_auth_reads_access_token_from_env()
```

**Purpose**: Checks that an agent identity token supplied through the environment can be loaded without writing auth.json. This supports temporary credentials in automated environments.

**Data flow**: It sets the access-token environment variable to a signed agent identity JWT, uses mock endpoints for key lookup and task registration, and loads auth. The result should be an AgentIdentity auth object with the expected record and task ID, while disk remains untouched.

**Call relations**: This test combines EnvVarGuard::set, signed_agent_identity_jwt, test_jwks_body, and load_auth to exercise environment-based agent identity loading.

*Call graph*: calls 4 internal fn (set, agent_identity_record, signed_agent_identity_jwt, test_jwks_body); 12 external calls (given, start, new, assert!, assert_eq!, format!, json!, panic!, load_auth, tempdir (+2 more)).


##### `load_auth_reads_personal_access_token_from_env`  (lines 927–979)

```
async fn load_auth_reads_personal_access_token_from_env()
```

**Purpose**: Verifies that a personal access token from the environment loads correctly in both file and ephemeral storage modes. Ephemeral means credentials are kept only in memory for the run.

**Data flow**: It points the auth API to a mock server, sets the access-token environment variable, then loads auth twice with different storage modes. Each result should expose the token and account metadata, and no auth.json should be written.

**Call relations**: The test uses personal_access_token_whoami as the mock whoami response and drives load_auth through the environment-token path.

*Call graph*: calls 3 internal fn (set, default, personal_access_token_whoami); 10 external calls (given, start, new, assert!, assert_eq!, load_auth, tempdir, header, method, path).


##### `auth_manager_rejects_env_personal_access_token_workspace_mismatch`  (lines 983–1013)

```
async fn auth_manager_rejects_env_personal_access_token_workspace_mismatch()
```

**Purpose**: Checks that AuthManager rejects an environment personal access token if it belongs to a disallowed workspace. The manager should expose no usable auth in that case.

**Data flow**: It sets an environment token, makes the mock whoami endpoint report a disallowed workspace, and creates a manager with an allowed-workspace restriction. Asking the manager for auth should return None.

**Call relations**: This test exercises AuthManager::new_with_workspace_restriction using environment credentials and the personal_access_token_whoami mock response.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new_with_workspace_restriction); 9 external calls (given, start, new, assert_eq!, tempdir, vec!, header, method, path).


##### `auth_manager_rejects_stored_personal_access_token_workspace_mismatch`  (lines 1017–1065)

```
async fn auth_manager_rejects_stored_personal_access_token_workspace_mismatch()
```

**Purpose**: Checks that AuthManager also rejects a stored personal access token when workspace restrictions do not match. This covers credentials already saved before a policy change.

**Data flow**: For both file and ephemeral modes, it logs in with a token, then builds a restricted manager whose allowed workspace differs from the token’s workspace. The manager should return no auth.

**Call relations**: The test first calls login_with_access_token to seed storage, then AuthManager::new_with_workspace_restriction to verify policy enforcement at load time.

*Call graph*: calls 5 internal fn (set, default, personal_access_token_whoami, remove_access_token_env_var, new_with_workspace_restriction); 10 external calls (given, start, new, assert_eq!, login_with_access_token, tempdir, vec!, header, method, path).


##### `personal_access_token_does_not_offer_unauthorized_recovery`  (lines 1069–1104)

```
async fn personal_access_token_does_not_offer_unauthorized_recovery()
```

**Purpose**: Verifies that personal access tokens do not offer automatic unauthorized recovery. These tokens cannot be refreshed like OAuth tokens, so retry recovery should be unavailable.

**Data flow**: It loads a personal access token from the environment, asks the manager for unauthorized recovery, and checks that no next step exists. It also calls refresh_token_from_authority to confirm it is harmless for this auth type.

**Call relations**: This test uses EnvVarGuard::set and a mock whoami endpoint, then checks AuthManager’s recovery behavior for PersonalAccessToken mode.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, new); 9 external calls (new, given, start, new, assert!, assert_eq!, tempdir, method, path).


##### `load_auth_keeps_codex_api_key_env_precedence`  (lines 1108–1128)

```
async fn load_auth_keeps_codex_api_key_env_precedence()
```

**Purpose**: Checks that the API-key environment variable wins over an access-token environment variable when API-key env loading is enabled. This preserves the intended credential priority.

**Data flow**: It sets both an access-token-like value and a CODEX_API_KEY value, then loads auth with API-key env support enabled. The resulting auth should use the API key.

**Call relations**: The test uses fake_agent_identity_jwt only as a competing access-token value, while load_auth decides which environment credential takes precedence.

*Call graph*: calls 3 internal fn (set, agent_identity_record, fake_agent_identity_jwt); 3 external calls (assert_eq!, load_auth, tempdir).


##### `enforce_login_restrictions_logs_out_for_method_mismatch`  (lines 1132–1158)

```
async fn enforce_login_restrictions_logs_out_for_method_mismatch()
```

**Purpose**: Checks that stored API-key auth is removed when configuration requires ChatGPT login. This prevents a forbidden login method from remaining active.

**Data flow**: It logs in with an API key, builds a config that forces ChatGPT login, and runs restriction enforcement. The function should return an error and delete auth.json.

**Call relations**: This test uses build_config to create the policy and calls enforce_login_restrictions to exercise the production cleanup behavior.

*Call graph*: calls 3 internal fn (default, build_config, remove_access_token_env_var); 3 external calls (assert!, enforce_login_restrictions, tempdir).


##### `enforce_login_restrictions_logs_out_for_workspace_mismatch`  (lines 1162–1193)

```
async fn enforce_login_restrictions_logs_out_for_workspace_mismatch()
```

**Purpose**: Checks that stored ChatGPT auth is removed when its workspace does not match the allowed list. This avoids accidentally operating under the wrong organization.

**Data flow**: It writes an auth file whose account ID is disallowed, builds a config with a different allowed workspace, and enforces restrictions. The result should be an error and no auth.json.

**Call relations**: write_auth_file seeds the mismatched credentials, build_config supplies the policy, and enforce_login_restrictions performs the check.

*Call graph*: calls 3 internal fn (build_config, remove_access_token_env_var, write_auth_file); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch`  (lines 1197–1242)

```
async fn enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch()
```

**Purpose**: Verifies that a stored personal access token is deleted when its workspace does not match the configured allowed workspace. The error should also explain the current workspace.

**Data flow**: It logs in with a personal access token whose mock whoami response reports a disallowed workspace, then enforces a different workspace restriction. The auth file should be removed and the error should mention the mismatched account.

**Call relations**: The test uses login_with_access_token to create stored personal-token auth, then calls enforce_login_restrictions with a restricted AuthConfig.

*Call graph*: calls 4 internal fn (set, default, personal_access_token_whoami, remove_access_token_env_var); 10 external calls (given, start, new, assert!, enforce_login_restrictions, login_with_access_token, tempdir, vec!, method, path).


##### `enforce_login_restrictions_allows_matching_workspace`  (lines 1246–1273)

```
async fn enforce_login_restrictions_allows_matching_workspace()
```

**Purpose**: Checks that stored ChatGPT auth is accepted when its workspace matches the allowed workspace. Passing credentials should not be deleted.

**Data flow**: It writes an auth file with the allowed workspace ID, builds the matching restriction config, and runs enforcement. The call should succeed and auth.json should remain.

**Call relations**: This is the positive counterpart to the workspace-mismatch tests, using write_auth_file, build_config, and enforce_login_restrictions.

*Call graph*: calls 3 internal fn (build_config, remove_access_token_env_var, write_auth_file); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_allows_any_matching_workspace_in_list`  (lines 1277–1302)

```
async fn enforce_login_restrictions_allows_any_matching_workspace_in_list()
```

**Purpose**: Verifies that a credential is allowed if its workspace matches any one item in a configured list. This supports policies with multiple allowed workspaces.

**Data flow**: It writes credentials for one workspace and builds a config containing that workspace plus another. Enforcement should succeed.

**Call relations**: The test uses build_config to supply a multi-workspace policy and write_auth_file to seed matching stored auth.

*Call graph*: calls 2 internal fn (build_config, write_auth_file); 3 external calls (enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch`  (lines 1306–1366)

```
async fn enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch()
```

**Purpose**: Checks that stored agent identity credentials are deleted if their account does not match the allowed workspace. Agent identities must obey the same workspace policy as user tokens.

**Data flow**: It saves a signed agent identity for a disallowed workspace, serves verification and task-registration mock endpoints, and enforces an allowed workspace config. Enforcement should fail and remove auth.json.

**Call relations**: The test uses agent_identity_record, signed_agent_identity_jwt, test_jwks_body, save_auth, and enforce_login_restrictions together to cover the agent-identity path.

*Call graph*: calls 6 internal fn (set, default, agent_identity_record, remove_access_token_env_var, signed_agent_identity_jwt, test_jwks_body); 11 external calls (given, start, new, assert!, format!, json!, enforce_login_restrictions, tempdir, vec!, method (+1 more)).


##### `enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set`  (lines 1370–1396)

```
async fn enforce_login_restrictions_allows_api_key_if_login_method_not_set_but_forced_chatgpt_workspace_id_is_set()
```

**Purpose**: Checks that an API key is allowed when only a workspace restriction is set and no login method is forced. Workspace checks apply to ChatGPT-like account credentials, not plain API keys in this case.

**Data flow**: It logs in with an API key, builds a config with allowed workspaces but no forced login method, and enforces restrictions. The call should succeed and keep auth.json.

**Call relations**: This test uses build_config and enforce_login_restrictions to document the intended exception for API-key auth.

*Call graph*: calls 3 internal fn (default, build_config, remove_access_token_env_var); 4 external calls (assert!, enforce_login_restrictions, tempdir, vec!).


##### `enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required`  (lines 1400–1419)

```
async fn enforce_login_restrictions_blocks_env_api_key_when_chatgpt_required()
```

**Purpose**: Verifies that an API key from the environment does not satisfy a policy requiring ChatGPT login. The rule applies even if the API key was not stored on disk.

**Data flow**: It sets the API-key environment variable, removes the access-token environment variable, builds a config forcing ChatGPT login, and enforces restrictions. The result should be an error explaining the mismatch.

**Call relations**: This test uses EnvVarGuard::set, remove_access_token_env_var, build_config, and enforce_login_restrictions to check environment credential policy.

*Call graph*: calls 3 internal fn (set, build_config, remove_access_token_env_var); 3 external calls (assert!, enforce_login_restrictions, tempdir).


##### `agent_identity_record`  (lines 1421–1433)

```
fn agent_identity_record(account_id: &str) -> AgentIdentityAuthRecord
```

**Purpose**: Builds a test agent identity record for a given account ID. The record contains the fields an agent identity token normally carries, including generated private key material.

**Data flow**: It receives an account ID, generates agent key material, and returns an AgentIdentityAuthRecord with fixed test user, email, plan, and FedRAMP values.

**Call relations**: Agent identity login, environment-token, workspace-restriction, and plan-alias tests call this before creating fake or signed JWTs.

*Call graph*: called by 6 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_keeps_codex_api_key_env_precedence, load_auth_reads_access_token_from_env, login_with_access_token_rejects_unsigned_jwt, login_with_access_token_writes_only_token); 1 external calls (generate_agent_key_material).


##### `fake_agent_identity_jwt`  (lines 1435–1437)

```
fn fake_agent_identity_jwt(record: &AgentIdentityAuthRecord) -> std::io::Result<String>
```

**Purpose**: Creates an unsigned-looking fake agent identity JWT for tests that need an invalid token. It uses the record’s normal plan type.

**Data flow**: It converts the record’s plan type into JSON and passes the record plus that value to fake_agent_identity_jwt_with_plan_type. The output is a JWT-shaped string with a dummy signature.

**Call relations**: Negative tests such as unsigned-token rejection and API-key precedence use this as test input.

*Call graph*: calls 1 internal fn (fake_agent_identity_jwt_with_plan_type); called by 2 (load_auth_keeps_codex_api_key_env_precedence, login_with_access_token_rejects_unsigned_jwt); 1 external calls (to_value).


##### `fake_agent_identity_jwt_with_plan_type`  (lines 1439–1461)

```
fn fake_agent_identity_jwt_with_plan_type(
    record: &AgentIdentityAuthRecord,
    plan_type: serde_json::Value,
) -> std::io::Result<String>
```

**Purpose**: Builds a JWT-shaped agent identity token with a chosen plan value and a dummy signature. It is useful for testing parsing without producing a trusted signature.

**Data flow**: It base64-url encodes a fixed header, a payload made from the record and supplied plan type, and a fake signature, then joins them with dots.

**Call relations**: fake_agent_identity_jwt calls this helper to make invalid but realistically shaped agent identity tokens.

*Call graph*: called by 1 (fake_agent_identity_jwt); 3 external calls (format!, json!, to_vec).


##### `signed_agent_identity_jwt`  (lines 1463–1486)

```
fn signed_agent_identity_jwt(
    record: &AgentIdentityAuthRecord,
    plan_type: serde_json::Value,
) -> jsonwebtoken::errors::Result<String>
```

**Purpose**: Creates a properly signed test agent identity JWT. Tests use it when they need the production verification path to accept the token.

**Data flow**: It builds a JWT header with a test key ID, fills a payload from the agent identity record and plan type, and signs it with the embedded RSA private key. The result is a valid token string for the mock public key.

**Call relations**: Agent identity login, environment loading, workspace enforcement, and plan-alias tests call this along with test_jwks_body.

*Call graph*: called by 4 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_reads_access_token_from_env, login_with_access_token_writes_only_token); 4 external calls (json!, from_rsa_pem, new, encode).


##### `test_jwks_body`  (lines 1488–1499)

```
fn test_jwks_body() -> serde_json::Value
```

**Purpose**: Returns the mock public-key response used to verify signed agent identity tokens. JWKS means JSON Web Key Set, a JSON format for publishing public signing keys.

**Data flow**: It produces a JSON object containing one RSA public key with the test key ID. Mock servers return this body to the code under test.

**Call relations**: Tests using signed_agent_identity_jwt mount this response so production verification can find the matching public key.

*Call graph*: called by 5 (assert_agent_identity_plan_alias, enforce_login_restrictions_logs_out_for_agent_identity_workspace_mismatch, load_auth_reads_access_token_from_env, login_with_access_token_rejects_unsigned_jwt, login_with_access_token_writes_only_token); 1 external calls (json!).


##### `personal_access_token_whoami`  (lines 1501–1509)

```
fn personal_access_token_whoami(account_id: &str) -> serde_json::Value
```

**Purpose**: Builds a fake response for the personal-access-token whoami endpoint. It tells tests what account, user, email, plan, and FedRAMP status the token should represent.

**Data flow**: It receives an account ID and returns JSON containing fixed user details plus that account ID. Mock auth servers send this response when validating a personal access token.

**Call relations**: Personal-token login, loading, restriction, and recovery tests use this helper as the mock server’s successful response.

*Call graph*: called by 7 (auth_manager_rejects_env_personal_access_token_workspace_mismatch, auth_manager_rejects_stored_personal_access_token_workspace_mismatch, enforce_login_restrictions_logs_out_for_personal_access_token_workspace_mismatch, load_auth_reads_personal_access_token_from_env, login_with_access_token_rejects_personal_access_token_workspace_mismatch, login_with_access_token_writes_only_personal_access_token, personal_access_token_does_not_offer_unauthorized_recovery); 1 external calls (json!).


##### `agent_identity_plan_type_maps_raw_enterprise_alias`  (lines 1542–1544)

```
async fn agent_identity_plan_type_maps_raw_enterprise_alias()
```

**Purpose**: Checks that the raw plan string hc maps to the Enterprise plan type for agent identity auth. This supports legacy or alternate naming from token issuers.

**Data flow**: It passes the JSON string hc and the expected Enterprise plan into the shared alias assertion helper. The helper performs the full signed-token load.

**Call relations**: This small test delegates the setup and verification work to assert_agent_identity_plan_alias.

*Call graph*: calls 1 internal fn (assert_agent_identity_plan_alias); 1 external calls (json!).


##### `agent_identity_plan_type_maps_raw_education_alias`  (lines 1548–1550)

```
async fn agent_identity_plan_type_maps_raw_education_alias()
```

**Purpose**: Checks that the raw plan string education maps to the Edu plan type for agent identity auth. This keeps plan reporting consistent even when raw token values differ.

**Data flow**: It passes the JSON string education and the expected Edu plan into the shared alias assertion helper. The helper verifies the loaded auth’s plan type.

**Call relations**: Like the enterprise-alias test, it relies on assert_agent_identity_plan_alias for the signed-token and mock-server flow.

*Call graph*: calls 1 internal fn (assert_agent_identity_plan_alias); 1 external calls (json!).


##### `assert_agent_identity_plan_alias`  (lines 1552–1582)

```
async fn assert_agent_identity_plan_alias(
    plan_type: serde_json::Value,
    expected_plan_type: AccountPlanType,
)
```

**Purpose**: Shared helper that verifies a raw agent identity plan value maps to an expected account plan type. It prevents duplicate setup across alias tests.

**Data flow**: It creates a record, signs a JWT using the supplied plan value, serves mock key and task-registration endpoints, loads agent identity auth, and compares the resulting plan type to the expected value.

**Call relations**: The raw enterprise and education alias tests call this helper; it uses agent_identity_record, signed_agent_identity_jwt, test_jwks_body, EnvVarGuard::set, and CodexAuth::from_agent_identity_jwt.

*Call graph*: calls 5 internal fn (set, agent_identity_record, signed_agent_identity_jwt, test_jwks_body, from_agent_identity_jwt); called by 2 (agent_identity_plan_type_maps_raw_education_alias, agent_identity_plan_type_maps_raw_enterprise_alias); 8 external calls (given, start, new, format!, json!, assert_eq!, method, path).


##### `plan_type_maps_known_plan`  (lines 1586–1612)

```
async fn plan_type_maps_known_plan()
```

**Purpose**: Checks that a stored ChatGPT plan string for Pro maps to the public Pro account plan type. Plan mapping affects feature gating and display.

**Data flow**: It writes an auth file with chatgpt_plan_type set to pro, loads auth, and checks account_plan_type. The result should be Pro.

**Call relations**: This test uses write_auth_file and load_auth to exercise plan mapping from stored token metadata.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_self_serve_business_usage_based_plan`  (lines 1616–1645)

```
async fn plan_type_maps_self_serve_business_usage_based_plan()
```

**Purpose**: Verifies that the self_serve_business_usage_based plan string maps to the matching account plan enum value. This keeps newer business billing plans recognizable.

**Data flow**: It writes a fake auth file with that plan string, loads auth, and inspects the mapped account plan type. The result should be SelfServeBusinessUsageBased.

**Call relations**: The test follows the same write_auth_file plus load_auth pattern as the other stored-plan mapping tests.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_enterprise_cbp_usage_based_plan`  (lines 1649–1678)

```
async fn plan_type_maps_enterprise_cbp_usage_based_plan()
```

**Purpose**: Checks that the enterprise_cbp_usage_based plan string maps to the correct account plan type. This protects handling of a specific enterprise billing plan.

**Data flow**: It stores that plan value in a fake auth file, loads the auth object, and compares the exposed plan type. The expected result is EnterpriseCbpUsageBased.

**Call relations**: This is one member of the plan mapping test set that uses write_auth_file and load_auth.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `plan_type_maps_unknown_to_unknown`  (lines 1682–1708)

```
async fn plan_type_maps_unknown_to_unknown()
```

**Purpose**: Verifies that an unrecognized plan string maps to Unknown instead of failing. This lets the system tolerate new or unexpected plan names safely.

**Data flow**: It writes an auth file with a made-up plan string, loads auth, and reads the account plan type. The result should be Unknown.

**Call relations**: The test uses the shared auth-file helper and the normal load_auth path to document graceful handling of unknown plan values.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


##### `missing_plan_type_maps_to_unknown`  (lines 1712–1738)

```
async fn missing_plan_type_maps_to_unknown()
```

**Purpose**: Checks that missing plan information maps to Unknown. This avoids crashes or misleading defaults when older tokens do not include a plan.

**Data flow**: It writes an auth file without a chatgpt_plan_type field, loads auth, and checks the exposed account plan type. The result should be Unknown.

**Call relations**: This completes the stored-token plan mapping coverage using write_auth_file and load_auth.

*Call graph*: calls 2 internal fn (remove_access_token_env_var, write_auth_file); 3 external calls (assert_eq!, load_auth, tempdir).


### `login/src/auth/bedrock_api_key_tests.rs`

`test` · `test run`

This is a test file for the authentication system. Authentication is the part of the app that remembers who the user is allowed to act as, usually by storing a key or token. These tests focus on Bedrock API key login, where the user provides an Amazon Bedrock API key plus an AWS region.

Each test creates a temporary Codex home folder, like giving the app a fresh empty desk to work on. The tests then save or create auth data in that folder and ask the normal AuthManager to read it back. This checks the real storage path rather than only checking small pieces in isolation.

The important behavior is that only one main login method should be active at a time. If a user logs in with Bedrock after using an OpenAI API key, the old OpenAI key should disappear. If they later log in with an OpenAI API key, the Bedrock key should disappear. Logout should remove Bedrock credentials entirely. One test also covers older or partial stored data where a Bedrock key exists but the auth mode is missing; the app should still treat that as Bedrock login.

The small helper functions build expected auth records so the tests can compare the whole saved file exactly.

#### Function details

##### `api_key_auth`  (lines 14–24)

```
fn api_key_auth() -> AuthDotJson
```

**Purpose**: Builds a sample stored authentication record for a normal OpenAI API key login. The tests use it as the expected shape of the auth file when OpenAI API key login is active.

**Data flow**: It takes no input. It creates an AuthDotJson value with the auth mode set to API key, the OpenAI key filled in, and all other credential fields empty. It returns that ready-made value for saving or comparison.

**Call relations**: The replacement test uses this helper to seed the temporary auth storage with an existing OpenAI API key before trying a Bedrock login. The API-key-after-Bedrock test also compares the final saved auth file to this same expected record.

*Call graph*: called by 1 (login_with_bedrock_api_key_replaces_openai_auth).


##### `bedrock_only_auth`  (lines 26–36)

```
fn bedrock_only_auth() -> AuthDotJson
```

**Purpose**: Builds a stored authentication record that contains Bedrock credentials but does not explicitly say which auth mode is active. This represents a partial or older saved state that the app still needs to understand.

**Data flow**: It takes no input. It asks bedrock_auth for the sample Bedrock key and region, puts that into an AuthDotJson value, leaves auth_mode empty, and leaves all other credential fields empty. It returns this incomplete-but-usable stored auth record.

**Call relations**: The test for Bedrock-only stored data writes this value directly to disk, then starts AuthManager to confirm that the wider auth system can infer Bedrock login from the saved Bedrock credentials.

*Call graph*: calls 1 internal fn (bedrock_auth); called by 1 (bedrock_only_auth_storage_creates_primary_auth).


##### `bedrock_auth`  (lines 38–43)

```
fn bedrock_auth() -> BedrockApiKeyAuth
```

**Purpose**: Builds the standard sample Bedrock credential used throughout these tests. It keeps the expected API key and region in one place so the tests compare against the same value they set up.

**Data flow**: It takes no input. It creates a BedrockApiKeyAuth value containing the test API key and the test AWS region. It returns that value to callers.

**Call relations**: The helper for Bedrock-only stored data uses it when constructing test storage. The replacement test also uses it when checking that AuthManager cached exactly the Bedrock credentials that were logged in.

*Call graph*: called by 2 (bedrock_only_auth, login_with_bedrock_api_key_replaces_openai_auth).


##### `login_with_bedrock_api_key_replaces_openai_auth`  (lines 47–92)

```
async fn login_with_bedrock_api_key_replaces_openai_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that logging in with a Bedrock API key replaces an existing OpenAI API key login. This matters because the app should not keep two competing primary credentials in the same auth file.

**Data flow**: It starts with a fresh temporary Codex home folder. It saves a fake OpenAI API key auth record there, then calls the Bedrock login routine with a Bedrock key and region. After that, it creates an AuthManager, reloads the stored auth file, and checks that the OpenAI key is gone, the auth mode is Bedrock API key, and the in-memory cached auth is the expected Bedrock credential.

**Call relations**: This test drives the real login function and then asks AuthManager to read the result back, which connects the write side and read side of authentication. It uses api_key_auth to create the starting state and bedrock_auth to define the expected final Bedrock credential.

*Call graph*: calls 5 internal fn (default, api_key_auth, bedrock_auth, new, new); 2 external calls (assert_eq!, tempdir).


##### `logout_removes_bedrock_auth`  (lines 96–120)

```
async fn logout_removes_bedrock_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that logging out after Bedrock API key login removes the saved Bedrock credentials and clears the in-memory auth cache. This protects users from staying logged in after they asked to log out.

**Data flow**: It creates a temporary Codex home folder, logs in with the sample Bedrock key and region, and then creates an AuthManager for that folder. It calls logout on the manager. The expected result is that logout reports success, the auth file is gone or empty, and the manager no longer has cached authentication.

**Call relations**: This test first uses the normal Bedrock login path to create real stored credentials. It then exercises AuthManager.logout and verifies both the file storage layer and the manager's cached state agree that the user is logged out.

*Call graph*: calls 3 internal fn (default, new, new); 3 external calls (assert!, assert_eq!, tempdir).


##### `bedrock_only_auth_storage_creates_primary_auth`  (lines 124–151)

```
async fn bedrock_only_auth_storage_creates_primary_auth() -> anyhow::Result<()>
```

**Purpose**: Checks that stored Bedrock credentials are enough for the app to treat Bedrock as the active login method, even when the stored auth mode field is missing. This helps keep existing or imperfect auth files usable.

**Data flow**: It creates a temporary Codex home folder and writes an auth file that contains only the Bedrock credential. Then it starts AuthManager for that folder. The output it checks is AuthManager's view of the world: the active mode should be Bedrock API key, and the cached credential should match the sample Bedrock key and region.

**Call relations**: This test bypasses the login function and writes the stored auth shape directly, using bedrock_only_auth. It then relies on AuthManager startup logic to interpret that stored data and create the primary in-memory authentication state.

*Call graph*: calls 4 internal fn (default, bedrock_only_auth, new, new); 2 external calls (assert_eq!, tempdir).


##### `login_with_api_key_clears_bedrock_api_key`  (lines 154–174)

```
async fn login_with_api_key_clears_bedrock_api_key() -> anyhow::Result<()>
```

**Purpose**: Checks the reverse replacement case: logging in with an OpenAI API key should clear any saved Bedrock API key. This keeps the auth file unambiguous when the user switches login methods.

**Data flow**: It starts with a fresh temporary Codex home folder and logs in with Bedrock credentials. It then calls the regular API key login function with a sample OpenAI key. Finally, it reloads the auth file and checks that it contains only the OpenAI API key record, with no Bedrock credential left behind.

**Call relations**: This test uses the Bedrock login path to create the starting state, then hands control to the existing OpenAI API key login routine. The final comparison to api_key_auth proves that switching login methods cleans up the old Bedrock-specific data.

*Call graph*: calls 2 internal fn (default, new); 3 external calls (assert_eq!, login_with_api_key, tempdir).


### Login journey integrations
These integration tests cover the main user login entry points, from CLI invocation through device-code and browser-based server flows.

### `cli/tests/login.rs`

`test` · `test run`

This is a test file for the `codex login` command. Its job is to make sure login behaves safely and predictably from a user's point of view. Each test creates a temporary Codex home folder, like giving the app a fresh private workspace, so it does not touch a real user's files. The tests also force credentials to be stored in a local `auth.json` file, which makes the results easy to inspect.

The first test checks the simplest path: a user pipes an API key into standard input, and Codex writes that key into `auth.json` without also writing unrelated token data. The second test checks a failure case: if a user provides text that is not a valid JWT access token, the command should reject it and print an error instead of saving bad credentials. A JWT is a signed-looking token format made of dot-separated parts.

The largest test checks the device-login flow, where Codex talks to an OAuth-style server to get tokens. OAuth is a common web sign-in system for granting access without sharing a password. Here, a fake local server stands in for the real service. The test starts with old saved tokens, verifies Codex first sends a revoke request for the old refresh token, then checks it continues through the expected device-auth steps and saves the new refresh token.

#### Function details

##### `codex_command`  (lines 18–22)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper builds a command object for running the `codex` binary in tests. It also points the command at a temporary Codex home folder so the test stays isolated from the real machine.

**Data flow**: It receives a path to a test-only Codex home directory. It finds the compiled `codex` program, creates a command runner for it, sets the `CODEX_HOME` environment variable to the given path, and returns that prepared command or an error if setup fails.

**Call relations**: The login tests call this whenever they need to run the real CLI. After this helper prepares the command, each test adds its own arguments, input, and environment settings before asserting whether the command succeeds or fails.

*Call graph*: called by 3 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_access_token_rejects_invalid_jwt, login_with_api_key_reads_stdin_and_writes_auth_json); 2 external calls (new, cargo_bin).


##### `write_file_auth_config`  (lines 24–30)

```
fn write_file_auth_config(codex_home: &Path) -> Result<()>
```

**Purpose**: This helper writes a small configuration file that tells Codex to store login credentials in a plain file. That makes the tests able to read back and verify exactly what was saved.

**Data flow**: It receives the path to the temporary Codex home directory. It writes `config.toml` there with the setting `cli_auth_credentials_store = "file"`, then returns success or any file-writing error.

**Call relations**: Each test calls this before running `codex login`. It sets up the storage behavior that later lets `read_auth_json` inspect the saved credentials.

*Call graph*: called by 3 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_access_token_rejects_invalid_jwt, login_with_api_key_reads_stdin_and_writes_auth_json); 2 external calls (join, write).


##### `read_auth_json`  (lines 32–35)

```
fn read_auth_json(codex_home: &Path) -> Result<Value>
```

**Purpose**: This helper reads Codex's saved login data from `auth.json`. Tests use it to confirm that the login command saved the right credential values and did not save the wrong ones.

**Data flow**: It receives the temporary Codex home path, reads the `auth.json` file inside it as text, parses that text as JSON, and returns the parsed JSON value or an error if reading or parsing fails.

**Call relations**: The successful login tests call this after running the CLI. It turns the saved file into data the test can compare against expected values.

*Call graph*: called by 2 (device_login_revokes_existing_auth_before_requesting_new_tokens, login_with_api_key_reads_stdin_and_writes_auth_json); 3 external calls (join, from_str, read_to_string).


##### `login_with_api_key_reads_stdin_and_writes_auth_json`  (lines 38–60)

```
fn login_with_api_key_reads_stdin_and_writes_auth_json() -> Result<()>
```

**Purpose**: This test verifies that API-key login accepts a key typed or piped through standard input and saves it correctly. It also checks that token-based fields are not accidentally written during API-key login.

**Data flow**: It creates a temporary Codex home, writes the file-based credential configuration, then runs `codex login --with-api-key` with `sk-test` supplied on standard input. After the command succeeds and reports a successful login, it reads `auth.json` and checks that `OPENAI_API_KEY` is `sk-test` while `tokens` and `agent_identity` are absent.

**Call relations**: This test relies on `write_file_auth_config` for setup, `codex_command` to run the CLI, and `read_auth_json` to inspect the result. It exercises the API-key login path end to end from command input to saved file.

*Call graph*: calls 3 internal fn (codex_command, read_auth_json, write_file_auth_config); 4 external calls (new, assert!, assert_eq!, contains).


##### `login_with_access_token_rejects_invalid_jwt`  (lines 63–75)

```
fn login_with_access_token_rejects_invalid_jwt() -> Result<()>
```

**Purpose**: This test verifies that access-token login refuses input that is not shaped like a valid JWT token. This protects users from thinking they are logged in when the saved credential would not work.

**Data flow**: It creates a temporary Codex home, enables file-based credential storage, then runs `codex login --with-access-token` with `not-a-jwt` on standard input. The expected result is command failure, with an error message saying access-token login failed.

**Call relations**: This test uses `write_file_auth_config` and `codex_command` for setup and execution. Unlike the successful tests, it does not read `auth.json`, because the important behavior is that the command rejects the bad input.

*Call graph*: calls 2 internal fn (codex_command, write_file_auth_config); 2 external calls (new, contains).


##### `device_login_revokes_existing_auth_before_requesting_new_tokens`  (lines 78–176)

```
async fn device_login_revokes_existing_auth_before_requesting_new_tokens() -> Result<()>
```

**Purpose**: This test verifies a safety rule in device login: if old OAuth tokens already exist, Codex should revoke the old refresh token before asking for new tokens. That helps avoid leaving stale access credentials active.

**Data flow**: It starts a fake local OAuth server and programs it to expect four requests: revoke the old token, request a user code, exchange device authorization details, and finally obtain new tokens. It creates a temporary Codex home with an existing `auth.json` containing old tokens, runs `codex login --device-auth` against the fake issuer, then reads the server's received requests and the final `auth.json`. The test confirms the request order, checks that the revoke request contains the old refresh token and client ID, and verifies that the saved refresh token is now the new one.

**Call relations**: This asynchronous test combines the helper functions with a mock server. `write_file_auth_config` prepares file storage, `codex_command` runs the CLI against the fake OAuth service, and `read_auth_json` confirms the new saved credentials. The mock server records the network calls so the test can prove Codex revoked first and only then continued the login flow.

*Call graph*: calls 3 internal fn (codex_command, read_auth_json, write_file_auth_config); 12 external calls (given, start, new, new, assert_eq!, format!, json!, contains, to_vec, write (+2 more)).


### `login/tests/suite/device_code_login.rs`

`test` · `test run`

This is an integration test file. It pretends to be the login server by starting a small fake HTTP server, then runs the real device-code login code against it. That lets the tests check the full login journey without contacting the real service.

The device-code flow works like a coat-check ticket. First the app asks the server for a short user code. The user would normally enter that code in a browser. Meanwhile, the app keeps asking the server, “Has this code been approved yet?” Once approved, the server gives back an authorization code, and the app exchanges that for login tokens.

The helpers in this file set up fake server responses for each step: giving out a user code, making the first polling attempt fail or wait, returning final tokens, or returning errors. The tests then verify what happens afterward by reading the saved auth file from a temporary Codex home directory.

The important behavior is that successful login persists tokens, workspace restrictions are enforced, and failed login attempts do not leave behind an auth file. This protects users from ending up half-logged-in or logged into the wrong workspace.

#### Function details

##### `make_jwt`  (lines 30–36)

```
fn make_jwt(payload: serde_json::Value) -> String
```

**Purpose**: Builds a simple fake JSON Web Token, or JWT, which is a compact string normally used to carry identity information. The tests use it to pretend that the login server returned an identity token with chosen account details.

**Data flow**: It takes a JSON payload chosen by the test, adds a basic token header, turns both pieces into bytes, encodes them in URL-safe base64 text, and joins them with a fake signature. The result is a token-shaped string that the login code can read during the test.

**Call relations**: The success, workspace-mismatch, and no-API-key tests call this helper when they need an identity token with specific contents. It relies on JSON construction and byte serialization, then hands the finished token to the mocked OAuth token response.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 3 external calls (format!, json!, to_vec).


##### `mock_usercode_success`  (lines 38–49)

```
async fn mock_usercode_success(server: &MockServer)
```

**Purpose**: Sets up the fake server to successfully answer the first device-login request. This mimics the real server giving the command-line app a device authorization ID and a user-facing code.

**Data flow**: It receives the mock server, registers a POST route for the user-code endpoint, and configures that route to return a successful JSON response. After this setup, any matching request gets the fake device auth ID, user code, and a zero polling interval so the test does not wait.

**Call relations**: Most tests call this before running the login flow, because the flow must start by getting a user code. It uses WireMock route matching and response building, then leaves the fake server ready for `run_device_code_login` to contact it.

*Call graph*: called by 4 (device_code_login_integration_handles_error_payload, device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 5 external calls (given, new, json!, method, path).


##### `mock_usercode_failure`  (lines 51–57)

```
async fn mock_usercode_failure(server: &MockServer, status: u16)
```

**Purpose**: Sets up the fake server to reject the first device-login request. This lets the test prove that an early server failure is reported and does not create saved credentials.

**Data flow**: It takes the mock server and an HTTP status number, registers the user-code endpoint, and makes that endpoint return only that status. The output is not a value, but a changed mock server that will fail the login request.

**Call relations**: The user-code HTTP failure test calls this instead of the success helper. It prepares the first request to fail, so when `run_device_code_login` runs, the test can check that the error bubbles up and no auth file is written.

*Call graph*: called by 1 (device_code_login_integration_handles_usercode_http_failure); 4 external calls (given, new, method, path).


##### `mock_poll_token_two_step`  (lines 59–82)

```
async fn mock_poll_token_two_step(
    server: &MockServer,
    counter: Arc<AtomicUsize>,
    first_response_status: u16,
)
```

**Purpose**: Sets up the fake server so the polling step fails or waits once, then succeeds on the second try. This matches the real device-code flow, where approval may not be ready immediately.

**Data flow**: It receives the mock server, a shared counter, and the status to return for the first polling request. Each time the token polling endpoint is called, it increments the counter: the first call returns the chosen status, and the second call returns an authorization code plus proof strings needed for the next exchange.

**Call relations**: The main success-style tests use this helper after the user-code step. It connects the fake server to the login code’s polling loop, so `run_device_code_login` can experience a realistic first miss followed by approval.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 3 external calls (given, method, path).


##### `mock_poll_token_single`  (lines 84–90)

```
async fn mock_poll_token_single(server: &MockServer, endpoint: &str, response: ResponseTemplate)
```

**Purpose**: Sets up one fake response for a chosen polling-related endpoint. It is a flexible helper for tests that need a specific error or unusual response.

**Data flow**: It takes the mock server, an endpoint path, and a prepared response. It registers a POST route for that path and attaches the response, so the next matching request gets exactly what the test specified.

**Call relations**: The error-payload test uses this to make the device token endpoint return an authorization error. It hands off the custom response setup to WireMock so the real login flow can be tested against that failure.

*Call graph*: called by 1 (device_code_login_integration_handles_error_payload); 3 external calls (given, method, path).


##### `mock_oauth_token_single`  (lines 92–102)

```
async fn mock_oauth_token_single(server: &MockServer, jwt: String)
```

**Purpose**: Sets up the fake OAuth token exchange. OAuth is the standard login protocol step where a short authorization code is exchanged for longer-lived access and refresh tokens.

**Data flow**: It receives the mock server and a fake ID token string. It registers the `/oauth/token` endpoint to return access, refresh, and ID tokens in a successful JSON response. The changed mock server is then ready for the final part of login.

**Call relations**: The tests that reach the token-exchange stage call this after setting up polling. When `run_device_code_login` finishes polling, this mock supplies the tokens that the test later expects to find in the saved auth file.

*Call graph*: called by 3 (device_code_login_integration_persists_without_api_key_on_exchange_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 5 external calls (given, new, json!, method, path).


##### `server_opts`  (lines 104–119)

```
fn server_opts(
    codex_home: &tempfile::TempDir,
    issuer: String,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
) -> ServerOptions
```

**Purpose**: Creates login settings for tests in one place. This keeps each test focused on the behavior it cares about instead of repeating setup details.

**Data flow**: It takes a temporary Codex home directory, an issuer URL for the fake server, and a credential storage mode. It builds `ServerOptions`, points the issuer at the mock server, disables browser opening, and returns the finished options.

**Call relations**: Several tests call this just before running `run_device_code_login`. It uses the normal `ServerOptions` constructor and default keyring backend, then gives the login flow a safe temporary home and fake server address.

*Call graph*: calls 2 internal fn (default, new); called by 3 (device_code_login_integration_handles_usercode_http_failure, device_code_login_integration_succeeds, device_code_login_rejects_workspace_mismatch); 1 external calls (path).


##### `device_code_login_integration_succeeds`  (lines 122–166)

```
async fn device_code_login_integration_succeeds() -> anyhow::Result<()>
```

**Purpose**: Checks that the full device-code login flow succeeds when every required server step eventually works. It proves that the real login code can save the tokens it receives.

**Data flow**: The test starts with an empty temporary Codex home and a fake server. It configures successful user-code, polling, and OAuth token responses, runs the login flow, then reads the auth file. The expected result is that access token, refresh token, raw ID token, and account ID are all saved correctly.

**Call relations**: This is a top-level async test run by the test framework. It calls the mock setup helpers, builds options with `server_opts`, runs `run_device_code_login`, and then uses `load_auth_dot_json` to verify what the login code wrote.

*Call graph*: calls 6 internal fn (default, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success, server_opts); 9 external calls (new, new, start, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


##### `device_code_login_rejects_workspace_mismatch`  (lines 169–213)

```
async fn device_code_login_rejects_workspace_mismatch() -> anyhow::Result<()>
```

**Purpose**: Checks that login is blocked when the returned account belongs to a workspace that is not allowed. This matters because saving credentials for the wrong workspace could give the user access under the wrong identity or policy.

**Data flow**: The test creates a fake token whose account and organization IDs are disallowed, while the login options allow only a different workspace ID. It runs the login flow and expects a permission-denied error. It then reads the auth location and confirms no auth file was created.

**Call relations**: This test uses the normal success-style mock setup, but changes the token payload and forced workspace option before calling `run_device_code_login`. After the login code rejects the mismatch, the test checks storage with `load_auth_dot_json`.

*Call graph*: calls 6 internal fn (default, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success, server_opts); 11 external calls (new, new, start, assert!, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir (+1 more)).


##### `device_code_login_integration_handles_usercode_http_failure`  (lines 216–248)

```
async fn device_code_login_integration_handles_usercode_http_failure() -> anyhow::Result<()>
```

**Purpose**: Checks that login fails cleanly if the very first device-code request gets an HTTP error from the server. It also verifies that this early failure does not leave saved credentials behind.

**Data flow**: The test creates a temporary home and mock server, configures the user-code endpoint to return a 503 error, and runs the login flow. It expects an error message about the failed device-code request, then confirms that no auth data exists.

**Call relations**: This top-level test uses `mock_usercode_failure` rather than the success helper. It then calls `run_device_code_login` and verifies the aftermath through `load_auth_dot_json`, showing that an early server problem stops the whole flow.

*Call graph*: calls 3 internal fn (default, mock_usercode_failure, server_opts); 6 external calls (start, assert!, load_auth_dot_json, run_device_code_login, skip_if_no_network!, tempdir).


##### `device_code_login_integration_persists_without_api_key_on_exchange_failure`  (lines 251–301)

```
async fn device_code_login_integration_persists_without_api_key_on_exchange_failure() -> anyhow::Result<()>
```

**Purpose**: Checks that token login can still be saved even when no OpenAI API key is obtained. The important point is that browser-based tokens are still useful credentials, so the login should not be thrown away just because an extra API-key step is unavailable.

**Data flow**: The test sets up a normal device-code and token exchange, but uses an ID token without the account details that would support an API-key exchange. After running login, it reads the auth file and confirms there is no API key, while access, refresh, and ID tokens were still saved.

**Call relations**: This test performs its own server option setup rather than using `server_opts`, then runs the same core login function. It uses the common mock helpers for user code, polling, token response, and fake JWT creation, then checks storage with `load_auth_dot_json`.

*Call graph*: calls 6 internal fn (default, new, make_jwt, mock_oauth_token_single, mock_poll_token_two_step, mock_usercode_success); 10 external calls (new, new, start, assert!, assert_eq!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


##### `device_code_login_integration_handles_error_payload`  (lines 304–360)

```
async fn device_code_login_integration_handles_error_payload() -> anyhow::Result<()>
```

**Purpose**: Checks that the login flow reports a meaningful failure when the device token endpoint returns an OAuth-style error payload. This protects users from silent or confusing failures when they decline authorization or the server refuses it.

**Data flow**: The test starts a temporary home and fake server, returns a valid user code, then makes the token polling endpoint return a 401 response containing `authorization_declined`. It runs login, expects an error mentioning either the decline or the HTTP status, and confirms no auth file was written.

**Call relations**: This top-level async test uses `mock_poll_token_single` to inject a precise error response after the user-code step. The real login flow consumes that response, and the test finishes by checking the error and reading storage with `load_auth_dot_json`.

*Call graph*: calls 4 internal fn (default, new, mock_poll_token_single, mock_usercode_success); 8 external calls (start, new, assert!, load_auth_dot_json, run_device_code_login, json!, skip_if_no_network!, tempdir).


### `login/tests/suite/login_server_e2e.rs`

`test` · `test run`

This is an end-to-end test file for Codex login. Instead of testing one small helper in isolation, it starts a real local login server, pretends to be the OAuth issuer, and sends HTTP requests like a browser callback would. OAuth is the common “sign in with another service” flow: the app sends the user to a login page, then receives a callback with either a code or an error.

The file includes a tiny fake issuer server. When the login server asks it for tokens, the fake issuer returns a small JSON response with an ID token, access token, refresh token, email, plan, and workspace/account id. This lets the tests check the login flow without depending on the real internet service beyond local networking support.

The tests use temporary directories as fake Codex home folders. That keeps each test isolated, like using a fresh notebook for every experiment. They check that auth.json is created or overwritten correctly, that missing parent folders are made, that workspace allow-lists are added to the sign-in URL, and that mismatched workspaces do not save credentials. They also check user-facing error pages for denied OAuth callbacks, plus port behavior: falling back from the default port and replacing an older login server on the same port.

#### Function details

##### `start_mock_issuer`  (lines 28–89)

```
fn start_mock_issuer(chatgpt_account_id: &str) -> (SocketAddr, thread::JoinHandle<()>)
```

**Purpose**: Starts a small fake OAuth token server on a random local port. Tests use it so the login server can exchange a login code for predictable tokens without contacting a real identity service.

**Data flow**: It takes a ChatGPT account or workspace id as text. It opens a local TCP port, starts a background thread, and waits for HTTP requests. When it receives a request to /oauth/token, it returns JSON containing fake access and refresh tokens plus a simple unsigned JWT-like ID token that includes the given account id. It returns the server address and the thread handle so the test can point the login server at it.

**Call relations**: All the login-flow tests call this first to create the fake issuer. The login server under test later contacts that issuer during the callback flow, and the mock response drives whether the test should succeed, fail for workspace mismatch, or inspect generated login URLs.

*Call graph*: called by 8 (cancels_previous_login_server_when_port_is_in_use, creates_missing_codex_home_dir, end_to_end_login_flow_persists_auth_json, falls_back_to_registered_fallback_port_when_default_port_is_in_use, forced_chatgpt_workspace_id_mismatch_blocks_login, login_server_includes_forced_workspaces_as_one_query_param, oauth_access_denied_missing_entitlement_blocks_login_with_clear_error, oauth_access_denied_unknown_reason_uses_generic_error_page); 3 external calls (bind, spawn, from_listener).


##### `end_to_end_login_flow_persists_auth_json`  (lines 92–169)

```
async fn end_to_end_login_flow_persists_auth_json() -> Result<()>
```

**Purpose**: Checks the full happy path: a browser callback completes login and the new credentials are saved to auth.json. It also confirms old stale credentials are replaced.

**Data flow**: The test starts with a temporary Codex home folder containing an old auth.json with stale API key and token values. It starts the mock issuer with an allowed account id, runs the login server, sends a callback request with the expected state and code, then waits for the server to finish. Afterward it reads auth.json and verifies that the access token, refresh token, account id, and legacy API key field now contain the fresh values from the mock issuer.

**Call relations**: This test depends on start_mock_issuer to provide token data and on run_login_server to start the real login server. It simulates the browser step with an HTTP client, then lets the server finish its normal shutdown path before checking the file written by the login code.

*Call graph*: calls 1 internal fn (start_mock_issuer); 14 external calls (assert!, assert_eq!, builder, run_login_server, limited, format!, from_str, json!, to_string_pretty, skip_if_no_network! (+4 more)).


##### `creates_missing_codex_home_dir`  (lines 172–213)

```
async fn creates_missing_codex_home_dir() -> Result<()>
```

**Purpose**: Verifies that login still works when the Codex home directory does not exist yet. This matters for first-time users, where there may be no settings folder to write into.

**Data flow**: The test creates a temporary parent folder and chooses a child path that is missing. It starts the mock issuer, launches the login server with that missing folder as its home, and sends a valid callback request. After the server finishes, it checks that auth.json exists inside the newly created folder.

**Call relations**: It uses start_mock_issuer for a fake token service and run_login_server for the real server behavior. The important handoff is from the callback request to the login server’s credential-writing path, which should create the directory before saving the file.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 5 external calls (assert!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `login_server_includes_forced_workspaces_as_one_query_param`  (lines 216–255)

```
async fn login_server_includes_forced_workspaces_as_one_query_param() -> Result<()>
```

**Purpose**: Checks that when login is restricted to specific workspaces, the generated sign-in URL includes those workspace ids correctly. It specifically expects multiple allowed workspace ids to be packed into one query parameter.

**Data flow**: The test gives the login server two allowed workspace ids. It starts the server, parses the generated authorization URL, extracts every allowed_workspace_id query value, and verifies there is exactly one value containing both ids separated by a comma.

**Call relations**: It calls start_mock_issuer only to give the login server a usable issuer URL, but the main thing being tested is the auth_url produced by run_login_server. No browser callback is needed because the test is about URL construction before the user signs in.

*Call graph*: calls 1 internal fn (start_mock_issuer); 7 external calls (parse, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, vec!).


##### `forced_chatgpt_workspace_id_mismatch_blocks_login`  (lines 258–316)

```
async fn forced_chatgpt_workspace_id_mismatch_blocks_login() -> Result<()>
```

**Purpose**: Confirms that login is rejected when the token says the user belongs to a workspace that is not allowed. This prevents credentials from being saved for the wrong organization or account.

**Data flow**: The test starts the fake issuer so it will return a disallowed workspace id, while configuring the login server to allow only a different id. It sends a normal callback with a code and matching state. The response page should explain the workspace restriction, the server should finish with a permission-denied error, and no auth.json file should be written.

**Call relations**: start_mock_issuer supplies the mismatching account id, and run_login_server enforces the allowed-workspace setting. The callback request triggers the token exchange, then the login server compares the received account id with the configured allowed list and stops before saving credentials.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 7 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, vec!).


##### `oauth_access_denied_missing_entitlement_blocks_login_with_clear_error`  (lines 319–385)

```
async fn oauth_access_denied_missing_entitlement_blocks_login_with_clear_error() -> Result<()>
```

**Purpose**: Tests the special error shown when OAuth says the user is denied because they lack Codex access. It makes sure the message is useful rather than exposing only an internal error phrase.

**Data flow**: The test starts a login server, then sends a callback that contains an OAuth error instead of a code: access_denied with the description missing_codex_entitlement. It reads the returned page and checks that it says the user does not have access to Codex, tells them to contact a workspace administrator, still includes the OAuth error code, and hides the raw entitlement phrase. It then verifies the server reports a permission-denied error and writes no auth.json.

**Call relations**: The mock issuer is available but not really used for token exchange here, because the callback is already an error. run_login_server receives the callback, maps this known denial reason to friendly user-facing text, and ends the login attempt without saving credentials.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 6 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `oauth_access_denied_unknown_reason_uses_generic_error_page`  (lines 388–466)

```
async fn oauth_access_denied_unknown_reason_uses_generic_error_page() -> Result<()>
```

**Purpose**: Checks that an unknown OAuth denial still produces a clear generic failure page. The server should preserve the original error details so the user or support staff can see what happened.

**Data flow**: The test starts the login server and sends a callback with access_denied plus an unfamiliar error description. It reads the response page and expects a generic sign-in failure title, retry guidance, and the original error text. It also verifies that the entitlement-specific access message is not shown, the server ends with a permission-denied error, and no auth.json is created.

**Call relations**: Like the entitlement test, this mainly exercises the login server’s callback error path rather than the mock issuer’s token endpoint. run_login_server receives the denied callback, chooses the generic error page because the reason is unknown, and reports failure to the caller.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 6 external calls (assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir).


##### `falls_back_to_registered_fallback_port_when_default_port_is_in_use`  (lines 469–533)

```
async fn falls_back_to_registered_fallback_port_when_default_port_is_in_use() -> Result<()>
```

**Purpose**: Verifies that if the normal login port is already occupied by something else, the login server uses the registered fallback port instead. This keeps login usable when another local process is already listening on the default port.

**Data flow**: The test first checks that the fallback port is free, then deliberately binds the default port with a tiny dummy server. It starts the mock issuer and asks the login server to use its normal port behavior. After starting, it shuts down the dummy server and then checks that the login server actually chose the fallback port and that the generated redirect URL points to that fallback port.

**Call relations**: The dummy server creates the port conflict, start_mock_issuer supplies the issuer URL, and run_login_server performs the port-selection logic. The test then cancels the login server and waits for it to shut down, because the goal is only to inspect startup behavior and the generated authorization URL.

*Call graph*: calls 3 internal fn (default, new, start_mock_issuer); 13 external calls (new, from_secs, bind, assert!, assert_eq!, run_login_server, eprintln!, format!, skip_if_no_network!, tempdir (+3 more)).


##### `cancels_previous_login_server_when_port_is_in_use`  (lines 536–599)

```
async fn cancels_previous_login_server_when_port_is_in_use() -> Result<()>
```

**Purpose**: Tests the case where a second Codex login attempt starts on a port already used by an earlier Codex login server. The expected behavior is that the new attempt cancels the old one and takes over the port.

**Data flow**: The test starts a first login server and begins waiting for it in a background task. After a short pause, it starts a second login server configured to use the same port. The first server should finish with an interrupted/cancelled error, while the second server should successfully bind to the same port. The test then calls the second server’s /cancel endpoint and checks that it also shuts down as a cancellation.

**Call relations**: start_mock_issuer provides a shared fake issuer for both login servers. The first run_login_server call creates the server that will be displaced; the second call exercises the takeover behavior. The final HTTP request to /cancel uses the second server’s own cancel route to finish the test cleanly.

*Call graph*: calls 2 internal fn (new, start_mock_issuer); 9 external calls (from_millis, assert!, assert_eq!, run_login_server, format!, skip_if_no_network!, tempdir, spawn, sleep).


### Session maintenance and logout
These tests follow authenticated state after login, validating token refresh behavior and the cleanup path that revokes and removes persisted auth on logout.

### `login/tests/suite/auth_refresh.rs`

`test` · `test execution`

This is a test file for the authentication refresh path. A refresh token is like a spare key: when the short-lived access token is old or about to expire, Codex can trade the refresh token for a new pair of tokens. These tests create a temporary Codex home folder, write fake auth.json data into it, and point the token-refresh URL at a local mock server instead of the real service.

The tests cover the happy path, where the server returns new tokens and Codex writes them back to storage and cache. They also cover careful safety rules. If the auth file on disk changed since the cached copy was loaded, Codex should not blindly overwrite it. If the changed file belongs to another account, Codex should stop with an error. If the access token is still fresh enough, Codex should not make a network request. If a refresh token is expired or reused, Codex should treat that as a permanent failure and avoid repeated calls.

The helper types keep the tests isolated. RefreshTokenTestContext builds the temporary home folder, mock endpoint, and AuthManager. EnvGuard temporarily changes process environment variables and restores them afterward. Small token helpers build fake JSON Web Tokens, which are text tokens with encoded JSON inside, so the AuthManager can inspect expiry times during the tests.

#### Function details

##### `refresh_token_succeeds_updates_storage`  (lines 37–110)

```
async fn refresh_token_succeeds_updates_storage() -> Result<()>
```

**Purpose**: Checks the direct refresh path when everything works. It proves that Codex sends the expected refresh request, stores the returned access and refresh tokens, updates the last-refresh time, and keeps the in-memory cache in sync.

**Data flow**: The test starts with fake old tokens written to a temporary auth.json file and a mock server ready to return new tokens. It asks AuthManager to refresh from the authority, then reads the mock request, the saved auth file, and the cached auth. The result should be one correct network request and matching new token data in both disk storage and memory.

**Call relations**: The test runner invokes this case. It uses EnvGuard::set to override the client id, RefreshTokenTestContext::new to build an isolated AuthManager, build_tokens to create starting token data, and the context helpers to write and reload auth before exercising AuthManager.

*Call graph*: calls 3 internal fn (set, new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `refresh_token_refreshes_when_auth_is_unchanged`  (lines 114–176)

```
async fn refresh_token_refreshes_when_auth_is_unchanged() -> Result<()>
```

**Purpose**: Verifies that the normal refresh method refreshes tokens when the auth data on disk still matches what AuthManager has cached. This matters because unchanged cached auth is the safe case for replacing old tokens.

**Data flow**: The test writes initial tokens and an old last-refresh timestamp, then the mock server returns a new token pair. After calling refresh_token, it expects the saved file and cached auth to contain the new pair and a newer refresh time.

**Call relations**: The test runner calls this scenario. It relies on RefreshTokenTestContext::new for the temporary setup and build_tokens for the fake credentials, then hands control to AuthManager.refresh_token and checks the storage and cache afterward.

*Call graph*: calls 2 internal fn (new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `auth_refreshes_when_access_token_is_near_expiry`  (lines 180–238)

```
async fn auth_refreshes_when_access_token_is_near_expiry() -> Result<()>
```

**Purpose**: Checks that simply asking for auth triggers a refresh when the access token will expire very soon. This protects users from starting work with a token that is about to stop working.

**Data flow**: The test creates an access token whose expiry time is only a few minutes away, stores it, and configures the mock server to return replacements. When AuthManager.auth is requested, AuthManager should notice the short remaining lifetime, refresh the tokens, save them, and return the refreshed token data.

**Call relations**: The test runner starts this case. It uses access_token_with_expiration and build_tokens to create the near-expiry auth state, then observes how AuthManager.auth calls into the refresh behavior automatically.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 11 external calls (minutes, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `auth_skips_access_token_outside_refresh_window`  (lines 242–276)

```
async fn auth_skips_access_token_outside_refresh_window() -> Result<()>
```

**Purpose**: Confirms that Codex does not refresh just because a token has an expiry time. If the token is still comfortably valid, no network call should happen.

**Data flow**: The test stores an access token that expires later than the refresh window. It then asks AuthManager for auth and expects to get the original tokens back, with the auth file unchanged and the mock server receiving no requests.

**Call relations**: The test runner invokes this scenario. The helper access_token_with_expiration creates a still-fresh token, RefreshTokenTestContext supplies the isolated manager, and AuthManager.auth is expected to return cached data without contacting the mock server.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 6 external calls (minutes, start, now, assert!, assert_eq!, skip_if_no_network!).


##### `refresh_token_skips_refresh_when_auth_changed`  (lines 280–337)

```
async fn refresh_token_skips_refresh_when_auth_changed() -> Result<()>
```

**Purpose**: Checks that Codex does not overwrite auth.json when the file has changed outside the current cached copy. This prevents one process or login session from accidentally replacing newer credentials written by another.

**Data flow**: The test first writes one set of tokens through the context so AuthManager caches them. It then directly saves a different set of tokens to disk. When refresh_token is called, AuthManager should reload or accept the disk version instead of making a refresh request, leaving the newer disk auth intact.

**Call relations**: The test runner calls this case. It uses build_tokens for both cached and disk token sets, save_auth to simulate an outside file change, and then checks AuthManager.refresh_token behavior against the mock server and cached auth.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 7 external calls (days, start, now, assert!, assert_eq!, save_auth, skip_if_no_network!).


##### `refresh_token_errors_on_account_mismatch`  (lines 341–412)

```
async fn refresh_token_errors_on_account_mismatch() -> Result<()>
```

**Purpose**: Verifies that Codex refuses to continue if the auth file on disk changed to a different account. This is a safety check so tokens from one account are not mixed with another account.

**Data flow**: The test caches initial account tokens, then writes different tokens to disk with a different account id. When refresh_token runs, it should return an error marked as an 'other' refresh failure, leave the disk file untouched, make no network request, and keep the original cached tokens.

**Call relations**: The test runner invokes this scenario. RefreshTokenTestContext creates the manager, build_tokens creates both token sets, save_auth simulates an external account change, and AuthManager.refresh_token is expected to stop before talking to the mock server.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `returns_fresh_tokens_as_is`  (lines 416–461)

```
async fn returns_fresh_tokens_as_is() -> Result<()>
```

**Purpose**: Checks that a stale last-refresh timestamp alone does not force a refresh if the access token itself is still valid for a long time. This avoids unnecessary network calls.

**Data flow**: The test writes auth data with an old last-refresh time but an access token expiring about an hour later. When AuthManager.auth is called, it should return the original tokens, leave auth.json unchanged, and send no request to the mock server.

**Call relations**: The test runner runs this case. It uses access_token_with_expiration to make a fresh access token and build_tokens to wrap it, then confirms AuthManager.auth chooses reuse rather than refresh.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 12 external calls (days, hours, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network! (+2 more)).


##### `refreshes_token_when_access_token_is_expired`  (lines 465–523)

```
async fn refreshes_token_when_access_token_is_expired() -> Result<()>
```

**Purpose**: Confirms that Codex refreshes when the access token is already expired. Without this, users could keep using cached credentials that the server will reject.

**Data flow**: The test stores an access token whose expiry time is in the past and configures the mock server to return new tokens. Asking AuthManager for auth should cause a refresh, then the returned cache and saved auth file should both contain the new access and refresh tokens.

**Call relations**: The test runner invokes this scenario. access_token_with_expiration creates the expired token, build_tokens builds the auth data, RefreshTokenTestContext writes it, and AuthManager.auth performs the automatic refresh.

*Call graph*: calls 3 internal fn (new, access_token_with_expiration, build_tokens); 12 external calls (days, hours, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network! (+2 more)).


##### `auth_reloads_disk_auth_when_cached_auth_is_stale`  (lines 527–581)

```
async fn auth_reloads_disk_auth_when_cached_auth_is_stale() -> Result<()>
```

**Purpose**: Checks that when cached auth looks stale, Codex first looks at the auth file on disk and can adopt a fresher version from there. This avoids needless refreshes and respects credentials updated by another process.

**Data flow**: The test caches old auth, then directly writes newer auth to disk. When AuthManager.auth is requested, it should reload the disk version, return those disk tokens, leave the file unchanged, and avoid any refresh request.

**Call relations**: The test runner calls this case. It uses RefreshTokenTestContext to cache the first auth state, save_auth to simulate a newer disk state, and then observes AuthManager.auth choosing reload over network refresh.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 7 external calls (days, start, now, assert!, assert_eq!, save_auth, skip_if_no_network!).


##### `auth_reloads_disk_auth_without_calling_expired_refresh_token`  (lines 585–647)

```
async fn auth_reloads_disk_auth_without_calling_expired_refresh_token() -> Result<()>
```

**Purpose**: Verifies that a fresher disk auth file prevents Codex from calling a refresh token that would fail as expired. This shows the reload step happens before an unnecessary and harmful network attempt.

**Data flow**: The test sets up a mock endpoint that would return an expired-refresh-token error but expects zero calls. It caches stale auth, writes fresher auth to disk, asks AuthManager for auth, and expects the disk tokens to be loaded with no request sent.

**Call relations**: The test runner invokes this scenario. RefreshTokenTestContext builds the isolated manager, save_auth changes the disk auth behind its back, and AuthManager.auth should reload the file before considering the mock refresh endpoint.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 11 external calls (days, given, start, new, now, assert_eq!, save_auth, json!, skip_if_no_network!, method (+1 more)).


##### `refresh_token_returns_permanent_error_for_expired_refresh_token`  (lines 651–702)

```
async fn refresh_token_returns_permanent_error_for_expired_refresh_token() -> Result<()>
```

**Purpose**: Checks that an expired refresh token is reported as a permanent failure with the right reason. This helps higher-level code know that retrying the same token will not help.

**Data flow**: The test writes valid-looking cached auth and configures the mock server to reject refresh with a refresh_token_expired code. After refresh_token_from_authority is called, the error should be marked as expired, while the saved file and cached tokens remain unchanged.

**Call relations**: The test runner runs this case. RefreshTokenTestContext prepares the auth and mock endpoint, build_tokens creates the credentials, and AuthManager.refresh_token_from_authority is the behavior under test.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_does_not_retry_after_permanent_failure`  (lines 706–771)

```
async fn refresh_token_does_not_retry_after_permanent_failure() -> Result<()>
```

**Purpose**: Verifies that after a permanent refresh-token failure, Codex remembers not to call the server again with the same bad token. This avoids repeated doomed requests and noisy failures.

**Data flow**: The test sets up the server to reject the first refresh as a reused token. The first call to refresh_token returns an exhausted-token failure; the second call returns the same kind of failure without another server request. Storage and cache stay on the original tokens.

**Call relations**: The test runner invokes this case. RefreshTokenTestContext and build_tokens create the setup, then two AuthManager.refresh_token calls show the permanent-failure memory in action while the mock server verifies only one request occurred.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_does_not_retry_after_bad_request_reused_failure`  (lines 775–840)

```
async fn refresh_token_does_not_retry_after_bad_request_reused_failure() -> Result<()>
```

**Purpose**: Checks the same no-retry rule when the service reports a reused refresh token with a bad-request response. The exact HTTP status differs, but the meaning is still permanent.

**Data flow**: The test writes initial auth, has the mock server return a refresh_token_reused error with status 400, and calls refresh_token twice. The first call records an exhausted-token failure, the second fails without contacting the server again, and stored auth remains unchanged.

**Call relations**: The test runner calls this scenario. It uses the shared context and token helpers, then drives AuthManager.refresh_token twice to confirm permanent failures are cached regardless of this response status.

*Call graph*: calls 2 internal fn (new, build_tokens); 10 external calls (days, given, start, new, now, assert_eq!, json!, skip_if_no_network!, method, path).


##### `refresh_token_reloads_changed_auth_after_permanent_failure`  (lines 844–928)

```
async fn refresh_token_reloads_changed_auth_after_permanent_failure() -> Result<()>
```

**Purpose**: Confirms that a remembered permanent failure does not block Codex from accepting newly changed auth on disk. This lets a user recover by logging in again or otherwise updating credentials.

**Data flow**: The test first causes a permanent reused-token failure and then writes fresh, different auth to disk. A later refresh_token call should reload the changed disk auth without sending another refresh request, update the cache to the disk tokens, and leave only the original failed request recorded.

**Call relations**: The test runner runs this case. It combines the permanent-failure path with an external save_auth change, then checks that AuthManager.refresh_token prefers the new disk state rather than retrying the old failed refresh token.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, hours, given, start, new, now, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `refresh_token_returns_transient_error_on_server_failure`  (lines 932–982)

```
async fn refresh_token_returns_transient_error_on_server_failure() -> Result<()>
```

**Purpose**: Checks that a temporary server failure is treated as temporary, not as a bad token. This matters because retrying later may succeed.

**Data flow**: The test writes initial auth and makes the mock server return a 500 error, which means the server failed. refresh_token_from_authority should return a transient error with no permanent failed reason, and both disk and cached tokens should stay unchanged.

**Call relations**: The test runner invokes this scenario. RefreshTokenTestContext prepares storage and the mock server, build_tokens creates the token data, and AuthManager.refresh_token_from_authority is expected to distinguish server trouble from token exhaustion.

*Call graph*: calls 2 internal fn (new, build_tokens); 11 external calls (days, given, start, new, now, assert!, assert_eq!, json!, skip_if_no_network!, method (+1 more)).


##### `unauthorized_recovery_reloads_then_refreshes_tokens`  (lines 986–1081)

```
async fn unauthorized_recovery_reloads_then_refreshes_tokens() -> Result<()>
```

**Purpose**: Tests the recovery flow used after an unauthorized response from an API call. It proves recovery first reloads changed disk auth, then, if needed, refreshes tokens.

**Data flow**: The test caches one token set, writes another token set to disk, and creates an unauthorized recovery object. The first recovery step reloads the disk tokens without a network request. The second step sends a refresh request and stores the recovered tokens returned by the mock server. At the end, storage and cache contain the recovered pair and the recovery object has no more steps.

**Call relations**: The test runner calls this case. It uses AuthManager.unauthorized_recovery to create a step-by-step recovery sequence, while RefreshTokenTestContext, build_tokens, and save_auth prepare the cached and disk states used by those steps.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `unauthorized_recovery_errors_on_account_mismatch`  (lines 1085–1167)

```
async fn unauthorized_recovery_errors_on_account_mismatch() -> Result<()>
```

**Purpose**: Checks that unauthorized recovery stops if the disk auth belongs to a different account. This prevents recovery from silently switching accounts or mixing credentials.

**Data flow**: The test caches initial account tokens, writes disk tokens with another account id, and starts unauthorized recovery. The first recovery step should fail with an 'other' refresh failure, make no network request, leave the disk file as written, and keep the original cached tokens.

**Call relations**: The test runner invokes this scenario. It drives the recovery object returned by AuthManager.unauthorized_recovery, using build_tokens and save_auth to set up the account mismatch that recovery must detect.

*Call graph*: calls 3 internal fn (default, new, build_tokens); 12 external calls (days, given, start, new, now, assert!, assert_eq!, save_auth, json!, skip_if_no_network! (+2 more)).


##### `unauthorized_recovery_requires_chatgpt_auth`  (lines 1171–1201)

```
async fn unauthorized_recovery_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: Verifies that unauthorized recovery is only available for ChatGPT token-based auth, not API-key auth. An API key cannot be refreshed through the ChatGPT refresh-token flow.

**Data flow**: The test writes auth data that uses an API key and has no tokens. It creates a recovery object, expects it to have no valid next step, and confirms calling next returns an error without contacting the mock server.

**Call relations**: The test runner calls this case. RefreshTokenTestContext supplies the AuthManager, and AuthManager.unauthorized_recovery is expected to reject the non-ChatGPT auth mode before any refresh logic runs.

*Call graph*: calls 1 internal fn (new); 4 external calls (start, assert!, assert_eq!, skip_if_no_network!).


##### `RefreshTokenTestContext::new`  (lines 1210–1230)

```
async fn new(server: &MockServer) -> Result<Self>
```

**Purpose**: Creates an isolated test environment for refresh-token tests. It gives each test a temporary Codex home folder, points refresh requests at the mock server, and builds a shared AuthManager configured to use file storage.

**Data flow**: It receives a mock server. It creates a temporary directory, builds the mock token endpoint URL, stores that URL in an environment variable through EnvGuard::set, constructs AuthManager for the temporary directory, and returns all of that bundled in RefreshTokenTestContext.

**Call relations**: Most tests call this at the start of their setup. It hands off to EnvGuard::set for temporary environment changes and AuthManager::shared for the real manager object that the tests then exercise.

*Call graph*: calls 3 internal fn (default, shared, set); called by 18 (auth_refreshes_when_access_token_is_near_expiry, auth_reloads_disk_auth_when_cached_auth_is_stale, auth_reloads_disk_auth_without_calling_expired_refresh_token, auth_skips_access_token_outside_refresh_window, refresh_token_does_not_retry_after_bad_request_reused_failure, refresh_token_does_not_retry_after_permanent_failure, refresh_token_errors_on_account_mismatch, refresh_token_refreshes_when_auth_is_unchanged, refresh_token_reloads_changed_auth_after_permanent_failure, refresh_token_returns_permanent_error_for_expired_refresh_token (+8 more)); 2 external calls (new, format!).


##### `RefreshTokenTestContext::load_auth`  (lines 1232–1240)

```
fn load_auth(&self) -> Result<AuthDotJson>
```

**Purpose**: Reads the test auth.json file from the temporary Codex home directory. Tests use it to check what AuthManager actually saved to disk.

**Data flow**: It reads the context's temporary home path, calls the login library's auth loader in file-storage mode, and turns the optional result into a required AuthDotJson value. If the file is missing or unreadable, the test gets an error.

**Call relations**: Individual tests call this after refresh or recovery actions. It delegates the actual disk reading to load_auth_dot_json so assertions compare against the same format the application uses.

*Call graph*: calls 1 internal fn (default); 2 external calls (path, load_auth_dot_json).


##### `RefreshTokenTestContext::write_auth`  (lines 1242–1251)

```
async fn write_auth(&self, auth_dot_json: &AuthDotJson) -> Result<()>
```

**Purpose**: Writes auth data into the temporary test storage and reloads AuthManager so its cache sees that data. This gives each test a known starting point.

**Data flow**: It receives an AuthDotJson value, saves it to the temporary Codex home directory using file storage, then asks AuthManager to reload. After it returns, both the file and the manager's cache are prepared for the test.

**Call relations**: The tests call this during setup before they invoke refresh or auth-loading behavior. It hands off file writing to save_auth and then uses AuthManager.reload to align memory with disk.

*Call graph*: calls 1 internal fn (default); 2 external calls (path, save_auth).


##### `EnvGuard::set`  (lines 1260–1267)

```
fn set(key: &'static str, value: String) -> Self
```

**Purpose**: Temporarily changes an environment variable for a test and remembers its original value. This lets tests point AuthManager at mock settings without permanently changing the process environment.

**Data flow**: It receives an environment variable name and a replacement value. It reads the current value, sets the new one, and returns an EnvGuard containing the name and original value so it can be restored later.

**Call relations**: RefreshTokenTestContext::new uses it to override the refresh-token URL, and one test uses it to override the client id. Other auth tests in the suite also use the same helper. EnvGuard::drop completes the story by restoring the value when the guard is discarded.

*Call graph*: called by 6 (new, refresh_token_succeeds_updates_storage, auth_manager_logout_with_revoke_uses_cached_auth, logout_with_revoke_removes_auth_when_revoke_fails, logout_with_revoke_revokes_refresh_token_then_removes_auth, logout_with_revoke_uses_stored_auth_when_access_token_env_is_set); 2 external calls (set_var, var_os).


##### `EnvGuard::drop`  (lines 1271–1279)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when an EnvGuard goes out of scope. This keeps one test's environment changes from leaking into later tests.

**Data flow**: It reads the saved original value inside the guard. If there was an original value, it sets the variable back; if there was none, it removes the variable.

**Call relations**: Rust calls this automatically when an EnvGuard is dropped. It is the cleanup half of EnvGuard::set, which is why the tests can safely override process-wide environment variables while running serially.

*Call graph*: 2 external calls (remove_var, set_var).


##### `jwt_with_payload`  (lines 1282–1304)

```
fn jwt_with_payload(payload: serde_json::Value) -> String
```

**Purpose**: Builds a simple fake JSON Web Token for tests. A JSON Web Token, or JWT, is a string with encoded JSON sections; here it is not meant to be secure, only shaped correctly enough for expiry and subject parsing.

**Data flow**: It receives a JSON payload, creates a small header saying the algorithm is 'none', serializes the header and payload to bytes, base64-encodes each section without padding, adds a dummy signature, and returns the three-part token string.

**Call relations**: minimal_jwt and access_token_with_expiration call this helper. Those helpers then feed build_tokens and the expiry-related tests with token strings that AuthManager can inspect.

*Call graph*: called by 2 (access_token_with_expiration, minimal_jwt); 2 external calls (format!, to_vec).


##### `minimal_jwt`  (lines 1306–1308)

```
fn minimal_jwt() -> String
```

**Purpose**: Creates the smallest fake id token used by these tests. It includes a user subject but no expiry because the id token is only supporting data here.

**Data flow**: It builds a JSON payload with a subject value and passes it to jwt_with_payload. The result is a fake JWT string suitable for the raw id token field in TokenData.

**Call relations**: build_tokens calls this whenever it needs a complete TokenData value. It keeps individual tests from repeating JWT-building details.

*Call graph*: calls 1 internal fn (jwt_with_payload); called by 1 (build_tokens); 1 external calls (json!).


##### `access_token_with_expiration`  (lines 1310–1312)

```
fn access_token_with_expiration(expires_at: chrono::DateTime<Utc>) -> String
```

**Purpose**: Creates a fake access token with a chosen expiry time. Tests use it to check whether AuthManager refreshes, skips refresh, or handles expired tokens correctly.

**Data flow**: It receives a date and time, converts that time to a Unix timestamp, places it in the JWT payload as the exp field, and returns the encoded token string from jwt_with_payload.

**Call relations**: The expiry-window tests call this before build_tokens. It supplies the key input that lets AuthManager.auth decide whether a token is near expiry, expired, or still fresh.

*Call graph*: calls 1 internal fn (jwt_with_payload); called by 4 (auth_refreshes_when_access_token_is_near_expiry, auth_skips_access_token_outside_refresh_window, refreshes_token_when_access_token_is_expired, returns_fresh_tokens_as_is); 1 external calls (json!).


##### `build_tokens`  (lines 1314–1325)

```
fn build_tokens(access_token: &str, refresh_token: &str) -> TokenData
```

**Purpose**: Builds a complete TokenData object from an access token string and refresh token string. It gives tests a consistent account id and id token so they can focus on refresh behavior.

**Data flow**: It receives access and refresh token text. It creates a minimal fake id token, copies the provided token strings into TokenData, sets a fixed account id, and returns the finished token bundle.

**Call relations**: Nearly every test uses this helper to create starting, disk, or expected token data. It calls minimal_jwt for the id token and keeps the test setup readable.

*Call graph*: calls 1 internal fn (minimal_jwt); called by 17 (auth_refreshes_when_access_token_is_near_expiry, auth_reloads_disk_auth_when_cached_auth_is_stale, auth_reloads_disk_auth_without_calling_expired_refresh_token, auth_skips_access_token_outside_refresh_window, refresh_token_does_not_retry_after_bad_request_reused_failure, refresh_token_does_not_retry_after_permanent_failure, refresh_token_errors_on_account_mismatch, refresh_token_refreshes_when_auth_is_unchanged, refresh_token_reloads_changed_auth_after_permanent_failure, refresh_token_returns_permanent_error_for_expired_refresh_token (+7 more)); 1 external calls (default).


### `login/tests/suite/logout.rs`

`test` · `test execution`

Logging out has two jobs: tell the server that the refresh token should no longer work, and delete the local credentials from the user's machine. This test file makes sure both parts happen correctly. It uses a temporary folder as a fake Codex home directory, so the tests can create and delete an auth.json file without touching a real user's setup. It also uses a mock web server, which is a small fake server used to record and answer HTTP requests, so the tests can check exactly what Codex would send to the token-revocation endpoint.

The tests cover several important situations. In the normal case, logout sends the stored refresh token to the revoke URL and then removes auth.json. If an access-token environment variable is set, logout still uses the stored ChatGPT credentials for revocation rather than being distracted by that environment value. If the server returns an error, logout still deletes the local auth file, because a user who asks to log out should not stay logged in locally just because the network side failed. One test also checks AuthManager, the higher-level object that caches authentication, to make sure it revokes the cached token and clears both memory and disk.

Because these tests temporarily change process-wide environment variables, EnvGuard saves the old value and restores it afterward, like putting a borrowed tool back where it came from.

#### Function details

##### `logout_with_revoke_revokes_refresh_token_then_removes_auth`  (lines 34–87)

```
async fn logout_with_revoke_revokes_refresh_token_then_removes_auth() -> Result<()>
```

**Purpose**: This test proves the main happy path for logout. It expects Codex to revoke the stored refresh token with the server, then delete the local auth.json file.

**Data flow**: The test starts with a fake revoke server, a temporary Codex home folder, and a saved ChatGPT auth file containing a known refresh token. It overrides the client ID and revoke URL through environment variables, calls logout_with_revoke, then checks that the result says credentials were removed, auth.json is gone, and the fake server received one JSON request containing the refresh token, token type hint, and overridden client ID.

**Call relations**: This is a top-level async test. It uses EnvGuard::set to safely change environment variables, chatgpt_auth to build test credentials, save_auth to write them, and logout_with_revoke to exercise the real logout code. It then asks the mock server what request arrived so it can verify the revoke call.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 13 external calls (given, start, new, new, assert!, assert_eq!, logout_with_revoke, save_auth, format!, json! (+3 more)).


##### `logout_with_revoke_uses_stored_auth_when_access_token_env_is_set`  (lines 91–129)

```
async fn logout_with_revoke_uses_stored_auth_when_access_token_env_is_set() -> Result<()>
```

**Purpose**: This test checks that a temporary access token from the environment does not replace the stored login when logging out. That matters because revocation needs the saved refresh token, not just any token visible in the process.

**Data flow**: The test sets up a fake revoke server, puts an access-token value in the environment, writes normal ChatGPT auth data to a temporary auth.json, and calls logout_with_revoke. Afterward it checks that logout reported removal, the auth file is gone, and the mock server saw the expected revoke request.

**Call relations**: This top-level async test uses EnvGuard::set for both the revoke URL and the access-token environment variable. It gets its stored credential data from chatgpt_auth, writes it through save_auth, and then drives the real logout_with_revoke path.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 11 external calls (given, start, new, new, assert!, logout_with_revoke, save_auth, format!, skip_if_no_network!, method (+1 more)).


##### `logout_with_revoke_removes_auth_when_revoke_fails`  (lines 133–172)

```
async fn logout_with_revoke_removes_auth_when_revoke_fails() -> Result<()>
```

**Purpose**: This test makes sure local logout still succeeds when the remote revoke request fails. In user terms, Codex should still remove your local login even if the server answers with an error.

**Data flow**: The test creates a fake revoke server that returns an HTTP 500 error, saves valid ChatGPT auth data in a temporary folder, and calls logout_with_revoke. Even though the server response is a failure, the expected result is that logout reports credentials were removed and auth.json no longer exists.

**Call relations**: This top-level async test uses EnvGuard::set to point revocation at the fake server, chatgpt_auth to create the auth file contents, save_auth to store them, and logout_with_revoke to run the behavior under test. It asks the mock server to verify that the revoke attempt was still made.

*Call graph*: calls 3 internal fn (default, set, chatgpt_auth); 12 external calls (given, start, new, new, assert!, logout_with_revoke, save_auth, format!, json!, skip_if_no_network! (+2 more)).


##### `auth_manager_logout_with_revoke_uses_cached_auth`  (lines 176–238)

```
async fn auth_manager_logout_with_revoke_uses_cached_auth() -> Result<()>
```

**Purpose**: This test checks logout through AuthManager, the higher-level authentication object. It proves that AuthManager revokes the credentials it already cached in memory, even if the auth file on disk changes afterward.

**Data flow**: The test first saves auth data with one refresh token, creates an AuthManager so it reads and caches that data, then overwrites the auth file with a different refresh token. When manager.logout_with_revoke is called, the test expects the revoke request to contain the original cached refresh token, not the newer disk value. It also checks that the manager's in-memory auth is cleared and auth.json is removed from disk.

**Call relations**: This top-level async test uses EnvGuard::set to redirect revocation to the fake server and chatgpt_auth_with_refresh_token to build two different credential records. It creates an AuthManager with AuthManager::new, then calls the manager's logout_with_revoke method and verifies both the local cleanup and the request received by the mock server.

*Call graph*: calls 4 internal fn (default, new, set, chatgpt_auth_with_refresh_token); 12 external calls (given, start, new, new, assert!, assert_eq!, save_auth, format!, json!, skip_if_no_network! (+2 more)).


##### `chatgpt_auth`  (lines 240–242)

```
fn chatgpt_auth() -> AuthDotJson
```

**Purpose**: This helper builds a standard fake ChatGPT auth record for tests. It keeps the repeated test setup short and makes the default refresh token easy to recognize.

**Data flow**: It takes no input. It calls chatgpt_auth_with_refresh_token using the file's shared REFRESH_TOKEN constant, and returns the completed AuthDotJson test credential object.

**Call relations**: The three logout_with_revoke tests call this helper when they do not need a special refresh token. It delegates the real construction work to chatgpt_auth_with_refresh_token.

*Call graph*: calls 1 internal fn (chatgpt_auth_with_refresh_token); called by 3 (logout_with_revoke_removes_auth_when_revoke_fails, logout_with_revoke_revokes_refresh_token_then_removes_auth, logout_with_revoke_uses_stored_auth_when_access_token_env_is_set).


##### `chatgpt_auth_with_refresh_token`  (lines 244–262)

```
fn chatgpt_auth_with_refresh_token(refresh_token: &str) -> AuthDotJson
```

**Purpose**: This helper creates a fake saved authentication record with a caller-chosen refresh token. Tests use it when they need to tell one token apart from another.

**Data flow**: It receives a refresh token string. It builds an AuthDotJson object marked as ChatGPT authentication, includes a fake ID token, the shared access token, the supplied refresh token, and a test account ID, while leaving unrelated credential fields empty. The completed auth object is returned to the caller.

**Call relations**: chatgpt_auth calls this with the default token, and the AuthManager cache test calls it directly with different token values. It uses minimal_jwt to create just enough ID-token text for the auth data to look valid to the code under test.

*Call graph*: calls 1 internal fn (minimal_jwt); called by 2 (auth_manager_logout_with_revoke_uses_cached_auth, chatgpt_auth); 1 external calls (default).


##### `minimal_jwt`  (lines 264–270)

```
fn minimal_jwt() -> String
```

**Purpose**: This helper creates a tiny fake JWT, which is a three-part encoded token format commonly used for identity information. The tests only need something shaped like a token, not a real signed identity document.

**Data flow**: It starts with small JSON snippets for a header and payload, plus a simple signature string. It base64-url encodes each part without padding, joins them with dots, and returns the resulting token-shaped string.

**Call relations**: chatgpt_auth_with_refresh_token calls this while building test credentials. The token it returns becomes the raw ID token inside the fake AuthDotJson record.

*Call graph*: called by 1 (chatgpt_auth_with_refresh_token); 1 external calls (format!).


##### `EnvGuard::set`  (lines 278–285)

```
fn set(key: &'static str, value: String) -> Self
```

**Purpose**: This helper temporarily changes an environment variable for one test and remembers what it used to be. It prevents one test's environment changes from leaking into later tests.

**Data flow**: It receives the name of an environment variable and the value to set. It reads and stores the original value, sets the new value for the running process, and returns an EnvGuard object holding the key and saved original value.

**Call relations**: The async logout tests call this before running code that reads environment variables, such as override URLs, client IDs, and access tokens. The returned guard is kept alive for the test, and its Drop implementation restores the environment when the guard goes out of scope.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvGuard::drop`  (lines 289–297)

```
fn drop(&mut self)
```

**Purpose**: This cleanup method restores an environment variable when an EnvGuard is no longer needed. It is what makes the temporary environment changes safe for the rest of the test suite.

**Data flow**: It reads the saved original value inside the EnvGuard. If there was an original value, it puts that value back; if there was none, it removes the variable entirely. It does not return a value, but it changes the process environment back to its prior state.

**Call relations**: Rust calls this automatically when an EnvGuard created by EnvGuard::set goes out of scope. The tests are marked to run serially around auth environment changes, so this restore step happens before another auth-environment test gets its turn.

*Call graph*: 2 external calls (remove_var, set_var).
