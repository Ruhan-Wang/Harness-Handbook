# Caches and local persisted lookup data  `stage-21.3`

This stage is cross-cutting persistence infrastructure: it sits underneath startup checks, refresh paths, and interactive flows to keep small pieces of fetched or derived data on disk so the rest of the system can start faster, avoid unnecessary network calls, and retain limited behavior when remote services are unavailable.

The cloud-config cache stores signed configuration bundles with TTL checks, identity scoping, and HMAC verification, so startup and refresh logic can reuse trusted config only when it is fresh, untampered, and tied to the current authenticated user/account. Connector and model caches persist fetched directory/catalog results, derive stable account-aware cache keys, and reject stale, malformed, or version-mismatched entries before higher layers consume them. The remote plugin catalog cache plays the same role for plugin discovery, additionally separating data by endpoint and account so workspaces do not leak into each other. The shared-plugin local-path store keeps a best-effort mapping from remote shared plugin IDs to local filesystem locations, guarded by a process-local mutex for safe concurrent access. Finally, the TUI updates cache records update-check state and dismissed popups, preserving user-facing update behavior across runs.

## Files in this stage

### Signed cloud config cache
This cache layer defines the most security-sensitive persisted lookup data, handling signed cloud-config bundles with identity scoping, TTL checks, and tamper detection.

### `cloud-config/src/cache.rs`

`io_transport` · `startup cache read and post-fetch cache write`

This file defines the persistent cache used to avoid backend fetches on startup. `CloudConfigBundleCache` stores a single resolved cache file path under `codex_home`, always named `cloud-config-bundle-cache.json`. The cache format is explicit: `CloudConfigBundleCacheFile` contains a `signed_payload` and a base64-encoded HMAC `signature`; the payload records a version number, `cached_at`, `expires_at`, optional `chatgpt_user_id`, optional `account_id`, and the full `CloudConfigBundle`.

`load` is intentionally strict and ordered. It first requires both request identity components; if either is missing, it returns `AuthIdentityIncomplete` before touching disk. It then reads the file, distinguishes not-found from other I/O errors, parses JSON, reserializes the payload with `cache_payload_bytes`, verifies the signature against all accepted read keys, checks the cache version, requires complete cached identity, compares cached and requested identity, and finally rejects expired entries using `Utc::now()`. Only after all checks does it return the signed payload.

`save` computes `expires_at` from a one-hour TTL, serializes the payload, signs it with the current write key, creates parent directories if needed, and writes pretty-printed JSON. Signature helpers use HMAC-SHA256 and base64 encoding; verification supports key rotation by trying every key in `CLOUD_CONFIG_BUNDLE_CACHE_READ_HMAC_KEYS`. `log_load_status` intentionally suppresses logs for cache misses but emits warnings for corruption/tampering and info for benign skips like mismatch or expiry.

#### Function details

##### `CloudConfigBundleCache::new`  (lines 39–43)

```
fn new(codex_home: AbsolutePathBuf) -> Self
```

**Purpose**: Constructs a cache object rooted at the caller’s resolved Codex home directory.

**Data flow**: Consumes an `AbsolutePathBuf` and appends `CLOUD_CONFIG_BUNDLE_CACHE_FILENAME` via `join`, storing the resulting absolute path in `CloudConfigBundleCache`. It returns the new cache wrapper.

**Call relations**: Created by the service during initialization and by tests when preparing or inspecting cache files.

*Call graph*: calls 1 internal fn (join); called by 3 (create_test_cache, new, create_test_cache).


##### `CloudConfigBundleCache::path`  (lines 45–47)

```
fn path(&self) -> &Path
```

**Purpose**: Exposes the filesystem path of the cache file for logging and test helpers.

**Data flow**: Borrows `self` and returns `&Path` referencing the internally stored absolute path. It performs no transformation or mutation.

**Call relations**: Used by tests to write/read the cache file directly and by service logging paths when cached content is used or rejected.

*Call graph*: called by 1 (write_cache_file).


##### `CloudConfigBundleCache::load`  (lines 49–107)

```
async fn load(
        &self,
        chatgpt_user_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<CloudConfigBundleCacheSignedPayload, CacheLoadStatus>
```

**Purpose**: Reads, authenticates, version-checks, identity-checks, and TTL-checks the cached bundle payload, returning a detailed status on every failure mode.

**Data flow**: Takes optional request `chatgpt_user_id` and `account_id`. If either is `None`, it returns `Err(AuthIdentityIncomplete)` immediately. Otherwise it asynchronously reads `self.path`; not-found becomes `CacheFileNotFound`, other I/O errors become `CacheReadFailed(String)`. It parses bytes into `CloudConfigBundleCacheFile` with `serde_json::from_slice`; parse failures become `CacheParseFailed`. It reserializes `signed_payload` with `cache_payload_bytes`; failure also maps to `CacheParseFailed`. It verifies the HMAC with `verify_cache_signature`, checks `version` against `CLOUD_CONFIG_BUNDLE_CACHE_VERSION`, requires both cached identity fields to be present, compares them to the requested identity, and rejects expired payloads using `Utc::now()`. On success it returns the validated `CloudConfigBundleCacheSignedPayload`.

**Call relations**: Called by the service before any remote fetch on startup. It delegates serialization and signature checks to the helper functions and returns granular statuses so the service can log and decide whether to refetch.

