# Caches and local persisted lookup data  `stage-21.3`

This stage is shared behind-the-scenes support. It gives the app a local memory on disk, so it can start faster, work offline in some cases, and avoid asking servers the same questions again and again. These caches are small saved files, like notes the app leaves for its future self, but they are checked carefully before use.

The cloud-config cache stores cloud settings for the signed-in account. It rejects old, corrupted, edited, or wrong-user data. The connector directory cache saves lists of available connectors under the Codex home folder, so the app can reuse a valid list. The plugin catalog cache stores remote plugin lists separately for each server and account, preventing one user’s data from leaking into another’s view. The model cache keeps the available model list and ignores it when it is too old or from a different client version. The local plugin paths file remembers which shared plugin IDs map to folders on this machine. The update cache remembers the latest version seen and whether its notice was dismissed.

## Files in this stage

### Signed cloud config cache
This cache layer defines the most security-sensitive persisted lookup data, handling signed cloud-config bundles with identity scoping, TTL checks, and tamper detection.

### `cloud-config/src/cache.rs`

`io_transport` · `startup and cloud config refresh`

Cloud configuration normally comes from a remote service, but fetching it every time would be slower and less reliable. This file provides a small on-disk cache, like keeping a sealed envelope in a drawer: the app can reuse the contents for a short time, but only if the seal is intact and the envelope belongs to the current user.

The main type, CloudConfigBundleCache, points at a JSON file inside the Codex home directory. When saving, it wraps the bundle with metadata: a cache format version, when it was written, when it expires, and the ChatGPT user and account it belongs to. It then signs that wrapped data with an HMAC, which is a secret-key checksum used to detect tampering. The signed file is written prettily as JSON.

When loading, the file is deliberately cautious. It refuses to use the cache if the current identity is missing, the file cannot be read or parsed, the signature does not match, the cache version is unsupported, the cached identity does not match the current identity, or the expiry time has passed. These failures are reported as clear CacheLoadStatus values so callers can decide whether to fetch fresh data instead. Without this file, the project would either hit the network more often or risk using stale, wrong-account, or edited cloud configuration.

#### Function details

##### `CloudConfigBundleCache::new`  (lines 39–43)

```
fn new(codex_home: AbsolutePathBuf) -> Self
```

**Purpose**: Creates a cache object for a specific Codex home directory. It decides the exact file path where the cloud config bundle cache will live.

**Data flow**: It receives the absolute path to the Codex home directory. It appends the fixed cache filename to that directory. It returns a CloudConfigBundleCache that remembers that full path for later reads and writes.

**Call relations**: Test helpers and constructors call this when they need a cache instance. It uses the path-joining operation so the rest of the file can work with one ready-made cache file path instead of rebuilding it each time.

*Call graph*: calls 1 internal fn (join); called by 3 (create_test_cache, new, create_test_cache).


##### `CloudConfigBundleCache::path`  (lines 45–47)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the cache file path that this cache object uses. This is useful when another piece of code needs to inspect or write the file directly, such as in tests.

**Data flow**: It reads the path stored inside the CloudConfigBundleCache. It returns a borrowed view of that path without changing anything.

**Call relations**: The test helper write_cache_file calls this to know where to place a cache file. In normal use, other methods such as load and save use the stored path internally.

*Call graph*: called by 1 (write_cache_file).


##### `CloudConfigBundleCache::load`  (lines 49–107)

```
async fn load(
        &self,
        chatgpt_user_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<CloudConfigBundleCacheSignedPayload, CacheLoadStatus>
```

**Purpose**: Tries to read a saved cloud config bundle from disk and proves it is safe to use. It only returns the cached bundle data if the user/account matches, the file is still fresh, and the signature is valid.

**Data flow**: It receives the current ChatGPT user ID and account ID, if known. If either is missing, it stops. Otherwise it reads the cache file, parses the JSON, turns the signed payload back into bytes, checks the HMAC signature, checks the cache version, checks the cached identity, and checks the expiry time against the current clock. On success it returns the signed payload; on failure it returns a specific CacheLoadStatus explaining why the cache was rejected.

**Call relations**: The cloud config loading flow, represented in the graph by load_valid_cached_bundle, calls this before relying on cached data. Inside, it hands work to cache_payload_bytes to recreate the exact signed bytes and to verify_cache_signature to confirm the file was not changed.

*Call graph*: calls 2 internal fn (cache_payload_bytes, verify_cache_signature); called by 1 (load_valid_cached_bundle); 6 external calls (now, CacheParseFailed, CacheReadFailed, CacheVersionUnsupported, read, from_slice).


##### `CloudConfigBundleCache::log_load_status`  (lines 109–126)

```
fn log_load_status(&self, status: &CacheLoadStatus)
```

**Purpose**: Writes an appropriate log message after a cache load attempt fails or is skipped. It keeps the common harmless case, a missing cache file, quiet.

**Data flow**: It receives a CacheLoadStatus. If the status is CacheFileNotFound, it does nothing. For read, parse, or signature problems it writes a warning because those may indicate a damaged or suspicious file. For other expected reasons, such as expiry or identity mismatch, it writes an informational message. It does not return a value.

**Call relations**: The cache loading path calls this after receiving a load status, such as in load_valid_cached_bundle. It does not change cache behavior; it explains the decision to humans reading logs.

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