*Call graph*: calls 2 internal fn (cache_payload_bytes, verify_cache_signature); called by 1 (load_valid_cached_bundle); 6 external calls (now, CacheParseFailed, CacheReadFailed, CacheVersionUnsupported, read, from_slice).


##### `CloudConfigBundleCache::log_load_status`  (lines 109–126)

```
fn log_load_status(&self, status: &CacheLoadStatus)
```

**Purpose**: Logs cache load outcomes with severity chosen to distinguish corruption from expected misses or skips.

**Data flow**: Borrows `self` and a `CacheLoadStatus`. It returns early for `CacheFileNotFound` to avoid noisy logs. For read/parse/signature failures it emits `tracing::warn!`; for other statuses such as identity mismatch, unsupported version, expiry, or invalid bundle it emits `tracing::info!`, always including the cache path.

**Call relations**: Used by the service after cache lookup attempts, both for direct cache failures and for the synthetic `CacheInvalidBundle` case when validation rejects an otherwise well-formed cached payload.

*Call graph*: called by 1 (load_valid_cached_bundle); 3 external calls (matches!, info!, warn!).


##### `CloudConfigBundleCache::save`  (lines 128–167)

```
async fn save(
        &self,
        chatgpt_user_id: Option<String>,
        account_id: Option<String>,
        bundle: CloudConfigBundle,
    ) -> Result<(), CloudConfigBundleCacheError>
```

**Purpose**: Writes a fresh signed cache file containing the bundle, identity scope, version, and expiration timestamp.

**Data flow**: Consumes optional owned `chatgpt_user_id`, optional owned `account_id`, and a `CloudConfigBundle`. It captures `Utc::now()`, computes `expires_at` by adding the fixed TTL via `ChronoDuration::from_std`, builds `CloudConfigBundleCacheSignedPayload`, serializes that payload with `cache_payload_bytes`, signs the bytes with `sign_cache_payload`, wraps both into `CloudConfigBundleCacheFile`, and pretty-serializes to JSON. If the cache path has a parent directory, it asynchronously creates it with `create_dir_all`, then writes the file bytes with `fs::write`. Any failure collapses to `CloudConfigBundleCacheError`; success returns `Ok(())`.

**Call relations**: Invoked only after a remotely fetched bundle passes validation. The service treats cache write failure as non-fatal and continues using the fetched bundle.

*Call graph*: calls 3 internal fn (cache_payload_bytes, sign_cache_payload, parent); called by 1 (validate_and_cache_remote_bundle); 5 external calls (from_std, now, create_dir_all, write, to_vec_pretty).


##### `cache_payload_bytes`  (lines 214–218)

```
fn cache_payload_bytes(
    payload: &CloudConfigBundleCacheSignedPayload,
) -> Option<Vec<u8>>
```

**Purpose**: Produces the canonical serialized byte representation of a signed payload for signing and verification.

**Data flow**: Borrows a `CloudConfigBundleCacheSignedPayload`, serializes it with `serde_json::to_vec`, and returns `Some(Vec<u8>)` on success or `None` on serialization failure.

**Call relations**: Shared by both `load` and `save` so the exact same payload encoding is used when generating and verifying HMAC signatures.

*Call graph*: called by 2 (load, save); 1 external calls (to_vec).


##### `sign_cache_payload`  (lines 220–225)

```
fn sign_cache_payload(payload_bytes: &[u8]) -> Option<String>
```

**Purpose**: Computes the base64-encoded HMAC-SHA256 signature for serialized cache payload bytes using the current write key.

**Data flow**: Takes raw payload bytes, initializes `HmacSha256` from `CLOUD_CONFIG_BUNDLE_CACHE_WRITE_HMAC_KEY`, feeds the bytes into the MAC, finalizes to signature bytes, base64-encodes them with `BASE64_STANDARD`, and returns the resulting `String` inside `Some`. If MAC initialization fails, it returns `None`.

**Call relations**: Used during cache writes to populate the `signature` field stored alongside the payload.

*Call graph*: called by 1 (save); 1 external calls (new_from_slice).


##### `verify_cache_signature`  (lines 227–236)

```
fn verify_cache_signature(payload_bytes: &[u8], signature: &str) -> bool
```

**Purpose**: Checks whether a stored base64 signature matches the payload under any accepted read key.

**Data flow**: Takes payload bytes and a signature string. It first base64-decodes the signature; decode failure returns `false`. It then iterates `CLOUD_CONFIG_BUNDLE_CACHE_READ_HMAC_KEYS` and returns `true` if any key makes `verify_cache_signature_with_key` succeed, otherwise `false`.

**Call relations**: Called during cache load before version, identity, or TTL checks so tampered files are rejected immediately. The multi-key loop supports future key rotation.

*Call graph*: called by 1 (load).


##### `verify_cache_signature_with_key`  (lines 238–249)

```
fn verify_cache_signature_with_key(
    payload_bytes: &[u8],
    signature_bytes: &[u8],
    key: &[u8],
) -> bool
```

**Purpose**: Performs the actual HMAC-SHA256 verification of payload bytes against decoded signature bytes for one specific key.

**Data flow**: Takes payload bytes, decoded signature bytes, and a candidate key. It initializes `HmacSha256` from the key, updates it with the payload bytes, and returns whether `verify_slice(signature_bytes)` succeeds. Invalid key material yields `false`.

**Call relations**: This private helper is used only by `verify_cache_signature` while trying each accepted read key.

*Call graph*: 1 external calls (new_from_slice).


### Catalog persistence caches
These files persist fetched directory-style data for connectors, plugins, and models so higher-level refresh flows can reuse local results and fall back when remote fetches are unavailable.

### `connectors/src/directory_cache.rs`

`io_transport` · `connector directory cache read/write during fetch and cache lookup`

This file is the disk-backed half of connector directory caching. Its central type, `ConnectorDirectoryCacheContext`, carries the caller’s `codex_home` root and a `ConnectorDirectoryCacheKey`; together they determine where a cache file lives under `cache/codex_app_directory`. The filename is not the raw key but a SHA-1 hex digest of the key serialized as JSON, which avoids leaking account identifiers into paths and keeps filenames filesystem-safe.

The cache payload is stored as pretty-printed JSON in the private `ConnectorDirectoryDiskCache` struct, containing a `schema_version` and `Vec<AppInfo>`. Reads return a three-way result via `CachedConnectorDirectoryDiskLoad`: `Hit`, `Missing`, or `Invalid`. The loader distinguishes a missing file from other I/O failures, logs unexpected read/parse errors with `tracing::warn!`, and proactively deletes cache files that cannot be parsed or whose schema version no longer matches `CONNECTOR_DIRECTORY_DISK_CACHE_SCHEMA_VERSION`. That deletion behavior is important: invalid cache entries are treated as self-healing rather than repeatedly retried.

Writes are intentionally best-effort. The writer creates parent directories if possible, serializes the current schema version plus connector list, and ignores serialization or filesystem write failures. There is no locking, partial-write recovery, or multi-entry index; the design assumes a single cache blob per key and relies on higher layers for freshness and fallback fetching.

#### Function details

##### `ConnectorDirectoryCacheContext::new`  (lines 22–27)

```
fn new(codex_home: PathBuf, cache_key: ConnectorDirectoryCacheKey) -> Self
```

**Purpose**: Constructs the cache context object that binds a Codex home directory to a specific connector-directory cache key.

**Data flow**: Takes a `PathBuf` for `codex_home` and a `ConnectorDirectoryCacheKey`, stores them unchanged in a new `ConnectorDirectoryCacheContext`, and returns that struct without side effects.

**Call relations**: It is created by higher-level cache-context builders before any cache lookup or write. Those callers pass the resulting context into disk and memory cache routines so all later path derivation uses the same account-scoped inputs.

*Call graph*: called by 3 (connector_directory_cache_context, cache_context, cached_directory_connectors_for_tool_suggest_with_auth).


##### `ConnectorDirectoryCacheContext::cache_path`  (lines 29–35)

```
fn cache_path(&self) -> PathBuf
```

**Purpose**: Computes the exact JSON cache file path for this context by hashing the serialized cache key.

**Data flow**: Reads `self.cache_key`, serializes it with `serde_json::to_string`, falls back to an empty string on serialization failure, hashes that string through `sha1_hex`, and joins `self.codex_home`, the fixed cache directory, and `<hash>.json` into a `PathBuf` return value.

**Call relations**: Both disk load and disk write call this first so they operate on the same deterministic file. It delegates hashing to `sha1_hex` and keeps path construction centralized instead of duplicating filename logic.

*Call graph*: calls 1 internal fn (sha1_hex); called by 2 (load_cached_directory_connectors_from_disk, write_cached_directory_connectors_to_disk); 3 external calls (join, format!, to_string).


##### `load_cached_directory_connectors_from_disk`  (lines 44–80)

```
fn load_cached_directory_connectors_from_disk(
    cache_context: &ConnectorDirectoryCacheContext,
) -> CachedConnectorDirectoryDiskLoad
```

**Purpose**: Attempts to read and validate a cached connector directory JSON file from disk, returning whether it was usable, absent, or invalid.

**Data flow**: Consumes a `&ConnectorDirectoryCacheContext`, derives the cache path, reads raw bytes from that file, deserializes them into `ConnectorDirectoryDiskCache`, checks `schema_version`, and returns `Hit { connectors }`, `Missing`, or `Invalid`. On non-NotFound read errors and JSON parse errors it emits warnings; on parse failure or schema mismatch it also removes the cache file.

**Call relations**: It is invoked by the higher-level `cached_directory_connectors` path after the in-memory cache misses. It delegates path derivation to `cache_path` and JSON decoding to `serde_json::from_slice`; invalid outcomes signal the caller to refetch rather than trust disk state.

*Call graph*: calls 1 internal fn (cache_path); called by 1 (cached_directory_connectors); 4 external calls (from_slice, read, remove_file, warn!).


##### `write_cached_directory_connectors_to_disk`  (lines 82–99)

```
fn write_cached_directory_connectors_to_disk(
    cache_context: &ConnectorDirectoryCacheContext,
    connectors: &[AppInfo],
)
```

**Purpose**: Persists a connector list to the cache file as versioned JSON, creating the cache directory if needed.

**Data flow**: Takes a cache context and `&[AppInfo]`, computes the target path, creates parent directories when present, serializes a `ConnectorDirectoryDiskCache` containing the current schema version and a cloned connector vector, and writes the resulting bytes to disk. Any directory creation, serialization, or write failure causes an early return or ignored error with no propagated result.

**Call relations**: It is called by the library-level cache writer after fresh connector data has been assembled. It relies on `cache_path` for location and intentionally acts as a best-effort sink so fetch success is not blocked by cache persistence failures.