**Purpose**: Writes a cloud config bundle to the local cache in a signed form. This lets later runs reuse the bundle briefly without trusting an unsigned file.

**Data flow**: It receives optional user and account IDs plus the CloudConfigBundle to store. It records the current time, calculates an expiry time one hour later, builds the signed payload, serializes that payload into bytes, signs those bytes, wraps the payload and signature into a JSON cache file, creates the parent directory if needed, and writes the file to disk. It returns success or a generic cache write error.

**Call relations**: The remote bundle validation flow calls this after it has accepted a bundle from the service. It relies on cache_payload_bytes to produce the bytes that will be protected by the signature and on sign_cache_payload to create that signature before writing to disk.

*Call graph*: calls 3 internal fn (cache_payload_bytes, sign_cache_payload, parent); called by 1 (validate_and_cache_remote_bundle); 5 external calls (from_std, now, create_dir_all, write, to_vec_pretty).


##### `cache_payload_bytes`  (lines 214–218)

```
fn cache_payload_bytes(
    payload: &CloudConfigBundleCacheSignedPayload,
) -> Option<Vec<u8>>
```

**Purpose**: Turns the cache payload into the exact JSON bytes that are signed or checked. This keeps signing and verification focused on the same piece of data.

**Data flow**: It receives a CloudConfigBundleCacheSignedPayload. It serializes that payload to JSON bytes. If serialization works, it returns those bytes; if not, it returns nothing.

**Call relations**: Both save and load call this. During save, its output is signed. During load, its output is verified against the stored signature, so both sides agree on what the signature covers.

*Call graph*: called by 2 (load, save); 1 external calls (to_vec).


##### `sign_cache_payload`  (lines 220–225)

```
fn sign_cache_payload(payload_bytes: &[u8]) -> Option<String>
```

**Purpose**: Creates a Base64 text signature for cache payload bytes. The signature is used later to detect whether the cache file was edited or corrupted.

**Data flow**: It receives the payload bytes. It creates an HMAC-SHA256 signer using the cache write key, feeds in the bytes, finalizes the signature, and encodes the raw signature as Base64 text so it can be stored in JSON. It returns the signature text, or nothing if the signer cannot be created.

**Call relations**: CloudConfigBundleCache::save calls this just before writing the cache file. Its result becomes the signature field that CloudConfigBundleCache::load later checks through verify_cache_signature.

*Call graph*: called by 1 (save); 1 external calls (new_from_slice).


##### `verify_cache_signature`  (lines 227–236)

```
fn verify_cache_signature(payload_bytes: &[u8], signature: &str) -> bool
```

**Purpose**: Checks whether a stored signature really matches the payload bytes. This is the main gate that prevents a changed cache file from being trusted.

**Data flow**: It receives the payload bytes and the signature string read from the cache file. It decodes the signature from Base64 into raw bytes. Then it tries the allowed read keys and returns true if any key verifies the signature; otherwise it returns false.

**Call relations**: CloudConfigBundleCache::load calls this after parsing the cache file and before trusting anything inside it. It delegates each key-specific check to verify_cache_signature_with_key, which makes future key rotation possible because more read keys can be accepted.

*Call graph*: called by 1 (load).


##### `verify_cache_signature_with_key`  (lines 238–249)

```
fn verify_cache_signature_with_key(
    payload_bytes: &[u8],
    signature_bytes: &[u8],
    key: &[u8],
) -> bool
```

**Purpose**: Checks one signature against one secret key. It is the low-level comparison step used by the broader signature verification function.

**Data flow**: It receives payload bytes, decoded signature bytes, and one HMAC key. It rebuilds the expected HMAC for the payload using that key, then compares it with the supplied signature in the cryptographic verifier. It returns true only if they match.

**Call relations**: verify_cache_signature calls this while trying the cache read keys. This helper keeps the repeated per-key verification logic separate from the outer work of decoding the signature and choosing keys.

*Call graph*: 1 external calls (new_from_slice).


### Catalog persistence caches
These files persist fetched directory-style data for connectors, plugins, and models so higher-level refresh flows can reuse local results and fall back when remote fetches are unavailable.

### `connectors/src/directory_cache.rs`

`io_transport` · `request handling / cache lookup`

This file is the small “filing cabinet” for connector directory data. A connector directory is a list of available apps or connectors, represented here as `AppInfo` records. Instead of always asking another service for that list, the app can write the list to a JSON file and read it back later.

The cache is tied to a `ConnectorDirectoryCacheKey`, which describes which connector directory result is being cached. Rather than using that key directly as a file name, the file turns the key into JSON and then hashes it with SHA-1, producing a safe, predictable file name. This is like putting a long address on a label-maker and getting back a neat short label for a drawer.

When reading, the code looks for the cache file. If it is not there, it reports “missing.” If it cannot read or parse the file, or if the stored schema version is old, it reports “invalid” and may delete the bad file. If everything checks out, it returns the cached connector list. When writing, it creates the cache directory if needed, wraps the connectors with a schema version, serializes them as pretty JSON, and writes them to disk. Failures while writing are quietly ignored, because the cache is helpful but not essential.

#### Function details

##### `ConnectorDirectoryCacheContext::new`  (lines 22–27)

```
fn new(codex_home: PathBuf, cache_key: ConnectorDirectoryCacheKey) -> Self
```

**Purpose**: Creates the small context object needed to find the right cache file. It combines the Codex home directory with the cache key that identifies one particular connector directory result.

**Data flow**: It receives a filesystem path for `codex_home` and a `ConnectorDirectoryCacheKey`. It stores both values together in a new `ConnectorDirectoryCacheContext`. The result is a reusable object that later functions can ask, “where should this cache entry live on disk?”

**Call relations**: Higher-level connector-directory code calls this when it is preparing to use the disk cache. Once created, the context is passed onward to the cache read and write helpers, which use it to compute the exact cache file path.

*Call graph*: called by 3 (connector_directory_cache_context, cache_context, cached_directory_connectors_for_tool_suggest_with_auth).


##### `ConnectorDirectoryCacheContext::cache_path`  (lines 29–35)

```
fn cache_path(&self) -> PathBuf
```

**Purpose**: Builds the full path to the JSON file for this cache entry. It turns the cache key into a stable hashed file name so the app can safely store many different cache entries in one directory.

**Data flow**: It reads the context’s `cache_key` and `codex_home`. First it serializes the cache key to JSON text. Then it sends that text to `sha1_hex`, which produces a short hexadecimal hash string. Finally it joins the Codex home path, the connector cache directory, and the hash plus `.json` into one full file path.

**Call relations**: The disk read and write functions both call this before touching the filesystem. It delegates the hashing step to `sha1_hex`, then hands back the path those functions should read from or write to.

*Call graph*: calls 1 internal fn (sha1_hex); called by 2 (load_cached_directory_connectors_from_disk, write_cached_directory_connectors_to_disk); 3 external calls (join, format!, to_string).


##### `load_cached_directory_connectors_from_disk`  (lines 44–80)

```
fn load_cached_directory_connectors_from_disk(
    cache_context: &ConnectorDirectoryCacheContext,
) -> CachedConnectorDirectoryDiskLoad
```

**Purpose**: Tries to read a cached connector list from disk and tells the caller whether it found a usable cache entry. It protects the rest of the app from bad or outdated cache files.

**Data flow**: It receives a `ConnectorDirectoryCacheContext`, asks it for the cache file path, and tries to read that file. If the file is absent, it returns `Missing`. If the file cannot be read, cannot be parsed as JSON, or has the wrong schema version, it returns `Invalid`; in some invalid cases it removes the bad file. If the file is valid, it extracts the stored `AppInfo` list and returns it as a cache `Hit`.

**Call relations**: The connector directory lookup flow calls this before doing more expensive work. This function uses `cache_path` to locate the file, standard filesystem reading to load it, JSON parsing to decode it, and warning logs when something unexpected happens.

*Call graph*: calls 1 internal fn (cache_path); called by 1 (cached_directory_connectors); 4 external calls (from_slice, read, remove_file, warn!).


##### `write_cached_directory_connectors_to_disk`  (lines 82–99)

```
fn write_cached_directory_connectors_to_disk(
    cache_context: &ConnectorDirectoryCacheContext,
    connectors: &[AppInfo],
)
```

**Purpose**: Writes a connector list to the local disk cache for later reuse. It is a best-effort helper: if caching fails, it simply gives up rather than stopping the main connector flow.

**Data flow**: It receives a cache context and a slice of `AppInfo` connector records. It computes the cache file path, creates the parent cache directory if necessary, wraps the connector list with the current cache schema version, converts that wrapper to pretty JSON bytes, and writes those bytes to the file. It does not return a value, and it ignores write failures because the cache is optional.

**Call relations**: After connector directory data has been fetched or computed, higher-level code calls this to save the result. It relies on `cache_path` for the destination path, then hands the actual bytes to the filesystem write operation.

*Call graph*: calls 1 internal fn (cache_path); called by 1 (write_cached_directory_connectors); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `sha1_hex`  (lines 107–112)

```
fn sha1_hex(value: &str) -> String
```

**Purpose**: Turns a string into a SHA-1 hash written as hexadecimal text. Here it is used to make a safe file name from a potentially long or awkward cache key.

**Data flow**: It receives a text string, feeds its bytes into a SHA-1 hasher, finalizes the hash, and formats the result as lowercase hexadecimal characters. The output is a compact string suitable for use in a cache file name.

**Call relations**: `cache_path` calls this after converting the cache key to JSON. The returned hash becomes the base name of the cache file, which the read and write helpers later use.

*Call graph*: called by 1 (cache_path); 2 external calls (new, format!).


### `core-plugins/src/remote/catalog_cache.rs`

`io_transport` · `remote plugin discovery and cache reuse`

Remote plugin discovery depends on a catalog: a list of plugins available from a remote service. Fetching that list can be slow or unavailable if the network is down, so this file provides a small disk cache, like keeping a recent menu in a drawer instead of calling the restaurant every time.

The cache is tied to a specific situation: the ChatGPT server URL, the account ID, the ChatGPT user ID, and whether the account is a workspace account. Those details become a cache key. The key is turned into a short hashed filename under `cache/remote_plugin_catalog` inside the Codex home directory.

When reading, the file tries to open that JSON cache file. If it is missing, it simply returns nothing. If the file exists but cannot be read or parsed, it logs a warning and ignores it; broken cache data should not stop the program. Parsed cache data also includes a schema version, which is a simple version number for the file format. If the version does not match the current code, the old file is deleted and ignored.