*Call graph*: calls 1 internal fn (cache_path); called by 1 (write_cached_directory_connectors); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `sha1_hex`  (lines 107–112)

```
fn sha1_hex(value: &str) -> String
```

**Purpose**: Produces a lowercase hexadecimal SHA-1 digest string for an input string.

**Data flow**: Accepts `&str`, feeds its UTF-8 bytes into a new `Sha1` hasher, finalizes the digest, formats it as lowercase hex, and returns the resulting `String`.

**Call relations**: It is only used by `ConnectorDirectoryCacheContext::cache_path` to turn serialized cache-key JSON into a compact filename component.

*Call graph*: called by 1 (cache_path); 2 external calls (new, format!).


### `core-plugins/src/remote/catalog_cache.rs`

`io_transport` · `remote catalog fetch and cache lookup`

This file defines a tiny disk-cache format for lists of `RemotePluginDirectoryItem` and the logic to read and write that cache under `cache/remote_plugin_catalog` inside `codex_home`. The cache is intentionally scoped by a serialized `RemotePluginCatalogCacheKey`, which captures `chatgpt_base_url`, optional `account_id`, optional `chatgpt_user_id`, and whether the auth represents a workspace account. That means two users hitting the same backend, or the same user switching account context, get separate cache files.

The on-disk payload is `RemotePluginCatalogDiskCache { schema_version, plugins }`, serialized as pretty JSON. Reads are defensive: missing files return `None`, other I/O failures are logged with `tracing::warn!`, malformed JSON is warned about and deleted, and schema-version mismatches are silently invalidated by deleting the stale file. Writes are also best-effort: parent directories are created if possible, serialization failures abort the write, and the final `std::fs::write` result is ignored.

`cache_path` does not expose account data in filenames. Instead it serializes the cache key to JSON and computes a simple 64-bit FNV-style hash, then uses a fixed-width hex filename like `xxxxxxxxxxxxxxxx.json`. The design favors privacy and stable partitioning over cryptographic guarantees; collisions are theoretically possible but unlikely for this cache use.

#### Function details

##### `RemotePluginCatalogCacheKey::global`  (lines 22–29)

```
fn global(config: &RemotePluginServiceConfig, auth: &CodexAuth) -> Self
```

**Purpose**: Builds the cache partition key for the global remote catalog from service configuration and the current authenticated ChatGPT identity.

**Data flow**: It reads `config.chatgpt_base_url` plus `auth.get_account_id()`, `auth.get_chatgpt_user_id()`, and `auth.is_workspace_account()`, then packages those values into a new `RemotePluginCatalogCacheKey`. It returns that key without mutating external state.

**Call relations**: This constructor is used by both cache readers and writers so they derive exactly the same identity-scoped key before delegating to `cache_path`.

*Call graph*: calls 3 internal fn (get_account_id, get_chatgpt_user_id, is_workspace_account); called by 2 (load_cached_global_directory_plugins, write_cached_global_directory_plugins).


##### `load_cached_global_directory_plugins`  (lines 38–75)

```
fn load_cached_global_directory_plugins(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Option<Vec<RemotePluginDirectoryItem>>
```

**Purpose**: Attempts to load a previously cached global plugin directory listing from disk and rejects stale or corrupt cache files.

**Data flow**: It takes `codex_home`, `config`, and `auth`; derives a cache key via `RemotePluginCatalogCacheKey::global`; converts that to a file path with `cache_path`; reads raw bytes from disk; deserializes `RemotePluginCatalogDiskCache` from JSON; checks `schema_version`; and returns `Some(Vec<RemotePluginDirectoryItem>)` on success or `None` on any miss/invalid condition. On parse failure or schema mismatch it removes the cache file, and on non-`NotFound` read errors or parse errors it emits a warning.

**Call relations**: Higher-level remote discovery and marketplace-fetch paths call this as a fast path before hitting the network. Internally it delegates path derivation to `global` and `cache_path`, then uses filesystem and serde operations to validate the cache before handing plugin items back to its callers.

*Call graph*: calls 2 internal fn (global, cache_path); called by 3 (cached_global_remote_discoverable_plugins, fetch_remote_marketplaces, has_cached_global_remote_plugin_catalog); 4 external calls (from_slice, read, remove_file, warn!).


##### `write_cached_global_directory_plugins`  (lines 77–99)

```
fn write_cached_global_directory_plugins(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    plugins: &[RemotePluginDirectoryItem],
)
```

**Purpose**: Serializes a fresh global plugin directory listing and stores it in the identity-scoped disk cache location.

**Data flow**: It receives `codex_home`, `config`, `auth`, and a slice of `RemotePluginDirectoryItem`; derives the cache file path from `global` and `cache_path`; creates the parent directory if needed; clones the slice into a `Vec`; wraps it in `RemotePluginCatalogDiskCache` with the current schema version; serializes to pretty JSON bytes; and writes those bytes to disk. Any directory-creation, serialization, or write failure is ignored after aborting the operation.

**Call relations**: Network fetch paths call this after successfully obtaining remote catalog data. It mirrors the reader’s key/path logic so subsequent `load_cached_global_directory_plugins` calls can find the same file.

*Call graph*: calls 2 internal fn (global, cache_path); called by 2 (fetch_and_cache_global_remote_plugin_catalog, fetch_remote_marketplaces); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `cache_path`  (lines 101–111)