When writing, the file creates the cache directory if needed, serializes the plugin list as pretty JSON, and writes it out. Most write failures are silently ignored because this cache is helpful but not essential.

#### Function details

##### `RemotePluginCatalogCacheKey::global`  (lines 22–29)

```
fn global(config: &RemotePluginServiceConfig, auth: &CodexAuth) -> Self
```

**Purpose**: Builds the identity used to choose the correct cache file for the current remote plugin catalog. It includes both the remote service address and the current authentication account details, so cached plugin lists stay separated by user and account context.

**Data flow**: It receives the remote plugin service configuration and the current authentication object. It copies the ChatGPT base URL from the config, asks the auth object for the account ID, ChatGPT user ID, and workspace-account flag, and packages those values into a `RemotePluginCatalogCacheKey`. The result is a small structured key that can later be converted into a cache filename.

**Call relations**: Both cache reading and cache writing call this first, because they must agree on exactly which cache file belongs to the current user and server. It relies on the auth object’s account/user helper methods to fill in the identity pieces before `cache_path` turns the key into a path on disk.

*Call graph*: calls 3 internal fn (get_account_id, get_chatgpt_user_id, is_workspace_account); called by 2 (load_cached_global_directory_plugins, write_cached_global_directory_plugins).


##### `load_cached_global_directory_plugins`  (lines 38–75)

```
fn load_cached_global_directory_plugins(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Option<Vec<RemotePluginDirectoryItem>>
```

**Purpose**: Tries to load the previously saved global remote plugin catalog from disk. It returns the cached plugin list when it is present, readable, valid JSON, and written in the current cache format; otherwise it returns no result and lets callers continue without cached data.

**Data flow**: It receives the Codex home directory, remote service config, and auth information. From those, it builds the cache key and cache path, then reads the JSON file at that path. If the file is missing, unreadable, malformed, or from an old schema version, it returns `None`; malformed or outdated files may be deleted. If everything checks out, it returns the stored list of `RemotePluginDirectoryItem` values.

**Call relations**: Higher-level remote discovery code calls this when it wants a quick answer from local disk, such as checking whether a global catalog is cached or using cached marketplace data. Internally it asks `RemotePluginCatalogCacheKey::global` for the right user/server key, asks `cache_path` where that key lives on disk, uses filesystem reading and JSON parsing, and logs warnings when a bad cache file is found.

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

**Purpose**: Saves a freshly obtained global remote plugin catalog to disk for later reuse. This makes future plugin discovery faster and more resilient when the network is slow or unavailable.

**Data flow**: It receives the Codex home directory, remote service config, auth information, and a slice of plugin directory items. It builds the matching cache path, creates the parent cache directory if it can, wraps the plugin list together with the current schema version, converts that wrapper into pretty JSON bytes, and writes those bytes to the cache file. It does not return a value, and if cache writing fails it quietly gives up because the main program can still work without the cache.

**Call relations**: Remote marketplace fetching code calls this after it has obtained plugin catalog data worth saving. Like the loading path, it uses `RemotePluginCatalogCacheKey::global` and `cache_path` so reads and writes point to the same per-user, per-server file. It then hands off to JSON serialization and filesystem writing to put the cache on disk.

*Call graph*: calls 2 internal fn (global, cache_path); called by 2 (fetch_and_cache_global_remote_plugin_catalog, fetch_remote_marketplaces); 4 external calls (to_vec, to_vec_pretty, create_dir_all, write).


##### `cache_path`  (lines 101–111)

```
fn cache_path(codex_home: &Path, cache_key: &RemotePluginCatalogCacheKey) -> PathBuf
```

**Purpose**: Turns a cache key into the exact JSON file path used on disk. It hides the account and server details behind a short hash, producing a stable filename for the same key without placing raw user data directly in the filename.

**Data flow**: It receives the Codex home directory and a cache key. It serializes the key to JSON bytes, feeds those bytes through a simple 64-bit hash calculation, formats the hash as a hexadecimal filename ending in `.json`, and joins that filename under `cache/remote_plugin_catalog` inside the Codex home directory. The output is a `PathBuf`, meaning an owned filesystem path.

**Call relations**: Both the load and write functions call this after creating the global cache key. Because both sides use the same path-building logic, a plugin catalog written during one run can be found again during a later run with the same server and account identity.

*Call graph*: called by 2 (load_cached_global_directory_plugins, write_cached_global_directory_plugins); 4 external calls (join, format!, to_vec, from).


### `models-manager/src/cache.rs`

`io_transport` · `model list loading and refresh`

This file is the model-list cache. A cache is a saved shortcut: like keeping yesterday’s train timetable on your desk so you do not need to call the station every time, but only trusting it if it is still recent enough. Here, the saved data is a JSON file on disk containing the list of models plus small pieces of metadata: when it was fetched, an optional ETag value from the server, and the client version that created it.

The main worker is `ModelsCacheManager`. It knows where the cache file lives and how long cached data is allowed to stay valid. When asked for a fresh cache, it reads the file, checks that it was written by the expected client version, and checks that its age is within the configured time-to-live, or TTL, meaning “how long this data may be trusted.” If any check fails, it returns nothing so the caller can fetch fresh data instead.