```
fn cache_path(codex_home: &Path, cache_key: &RemotePluginCatalogCacheKey) -> PathBuf
```

**Purpose**: Maps a logical cache key to a deterministic filename under the remote catalog cache directory.

**Data flow**: It takes `codex_home` and a `RemotePluginCatalogCacheKey`, serializes the key to JSON bytes with a default empty vector fallback, folds those bytes into a 64-bit FNV-like hash, and joins `codex_home`, `REMOTE_PLUGIN_CATALOG_DISK_CACHE_DIR`, and a zero-padded hex filename into a `PathBuf`. It returns that path and does not touch the filesystem.

**Call relations**: Both the load and write paths rely on this helper after constructing the same cache key, ensuring they converge on one disk location per backend/account/user/workspace combination.

*Call graph*: called by 2 (load_cached_global_directory_plugins, write_cached_global_directory_plugins); 4 external calls (join, format!, to_vec, from).


### `models-manager/src/cache.rs`

`io_transport` · `model catalog refresh caching`

This file defines two closely related types: `ModelsCacheManager`, which owns the cache file path and TTL policy, and `ModelsCache`, the serialized snapshot written to disk. A cache entry stores `fetched_at`, optional `etag`, optional `client_version`, and the full `Vec<ModelInfo>` returned by a models fetch. Serialization uses Serde, with `etag` and `client_version` omitted when absent.

`ModelsCacheManager::load_fresh` is the main read path. It logs an attempted load, calls the internal `load`, logs and returns `None` on I/O or parse failure, then rejects the cache if `client_version` does not match the caller's expected version or if `ModelsCache::is_fresh` says the entry is stale. Only a matching, fresh cache is returned. `persist_cache` builds a new snapshot with `Utc::now()` and writes it via `save_internal`, logging but swallowing write failures. `renew_cache_ttl` is a lighter-weight update path that reloads an existing cache, errors with `NotFound` if absent, updates only `fetched_at`, and rewrites the file.

The internal `load` method reads bytes asynchronously with Tokio, treats missing files as `Ok(None)`, and maps JSON parse errors to `io::ErrorKind::InvalidData`. `save_internal` creates parent directories if needed and writes pretty-printed JSON. Freshness logic is intentionally conservative: zero TTL is always stale, and any failure converting `std::time::Duration` to `chrono::Duration` also yields stale. Test-only helpers allow direct TTL changes and mutation of timestamps or full cache contents after loading the current file.

#### Function details

##### `ModelsCacheManager::new`  (lines 23–28)

```
fn new(cache_path: PathBuf, cache_ttl: Duration) -> Self
```

**Purpose**: Creates a cache manager bound to a specific cache file path and TTL policy.

**Data flow**: It takes a `PathBuf` and `Duration`, stores them as `cache_path` and `cache_ttl`, and returns a new `ModelsCacheManager`.

**Call relations**: This constructor is used by higher-level models-manager code when setting up remote catalog caching.

*Call graph*: called by 1 (new).


##### `ModelsCacheManager::load_fresh`  (lines 31–74)

```
async fn load_fresh(&self, expected_version: &str) -> Option<ModelsCache>
```

**Purpose**: Loads a cache entry only if it exists, parses successfully, matches the expected client version, and is still within TTL.

**Data flow**: It takes `expected_version`, logs the attempt, awaits `self.load()`, returns `None` on missing cache, parse/I/O error, version mismatch, or stale timestamp, and otherwise returns `Some(ModelsCache)`. Along the way it logs cache metadata, mismatch reasons, and cache-hit/stale outcomes.

**Call relations**: This is the main cache-read path used by remote models refresh logic before making network requests. It delegates to `load` for disk I/O and to `ModelsCache::is_fresh` for TTL evaluation.

*Call graph*: calls 1 internal fn (load); called by 1 (try_load_cache); 2 external calls (error!, info!).


##### `ModelsCacheManager::persist_cache`  (lines 77–92)

```
async fn persist_cache(
        &self,
        models: &[ModelInfo],
        etag: Option<String>,
        client_version: String,
    )
```

**Purpose**: Writes a freshly fetched models snapshot to disk with the current timestamp and optional ETag/version metadata.

**Data flow**: It takes a slice of `ModelInfo`, optional `etag`, and `client_version`, constructs a `ModelsCache` with `fetched_at: Utc::now()` and `models: models.to_vec()`, then awaits `save_internal(&cache)`. Any write error is logged and otherwise ignored.

**Call relations**: This method is called after successful remote model fetches to update the on-disk cache. It delegates actual serialization and file writing to `save_internal`.

*Call graph*: calls 1 internal fn (save_internal); called by 1 (fetch_and_update_models); 3 external calls (now, error!, to_vec).


##### `ModelsCacheManager::renew_cache_ttl`  (lines 95–102)

```
async fn renew_cache_ttl(&self) -> io::Result<()>
```

**Purpose**: Extends the freshness window of an existing cache entry without changing its models or metadata.

**Data flow**: It awaits `self.load()?`, returns `io::ErrorKind::NotFound` if no cache exists, updates `cache.fetched_at` to `Utc::now()`, and rewrites the cache via `save_internal(&cache)`.

**Call relations**: This method is used when higher-level refresh logic determines the cached content is still valid, such as on an unchanged ETag path, and only the timestamp needs renewal.

*Call graph*: calls 2 internal fn (load, save_internal); called by 1 (refresh_if_new_etag); 2 external calls (now, new).


##### `ModelsCacheManager::load`  (lines 104–114)

```
async fn load(&self) -> io::Result<Option<ModelsCache>>
```

**Purpose**: Reads and deserializes the cache file from disk.

**Data flow**: It asynchronously reads `self.cache_path` with `fs::read`. On success it deserializes the bytes into `ModelsCache` with `serde_json::from_slice`, mapping parse failures to `io::ErrorKind::InvalidData`, and returns `Ok(Some(cache))`. A missing file becomes `Ok(None)`; other I/O errors are returned unchanged.

**Call relations**: This internal helper underpins `load_fresh`, `renew_cache_ttl`, and the test mutation helpers.

*Call graph*: called by 4 (load_fresh, manipulate_cache_for_test, mutate_cache_for_test, renew_cache_ttl); 2 external calls (read, from_slice).


##### `ModelsCacheManager::save_internal`  (lines 116–123)

```
async fn save_internal(&self, cache: &ModelsCache) -> io::Result<()>
```

**Purpose**: Serializes a cache entry and writes it to the configured cache path, creating parent directories first.

**Data flow**: It takes a `&ModelsCache`, checks `self.cache_path.parent()`, creates that directory tree with `fs::create_dir_all` when present, serializes the cache with `serde_json::to_vec_pretty`, maps serialization failures to `io::ErrorKind::InvalidData`, and writes the bytes with `fs::write`.

**Call relations**: This internal helper is the common write path used by cache persistence, TTL renewal, and test mutation helpers.

*Call graph*: called by 4 (manipulate_cache_for_test, mutate_cache_for_test, persist_cache, renew_cache_ttl); 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `ModelsCacheManager::set_ttl`  (lines 127–129)

```
fn set_ttl(&mut self, ttl: Duration)
```

**Purpose**: Test-only setter that changes the cache TTL after construction.

**Data flow**: It takes a mutable reference to the manager and a new `Duration`, assigns that duration to `self.cache_ttl`, and returns unit.

**Call relations**: This helper exists only for tests that need to force fresh or stale behavior without rebuilding the manager.


##### `ModelsCacheManager::manipulate_cache_for_test`  (lines 133–143)

```
async fn manipulate_cache_for_test(&self, f: F) -> io::Result<()>
```

**Purpose**: Test-only helper that mutates just the cached timestamp through a caller-supplied closure.

**Data flow**: It loads the current cache with `self.load().await?`, returns `NotFound` if absent, passes `&mut cache.fetched_at` to the closure `f`, then rewrites the modified cache with `save_internal`.

**Call relations**: This helper is used by tests that need to simulate stale or fresh cache ages while preserving the rest of the cache contents.

*Call graph*: calls 2 internal fn (load, save_internal); 1 external calls (new).


##### `ModelsCacheManager::mutate_cache_for_test`  (lines 147–157)

```
async fn mutate_cache_for_test(&self, f: F) -> io::Result<()>
```

**Purpose**: Test-only helper that allows arbitrary mutation of the full cached snapshot before rewriting it.

**Data flow**: It loads the current cache, errors with `NotFound` if absent, passes `&mut ModelsCache` to the closure `f`, and persists the modified cache via `save_internal`.

**Call relations**: This broader mutation helper supports tests that need to alter version, ETag, models, or timestamps in one step.

*Call graph*: calls 2 internal fn (load, save_internal); 1 external calls (new).


##### `ModelsCache::is_fresh`  (lines 173–182)

```
fn is_fresh(&self, ttl: Duration) -> bool
```

**Purpose**: Determines whether a cached snapshot is still valid under a given TTL.

**Data flow**: It takes a `Duration`, immediately returns `false` for zero TTL, attempts to convert the TTL to `chrono::Duration` and returns `false` on conversion failure, computes `age` as `Utc::now().signed_duration_since(self.fetched_at)`, and returns whether `age <= ttl_duration`.

**Call relations**: This method is called by `ModelsCacheManager::load_fresh` as the final freshness gate after version matching.

*Call graph*: 3 external calls (is_zero, now, from_std).


### Local plugin path mapping
This utility maintains the small persisted mapping from shared remote plugin identifiers to local filesystem paths, with simple concurrency protection around file access.

### `core-plugins/src/remote/share/local_paths.rs`

`util` · `cross-cutting share bookkeeping`

This file is a small persistence utility for share bookkeeping. The on-disk file is `.tmp/plugin-share-local-paths-v1.json`, containing a `PluginShareLocalPaths` wrapper with one field: `local_plugin_paths_by_remote_plugin_id: BTreeMap<String, AbsolutePathBuf>`. The wrapper uses camelCase serde naming so the JSON field is stable and explicit.

All public operations first acquire `PLUGIN_SHARE_LOCAL_PATHS_LOCK`, a global `Mutex<()>`, to serialize reads and updates within the process. `load_plugin_share_local_paths` performs a locked read and returns the raw mapping. `record_plugin_share_local_path` and `remove_plugin_share_local_path` perform read-modify-write updates under the same lock.

Reads are tolerant of missing files: `read_plugin_share_local_paths` returns an empty map on `NotFound`. Parse failures become `io::ErrorKind::InvalidData` with the file path embedded in the message. Update paths are intentionally more forgiving: `read_plugin_share_local_paths_for_update` treats malformed JSON as empty state so a corrupted best-effort cache does not permanently block future saves or deletes.