When new model data arrives, the manager writes it back to disk, creating folders if needed. It can also “renew” the cache by updating only the timestamp, useful when the server says the existing data is still current. The `ModelsCache` struct is the actual saved snapshot. Test-only helpers let tests deliberately age or alter the cache to check edge cases.

#### Function details

##### `ModelsCacheManager::new`  (lines 23–28)

```
fn new(cache_path: PathBuf, cache_ttl: Duration) -> Self
```

**Purpose**: Creates a cache manager for one cache file and one freshness limit. Other code uses this when it wants a small object that knows where to read and write the models cache.

**Data flow**: It receives a file path and a time duration. It stores both in a new `ModelsCacheManager`, which is then returned to the caller unchanged except for being packaged together.

**Call relations**: This is used during setup by a higher-level `new` function. After construction, that manager becomes the object other parts call when they want to load, save, or refresh the cache.

*Call graph*: called by 1 (new).


##### `ModelsCacheManager::load_fresh`  (lines 31–74)

```
async fn load_fresh(&self, expected_version: &str) -> Option<ModelsCache>
```

**Purpose**: Tries to read the cache and only returns it if it is safe to use now. It protects the program from using stale model data or data saved by a different client version.

**Data flow**: It receives the client version the caller expects. It reads the cache file through `load`, logs what happened, checks that the saved client version matches, then asks the cache whether it is still fresh under the configured TTL. If the file is missing, unreadable, version-mismatched, or too old, it returns `None`; otherwise it returns the usable `ModelsCache`.

**Call relations**: This is called by `try_load_cache`, which is the point where the system first hopes to avoid a network fetch. Inside, it delegates the actual disk reading to `load` and uses logging calls to leave a clear trail explaining whether the cache was accepted or rejected.

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

**Purpose**: Saves a newly fetched model list to the cache file. This makes future runs or future checks faster because they can reuse the saved list if it is still valid.

**Data flow**: It receives a slice of model records, an optional ETag, and the current client version. It copies the model list into a `ModelsCache`, stamps it with the current time, stores the metadata, and asks `save_internal` to write it to disk. If writing fails, it logs the error instead of returning it to the caller.

**Call relations**: This is called by `fetch_and_update_models` after fresh model data has been obtained. It hands the completed cache snapshot to `save_internal`, which does the practical work of making directories, turning the cache into JSON, and writing the file.

*Call graph*: calls 1 internal fn (save_internal); called by 1 (fetch_and_update_models); 3 external calls (now, error!, to_vec).


##### `ModelsCacheManager::renew_cache_ttl`  (lines 95–102)

```
async fn renew_cache_ttl(&self) -> io::Result<()>
```

**Purpose**: Refreshes the cache timestamp without changing the model list. This is useful when the server indicates that the existing saved data is still current, so only its freshness clock needs to be reset.

**Data flow**: It reads the existing cache through `load`. If no cache file exists, it returns a “not found” error. If a cache is present, it replaces `fetched_at` with the current time and writes the updated cache back through `save_internal`. The result is either success or an input/output error.

**Call relations**: This is called by `refresh_if_new_etag`, where the program has checked whether the remote model list changed. It relies on `load` to get the old snapshot and `save_internal` to put the timestamp-renewed snapshot back on disk.

*Call graph*: calls 2 internal fn (load, save_internal); called by 1 (refresh_if_new_etag); 2 external calls (now, new).


##### `ModelsCacheManager::load`  (lines 104–114)

```
async fn load(&self) -> io::Result<Option<ModelsCache>>
```

**Purpose**: Reads the cache file from disk and turns it back into a `ModelsCache` object. It cleanly distinguishes between “there is no cache yet” and “something went wrong reading or parsing it.”

**Data flow**: It uses the manager’s cache path to read bytes from disk. If the file is found, it parses those bytes as JSON into a `ModelsCache`. If the file is absent, it returns `Ok(None)`. If the file exists but cannot be read or contains invalid JSON, it returns an error.

**Call relations**: This is the shared low-level reader used by `load_fresh`, `renew_cache_ttl`, and the test helpers. Those higher-level functions decide what to do with the loaded cache; this function only performs the read-and-parse step.

*Call graph*: called by 4 (load_fresh, manipulate_cache_for_test, mutate_cache_for_test, renew_cache_ttl); 2 external calls (read, from_slice).


##### `ModelsCacheManager::save_internal`  (lines 116–123)

```
async fn save_internal(&self, cache: &ModelsCache) -> io::Result<()>
```

**Purpose**: Writes a cache snapshot to disk as readable JSON. It is the common save routine used whenever the cache contents or timestamp need to be stored.

**Data flow**: It receives a `ModelsCache`. It checks the cache path for a parent folder and creates that folder tree if needed. Then it converts the cache into pretty-printed JSON bytes and writes those bytes to the cache file. It returns success or the disk/serialization error that stopped it.

**Call relations**: This is the shared low-level writer used by `persist_cache`, `renew_cache_ttl`, and the test mutation helpers. The callers prepare the cache data; this function takes responsibility for directory creation, JSON conversion, and file writing.

*Call graph*: called by 4 (manipulate_cache_for_test, mutate_cache_for_test, persist_cache, renew_cache_ttl); 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `ModelsCacheManager::set_ttl`  (lines 127–129)

```
fn set_ttl(&mut self, ttl: Duration)
```

**Purpose**: Changes the cache freshness limit in tests. This lets tests simulate different expiry rules without rebuilding the manager from scratch.

**Data flow**: It receives a new duration and replaces the manager’s current TTL with that duration. It does not read or write any cache file and returns nothing.

**Call relations**: This function is compiled only for tests. It supports test scenarios that need to make cached data expire quickly or remain valid longer.


##### `ModelsCacheManager::manipulate_cache_for_test`  (lines 133–143)

```
async fn manipulate_cache_for_test(&self, f: F) -> io::Result<()>
```

**Purpose**: Lets tests change only the saved fetch timestamp. This is mainly used to create “fresh” or “stale” cache files on purpose.

**Data flow**: It receives a small callback function that can edit the cache’s `fetched_at` time. It loads the cache from disk, returns a “not found” error if none exists, gives the timestamp to the callback for editing, then saves the changed cache back to disk.

**Call relations**: This function exists only in test builds. It uses the same `load` and `save_internal` path as production code, so tests exercise realistic cache file reading and writing while changing just the timestamp.

*Call graph*: calls 2 internal fn (load, save_internal); 1 external calls (new).


##### `ModelsCacheManager::mutate_cache_for_test`  (lines 147–157)

```
async fn mutate_cache_for_test(&self, f: F) -> io::Result<()>
```

**Purpose**: Lets tests change any part of the saved cache. This is useful for checking behavior with unusual model lists, wrong versions, missing metadata, or other crafted cache states.

**Data flow**: It receives a callback that can edit the whole `ModelsCache`. It loads the existing cache, reports “not found” if there is no file, passes the full cache to the callback, and saves the modified cache back to disk.

**Call relations**: This function is test-only. Like the timestamp-specific helper, it relies on `load` and `save_internal`, but it gives tests access to the entire cache snapshot rather than just `fetched_at`.

*Call graph*: calls 2 internal fn (load, save_internal); 1 external calls (new).


##### `ModelsCache::is_fresh`  (lines 173–182)

```
fn is_fresh(&self, ttl: Duration) -> bool
```

**Purpose**: Decides whether a cache entry is still young enough to trust. It is the core age check behind cache hits and misses.

**Data flow**: It receives a TTL duration. If the TTL is zero, or cannot be converted into the date/time duration format used here, it returns `false`. Otherwise it compares the current time with the cache’s `fetched_at` time. If the cache age is less than or equal to the TTL, it returns `true`; if it is older, it returns `false`.

**Call relations**: This is used by `ModelsCacheManager::load_fresh` after the cache file has been read and the client version has been checked. It gives the final yes-or-no answer on whether the loaded cache can be used instead of fetching from the server.

*Call graph*: 3 external calls (is_zero, now, from_std).


### Local plugin path mapping
This utility maintains the small persisted mapping from shared remote plugin identifiers to local filesystem paths, with simple concurrency protection around file access.

### `core-plugins/src/remote/share/local_paths.rs`

`io_transport` · `during remote plugin share load, checkout, save, list, and delete operations`

Remote plugin shares have an ID, but the actual files live somewhere on the user’s computer. This file is the notebook that connects those two facts: “remote plugin ID X lives at local path Y.” It stores that notebook as a JSON file under the Codex home directory, inside `.tmp/plugin-share-local-paths-v1.json`.

The file provides three main actions: load the whole mapping, record or update one mapping, and remove one mapping. Each public action first takes a mutex, which is a lock that stops two parts of the same program from editing the notebook at the same time. That matters because without the lock, two saves could overlap and one could accidentally erase the other’s change.

Reads are forgiving: if the JSON file does not exist, the code treats that as an empty notebook. Updates are even more forgiving: because this is only a best-effort temporary cache, if the file is malformed, update operations start fresh instead of letting a bad cache permanently block saving or deleting plugin share information.

Writes are done carefully. If the mapping becomes empty, the file is deleted. Otherwise, the code writes JSON to a temporary file and then moves it into place. This “write to a spare page, then swap it in” approach helps avoid leaving behind a half-written file if something goes wrong mid-write.

#### Function details

##### `load_plugin_share_local_paths`  (lines 20–25)