Writes remove the file entirely when the mapping becomes empty. Otherwise they pretty-print JSON, append a trailing newline, and persist it atomically through a temporary file in the same directory. The design is deliberately simple and local: no cross-process locking, but safe enough for in-process concurrent share operations.

#### Function details

##### `load_plugin_share_local_paths`  (lines 20–25)

```
fn load_plugin_share_local_paths(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Loads the current remote-plugin-ID to local-path mapping under a process-local lock.

**Data flow**: It takes `codex_home`, acquires the mutex via `lock_plugin_share_local_paths`, then calls `read_plugin_share_local_paths` and returns its `io::Result<BTreeMap<String, AbsolutePathBuf>>`. It does not mutate the mapping.

**Call relations**: Share listing, checkout, and reverse-lookup code call this when they need a consistent snapshot of the persisted mapping.

*Call graph*: calls 2 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths); called by 3 (load_share_local_paths_for_checkout, list_remote_plugin_shares, load_plugin_share_remote_ids_by_local_path).


##### `record_plugin_share_local_path`  (lines 27–36)

```
fn record_plugin_share_local_path(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: AbsolutePathBuf,
) -> io::Result<()>
```

**Purpose**: Adds or replaces the local path associated with a remote shared plugin ID.

**Data flow**: It locks the mapping file, loads existing state with `read_plugin_share_local_paths_for_update`, inserts `remote_plugin_id -> plugin_path` into the `BTreeMap`, and writes the updated map back with `write_plugin_share_local_paths`. The only persistent state changed is the JSON mapping file.

**Call relations**: Successful share saves and successful share checkouts call this to remember where the local plugin lives for a given remote plugin ID.

*Call graph*: calls 3 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths_for_update, write_plugin_share_local_paths); called by 2 (checkout_remote_plugin_share, save_remote_plugin_share).


##### `remove_plugin_share_local_path`  (lines 38–46)

```
fn remove_plugin_share_local_path(
    codex_home: &Path,
    remote_plugin_id: &str,
) -> io::Result<()>
```

**Purpose**: Deletes the stored local-path mapping for a remote shared plugin ID.

**Data flow**: It locks the mapping file, loads current state with `read_plugin_share_local_paths_for_update`, removes the `remote_plugin_id` key from the map, and persists the result with `write_plugin_share_local_paths`. If the map becomes empty, the backing file is deleted.

**Call relations**: Remote share deletion calls this after the backend delete succeeds to clean up local bookkeeping.

*Call graph*: calls 3 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths_for_update, write_plugin_share_local_paths); called by 1 (delete_remote_plugin_share).


##### `lock_plugin_share_local_paths`  (lines 48–52)

```
fn lock_plugin_share_local_paths() -> io::Result<std::sync::MutexGuard<'static, ()>>
```

**Purpose**: Acquires the global mutex guarding in-process access to the share local-path mapping.

**Data flow**: It locks `PLUGIN_SHARE_LOCAL_PATHS_LOCK` and returns the `MutexGuard`. If the mutex is poisoned, it converts that condition into `io::Error::other` with a descriptive message.

**Call relations**: All public mapping operations call this first so reads and read-modify-write updates do not interleave within the process.

*Call graph*: called by 3 (load_plugin_share_local_paths, record_plugin_share_local_path, remove_plugin_share_local_path).


##### `read_plugin_share_local_paths`  (lines 54–74)

```
fn read_plugin_share_local_paths(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Reads and parses the mapping file from disk without applying update-specific recovery behavior.

**Data flow**: It computes the file path with `plugin_share_local_paths_path`, reads the file as a string, returns an empty `BTreeMap` on `NotFound`, parses JSON into `PluginShareLocalPaths`, and returns the inner `local_plugin_paths_by_remote_plugin_id` map. Parse failures become `io::ErrorKind::InvalidData` with the path included in the message.

**Call relations**: The locked read path uses this directly, and update operations use it indirectly through `read_plugin_share_local_paths_for_update`.

*Call graph*: calls 1 internal fn (plugin_share_local_paths_path); called by 2 (load_plugin_share_local_paths, read_plugin_share_local_paths_for_update); 2 external calls (new, read_to_string).


##### `read_plugin_share_local_paths_for_update`  (lines 76–86)

```
fn read_plugin_share_local_paths_for_update(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Loads mapping state for mutation, treating malformed JSON as empty state so future updates can recover.

**Data flow**: It calls `read_plugin_share_local_paths(codex_home)`. Successful reads are returned unchanged; `InvalidData` errors are converted into `Ok(BTreeMap::new())`; all other I/O errors are propagated.

**Call relations**: Both record and remove operations use this helper so a corrupted `.tmp` file does not block subsequent writes.

*Call graph*: calls 1 internal fn (read_plugin_share_local_paths); called by 2 (record_plugin_share_local_path, remove_plugin_share_local_path); 1 external calls (new).


##### `write_plugin_share_local_paths`  (lines 88–106)

```
fn write_plugin_share_local_paths(
    codex_home: &Path,
    mapping: BTreeMap<String, AbsolutePathBuf>,
) -> io::Result<()>
```

**Purpose**: Persists the mapping file, or removes it entirely when there are no entries left.

**Data flow**: It computes the target path with `plugin_share_local_paths_path`. If `mapping` is empty, it tries to remove the file and treats `NotFound` as success. Otherwise it wraps the map in `PluginShareLocalPaths`, pretty-serializes it to JSON, appends a newline, and writes it atomically via `write_atomically`.

**Call relations**: This is the shared persistence sink for both add/update and remove operations.

*Call graph*: calls 2 internal fn (plugin_share_local_paths_path, write_atomically); called by 2 (record_plugin_share_local_path, remove_plugin_share_local_path); 3 external calls (format!, to_string_pretty, remove_file).


##### `write_atomically`  (lines 108–120)

```
fn write_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: Writes text contents to a path by creating a temporary file in the same directory and persisting it into place.

**Data flow**: It derives the parent directory from `write_path`, errors if absent, creates the parent directories, creates a `NamedTempFile` in that directory, writes `contents` bytes, and persists the temp file to the final path. It returns the resulting `io::Result<()>`.

**Call relations**: `write_plugin_share_local_paths` delegates here to avoid partially written mapping files.

*Call graph*: called by 1 (write_plugin_share_local_paths); 3 external calls (parent, create_dir_all, new_in).


##### `plugin_share_local_paths_path`  (lines 122–124)

```
fn plugin_share_local_paths_path(codex_home: &Path) -> std::path::PathBuf
```

**Purpose**: Computes the absolute path of the share local-path mapping file under a Codex home directory.

**Data flow**: It joins `codex_home` with the constant `PLUGIN_SHARE_LOCAL_PATHS_FILE` and returns the resulting `PathBuf`. It performs no I/O.

**Call relations**: Both read and write helpers use this so they agree on the exact mapping-file location.

*Call graph*: called by 2 (read_plugin_share_local_paths, write_plugin_share_local_paths); 1 external calls (join).


### Update UI state cache
This final cache stores lightweight persisted update-state data such as dismissal records for the TUI update flow.

### `tui/src/updates_cache.rs`

`io_transport` · `startup cache reads and dismissal persistence`

This module is the persistence layer for update metadata stored under the user's Codex home directory. Its central data type is `VersionInfo`, a serde-serializable struct containing `latest_version`, `last_checked_at` as `DateTime<Utc>`, and an optional `dismissed_version`. The `dismissed_version` field is marked with `#[serde(default)]`, which lets older cache files deserialize cleanly even if they predate dismissal support.

`version_filepath` is a simple path constructor that appends the fixed filename `version.json` to `config.codex_home`. `read_version_info` performs synchronous disk I/O with `std::fs::read_to_string` and deserializes the JSON payload into `VersionInfo`; callers treat any error as cache absence or corruption and recover accordingly.

`dismiss_version` is the only mutating operation in this file. It computes the cache path, tries to load existing metadata, and if that fails synthesizes a fallback `VersionInfo` whose `latest_version` is the dismissed version and whose `last_checked_at` is `DateTime::<Utc>::UNIX_EPOCH`. It then overwrites `dismissed_version` with the provided version, serializes the struct as a single JSON line with a trailing newline, ensures the parent directory exists, and writes the file asynchronously. Preserving or synthesizing `latest_version` means popup suppression can work even when no prior successful update check has populated the cache.

#### Function details

##### `version_filepath`  (lines 20–22)

```
fn version_filepath(config: &Config) -> PathBuf
```

**Purpose**: Computes the canonical path of the update cache file inside the configured Codex home directory.

**Data flow**: It takes `&Config`, reads `config.codex_home`, joins the constant `VERSION_FILENAME`, converts the result into a `PathBuf`, and returns it. No filesystem access occurs.

**Call relations**: This helper is used by update-checking and dismissal code so all readers and writers agree on the same cache location.

*Call graph*: called by 3 (get_upgrade_version, get_upgrade_version_for_popup, dismiss_version).


##### `read_version_info`  (lines 24–27)

```
fn read_version_info(version_file: &Path) -> anyhow::Result<VersionInfo>
```

**Purpose**: Loads and deserializes the cached update metadata from disk.

**Data flow**: It takes a `&Path`, reads the entire file contents with `std::fs::read_to_string`, then parses the JSON into `VersionInfo` with `serde_json::from_str`. It returns `anyhow::Result<VersionInfo>` and does not write state.

**Call relations**: Callers across `updates.rs` and `dismiss_version` use this as the single cache-read path, typically treating errors as a missing or unusable cache.

*Call graph*: called by 4 (check_for_update, get_upgrade_version, get_upgrade_version_for_popup, dismiss_version); 2 external calls (from_str, read_to_string).


##### `dismiss_version`  (lines 31–48)

```
async fn dismiss_version(config: &Config, version: &str) -> anyhow::Result<()>
```

**Purpose**: Persists the user's choice to suppress the popup for a specific latest version.

**Data flow**: It takes `&Config` and the version string to dismiss. It computes the cache path with `version_filepath`, tries `read_version_info`, and on failure creates a fallback `VersionInfo` with `latest_version` set to the provided version, `last_checked_at` set to `UNIX_EPOCH`, and no dismissal yet. It then sets `info.dismissed_version = Some(version.to_string())`, serializes the struct to JSON plus newline, creates the parent directory if necessary, writes the file asynchronously with `tokio::fs::write`, and returns `anyhow::Result<()>`.

**Call relations**: This function is called from the update prompt when the user chooses “Skip until next version.” It reuses the same cache file as the background update checker so popup gating can compare the dismissed version against the latest known version.

*Call graph*: calls 2 internal fn (read_version_info, version_filepath); 3 external calls (format!, create_dir_all, write).