```
fn load_plugin_share_local_paths(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Loads the saved map from remote plugin share IDs to local folders. Other code uses this when it needs to know where already-shared plugins live on this machine.

**Data flow**: It receives the Codex home directory. It takes the shared lock, reads the JSON mapping file from under that home directory, and returns a map of remote plugin IDs to absolute local paths. If the file is missing, the result is an empty map.

**Call relations**: This is the safe public doorway for reading the cache. It is used when checkout code needs local paths, when remote plugin shares are listed, and when code needs to reverse the mapping from local paths back to remote IDs. Internally it delegates the locking step to `lock_plugin_share_local_paths` and the actual file reading to `read_plugin_share_local_paths`.

*Call graph*: calls 2 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths); called by 3 (load_share_local_paths_for_checkout, list_remote_plugin_shares, load_plugin_share_remote_ids_by_local_path).


##### `record_plugin_share_local_path`  (lines 27–36)

```
fn record_plugin_share_local_path(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: AbsolutePathBuf,
) -> io::Result<()>
```

**Purpose**: Saves or updates the local folder for one remote plugin share ID. This is used after a plugin share has been checked out or saved locally, so future operations can find it again.

**Data flow**: It receives the Codex home directory, a remote plugin ID, and an absolute local plugin path. It locks the cache, reads the current map in update-friendly mode, inserts or replaces the entry for that remote ID, and writes the updated map back to disk.

**Call relations**: Checkout and save flows call this after they know the local folder for a remote share. The function protects the read-change-write sequence with `lock_plugin_share_local_paths`, uses `read_plugin_share_local_paths_for_update` so a corrupt temporary cache does not block progress, and hands the final map to `write_plugin_share_local_paths`.

*Call graph*: calls 3 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths_for_update, write_plugin_share_local_paths); called by 2 (checkout_remote_plugin_share, save_remote_plugin_share).


##### `remove_plugin_share_local_path`  (lines 38–46)

```
fn remove_plugin_share_local_path(
    codex_home: &Path,
    remote_plugin_id: &str,
) -> io::Result<()>
```

**Purpose**: Forgets the saved local folder for one remote plugin share ID. This is used when a remote plugin share is deleted so the local cache does not keep pointing at stale information.

**Data flow**: It receives the Codex home directory and the remote plugin ID to remove. It locks the cache, reads the current map in update-friendly mode, removes that ID if present, and writes the new map back. If the map becomes empty, the backing file is removed.

**Call relations**: The delete flow calls this when a remote plugin share should no longer be tracked locally. Like recording a path, it uses the lock to keep the read-edit-write sequence safe, then relies on `write_plugin_share_local_paths` to either update or delete the JSON file.

*Call graph*: calls 3 internal fn (lock_plugin_share_local_paths, read_plugin_share_local_paths_for_update, write_plugin_share_local_paths); called by 1 (delete_remote_plugin_share).


##### `lock_plugin_share_local_paths`  (lines 48–52)

```
fn lock_plugin_share_local_paths() -> io::Result<std::sync::MutexGuard<'static, ()>>
```

**Purpose**: Takes the in-process lock for this local-path cache. It exists so reads and writes do not step on each other while using the same JSON file.

**Data flow**: It reads no file data and receives no caller data. It tries to acquire a global mutex, which is a simple lock shared by this code. On success it returns a guard object; when that guard is dropped, the lock is released. If the lock has been poisoned because a previous holder panicked, it returns an input/output error with a useful message.

**Call relations**: The public load, record, and remove functions all call this before touching the cache file. It does not perform the file work itself; it simply creates the quiet, one-at-a-time space in which the caller can safely read or write.

*Call graph*: called by 3 (load_plugin_share_local_paths, record_plugin_share_local_path, remove_plugin_share_local_path).


##### `read_plugin_share_local_paths`  (lines 54–74)

```
fn read_plugin_share_local_paths(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Reads the JSON cache file and turns it into the in-memory map used by the rest of the plugin sharing code. It is the strict reader: malformed JSON is treated as an error.

**Data flow**: It receives the Codex home directory, builds the full path to the cache file, and tries to read it as text. If the file is absent, it returns an empty map. If the file exists, it parses the JSON wrapper object and returns its `localPluginPathsByRemotePluginId` map. Bad JSON becomes an `InvalidData` error that includes the file path.

**Call relations**: The normal load function calls this directly when it wants an accurate view of the cache. The update reader also calls it first, then decides whether to forgive certain errors. This function uses `plugin_share_local_paths_path` to agree on the exact file location.

*Call graph*: calls 1 internal fn (plugin_share_local_paths_path); called by 2 (load_plugin_share_local_paths, read_plugin_share_local_paths_for_update); 2 external calls (new, read_to_string).


##### `read_plugin_share_local_paths_for_update`  (lines 76–86)

```
fn read_plugin_share_local_paths_for_update(
    codex_home: &Path,
) -> io::Result<BTreeMap<String, AbsolutePathBuf>>
```

**Purpose**: Reads the cache before an edit, but deliberately forgives malformed cache contents. This keeps a broken temporary file from preventing future saves or deletes.

**Data flow**: It receives the Codex home directory and asks `read_plugin_share_local_paths` for the current map. If reading succeeds, it returns that map. If the only problem is invalid cached data, it returns an empty map instead. Other problems, such as permission or disk errors, are still returned to the caller.

**Call relations**: The record and remove flows use this before changing the mapping. It sits between the strict file reader and the update operations, applying the policy that this `.tmp` cache is useful but not precious.

*Call graph*: calls 1 internal fn (read_plugin_share_local_paths); called by 2 (record_plugin_share_local_path, remove_plugin_share_local_path); 1 external calls (new).


##### `write_plugin_share_local_paths`  (lines 88–106)

```
fn write_plugin_share_local_paths(
    codex_home: &Path,
    mapping: BTreeMap<String, AbsolutePathBuf>,
) -> io::Result<()>
```

**Purpose**: Writes the whole remote-ID-to-local-path map back to the cache file. If there is nothing left to remember, it removes the cache file instead.

**Data flow**: It receives the Codex home directory and the complete updated map. It builds the cache file path. If the map is empty, it tries to delete the file and treats an already-missing file as success. If the map has entries, it wraps them in the JSON shape used on disk, formats that JSON neatly, adds a trailing newline, and writes it through `write_atomically`.

**Call relations**: The record and remove functions call this after they have changed the in-memory map. It is responsible for turning that final map into durable disk state, and it hands the risky low-level write step to `write_atomically` so callers do not have to care about partial writes.

*Call graph*: calls 2 internal fn (plugin_share_local_paths_path, write_atomically); called by 2 (record_plugin_share_local_path, remove_plugin_share_local_path); 3 external calls (format!, to_string_pretty, remove_file).


##### `write_atomically`  (lines 108–120)

```
fn write_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: Writes text to a file in a safer way by first writing to a temporary file in the same folder, then moving it into the final location. This lowers the chance of leaving a half-written JSON file behind.

**Data flow**: It receives the final file path and the text to store. It finds the parent directory, creates that directory if needed, creates a temporary file there, writes all bytes into it, and then persists the temporary file at the target path. It returns success when the final path has been replaced with the new contents.

**Call relations**: `write_plugin_share_local_paths` calls this whenever there is a non-empty mapping to save. This function is the low-level disk-writing helper for this file, keeping the higher-level mapping code focused on what to save rather than how to save it safely.

*Call graph*: called by 1 (write_plugin_share_local_paths); 3 external calls (parent, create_dir_all, new_in).


##### `plugin_share_local_paths_path`  (lines 122–124)

```
fn plugin_share_local_paths_path(codex_home: &Path) -> std::path::PathBuf
```

**Purpose**: Builds the exact filesystem path where this cache file lives under the Codex home directory. It keeps all readers and writers pointed at the same file.

**Data flow**: It receives the Codex home directory and appends the fixed relative path `.tmp/plugin-share-local-paths-v1.json`. It returns the resulting full path.

**Call relations**: Both the strict reader and the writer call this before touching the cache file. It is the small shared rule that prevents different parts of this file from accidentally using different locations.

*Call graph*: called by 2 (read_plugin_share_local_paths, write_plugin_share_local_paths); 1 external calls (join).


### Update UI state cache
This final cache stores lightweight persisted update-state data such as dismissal records for the TUI update flow.

### `tui/src/updates_cache.rs`

`io_transport` · `update checking and update popup dismissal`

This file is the app’s memory for update notifications. Without it, the terminal UI would have to treat every run as fresh: it could forget when it last checked for a new version, and it might keep showing the same update popup even after the user dismissed it.

The cache is stored as a JSON file named `version.json` inside the app’s Codex home directory. JSON is a common plain-text data format, so this file can save a small record in a way the app can read back later. That record is represented by `VersionInfo`: the newest version the app knows about, the time it last checked, and optionally the version the user chose to dismiss.

The file has three main jobs. First, it knows how to build the path to `version.json` from the app configuration. Second, it can read that file from disk and turn the JSON text back into `VersionInfo`. Third, when the user dismisses an update message, it writes that dismissal back to disk. If the cache file is missing or unreadable during dismissal, it creates a basic record instead of failing immediately. This is like keeping a sticky note that says, “I already saw version X,” so the app does not nag the user about the same update again.

#### Function details

##### `version_filepath`  (lines 20–22)

```
fn version_filepath(config: &Config) -> PathBuf
```

**Purpose**: Builds the full path to the update cache file. Other parts of the app use this so they all look for `version.json` in the same place.

**Data flow**: It receives the app configuration, reads the configured Codex home directory from it, appends the fixed filename `version.json`, and returns that full path. It does not touch the disk; it only constructs the address of the file.

**Call relations**: When update-checking code needs to find the saved version information, it calls this helper first. `get_upgrade_version`, `get_upgrade_version_for_popup`, and `dismiss_version` all rely on it so they agree on the exact cache file location.

*Call graph*: called by 3 (get_upgrade_version, get_upgrade_version_for_popup, dismiss_version).


##### `read_version_info`  (lines 24–27)

```
fn read_version_info(version_file: &Path) -> anyhow::Result<VersionInfo>
```

**Purpose**: Reads the update cache file and turns it into a `VersionInfo` record the app can use. This is how the app remembers what version it previously saw and whether it was dismissed.

**Data flow**: It receives a file path, reads the whole file as text, then asks the JSON parser to convert that text into a `VersionInfo` value. If reading the file fails, or if the text is not valid JSON in the expected shape, it returns an error instead of a version record.

**Call relations**: Update-checking paths call this when they need the saved cache before deciding what to show. `dismiss_version` also calls it first so it can preserve existing cached details while adding the dismissed version.

*Call graph*: called by 4 (check_for_update, get_upgrade_version, get_upgrade_version_for_popup, dismiss_version); 2 external calls (from_str, read_to_string).


##### `dismiss_version`  (lines 31–48)

```
async fn dismiss_version(config: &Config, version: &str) -> anyhow::Result<()>
```

**Purpose**: Records that the user dismissed the update notice for a specific version. This prevents the same update popup from being shown again for that version.

**Data flow**: It receives the app configuration and the version string to dismiss. It finds the cache file path, tries to read the existing cache, and if that fails, starts with a minimal new record. It then sets `dismissed_version` to the given version, converts the record to JSON with a trailing newline, creates the parent directory if needed, writes the file to disk, and returns success or an error.

**Call relations**: This function is used when the update popup has been dismissed by the user. It depends on `version_filepath` to locate the cache and on `read_version_info` to reuse any existing cache contents; then it hands the final JSON to asynchronous file-writing operations so the terminal UI can save the choice without blocking unnecessarily.

*Call graph*: calls 2 internal fn (read_version_info, version_filepath); 3 external calls (format!, create_dir_all, write).
