# Requirements layering and execution-policy composition  `stage-4.1.2`

This stage is cross-cutting configuration infrastructure that runs as requirements are loaded, merged, validated, and sometimes updated on disk before the rest of the system consumes them. Its job is to turn multiple `requirements.toml` sources and related execution-policy inputs into one effective, source-aware policy surface.

`config_requirements.rs` defines the requirements schema, normalization, provenance tracking, and compiled constraints that can later reject invalid runtime settings. `requirements_exec_policy.rs` parses execution-policy sections embedded in requirements and converts them into internal policy objects suitable for comparison and composition. Within `requirements_layers`, `layer.rs` normalizes each raw layer, preserving source paths and evaluating sandbox selectors; `permissions.rs`, `hooks.rs`, and `rules.rs` implement the nonstandard merge semantics for deny-read patterns, hook definitions, and prefix rules; `stack.rs` applies those rules to assemble the final `ConfigRequirementsWithSources`, while `mod.rs` exposes that composition API.

Two consumers extend this work into runtime behavior: `network_proxy_loader.rs` builds and reloads proxy state from layered config plus exec-policy overlays, enforcing trusted constraints from non-user-controlled layers, and `hooks/config_rules.rs` derives effective persisted hook overrides with strict limits on user-controlled contributions. `execpolicy/amend.rs` supports safely appending new policy rules to disk.

## Files in this stage

### Execution-policy inputs
These files define how execution-policy data is represented in requirements-facing TOML, amended on disk, and consumed by runtime policy loaders.

### `config/src/requirements_exec_policy.rs`

`domain_logic` · `requirements parse and composition`

This file bridges user-authored requirements TOML and the executable rule engine in `codex_execpolicy`. The central wrapper, `RequirementsExecPolicy`, stores a `Policy` and deliberately defines equality by a normalized fingerprint rather than by direct structural comparison; `policy_fingerprint` walks `policy.rules().iter_all()`, formats each `(program, rule)` pair, sorts the resulting strings, and compares those sorted lists so insertion order in the underlying multimap does not affect equality.

The TOML model is split into `RequirementsExecPolicyToml`, `RequirementsExecPolicyPrefixRuleToml`, `RequirementsExecPolicyPatternTokenToml`, and `RequirementsExecPolicyDecisionToml`. Pattern tokens are represented as tables with either `token` or `any_of` because TOML arrays cannot mix scalar strings and nested arrays the way the Starlark builtin can. Parsing is strict: empty `prefix_rules`, empty patterns, blank justifications, missing decisions, malformed token specifications, and `allow` decisions all produce a typed `RequirementsExecPolicyParseError` with the offending rule/token index embedded.

`RequirementsExecPolicyToml::to_policy` performs the real lowering. It validates each rule, converts each pattern element into a `PatternToken`, rejects `allow`, then splits the pattern into a first token and remaining suffix. Because the first token may contain alternatives, it expands one `PrefixRule` per head alternative and inserts each into a `MultiMap<String, RuleRef>` keyed by program name. The suffix tokens are shared via `Arc<[PatternToken]>`, and each rule is wrapped as an `Arc<PrefixRule>` before constructing the final `Policy`.

#### Function details

##### `RequirementsExecPolicy::new`  (lines 18–20)

```
fn new(policy: Policy) -> Self
```

**Purpose**: Constructs the lightweight wrapper around an already-built `codex_execpolicy::Policy`. It exists so requirements-specific code can carry a distinct type while still exposing the underlying policy by reference.

**Data flow**: Takes a `Policy` by value, stores it in the `policy` field, and returns a new `RequirementsExecPolicy`. It does not inspect or mutate any external state.

**Call relations**: Used by callers that already have an internal policy object, including tests that compare merged requirement policies and the TOML conversion path via `to_requirements_policy`.

*Call graph*: called by 3 (child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs, merges_requirements_exec_policy_network_rules, preserves_host_executables_when_requirements_overlay_is_present).


##### `RequirementsExecPolicy::eq`  (lines 24–26)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Implements semantic equality for `RequirementsExecPolicy` by comparing normalized fingerprints of the wrapped policies. This avoids depending on incidental ordering in the underlying rule storage.

**Data flow**: Reads `self.policy` and `other.policy`, passes both to `policy_fingerprint`, and returns `true` when the sorted string fingerprints match. It writes no state.

**Call relations**: Invoked implicitly by equality assertions and comparisons on `RequirementsExecPolicy`; it delegates all normalization work to `policy_fingerprint`.

*Call graph*: calls 1 internal fn (policy_fingerprint).


##### `RequirementsExecPolicy::as_ref`  (lines 32–34)

```
fn as_ref(&self) -> &Policy
```

**Purpose**: Exposes the wrapped `Policy` through the standard `AsRef<Policy>` trait. This lets downstream code pass a `RequirementsExecPolicy` anywhere a borrowed `Policy` is needed.

**Data flow**: Reads the `policy` field and returns `&Policy`. No allocation or mutation occurs.

**Call relations**: Called through trait-based borrowing by consumers of the wrapper type; it is a simple adapter with no further delegation.


##### `policy_fingerprint`  (lines 37–46)

```
fn policy_fingerprint(policy: &Policy) -> Vec<String>
```

**Purpose**: Builds a deterministic textual summary of a `Policy`'s rules for equality checks. The summary includes each program key and the debug representation of each rule.

**Data flow**: Accepts `&Policy`, iterates `policy.rules().iter_all()`, formats every `(program, rule)` pair into `String`s, sorts the vector, and returns `Vec<String>`. It only reads policy contents and produces a derived value.

**Call relations**: Used exclusively by `RequirementsExecPolicy::eq` to normalize policies before comparison.

*Call graph*: called by 1 (eq); 3 external calls (new, rules, format!).


##### `RequirementsExecPolicyDecisionToml::as_decision`  (lines 84–90)

```
fn as_decision(self) -> Decision
```

**Purpose**: Maps the TOML enum used in requirements files onto the internal `codex_execpolicy::Decision` enum. The mapping is one-to-one for the three supported variants.

**Data flow**: Consumes `self`, matches `Allow`, `Prompt`, or `Forbidden`, and returns the corresponding internal `Decision`. It has no side effects.

**Call relations**: Called during `RequirementsExecPolicyToml::to_policy` after validation decides the rule's decision is present and permitted.


##### `RequirementsExecPolicyToml::to_policy`  (lines 125–183)

```
fn to_policy(&self) -> Result<Policy, RequirementsExecPolicyParseError>
```

**Purpose**: Validates and lowers the deserialized requirements rule set into a `codex_execpolicy::Policy`. It enforces requirements-specific restrictions, especially that `allow` decisions are forbidden because merged requirements use the most restrictive outcome.

**Data flow**: Reads `self.prefix_rules`; rejects an empty list immediately. For each rule, it validates nonblank justification, nonempty pattern, converts each pattern element with `parse_pattern_token`, validates `decision`, clones optional justification, splits the parsed pattern into head and tail, shares the tail as `Arc<[PatternToken]>`, expands every alternative in the first token into a separate `PrefixRule`, wraps each as `RuleRef`, and inserts them into a `MultiMap<String, RuleRef>`. On success it returns `Policy::new(rules_by_program)`; on any validation failure it returns a `RequirementsExecPolicyParseError` carrying rule/token indices and a concrete reason.

**Call relations**: This is the main conversion routine for requirements execution rules. `to_requirements_policy` delegates directly to it, and its output feeds higher-level requirements composition and tests.

*Call graph*: called by 1 (to_requirements_policy); 4 external calls (from, new, new, new).


##### `RequirementsExecPolicyToml::to_requirements_policy`  (lines 185–189)

```
fn to_requirements_policy(
        &self,
    ) -> Result<RequirementsExecPolicy, RequirementsExecPolicyParseError>
```

**Purpose**: Converts TOML rules directly into the wrapper type used by the config layer. It is a thin convenience layer over `to_policy`.

**Data flow**: Reads `self`, calls `to_policy`, and maps the successful `Policy` into `RequirementsExecPolicy::new`. It returns either the wrapped policy or the same parse error from the lower conversion step.

**Call relations**: Called by code that wants the requirements-specific wrapper rather than a bare `Policy`; it delegates all parsing and validation to `to_policy`.

*Call graph*: calls 1 internal fn (to_policy).


##### `parse_pattern_token`  (lines 192–236)

```
fn parse_pattern_token(
    token: &RequirementsExecPolicyPatternTokenToml,
    rule_index: usize,
    token_index: usize,
) -> Result<PatternToken, RequirementsExecPolicyParseError>
```

**Purpose**: Validates one TOML pattern-token table and converts it into a `PatternToken`. It enforces the invariant that exactly one of `token` or `any_of` must be set and that no provided strings are blank.

**Data flow**: Consumes a borrowed `RequirementsExecPolicyPatternTokenToml` plus `rule_index` and `token_index` for diagnostics. It matches the `(token, any_of)` combination, returns `PatternToken::Single` or `PatternToken::Alts` on valid input, and otherwise returns `RequirementsExecPolicyParseError::InvalidPatternToken` with a specific reason string.

**Call relations**: Used inside `RequirementsExecPolicyToml::to_policy` while mapping each rule's `pattern` vector into internal tokens; it isolates per-token validation so the caller can collect a full parsed pattern or fail early with indexed errors.

*Call graph*: 2 external calls (Alts, Single).


### `execpolicy/src/amend.rs`

`io_transport` · `policy amendment / disk write`

This module implements the write path for amending execpolicy rule files. Its public API consists of two blocking functions: one appends an allow-only `prefix_rule`, the other appends a `network_rule`. Both convert structured inputs into the textual policy language, then funnel through shared file-update helpers that create the containing directory if needed, lock the file, read existing contents, avoid writing duplicate lines, and preserve newline formatting when appending.

`AmendError` is the central error surface and distinguishes validation failures from filesystem failures at each stage: missing parent directory, directory creation, serialization, open/lock/seek/read/write, and invalid network rule inputs. Prefix rules require at least one token; each token is JSON-serialized so embedded quotes and punctuation are escaped correctly before being inserted into `prefix_rule(pattern=[...], decision="allow")`. Network rules first normalize and validate the host with `normalize_network_rule_host`, reject blank justifications after trimming, serialize host/protocol/decision/justification fields individually with `serde_json`, and map `Decision::Forbidden` to the policy string `"deny"` rather than the enum variant name.

The internal append path is intentionally conservative: it opens with create/read/append, acquires an advisory lock, rewinds to the start to inspect current contents, returns early if the exact line already exists, inserts a newline only when the file is non-empty and lacks one, then writes the new rule plus trailing newline. The embedded tests cover directory creation, newline behavior, mixed prefix/network appends, and wildcard-host rejection.

#### Function details

##### `blocking_append_allow_prefix_rule`  (lines 65–81)

```
fn blocking_append_allow_prefix_rule(
    policy_path: &Path,
    prefix: &[String],
) -> Result<(), AmendError>
```

**Purpose**: Builds a textual `prefix_rule` that allows a specific command-token prefix and appends it to the policy file. It validates that the prefix is non-empty and serializes each token as JSON to preserve exact token contents.

**Data flow**: Inputs are `policy_path: &Path` and `prefix: &[String]`. It first rejects an empty slice with `AmendError::EmptyPrefix`; otherwise it maps each token through `serde_json::to_string`, joins the serialized tokens into a JSON-like array string, embeds that into `prefix_rule(pattern=[...], decision="allow")`, and passes the final line to `append_rule_line`. It returns `Ok(())` on success or an `AmendError` describing validation, serialization, or file-update failure.

**Call relations**: This is one of the module's public entry points and is exercised by multiple unit tests covering directory creation and newline handling. After local validation and formatting, it delegates all filesystem concerns to `append_rule_line`.

*Call graph*: calls 1 internal fn (append_rule_line); called by 4 (appends_prefix_and_network_rules, appends_rule_and_creates_directories, appends_rule_without_duplicate_newline, inserts_newline_when_missing_before_append); 1 external calls (format!).


##### `blocking_append_network_rule`  (lines 85–125)

```
fn blocking_append_network_rule(
    policy_path: &Path,
    host: &str,
    protocol: NetworkRuleProtocol,
    decision: Decision,
    justification: Option<&str>,
) -> Result<(), AmendError>
```

**Purpose**: Constructs and appends a textual `network_rule` from structured host, protocol, decision, and optional justification inputs. It normalizes the host, rejects invalid or empty justification text, and converts enum values into the policy language's expected strings.

**Data flow**: It accepts `policy_path`, raw `host`, `protocol: NetworkRuleProtocol`, `decision: Decision`, and `justification: Option<&str>`. The host is normalized with `normalize_network_rule_host`; failures become `AmendError::InvalidNetworkRule`. A present but whitespace-only justification is also rejected. It JSON-serializes the normalized host, `protocol.as_policy_string()`, and a decision string chosen from `allow`, `prompt`, or `deny`, optionally serializes the justification, assembles `network_rule(host=..., protocol=..., decision=..., justification=...)`, and forwards that line to `append_rule_line`.

**Call relations**: This public entry point is used by tests for successful network-rule append, mixed append ordering, and wildcard-host rejection. It performs all semantic validation and string assembly itself, then relies on `append_rule_line` for directory creation, locking, duplicate detection, and writing.

*Call graph*: calls 3 internal fn (append_rule_line, as_policy_string, normalize_network_rule_host); called by 3 (appends_network_rule, appends_prefix_and_network_rules, rejects_wildcard_network_rule_host); 4 external calls (InvalidNetworkRule, format!, to_string, vec!).


##### `append_rule_line`  (lines 127–145)

```
fn append_rule_line(policy_path: &Path, rule: &str) -> Result<(), AmendError>
```

**Purpose**: Prepares the filesystem location for a rule append by ensuring the policy file has a parent directory and creating that directory when absent. It isolates path-level setup from the lower-level locked append logic.

**Data flow**: Given `policy_path` and a fully formatted rule line, it reads `policy_path.parent()`, returning `AmendError::MissingParent` if none exists. It then calls `std::fs::create_dir(dir)`, treating `AlreadyExists` as success and mapping any other error to `AmendError::CreatePolicyDir`. Finally it calls `append_locked_line(policy_path, rule)` and returns that result.

**Call relations**: Both public append functions delegate here after formatting their rule strings. This helper in turn delegates the actual file open/read/lock/write sequence to `append_locked_line` once the directory precondition is satisfied.

*Call graph*: calls 1 internal fn (append_locked_line); called by 2 (blocking_append_allow_prefix_rule, blocking_append_network_rule); 2 external calls (parent, create_dir).


##### `append_locked_line`  (lines 147–193)

```
fn append_locked_line(policy_path: &Path, line: &str) -> Result<(), AmendError>
```

**Purpose**: Performs the actual append under an advisory file lock, while preventing duplicate rule lines and preserving correct newline separation. It is the module's critical section for safe concurrent file updates.

**Data flow**: Inputs are `policy_path` and the rule `line`. It opens the file with create/read/append options, maps open failures to `OpenPolicyFile`, acquires a lock mapped to `LockPolicyFile`, seeks to byte 0 mapped to `SeekPolicyFile`, and reads the entire file into a `String` mapped to `ReadPolicyFile`. If any existing line exactly equals `line`, it returns `Ok(())` without writing. Otherwise, if the file is non-empty and does not end with `\n`, it writes a newline first, then writes `{line}\n`, mapping write failures to `WritePolicyFile`. It returns `Ok(())` after the append.

**Call relations**: Only `append_rule_line` calls this helper. It is the final stage in the append pipeline and encapsulates the lock/read-check-write sequence that all rule types share.

*Call graph*: called by 1 (append_rule_line); 4 external calls (new, Start, new, format!).


##### `tests::appends_rule_and_creates_directories`  (lines 202–218)

```
fn appends_rule_and_creates_directories()
```

**Purpose**: Verifies that appending a prefix rule creates the missing parent directory tree and writes the expected single-line file content. It serves as the baseline happy-path test for a fresh policy path.

**Data flow**: The test creates a temporary directory, derives `rules/default.rules` beneath it, calls `blocking_append_allow_prefix_rule` with `echo` and `Hello, world!`, then reads the file back with `std::fs::read_to_string` and asserts exact string equality including the trailing newline.

**Call relations**: Invoked by the test harness. It exercises the full public append path through directory creation and into the locked writer, validating the externally visible file contents.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `tests::appends_rule_without_duplicate_newline`  (lines 221–245)

```
fn appends_rule_without_duplicate_newline()
```

**Purpose**: Checks that appending to a file that already ends with a newline produces exactly one separator newline between rules. It guards against accidental blank lines during repeated amendments.

**Data flow**: The test creates a temp directory, pre-creates the policy directory, seeds the file with one prefix rule ending in `\n`, calls `blocking_append_allow_prefix_rule` for a second rule, reads the file contents, and asserts that the result contains two consecutive rule lines with no empty line between them.

**Call relations**: Called by the test harness to cover the branch in `append_locked_line` where `contents.ends_with('\n')` is true, so no extra newline should be inserted before writing the new rule.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 6 external calls (from, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `tests::inserts_newline_when_missing_before_append`  (lines 248–271)

```
fn inserts_newline_when_missing_before_append()
```

**Purpose**: Verifies that the append logic inserts a separator newline when the existing file lacks a trailing newline. This preserves one-rule-per-line formatting even for manually edited or malformed seed files.

**Data flow**: It creates a temp directory and policy directory, writes an initial rule string without a trailing newline, invokes `blocking_append_allow_prefix_rule` for a second rule, reads the file back, and asserts that the resulting contents contain the original rule, an inserted newline, and the appended rule with its own trailing newline.

**Call relations**: The test harness invokes this case to exercise the `!contents.is_empty() && !contents.ends_with('\n')` branch inside `append_locked_line`.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 6 external calls (from, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `tests::appends_network_rule`  (lines 274–293)

```
fn appends_network_rule()
```

**Purpose**: Confirms that a network rule is normalized, serialized, and appended in the exact policy syntax expected by downstream parsers. It specifically checks lowercase host normalization and inclusion of justification text.

**Data flow**: The test creates a temp policy path, calls `blocking_append_network_rule` with host `Api.GitHub.com`, protocol `Https`, decision `Allow`, and a justification string, then reads the file and asserts exact equality with a single `network_rule(...)` line containing normalized host `api.github.com`, protocol `https`, decision `allow`, and the justification field.

**Call relations**: Invoked by the test harness as the primary positive test for the network-rule entry point. It covers host normalization and field serialization before the shared append machinery writes the file.

*Call graph*: calls 1 internal fn (blocking_append_network_rule); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `tests::appends_prefix_and_network_rules`  (lines 296–318)

```
fn appends_prefix_and_network_rules()
```

**Purpose**: Checks that different rule kinds can be appended sequentially to the same file and preserve order. It validates interoperability of the two public amendment APIs against one shared append backend.

**Data flow**: The test creates a temp policy path, first calls `blocking_append_allow_prefix_rule` with `curl`, then `blocking_append_network_rule` with an HTTPS GitHub host rule, reads the resulting file, and asserts exact two-line contents in append order.

**Call relations**: The test harness invokes this case to exercise both public append functions in one scenario, proving they compose correctly through `append_rule_line` and `append_locked_line`.

*Call graph*: calls 2 internal fn (blocking_append_allow_prefix_rule, blocking_append_network_rule); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `tests::rejects_wildcard_network_rule_host`  (lines 321–336)

```
fn rejects_wildcard_network_rule_host()
```

**Purpose**: Ensures wildcard hosts are rejected before any file write occurs and that the surfaced error message is specific. It documents the invariant that network rules must target a concrete host.

**Data flow**: The test creates a temp policy path, calls `blocking_append_network_rule` with host `*.example.com`, protocol `Https`, decision `Allow`, and no justification, captures the returned error with `expect_err`, and asserts on `err.to_string()`.

**Call relations**: Called by the test harness as the negative validation case for network rules. It exercises the early host-normalization failure path in `blocking_append_network_rule`, so the shared append helpers are never reached.

*Call graph*: calls 1 internal fn (blocking_append_network_rule); 2 external calls (assert_eq!, tempdir).


### `core/src/network_proxy_loader.rs`

`orchestration` · `startup config load and runtime config reload for network proxy state`

This file is the loader/orchestration layer for network proxy configuration. Startup begins with `build_network_proxy_state` or `build_network_proxy_state_and_reloader`, which call `build_config_state_with_mtimes`. That function resolves `CODEX_HOME`, loads the full `ConfigLayerStack`, attempts to load exec policy, tolerates parse errors by warning and substituting an empty policy, then derives a `NetworkProxyConfig`, trusted `NetworkProxyConstraints`, and file mtimes before calling `codex_network_proxy::build_config_state`.

Two parallel config derivations happen here. `config_from_layers` merges all enabled layers in precedence order into one TOML value, selects the final active permission profile’s network table, accumulates MITM hooks/actions through `NetworkConfigAccumulator`, finalizes `network.mitm`, and overlays compiled exec-policy allow/deny domains via `apply_exec_policy_network_rules`. Separately, `network_constraints_from_trusted_layers` merges only non-user-controlled layers (excluding user, project, and session flags), selects the final trusted profile network, and applies only constraint-relevant fields into `NetworkProxyConstraints`; `enforce_trusted_constraints` then validates the effective config against those constraints.

The file also tracks reloadability. `collect_layer_mtimes` records mtimes for system, user, project, and legacy managed config files. `MtimeConfigReloader` stores those mtimes behind an async `RwLock`, compares current metadata in `needs_reload`, and either returns `None` or rebuilds fresh `ConfigState` plus mtimes in `maybe_reload`; `reload_now` forces the rebuild. Important invariants include precedence-order merging, normalization/upsert of domain permissions, and selecting only the final active permission profile rather than unioning multiple profiles across layers.

#### Function details

##### `build_network_proxy_state`  (lines 41–44)

```
async fn build_network_proxy_state() -> Result<NetworkProxyState>
```

**Purpose**: Builds a `NetworkProxyState` with an attached config reloader from current layered config.

**Data flow**: Calls `build_network_proxy_state_and_reloader()` to obtain a `ConfigState` and `MtimeConfigReloader`, wraps the reloader in `Arc`, and returns `NetworkProxyState::with_reloader(state, Arc::new(reloader))`.

**Call relations**: Top-level entry used when the runtime wants a ready-to-use proxy state object that can self-reload.

*Call graph*: calls 2 internal fn (build_network_proxy_state_and_reloader, with_reloader); 1 external calls (new).


##### `build_network_proxy_state_and_reloader`  (lines 46–50)

```
async fn build_network_proxy_state_and_reloader() -> Result<(ConfigState, MtimeConfigReloader)>
```

**Purpose**: Builds the initial network proxy config state and a matching mtime-based reloader.

**Data flow**: Calls `build_config_state_with_mtimes()` to get `(ConfigState, Vec<LayerMtime>)`, constructs `MtimeConfigReloader::new(layer_mtimes)`, and returns both pieces.

**Call relations**: Used by `build_network_proxy_state` and can also be called directly by code that wants separate state and reloader objects.

*Call graph*: calls 2 internal fn (new, build_config_state_with_mtimes); called by 1 (build_network_proxy_state).


##### `build_config_state_with_mtimes`  (lines 52–87)

```
async fn build_config_state_with_mtimes() -> Result<(ConfigState, Vec<LayerMtime>)>
```

**Purpose**: Loads layered config and exec policy, derives effective network proxy config plus trusted constraints, and records mtimes for reload detection.

**Data flow**: Finds `codex_home`, loads config layers with `load_config_layers_state`, loads exec policy with `load_exec_policy`, substituting `Policy::empty()` and logging a warning on parse errors, derives `NetworkProxyConfig` via `config_from_layers`, derives and validates trusted constraints via `enforce_trusted_constraints`, collects layer mtimes with `collect_layer_mtimes`, builds a `ConfigState` with `build_config_state(config, constraints)`, and returns `(state, layer_mtimes)`.

**Call relations**: Core builder used at startup and by both reload paths. It delegates config derivation, constraint derivation, and mtime collection to helper functions.

*Call graph*: calls 6 internal fn (load_config_layers_state, find_codex_home, load_exec_policy, collect_layer_mtimes, config_from_layers, enforce_trusted_constraints); called by 3 (maybe_reload, reload_now, build_network_proxy_state_and_reloader); 5 external calls (new, build_config_state, default, empty, warn!).


##### `collect_layer_mtimes`  (lines 89–109)

```
fn collect_layer_mtimes(stack: &ConfigLayerStack) -> Vec<LayerMtime>
```

**Purpose**: Collects filesystem paths and current modification times for reload-relevant config layers.

**Data flow**: Iterates enabled layers from the `ConfigLayerStack` in lowest-precedence-first order, maps supported `ConfigLayerSource` variants to concrete config file paths (`System.file`, `User.file`, `Project.dot_codex_folder/config.toml`, `LegacyManagedConfigTomlFromFile.file`), converts each path into `LayerMtime::new`, and returns the resulting vector.

**Call relations**: Called during initial state build and every reload rebuild so `MtimeConfigReloader` can later detect changes.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (build_config_state_with_mtimes).


##### `enforce_trusted_constraints`  (lines 111–120)

```
fn enforce_trusted_constraints(
    layers: &ConfigLayerStack,
    config: &NetworkProxyConfig,
) -> Result<NetworkProxyConstraints>
```

**Purpose**: Derives trusted-layer network constraints and validates the effective network proxy config against them.

**Data flow**: Calls `network_constraints_from_trusted_layers(layers)` to build `NetworkProxyConstraints`, then passes `config` and those constraints into `validate_policy_against_constraints`. On validation failure it converts the proxy constraint error into `anyhow` with context `network proxy constraints`; otherwise it returns the constraints.

**Call relations**: Used only by `build_config_state_with_mtimes` after effective config derivation, ensuring user-controlled layers cannot violate trusted baseline restrictions.

*Call graph*: calls 1 internal fn (network_constraints_from_trusted_layers); called by 1 (build_config_state_with_mtimes); 1 external calls (validate_policy_against_constraints).


##### `network_constraints_from_trusted_layers`  (lines 122–143)

```
fn network_constraints_from_trusted_layers(
    layers: &ConfigLayerStack,
) -> Result<NetworkProxyConstraints>
```

**Purpose**: Builds network proxy constraints from only trusted, non-user-controlled config layers.

**Data flow**: Starts with default `NetworkProxyConstraints` and an empty TOML table, iterates enabled layers in precedence order, skips layers for which `is_user_controlled_layer` is true, merges remaining layer TOML into `merged`, deserializes `NetworkTablesToml` with `network_tables_from_toml`, selects the final active network table with `selected_network_from_tables`, and if present applies it into the constraints via `apply_network_constraints` before returning them.

**Call relations**: Called by `enforce_trusted_constraints`. It mirrors `config_from_layers` structurally but intentionally excludes user/project/session layers and only extracts constraint-relevant fields.

*Call graph*: calls 5 internal fn (get_layers, apply_network_constraints, is_user_controlled_layer, network_tables_from_toml, selected_network_from_tables); called by 1 (enforce_trusted_constraints); 4 external calls (merge_toml_values, default, Table, new).


##### `apply_network_constraints`  (lines 145–182)

```
fn apply_network_constraints(network: NetworkToml, constraints: &mut NetworkProxyConstraints)
```

**Purpose**: Applies a selected `NetworkToml` profile into `NetworkProxyConstraints`, overlaying scalar flags and domain permissions.

**Data flow**: Reads fields from `network` and writes corresponding `Option` fields on `constraints` for enablement, mode, upstream proxy, non-loopback proxy, all-unix-sockets, unix socket allowance, and local binding. For `domains`, it reconstructs a temporary `NetworkProxyConfig` seeded from any existing allowed/denied domains in `constraints`, overlays the new domain permissions with `overlay_network_domain_permissions`, then writes back normalized allowed and denied domain lists. For `unix_sockets`, it computes `allow_unix_sockets()` and stores that boolean.

**Call relations**: Used by `network_constraints_from_trusted_layers` and tested directly to ensure overlay semantics match effective config behavior.

*Call graph*: calls 1 internal fn (overlay_network_domain_permissions); called by 1 (network_constraints_from_trusted_layers); 1 external calls (default).


##### `network_tables_from_toml`  (lines 190–195)

```
fn network_tables_from_toml(value: &toml::Value) -> Result<NetworkTablesToml>
```

**Purpose**: Deserializes the subset of merged TOML relevant to permission-profile network selection.

**Data flow**: Clones the input `toml::Value`, attempts `try_into::<NetworkTablesToml>()`, and returns the parsed struct or an `anyhow` error with context `failed to deserialize network tables from config`.

**Call relations**: Shared helper used by both effective-config and trusted-constraints derivation paths, plus test-only application helpers.

*Call graph*: called by 2 (config_from_layers, network_constraints_from_trusted_layers); 1 external calls (clone).


##### `selected_network_from_tables`  (lines 197–212)

```
fn selected_network_from_tables(parsed: NetworkTablesToml) -> Result<Option<NetworkToml>>
```

**Purpose**: Selects the final active `NetworkToml` from parsed config tables based on `default_permissions` and permission-profile inheritance rules.

**Data flow**: Reads `parsed.default_permissions`; if absent, returns `Ok(None)`. If the name is a built-in permission profile, it returns `Ok(None)` after validating that unknown built-ins are rejected. Otherwise it requires a `[permissions]` table, resolves the named profile with `resolve_permission_profile`, and returns `Ok(profile.network)`.

**Call relations**: Central selector used by both config and constraint derivation. It ensures only the final chosen profile contributes network settings.

*Call graph*: called by 3 (apply_network_tables, apply_network_tables, network_constraints_from_trusted_layers); 3 external calls (is_builtin_permission_profile_name, reject_unknown_builtin_permission_profile, resolve_permission_profile).


##### `apply_network_tables`  (lines 215–220)

```
fn apply_network_tables(config: &mut NetworkProxyConfig, parsed: NetworkTablesToml) -> Result<()>
```

**Purpose**: Test-only helper that applies the selected network table from parsed config directly into a `NetworkProxyConfig`.

**Data flow**: Calls `selected_network_from_tables(parsed)`; if it returns `Some(network)`, invokes `network.apply_to_network_proxy_config(config)`, then returns `Ok(())`.

**Call relations**: Compiled only in tests and used by `network_proxy_loader_tests.rs` to validate overlay behavior incrementally.

*Call graph*: calls 1 internal fn (selected_network_from_tables).


##### `NetworkConfigAccumulator::apply_network_tables`  (lines 230–235)

```
fn apply_network_tables(&mut self, parsed: NetworkTablesToml) -> Result<()>
```

**Purpose**: Applies the selected network table from parsed config into the accumulator’s config and MITM collections.

**Data flow**: Calls `selected_network_from_tables(parsed)`; if a `NetworkToml` is selected, forwards it to `self.apply_network(network)`, then returns `Ok(())`.

**Call relations**: Used by `config_from_layers` and tests to process one merged or incremental network table at a time while preserving MITM action/hook accumulation.

*Call graph*: calls 2 internal fn (apply_network, selected_network_from_tables).


##### `NetworkConfigAccumulator::apply_network`  (lines 237–249)

```
fn apply_network(&mut self, mut network: NetworkToml)
```

**Purpose**: Applies one `NetworkToml` into the accumulator, separating ordinary network settings from MITM hook/action definitions.

**Data flow**: Takes ownership of `network`, removes `network.mitm` with `take()`, applies the remaining network settings into `self.config` via `apply_to_network_proxy_config`, then extends `self.mitm_actions` and `self.mitm_hooks` with any actions/hooks found in the extracted MITM config.

**Call relations**: Called by `NetworkConfigAccumulator::apply_network_tables` whenever a selected network profile is present.

*Call graph*: calls 1 internal fn (apply_to_network_proxy_config); called by 1 (apply_network_tables); 1 external calls (extend).


##### `NetworkConfigAccumulator::finish`  (lines 251–266)

```
fn finish(mut self) -> Result<NetworkProxyConfig>
```

**Purpose**: Finalizes accumulated network config by validating MITM action references, materializing runtime hooks, and computing the final MITM-enabled flag.

**Data flow**: Consumes the accumulator. If `mitm_hooks` is non-empty, it builds a `NetworkMitmToml` from accumulated hooks and actions, validates hook action references, converts hooks to runtime hooks with `to_runtime_hooks`, and stores them in `self.config.network.mitm_hooks`. It then sets `self.config.network.mitm` to true if mode is `NetworkMode::Limited` or any MITM hooks exist, and returns the finished `NetworkProxyConfig`.

**Call relations**: Called by `config_from_layers` after all merged network settings have been accumulated.

*Call graph*: 1 external calls (is_empty).


##### `config_from_layers`  (lines 269–286)

```
fn config_from_layers(
    layers: &ConfigLayerStack,
    exec_policy: &codex_execpolicy::Policy,
) -> Result<NetworkProxyConfig>
```

**Purpose**: Builds the effective `NetworkProxyConfig` from all enabled config layers plus exec-policy domain overlays.

**Data flow**: Starts with an empty TOML table, merges every enabled layer’s config in lowest-precedence-first order, deserializes `NetworkTablesToml`, creates a default `NetworkConfigAccumulator`, applies the selected network tables into it, finalizes the accumulator into a `NetworkProxyConfig`, overlays exec-policy network rules via `apply_exec_policy_network_rules`, and returns the config.

**Call relations**: Called by `build_config_state_with_mtimes` as the main effective-config derivation step. It delegates profile selection to `selected_network_from_tables` and post-processing to the accumulator and exec-policy overlay helper.

*Call graph*: calls 3 internal fn (get_layers, apply_exec_policy_network_rules, network_tables_from_toml); called by 1 (build_config_state_with_mtimes); 4 external calls (merge_toml_values, default, Table, new).


##### `apply_exec_policy_network_rules`  (lines 288–307)

```
fn apply_exec_policy_network_rules(
    config: &mut NetworkProxyConfig,
    exec_policy: &codex_execpolicy::Policy,
)
```

**Purpose**: Overlays compiled exec-policy allow and deny domain rules onto the network proxy config.

**Data flow**: Calls `exec_policy.compiled_network_domains()` to get allowed and denied host lists, then iterates each list and calls `upsert_network_domain(config, host, permission)` with `Allow` or `Deny` respectively.

**Call relations**: Used by `config_from_layers` after config-derived network settings are built, so exec-policy rules take effect in the final runtime config.

*Call graph*: calls 1 internal fn (upsert_network_domain); called by 1 (config_from_layers); 1 external calls (compiled_network_domains).


##### `upsert_network_domain`  (lines 309–317)

```
fn upsert_network_domain(
    config: &mut NetworkProxyConfig,
    host: String,
    permission: codex_network_proxy::NetworkDomainPermission,
)
```

**Purpose**: Adds or updates one normalized domain permission entry in the network proxy config.

**Data flow**: Takes mutable `NetworkProxyConfig`, a host string, and a `NetworkDomainPermission`, then calls `config.network.upsert_domain_permission(host, permission, normalize_host)` to insert/update the normalized host entry.

**Call relations**: Internal helper used by `apply_exec_policy_network_rules` to ensure domain normalization and overwrite semantics are centralized.

*Call graph*: called by 1 (apply_exec_policy_network_rules).


##### `is_user_controlled_layer`  (lines 319–326)

```
fn is_user_controlled_layer(layer: &ConfigLayerSource) -> bool
```

**Purpose**: Classifies config layer sources that should be excluded when deriving trusted constraints.

**Data flow**: Matches the `ConfigLayerSource` and returns `true` for `User`, `Project`, and `SessionFlags`; returns `false` for all other layer kinds.

**Call relations**: Used by `network_constraints_from_trusted_layers` to filter out layers that are not trusted enough to impose baseline constraints.

*Call graph*: called by 1 (network_constraints_from_trusted_layers); 1 external calls (matches!).


##### `LayerMtime::new`  (lines 335–338)

```
fn new(path: AbsolutePathBuf) -> Self
```

**Purpose**: Captures the current modification time for one config file path.

**Data flow**: Takes an `AbsolutePathBuf`, reads filesystem metadata and modified time if available, stores the path and optional `SystemTime` in a new `LayerMtime`, and returns it.

**Call relations**: Called by `collect_layer_mtimes` when building the reload watch list.

*Call graph*: 1 external calls (metadata).


##### `MtimeConfigReloader::new`  (lines 346–350)

```
fn new(layer_mtimes: Vec<LayerMtime>) -> Self
```

**Purpose**: Constructs a reloader initialized with the current set of tracked layer mtimes.

**Data flow**: Wraps the provided `Vec<LayerMtime>` in a `tokio::sync::RwLock` and returns `MtimeConfigReloader { layer_mtimes }`.

**Call relations**: Created by `build_network_proxy_state_and_reloader` after the initial config state has been built.

*Call graph*: called by 1 (build_network_proxy_state_and_reloader); 1 external calls (new).


##### `MtimeConfigReloader::needs_reload`  (lines 352–363)

```
async fn needs_reload(&self) -> bool
```

**Purpose**: Checks whether any tracked config file has appeared, disappeared, or gained a newer modification time.

**Data flow**: Reads the current `layer_mtimes` lock, iterates each tracked layer, fetches current filesystem metadata for `layer.path`, compares current modified time against stored `layer.mtime`, and returns `true` if any file is newer, newly present, or newly missing; otherwise returns `false`.

**Call relations**: Used internally by `MtimeConfigReloader::maybe_reload` as the cheap change detector before rebuilding config state.

*Call graph*: called by 1 (maybe_reload).


##### `MtimeConfigReloader::source_label`  (lines 385–387)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a human-readable label describing what this reloader watches.

**Data flow**: Returns the constant string `"config layers"` as an owned `String`.

**Call relations**: Implements the `ConfigReloader` trait’s labeling method for diagnostics and logging.


##### `MtimeConfigReloader::maybe_reload`  (lines 389–391)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements conditional reload: rebuilds config state only if tracked layer mtimes indicate a change.

**Data flow**: Calls `self.needs_reload().await`; if false, returns `Ok(None)`. If true, it rebuilds `(state, layer_mtimes)` via `build_config_state_with_mtimes().await`, writes the new mtimes into the lock, and returns `Ok(Some(state))`.

**Call relations**: Exposed through the `ConfigReloader` trait and used by runtime code that polls for config changes without forcing a rebuild every time.

*Call graph*: calls 2 internal fn (needs_reload, build_config_state_with_mtimes); 1 external calls (pin).


##### `MtimeConfigReloader::reload_now`  (lines 393–395)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Forces an unconditional rebuild of network proxy config state and refreshes tracked mtimes.

**Data flow**: Calls `build_config_state_with_mtimes().await`, writes the returned mtimes into the lock, and returns the rebuilt `ConfigState`.

**Call relations**: Exposed through the `ConfigReloader` trait for explicit reload requests that bypass change detection.

*Call graph*: calls 1 internal fn (build_config_state_with_mtimes); 1 external calls (pin).


### Requirements schema and layer preparation
These files establish the requirements model and prepare individual requirement sources for later composition.

### `config/src/requirements_layers/mod.rs`

`orchestration` · `config load and requirement composition setup`

This module file is the root of the `requirements_layers` subsystem. It declares five internal submodules—`hooks`, `layer`, `permissions`, `rules`, and `stack`—which together implement the mechanics of requirement layering. Although the implementation details live in those files, this root establishes the public API by re-exporting `RequirementsLayerEntry` from `layer` and `compose_requirements` from `stack`.

That structure signals the intended abstraction boundary. Callers outside the subsystem are expected to work with a layer entry type that describes one source of requirements and a composition function that folds a stack of such layers into an effective result; they are not meant to depend directly on the lower-level hook, permission, or rule-merging internals. The design keeps the crate organized around a layered policy model, where requirements can originate from multiple places and must be combined deterministically. This file itself contains no executable logic, but it is important because it defines which concepts are stable and public versus which remain implementation details hidden behind the module tree.


### `config/src/config_requirements.rs`

`domain_logic` · `config load`

This file is the core of managed-requirements processing. It starts by modeling where a requirement came from with `RequirementSource`, including single origins, legacy MDM/file sources, enterprise-managed layers, and flattened/deduplicated composites for merged provenance. It then wraps constrained values in `ConstrainedWithSource<T>` and plain sourced values in `Sourced<T>` so later validation errors can name the exact layer that imposed a restriction.

The schema side is broad: `ConfigRequirementsToml` represents the raw requirements file, while helper TOML structs cover network permissions, filesystem deny-read patterns, managed hooks, app/tool approvals, MCP servers, plugins, Windows sandbox implementations, feature flags, residency, and remote-sandbox hostname overrides. Several custom deserializers normalize legacy shapes into canonical ones: network allow/deny lists become `NetworkDomainPermissionsToml` / `NetworkUnixSocketPermissionsToml`, filesystem deny-read entries are normalized to absolute paths or normalized glob prefixes, and `permissions.filesystem` is explicitly reserved so it cannot masquerade as a normal permission profile.

`ConfigRequirementsWithSources` merges multiple layers by filling only unset fields, except `apps`, which merge with special descending-precedence semantics: any `enabled = false` wins across layers, while higher-precedence tool approval modes are preserved. `ConfigRequirementsToml::apply_remote_sandbox_config` can replace top-level sandbox allowlists based on the first hostname-pattern match. Finally, `TryFrom<ConfigRequirementsWithSources> for ConfigRequirements` compiles raw allowlists into `Constrained` validators for approval policy, reviewer, permission profile, Windows sandbox mode, web search mode, managed hooks, and residency; converts rules into executable policy; and preserves network/filesystem constraints plus guardian-policy source metadata.

#### Function details

##### `RequirementSource::composite`  (lines 53–64)

```
fn composite(sources: impl IntoIterator<Item = RequirementSource>) -> Self
```

**Purpose**: Builds a single provenance value from multiple requirement sources while flattening nested composites and removing duplicates. It also collapses degenerate cases so zero inputs become `Unknown` and one input stays as that source instead of wrapping it.

**Data flow**: Consumes any iterator of `RequirementSource` values, pushes each through `append_to_composite` into a temporary `Vec<RequirementSource>`, then returns `Unknown`, the sole source, or `Composite { sources }` depending on the flattened count. It writes no external state.

**Call relations**: Used when higher-level merge logic needs one error-reporting source that represents several contributing layers; callers use it before storing or surfacing provenance so downstream constraint errors mention all relevant layers in priority order.

*Call graph*: called by 4 (constraint_error_includes_composite_requirement_source, apply_to, merge_output_source, source_for_top_level_keys); 1 external calls (new).


##### `RequirementSource::append_to_composite`  (lines 66–79)

```
fn append_to_composite(self, flattened: &mut Vec<RequirementSource>)
```

**Purpose**: Recursively flattens one source into a composite accumulator. Nested `Composite` variants are expanded and duplicate leaf sources are skipped.

**Data flow**: Takes ownership of `self` and a mutable `Vec<RequirementSource>` accumulator. If `self` is composite, it recursively appends each child; otherwise it checks `flattened.contains(&source)` and pushes only unique sources.

**Call relations**: This is the worker behind `RequirementSource::composite`; it is not part of external merge flow directly, but enforces the invariant that composite provenance is flat and deduplicated.


##### `RequirementSource::fmt`  (lines 83–112)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats requirement provenance into human-readable text for diagnostics and error messages. Each variant gets a concrete display string, including file paths and enterprise identifiers.

**Data flow**: Reads the enum variant and writes formatted text into the provided formatter. Composite sources are emitted as a comma-separated list prefixed with `requirements layers:`.

**Call relations**: Invoked implicitly whenever `RequirementSource` appears in `ConstraintError` or other formatted output, so all source-aware validation paths depend on this representation being concise and specific.

*Call graph*: 1 external calls (write!).


##### `ConstrainedWithSource::new`  (lines 122–124)

```
fn new(value: Constrained<T>, source: Option<RequirementSource>) -> Self
```

**Purpose**: Constructs a constrained value paired with optional provenance. It is the standard wrapper used for normalized requirement-backed settings.

**Data flow**: Accepts a `Constrained<T>` and an `Option<RequirementSource>`, stores them unchanged, and returns `ConstrainedWithSource<T>`.

**Call relations**: Called by defaults and by `ConfigRequirements::try_from` when compiling raw requirement fields into active constraints, so it is the bridge between generic constraint machinery and source-aware requirement state.

*Call graph*: called by 17 (resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode, default, try_from, test_requirements_web_search_mode_allowlist_does_not_warn_when_unset, default, from, from_configured_with_optional_warnings, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing (+7 more)).


##### `ConstrainedWithSource::deref`  (lines 130–132)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the inner `Constrained<T>` by shared reference so callers can use constraint APIs directly on the wrapper.

**Data flow**: Reads `self.value` and returns `&Constrained<T>`.

**Call relations**: Supports ergonomic use of `ConstrainedWithSource` throughout config resolution and tests without manually reaching into the `value` field.


##### `ConstrainedWithSource::deref_mut`  (lines 136–138)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Exposes the inner `Constrained<T>` mutably so callers can update or further constrain the wrapped value.

**Data flow**: Returns `&mut Constrained<T>` from `self.value`.

**Call relations**: Used where requirement-backed constrained values need mutation through the wrapper, preserving attached source metadata alongside the mutable constraint.


##### `ConfigRequirements::default`  (lines 169–208)

```
fn default() -> Self
```

**Purpose**: Creates the permissive baseline requirements object used when no managed requirements are present. It chooses concrete defaults for constrained fields and leaves optional managed sections absent.

**Data flow**: Builds `ConfigRequirements` with unconstrained approval/reviewer defaults, `PermissionProfile::read_only()` as the initial permission profile, `WebSearchMode::Cached`, `None` for optional sections, and unconstrained `None` for optional Windows sandbox and residency fields.

**Call relations**: Used as the empty normalized state before any managed layers are applied; later conversion and merge logic rely on these defaults to represent 'no requirement imposed'.

*Call graph*: calls 4 internal fn (new, allow_any, allow_any_from_default, read_only).


##### `ConfigRequirements::exec_policy_source`  (lines 212–214)

```
fn exec_policy_source(&self) -> Option<&RequirementSource>
```

**Purpose**: Returns the provenance of the compiled execution policy, if one exists. It is a convenience accessor over the sourced optional field.

**Data flow**: Reads `self.exec_policy`, maps `Some(Sourced<_>)` to `&policy.source`, and returns `Option<&RequirementSource>`.

**Call relations**: Called by consumers that need to explain where an execution policy came from without unpacking the full sourced wrapper.


##### `PluginRequirementsToml::is_empty`  (lines 235–237)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether a plugin requirements block contains any MCP server requirements. Empty or absent `mcp_servers` counts as empty.

**Data flow**: Reads `self.mcp_servers`; returns true when it is `None` or when the contained `BTreeMap` is empty.

**Call relations**: Used by higher-level emptiness checks so blank plugin requirement entries do not make an otherwise empty requirements file appear configured.


##### `NetworkDomainPermissionsToml::is_empty`  (lines 247–249)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the canonical domain-permission map has any entries.

**Data flow**: Returns `self.entries.is_empty()`.

**Call relations**: Supports emptiness checks and normalization decisions around managed network constraints.


##### `NetworkDomainPermissionsToml::allowed_domains`  (lines 251–259)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Projects the canonical domain-permission map back into just the allowed patterns. It preserves sorted `BTreeMap` iteration order.

**Data flow**: Iterates `self.entries`, filters entries whose value is `Allow`, clones the pattern keys into a `Vec<String>`, and returns `Some(vec)` unless the result is empty, in which case it returns `None`.

**Call relations**: Used by callers that need legacy-style allowlists or reporting views derived from the canonical mixed allow/deny representation.


##### `NetworkDomainPermissionsToml::denied_domains`  (lines 261–269)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Projects the canonical domain-permission map into only denied patterns.

**Data flow**: Iterates `self.entries`, selects `Deny` values, clones matching keys into a vector, and returns `Some(vec)` only when at least one deny entry exists.

**Call relations**: Complements `allowed_domains` for diagnostics and compatibility projections from canonical network requirements.


##### `NetworkDomainPermissionToml::fmt`  (lines 280–286)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a domain permission enum as the lowercase TOML token `allow` or `deny`.

**Data flow**: Matches `self` and writes the corresponding static string to the formatter.

**Call relations**: Used implicitly in debug or user-facing output involving canonical network permission entries.

*Call graph*: 1 external calls (write_str).


##### `NetworkUnixSocketPermissionsToml::is_empty`  (lines 296–298)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any Unix socket permission entries are present.

**Data flow**: Returns `self.entries.is_empty()`.

**Call relations**: Supports normalization and emptiness checks for managed network socket constraints.


##### `NetworkUnixSocketPermissionsToml::allow_unix_sockets`  (lines 300–306)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Extracts only the allowed Unix socket paths from the canonical allow/deny map.

**Data flow**: Iterates `self.entries`, filters `Allow` values, clones the path keys, and returns them as a `Vec<String>`; unlike domain helpers, it always returns a vector, possibly empty.

**Call relations**: Used when projecting canonical socket permissions into the legacy allowlist shape or for assertions/reporting.


##### `NetworkUnixSocketPermissionToml::fmt`  (lines 317–323)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a Unix socket permission enum as `allow` or `deny`.

**Data flow**: Matches the enum variant and writes the lowercase token to the formatter.

**Call relations**: Provides display behavior for canonical socket permission values in diagnostics and serialization-adjacent contexts.

*Call graph*: 1 external calls (write_str).


##### `NetworkRequirementsToml::deserialize`  (lines 365–412)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Custom-deserializes managed network requirements, enforcing that canonical and legacy field shapes are not mixed and normalizing legacy lists into canonical maps.

**Data flow**: Deserializes into `RawNetworkRequirementsToml`, checks for invalid combinations of `domains` with `allowed_domains`/`denied_domains` and `unix_sockets` with `allow_unix_sockets`, then constructs `NetworkRequirementsToml`, filling `domains` and `unix_sockets` from canonical fields or legacy conversion helpers.

**Call relations**: Invoked by serde whenever `experimental_network` is parsed, and also indirectly by `NetworkConstraints::deserialize`; it centralizes compatibility logic so later code only sees one normalized shape.

*Call graph*: called by 1 (deserialize); 2 external calls (custom, deserialize).


##### `legacy_domain_permissions_from_lists`  (lines 418–433)

```
fn legacy_domain_permissions_from_lists(
    allowed_domains: Option<Vec<String>>,
    denied_domains: Option<Vec<String>>,
) -> Option<NetworkDomainPermissionsToml>
```

**Purpose**: Converts legacy `allowed_domains` and `denied_domains` lists into the canonical mixed permission map. Empty legacy lists are intentionally treated as unset.

**Data flow**: Consumes two optional vectors, inserts allowed patterns then denied patterns into a `BTreeMap<String, NetworkDomainPermissionToml>`, and returns `Some(NetworkDomainPermissionsToml)` only if at least one entry exists.

**Call relations**: Called only from `NetworkRequirementsToml::deserialize` when canonical `domains` is absent, providing backward compatibility for older requirements files.

*Call graph*: 1 external calls (new).


##### `legacy_unix_socket_permissions_from_list`  (lines 435–445)

```
fn legacy_unix_socket_permissions_from_list(
    allow_unix_sockets: Option<Vec<String>>,
) -> Option<NetworkUnixSocketPermissionsToml>
```

**Purpose**: Converts the legacy `allow_unix_sockets` list into the canonical Unix socket permission map with all entries marked `Allow`.

**Data flow**: Consumes an optional vector of paths, maps each path to `(path, Allow)`, collects into a `BTreeMap`, and returns `Some(NetworkUnixSocketPermissionsToml)` only when non-empty.

**Call relations**: Used by `NetworkRequirementsToml::deserialize` to normalize the old socket allowlist field into the canonical representation.


##### `NetworkConstraints::deserialize`  (lines 465–471)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes normalized network constraints by reusing the requirements TOML parser and then converting the result into the runtime constraint struct.

**Data flow**: Delegates deserialization to `NetworkRequirementsToml::deserialize`, then converts the parsed value with `Into<NetworkConstraints>` and returns it.

**Call relations**: Lets callers deserialize directly into the normalized constraint type while still benefiting from the same legacy-shape validation and normalization rules.

*Call graph*: calls 1 internal fn (deserialize).


##### `NetworkConstraints::from`  (lines 475–500)

```
fn from(value: NetworkRequirementsToml) -> Self
```

**Purpose**: Performs a field-for-field conversion from `NetworkRequirementsToml` into the runtime `NetworkConstraints` struct.

**Data flow**: Consumes `NetworkRequirementsToml`, destructures all fields, and rebuilds them unchanged in `NetworkConstraints`.

**Call relations**: Used by `NetworkConstraints::deserialize` and by `ConfigRequirements::try_from` when preserving managed network requirements as sourced runtime constraints.


##### `FilesystemRequirementsToml::deserialize`  (lines 519–545)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Custom-deserializes requirements-level filesystem constraints while rejecting permission-profile fields in the reserved `permissions.filesystem` table.

**Data flow**: Deserializes into `RawFilesystemRequirementsToml`, checks whether any of `description`, `extends`, `workspace_roots`, `filesystem`, or `network` were supplied, returns a custom serde error if so, otherwise returns `FilesystemRequirementsToml { deny_read }`.

**Call relations**: Runs during parsing of `permissions.filesystem`, ensuring that this table is used only for managed deny-read constraints and not confused with normal profile definitions.

*Call graph*: 2 external calls (custom, deserialize).


##### `FilesystemConstraints::from`  (lines 563–569)

```
fn from(value: PermissionsRequirementsToml) -> Self
```

**Purpose**: Extracts the normalized filesystem deny-read constraint list from the broader permissions requirements structure.

**Data flow**: Consumes `PermissionsRequirementsToml`, pulls `filesystem.deny_read` if present, falls back to an empty vector otherwise, and returns `FilesystemConstraints { deny_read }`.

**Call relations**: Used by `ConfigRequirements::try_from` to preserve managed filesystem restrictions as a dedicated sourced constraint object.


##### `FilesystemDenyReadPattern::as_str`  (lines 577–579)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the normalized deny-read pattern string as a borrowed `&str`.

**Data flow**: Reads the inner transparent `String` and returns a string slice.

**Call relations**: Used by downstream filesystem enforcement or reporting code that needs the canonical pattern text.


##### `FilesystemDenyReadPattern::contains_glob`  (lines 581–583)

```
fn contains_glob(&self) -> bool
```

**Purpose**: Detects whether the normalized deny-read pattern contains glob metacharacters.

**Data flow**: Scans the inner string character-by-character and returns true if any character satisfies `is_glob_metacharacter`.

**Call relations**: Supports consumers that need to distinguish exact absolute paths from wildcard patterns.


##### `FilesystemDenyReadPattern::from_input`  (lines 585–606)

```
fn from_input(input: &str) -> Result<Self, String>
```

**Purpose**: Normalizes a user-supplied deny-read path or glob into a canonical absolute-pattern string. Non-glob inputs must deserialize as absolute paths; glob inputs normalize only the directory prefix to an absolute path and preserve the wildcard suffix.

**Data flow**: Reads an input `&str`. If it contains no glob metacharacters, it validates/deserializes the whole string as `AbsolutePathBuf` and stores its lossy string form. Otherwise it splits the pattern at the first glob boundary with `split_glob_pattern`, normalizes the directory prefix via `deserialize_absolute_path` (using `.` when the prefix is empty), then reconstructs a normalized pattern string with careful handling for root `/` and empty suffix cases.

**Call relations**: Called by serde deserialization and tests; it is the canonical entry point for deny-read pattern normalization before constraints are stored.

*Call graph*: calls 2 internal fn (deserialize_absolute_path, split_glob_pattern); 1 external calls (format!).


##### `FilesystemDenyReadPattern::from`  (lines 610–612)

```
fn from(value: AbsolutePathBuf) -> Self
```

**Purpose**: Converts an already-validated absolute path buffer into a deny-read pattern without adding glob semantics.

**Data flow**: Consumes `AbsolutePathBuf`, converts it to a lossy owned string, and wraps it in `FilesystemDenyReadPattern`.

**Call relations**: Used in tests and any code that already has an absolute path object and wants the normalized deny-read wrapper directly.

*Call graph*: calls 1 internal fn (to_string_lossy).


##### `FilesystemDenyReadPattern::deserialize`  (lines 616–622)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Serde entry point for deny-read patterns that accepts a string and normalizes it through `from_input`.

**Data flow**: Deserializes a `String`, passes it to `FilesystemDenyReadPattern::from_input`, and maps any normalization error into a serde custom error.

**Call relations**: Invoked automatically when parsing `deny_read` arrays in requirements TOML.

*Call graph*: 2 external calls (from_input, deserialize).


##### `deserialize_absolute_path`  (lines 625–628)

```
fn deserialize_absolute_path(input: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: Parses a string into `AbsolutePathBuf` using serde's existing absolute-path deserializer and converts any failure into a plain string message.

**Data flow**: Builds a `StrDeserializer` over the input string, calls `AbsolutePathBuf::deserialize`, and returns either the parsed absolute path or the error text.

**Call relations**: Used exclusively by `FilesystemDenyReadPattern::from_input` so path normalization shares the same validation rules as normal absolute-path TOML fields.

*Call graph*: calls 1 internal fn (deserialize); called by 1 (from_input); 1 external calls (new).


##### `split_glob_pattern`  (lines 630–653)

```
fn split_glob_pattern(input: &str) -> (&str, &str)
```

**Purpose**: Splits a path/glob string into the longest directory prefix before the first glob metacharacter and the remaining suffix. It preserves root and Windows drive-prefix edge cases.

**Data flow**: Searches for the first glob character, then scans backward for the last path separator before it. Returns a tuple `(directory_prefix, suffix)` with special handling for `/`, Windows `C:\`-style prefixes, and no-separator cases.

**Call relations**: Called by `FilesystemDenyReadPattern::from_input` to isolate the portion that must be normalized as an absolute path from the wildcard suffix that must remain textual.

*Call graph*: called by 1 (from_input); 1 external calls (cfg!).


##### `is_path_separator`  (lines 655–661)

```
fn is_path_separator(ch: char) -> bool
```

**Purpose**: Determines whether a character counts as a path separator on the current platform.

**Data flow**: Returns true for `/` on Unix and for either `/` or `\` on Windows.

**Call relations**: Used by `split_glob_pattern` so glob-prefix splitting respects platform path syntax.

*Call graph*: 1 external calls (cfg!).


##### `is_glob_metacharacter`  (lines 663–665)

```
fn is_glob_metacharacter(ch: char) -> bool
```

**Purpose**: Recognizes the subset of glob syntax that triggers special deny-read normalization.

**Data flow**: Returns true when the character is `*`, `?`, or `[`.

**Call relations**: Used by `contains_glob`, `from_input`, and `split_glob_pattern` to decide whether an input is a literal path or a wildcard pattern.

*Call graph*: 1 external calls (matches!).


##### `WebSearchModeRequirement::from`  (lines 676–682)

```
fn from(mode: WebSearchMode) -> Self
```

**Purpose**: Converts a runtime `WebSearchMode` into its requirements-layer enum counterpart.

**Data flow**: Matches the input mode and returns the corresponding `WebSearchModeRequirement` variant.

**Call relations**: Used when building accepted-mode sets and error messages during requirement compilation.


##### `WebSearchMode::from`  (lines 686–692)

```
fn from(mode: WebSearchModeRequirement) -> Self
```

**Purpose**: Converts a requirements-layer web search mode into the runtime `WebSearchMode` enum.

**Data flow**: Matches the requirement variant and returns the runtime equivalent.

**Call relations**: Used by `ConfigRequirements::try_from` when constructing allowed-mode diagnostics and initial constrained values.


##### `WebSearchModeRequirement::fmt`  (lines 696–702)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a requirements web-search mode as the lowercase TOML token.

**Data flow**: Matches the enum variant and writes `disabled`, `cached`, or `live` to the formatter.

**Call relations**: Supports readable diagnostics and serialization-adjacent output for web-search requirement values.

*Call graph*: 1 external calls (write!).


##### `ComputerUseRequirementsToml::is_empty`  (lines 711–713)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether the computer-use requirements block contains any configured restriction.

**Data flow**: Returns true when `allow_locked_computer_use` is `None`.

**Call relations**: Used by `ConfigRequirementsToml::is_empty` so an empty nested table does not count as configured requirements.


##### `WindowsRequirementsToml::is_empty`  (lines 722–724)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether the Windows-specific requirements block is empty.

**Data flow**: Returns true when `allowed_sandbox_implementations` is `None`.

**Call relations**: Participates in top-level emptiness checks before requirements are compiled.


##### `FeatureRequirementsToml::is_empty`  (lines 734–736)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any managed feature flags were specified.

**Data flow**: Returns `self.entries.is_empty()`.

**Call relations**: Used both in top-level emptiness checks and in `ConfigRequirements::try_from`, which drops empty feature maps.


##### `AppToolRequirementToml::is_empty`  (lines 745–747)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether an app-tool requirement contains any approval override.

**Data flow**: Returns true when `approval_mode` is `None`.

**Call relations**: Used by app-level emptiness checks so structurally present but blank tool entries do not count as meaningful requirements.


##### `AppToolsRequirementsToml::is_empty`  (lines 757–759)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether all tool requirement entries are empty.

**Data flow**: Iterates `self.tools.values()` and returns true only if every `AppToolRequirementToml` is empty.

**Call relations**: Used by `AppRequirementToml::is_empty` and top-level emptiness logic.


##### `AppRequirementToml::is_empty`  (lines 769–775)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether an app requirement has neither an `enabled` setting nor any non-empty tool requirements.

**Data flow**: Returns true when `enabled` is `None` and `tools` is absent or empty according to `AppToolsRequirementsToml::is_empty`.

**Call relations**: Used by `AppsRequirementsToml::is_empty` and by top-level emptiness checks.


##### `AppsRequirementsToml::is_empty`  (lines 785–787)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether every app entry is effectively empty.

**Data flow**: Iterates all app requirement values and returns true only if each `AppRequirementToml` is empty.

**Call relations**: Used by `ConfigRequirementsToml::is_empty` and merge tests to distinguish meaningful app restrictions from empty placeholders.


##### `merge_app_requirements_descending`  (lines 793–819)

```
fn merge_app_requirements_descending(
    base: &mut AppsRequirementsToml,
    incoming: AppsRequirementsToml,
)
```

**Purpose**: Merges lower-precedence app requirements into an existing higher-precedence set using special semantics: any explicit disable wins across layers, while higher-precedence tool approval modes are retained when already set.

**Data flow**: Mutates `base: &mut AppsRequirementsToml` by iterating incoming apps. For each app, it merges `enabled` so `Some(false)` dominates from either side, otherwise prefers higher precedence then lower. For tools, it creates missing app/tool entries and copies `approval_mode` only when the higher-precedence tool has none.

**Call relations**: Called from `ConfigRequirementsWithSources::merge_unset_fields` for the one field that does not follow simple fill-if-missing semantics. This preserves enforcement-oriented disablement across layered managed sources while still respecting higher-priority exact tool approvals.

*Call graph*: called by 8 (merge_unset_fields, merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset, merge_app_requirements_descending_prefers_false_from_lower_precedence, merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app, merge_app_requirements_descending_preserves_higher_tool_approval_mode, merge_app_requirements_descending_unions_distinct_apps, merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing, merge_app_requirements_descending_uses_lower_value_when_higher_missing).


##### `Sourced::new`  (lines 865–867)

```
fn new(value: T, source: RequirementSource) -> Self
```

**Purpose**: Constructs a value paired with the requirement source it came from.

**Data flow**: Accepts a value `T` and a `RequirementSource`, stores them unchanged, and returns `Sourced<T>`.

**Call relations**: Used throughout merge and normalization code whenever a raw or normalized requirement field must retain provenance for later diagnostics.

*Call graph*: called by 21 (try_from, merge_unset_fields, merge, apply_to, merge, populate_merged_regular_fields_with_sources, resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin (+11 more)).


##### `Sourced::deref`  (lines 873–875)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Provides shared-reference access to the wrapped value inside `Sourced<T>`.

**Data flow**: Returns `&self.value`.

**Call relations**: Enables ergonomic use of sourced values without repeatedly naming the `value` field.


##### `ConfigRequirementsWithSources::merge_unset_fields`  (lines 904–989)

```
fn merge_unset_fields(&mut self, source: RequirementSource, other: ConfigRequirementsToml)
```

**Purpose**: Merges one raw requirements layer into an accumulated sourced structure, filling only fields that are still unset and tagging copied values with the incoming source. It also trims blank guardian policy text and performs special app merging.

**Data flow**: Consumes a `RequirementSource` and `ConfigRequirementsToml`. After a destructuring guard that forces maintenance when fields are added, it normalizes blank `guardian_policy_config` to `None`, uses the `fill_missing_take!` macro to move each `Some` field into `self` only when the destination is `None`, and separately merges `apps` via `merge_app_requirements_descending` if both sides have app data.

**Call relations**: This is the main layer-composition routine used before final compilation. Higher-precedence callers invoke it first so later lower-precedence layers only backfill missing fields, except for app disablement/tool merging which intentionally combines across layers.

*Call graph*: calls 2 internal fn (new, merge_app_requirements_descending); 1 external calls (fill_missing_take!).


##### `ConfigRequirementsWithSources::into_toml`  (lines 991–1039)

```
fn into_toml(self) -> ConfigRequirementsToml
```

**Purpose**: Drops provenance wrappers and reconstructs a plain `ConfigRequirementsToml` from the sourced intermediate form.

**Data flow**: Consumes `self`, maps each `Option<Sourced<T>>` to `Option<T>`, explicitly sets `remote_sandbox_config` to `None`, and returns a new `ConfigRequirementsToml` with the unwrapped values.

**Call relations**: Used when callers need the merged raw requirements shape again after source-aware layering, without carrying provenance metadata forward.


##### `normalize_hostname`  (lines 1042–1045)

```
fn normalize_hostname(hostname: &str) -> Option<String>
```

**Purpose**: Normalizes a hostname for remote-sandbox matching by trimming whitespace, removing a trailing dot, rejecting empties, and lowercasing ASCII.

**Data flow**: Reads `&str`, applies trim and `trim_end_matches('.')`, and returns `Some(lowercased)` unless the result is empty.

**Call relations**: Used by hostname-pattern matching and remote-sandbox override application so matching is case-insensitive and tolerant of FQDN trailing dots.


##### `hostname_matches_any_pattern`  (lines 1047–1053)

```
fn hostname_matches_any_pattern(hostname: &str, patterns: &[String]) -> bool
```

**Purpose**: Checks whether a normalized hostname matches any configured wildcard pattern using case-insensitive wildmatch semantics.

**Data flow**: Iterates the pattern strings, normalizes each with `normalize_hostname`, constructs a `WildMatchPattern<'*','?'>` for valid patterns, and returns true if any pattern matches the provided hostname.

**Call relations**: Called by `ConfigRequirementsToml::apply_remote_sandbox_config` to select the first remote-sandbox override whose hostname patterns match the current host.


##### `SandboxModeRequirement::from`  (lines 1073–1079)

```
fn from(mode: SandboxMode) -> Self
```

**Purpose**: Converts a runtime `SandboxMode` into the requirements-layer sandbox enum.

**Data flow**: Matches `SandboxMode::{ReadOnly, WorkspaceWrite, DangerFullAccess}` and returns the corresponding `SandboxModeRequirement` variant.

**Call relations**: Used when translating permission profiles or runtime sandbox settings into the requirement vocabulary for validation and diagnostics.


##### `ConfigRequirementsToml::apply_remote_sandbox_config`  (lines 1089–1103)

```
fn apply_remote_sandbox_config(&mut self, hostname: Option<&str>)
```

**Purpose**: Applies the first matching `remote_sandbox_config` entry to override top-level `allowed_sandbox_modes` based on the current hostname.

**Data flow**: Mutably reads `self.remote_sandbox_config`; if absent, hostname missing, hostname normalization fails, or no pattern matches, it returns without changes. On the first matching config, it clones that entry's `allowed_sandbox_modes` into `self.allowed_sandbox_modes`.

**Call relations**: Called during requirements loading before source-aware merging. Because merge logic only fills unset fields, a higher-precedence layer's already-resolved sandbox modes still win over lower-precedence remote overrides.


##### `ConfigRequirementsToml::is_empty`  (lines 1105–1149)

```
fn is_empty(&self) -> bool
```

**Purpose**: Determines whether a raw requirements TOML object contains any meaningful configured requirement. It treats blank nested sections and whitespace-only guardian policy text as empty.

**Data flow**: Checks every field explicitly: scalar options must be `None`, nested structs must be absent or report empty via their own `is_empty` methods, plugin maps must contain only empty plugin entries, and `guardian_policy_config` must be absent or blank after trimming.

**Call relations**: Used by callers and tests to distinguish a truly empty requirements layer from one that merely contains syntactic scaffolding or compatibility-only blank values.


##### `ConfigRequirements::try_from`  (lines 1155–1459)

```
fn try_from(toml: ConfigRequirementsWithSources) -> Result<Self, Self::Error>
```

**Purpose**: Compiles merged raw requirements with provenance into the normalized runtime `ConfigRequirements` object. It turns allowlists and exact requirements into active `Constrained` validators, validates required non-empty lists, converts execution rules, and preserves sourced non-constrained sections.

**Data flow**: Consumes `ConfigRequirementsWithSources`, destructures fields, and builds each normalized field separately. Approval policies and reviewers require non-empty allowlists and use the first entry as the initial value. Sandbox-mode requirements constrain `PermissionProfile` by mapping candidate profiles through `sandbox_mode_requirement_for_permission_profile`, and reject allowlists that omit `read-only`. Windows sandbox implementations require a non-empty list and prefer `Elevated` as the initial value when allowed. Web-search requirements always add `Disabled` to the accepted set and choose an initial mode preferring `Cached`, then `Live`, then `Disabled`. Managed hooks are dropped if empty, otherwise constrained to exact equality. Residency is constrained to exact equality when present. Rules are parsed into `RequirementsExecPolicy`, with parse failures wrapped in `ConstraintError::ExecPolicyParse` carrying the source. Network and filesystem sections are converted into `NetworkConstraints` and `FilesystemConstraints` while preserving `Sourced` provenance. The function returns either a fully built `ConfigRequirements` or a `ConstraintError`.

**Call relations**: This is the final normalization step after layer merging. Callers invoke it once they have a `ConfigRequirementsWithSources`; downstream runtime config code then uses the resulting `Constrained` fields to validate or reject user/session settings with source-aware errors.

*Call graph*: calls 7 internal fn (new, new, allow_any, allow_any_from_default, new, empty_field, read_only); 1 external calls (format!).


##### `sandbox_mode_requirement_for_permission_profile`  (lines 1462–1483)

```
fn sandbox_mode_requirement_for_permission_profile(
    permission_profile: &PermissionProfile,
) -> SandboxModeRequirement
```

**Purpose**: Infers which sandbox requirement category a concrete `PermissionProfile` corresponds to. Managed profiles are classified by their filesystem write capabilities.

**Data flow**: Reads a `PermissionProfile`. `Disabled` maps to `DangerFullAccess`, `External` maps to `ExternalSandbox`, and `Managed` profiles inspect `file_system_sandbox_policy()`: full-disk write implies `DangerFullAccess`, any writable entry implies `WorkspaceWrite`, otherwise `ReadOnly`.

**Call relations**: Used by `ConfigRequirements::try_from` when enforcing `allowed_sandbox_modes` against candidate permission profiles rather than against raw sandbox-mode enums.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy).


##### `tests::tokens`  (lines 1499–1501)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Builds a `Vec<String>` from a slice of command tokens for exec-policy assertions.

**Data flow**: Maps each `&str` in the input slice to an owned `String` and collects the results.

**Call relations**: Used only by exec-policy tests to create command vectors in the same shape expected by policy evaluation.


##### `tests::system_requirements_toml_file_for_test`  (lines 1503–1507)

```
fn system_requirements_toml_file_for_test() -> Result<AbsolutePathBuf>
```

**Purpose**: Constructs a deterministic temporary absolute path representing a system `requirements.toml` file for provenance assertions.

**Data flow**: Reads `std::env::temp_dir()`, appends `requirements.toml`, converts the path into `AbsolutePathBuf`, and returns it in `anyhow::Result`.

**Call relations**: Shared by tests that need a concrete `RequirementSource::SystemRequirementsToml` value.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (temp_dir).


##### `tests::composite_requirement_source_flattens_and_deduplicates_sources`  (lines 1510–1526)

```
fn composite_requirement_source_flattens_and_deduplicates_sources()
```

**Purpose**: Verifies that composite provenance flattens nested composites and removes duplicate sources while preserving order.

**Data flow**: Constructs MDM and legacy sources, builds a nested composite, and asserts the result equals a flat two-source `Composite`.

**Call relations**: Exercises `RequirementSource::composite` behavior directly.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::with_unknown_source`  (lines 1528–1588)

```
fn with_unknown_source(toml: ConfigRequirementsToml) -> ConfigRequirementsWithSources
```

**Purpose**: Converts a plain `ConfigRequirementsToml` into `ConfigRequirementsWithSources` by wrapping every present field with `RequirementSource::Unknown`.

**Data flow**: Destructures the raw TOML struct, maps each `Option<T>` to `Option<Sourced<T>>` with `Unknown`, and returns the sourced aggregate.

**Call relations**: Used by many tests as a shortcut to feed raw TOML into `ConfigRequirements::try_from` without constructing explicit provenance.


##### `tests::deserialize_allow_managed_hooks_only`  (lines 1591–1601)

```
fn deserialize_allow_managed_hooks_only() -> Result<()>
```

**Purpose**: Checks that `allow_managed_hooks_only = true` deserializes and makes the requirements object non-empty.

**Data flow**: Parses a TOML snippet into `ConfigRequirementsToml`, then asserts the field value and `is_empty()` result.

**Call relations**: Covers a simple scalar requirement field in the raw schema.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::allow_managed_hooks_only_false_is_still_configured`  (lines 1604–1614)

```
fn allow_managed_hooks_only_false_is_still_configured() -> Result<()>
```

**Purpose**: Ensures `allow_managed_hooks_only = false` still counts as an explicit configured requirement rather than being treated as absent.

**Data flow**: Parses TOML, asserts the field is `Some(false)`, and asserts `is_empty()` is false.

**Call relations**: Guards against emptiness logic accidentally dropping explicit false values.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_managed_permission_profiles`  (lines 1617–1659)

```
fn deserialize_managed_permission_profiles() -> Result<()>
```

**Purpose**: Verifies that managed permission-profile catalog fields and nested profile definitions deserialize together correctly.

**Data flow**: Parses TOML containing `default_permissions`, `allowed_permission_profiles`, and `[permissions.*]` tables, then asserts the allowlist map, default profile name, nested profile presence, and non-empty status.

**Call relations**: Covers the raw TOML schema side of managed permission-profile configuration.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_allow_appshots`  (lines 1662–1672)

```
fn deserialize_allow_appshots() -> Result<()>
```

**Purpose**: Checks deserialization of `allow_appshots = true` and confirms it marks the requirements as configured.

**Data flow**: Parses TOML and asserts the field value and non-empty status.

**Call relations**: Simple scalar-field coverage.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::filesystem_requirements_table_cannot_define_a_permission_profile`  (lines 1675–1690)

```
fn filesystem_requirements_table_cannot_define_a_permission_profile()
```

**Purpose**: Ensures the reserved `permissions.filesystem` table rejects profile-style fields such as `extends`.

**Data flow**: Attempts to parse invalid TOML and asserts the resulting error message contains the reserved-table explanation.

**Call relations**: Directly exercises `FilesystemRequirementsToml::deserialize` rejection logic.

*Call graph*: 1 external calls (assert!).


##### `tests::allow_appshots_false_is_still_configured`  (lines 1693–1703)

```
fn allow_appshots_false_is_still_configured() -> Result<()>
```

**Purpose**: Confirms that an explicit false `allow_appshots` value is preserved and not treated as empty.

**Data flow**: Parses TOML, asserts `Some(false)`, and checks `is_empty()` is false.

**Call relations**: Protects emptiness semantics for boolean requirement fields.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::allow_remote_control_false_is_still_configured`  (lines 1706–1716)

```
fn allow_remote_control_false_is_still_configured() -> Result<()>
```

**Purpose**: Checks that `allow_remote_control = false` is retained as an explicit requirement.

**Data flow**: Parses TOML and asserts the field value and non-empty status.

**Call relations**: Another boolean-presence regression test.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_computer_use_requirements`  (lines 1719–1735)

```
fn deserialize_computer_use_requirements() -> Result<()>
```

**Purpose**: Verifies nested `[computer_use]` requirements deserialize into the expected struct and count as configured.

**Data flow**: Parses TOML, asserts the nested struct contents, and checks `is_empty()` is false.

**Call relations**: Covers nested optional requirement-table parsing.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::merge_unset_fields_copies_every_field_and_sets_sources`  (lines 1738–1839)

```
fn merge_unset_fields_copies_every_field_and_sets_sources()
```

**Purpose**: Checks that `merge_unset_fields` copies all supported fields from an incoming layer into an empty target and tags each copied field with the provided source.

**Data flow**: Builds a fully populated `ConfigRequirementsToml`, merges it into a default `ConfigRequirementsWithSources`, and asserts the resulting sourced structure field-by-field.

**Call relations**: Regression test for the explicit field list inside `merge_unset_fields`; adding new fields should force this test to be updated.

*Call graph*: 4 external calls (from, assert_eq!, default, vec!).


##### `tests::merge_unset_fields_fills_missing_values`  (lines 1842–1886)

```
fn merge_unset_fields_fills_missing_values() -> Result<()>
```

**Purpose**: Verifies that a missing field in the target is filled from an incoming layer with the correct source.

**Data flow**: Parses a minimal source TOML, merges it into an empty target, and asserts only the expected sourced field is populated.

**Call relations**: Covers the normal fill-if-missing merge path.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `tests::merge_unset_fields_does_not_overwrite_existing_values`  (lines 1889–1940)

```
fn merge_unset_fields_does_not_overwrite_existing_values() -> Result<()>
```

**Purpose**: Ensures a lower-precedence merge does not replace an already-set field in the target.

**Data flow**: Merges one source setting `allowed_approval_policies`, then merges a second source with a different value, and asserts the original sourced value remains.

**Call relations**: Validates precedence behavior of `merge_unset_fields`.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `tests::merge_unset_fields_ignores_blank_guardian_override`  (lines 1943–1973)

```
fn merge_unset_fields_ignores_blank_guardian_override()
```

**Purpose**: Checks that whitespace-only `guardian_policy_config` values are treated as absent so a later nonblank value can populate the field.

**Data flow**: Merges a blank guardian policy from one source, then a nonblank one from another, and asserts the final sourced value comes from the nonblank source.

**Call relations**: Exercises the special blank-string normalization inside `merge_unset_fields`.

*Call graph*: 4 external calls (default, assert_eq!, default, system_requirements_toml_file_for_test).


##### `tests::deserialize_guardian_policy_config`  (lines 1976–1990)

```
fn deserialize_guardian_policy_config() -> Result<()>
```

**Purpose**: Verifies multiline guardian policy text deserializes exactly, including trailing newline content from TOML literal formatting.

**Data flow**: Parses TOML and asserts the resulting string value.

**Call relations**: Covers raw schema handling for guardian policy text.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::blank_guardian_policy_config_is_empty`  (lines 1993–2004)

```
fn blank_guardian_policy_config_is_empty() -> Result<()>
```

**Purpose**: Ensures a blank multiline guardian policy does not make the requirements object non-empty.

**Data flow**: Parses TOML with whitespace-only guardian policy text and asserts `is_empty()` is true.

**Call relations**: Protects the blank-string emptiness rule.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::allowed_approvals_reviewers_is_not_empty`  (lines 2007–2016)

```
fn allowed_approvals_reviewers_is_not_empty() -> Result<()>
```

**Purpose**: Checks that setting `allowed_approvals_reviewers` makes the raw requirements object non-empty.

**Data flow**: Parses TOML and asserts `is_empty()` is false.

**Call relations**: Simple top-level emptiness coverage.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::deserialize_filesystem_deny_read_requirements`  (lines 2019–2054)

```
fn deserialize_filesystem_deny_read_requirements() -> Result<()>
```

**Purpose**: Verifies absolute-path filesystem deny-read requirements deserialize and survive normalization into sourced `FilesystemConstraints`.

**Data flow**: Builds platform-specific TOML, parses it, converts through `with_unknown_source(...).try_into()`, and asserts the resulting sourced `FilesystemConstraints` contains normalized absolute patterns.

**Call relations**: Exercises raw parsing plus `ConfigRequirements::try_from` filesystem preservation.

*Call graph*: 5 external calls (assert_eq!, cfg!, with_unknown_source, format!, from_str).


##### `tests::deserialize_filesystem_deny_read_glob_requirements`  (lines 2057–2081)

```
fn deserialize_filesystem_deny_read_glob_requirements() -> Result<()>
```

**Purpose**: Checks that glob deny-read patterns are normalized relative to the current absolute-path base and preserved in filesystem constraints.

**Data flow**: Sets an `AbsolutePathBufGuard` to the temp dir, parses TOML with a relative glob, converts to `ConfigRequirements`, and asserts the normalized pattern matches `FilesystemDenyReadPattern::from_input`.

**Call relations**: Covers the glob-specific normalization path in `FilesystemDenyReadPattern::from_input`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, with_unknown_source, temp_dir, from_str).


##### `tests::deserialize_apps_requirements`  (lines 2084–2104)

```
fn deserialize_apps_requirements() -> Result<()>
```

**Purpose**: Verifies app-level `enabled` requirements deserialize into the nested `AppsRequirementsToml` structure.

**Data flow**: Parses TOML with `[apps.connector_123123] enabled = false` and asserts the resulting nested map structure.

**Call relations**: Covers raw app requirement schema.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserialize_apps_tool_requirements`  (lines 2107–2134)

```
fn deserialize_apps_tool_requirements() -> Result<()>
```

**Purpose**: Verifies nested app tool approval requirements deserialize correctly.

**Data flow**: Parses TOML with `[apps.<id>.tools.<tool>] approval_mode = ...` and asserts the nested app/tool map structure.

**Call relations**: Covers raw app-tool requirement schema.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::apps_requirements`  (lines 2136–2151)

```
fn apps_requirements(entries: &[(&str, Option<bool>)]) -> AppsRequirementsToml
```

**Purpose**: Builds a compact `AppsRequirementsToml` fixture from `(app_id, enabled)` pairs.

**Data flow**: Maps the input slice into a `BTreeMap<String, AppRequirementToml>` with `tools: None` and returns the assembled struct.

**Call relations**: Shared helper for app-merge tests.


##### `tests::app_tool_requirements`  (lines 2153–2174)

```
fn app_tool_requirements(
        app_id: &str,
        tool_name: &str,
        approval_mode: AppToolApproval,
    ) -> AppsRequirementsToml
```

**Purpose**: Builds an `AppsRequirementsToml` fixture containing one app with one tool approval requirement.

**Data flow**: Constructs nested `BTreeMap` values for the app, its tools, and the `approval_mode`, then returns the assembled struct.

**Call relations**: Used by tests that focus on tool-level merge semantics.

*Call graph*: 1 external calls (from).


##### `tests::merge_app_requirements_descending_unions_distinct_apps`  (lines 2177–2190)

```
fn merge_app_requirements_descending_unions_distinct_apps()
```

**Purpose**: Checks that merging app requirements preserves distinct apps from both layers.

**Data flow**: Creates separate high- and low-precedence app sets, merges them, and asserts both apps are present afterward.

**Call relations**: Directly exercises `merge_app_requirements_descending` union behavior.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_prefers_false_from_lower_precedence`  (lines 2193–2203)

```
fn merge_app_requirements_descending_prefers_false_from_lower_precedence()
```

**Purpose**: Verifies that a lower-precedence `enabled = false` still disables an app even when the higher-precedence layer said `true`.

**Data flow**: Builds conflicting app fixtures, merges them, and asserts the merged result is `Some(false)`.

**Call relations**: Covers the special disable-wins rule in app merging.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset`  (lines 2206–2216)

```
fn merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset()
```

**Purpose**: Ensures an unset lower-precedence `enabled` value does not disturb a higher-precedence explicit `true`.

**Data flow**: Merges a higher `Some(true)` app with a lower `None` app and asserts the result stays `Some(true)`.

**Call relations**: Covers non-overwriting behavior for app enablement.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_uses_lower_value_when_higher_missing`  (lines 2219–2229)

```
fn merge_app_requirements_descending_uses_lower_value_when_higher_missing()
```

**Purpose**: Checks that a lower-precedence app value is adopted when the higher-precedence layer has no entry for that app.

**Data flow**: Merges an empty base with a lower app fixture and asserts the lower value appears in the result.

**Call relations**: Covers backfill behavior in app merging.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app`  (lines 2232–2242)

```
fn merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app()
```

**Purpose**: Ensures an existing disabled app remains disabled when the incoming lower-precedence layer lacks that app entirely.

**Data flow**: Merges a disabled base app with an empty incoming set and asserts no change.

**Call relations**: Regression coverage for no-op merges.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_preserves_higher_tool_approval_mode`  (lines 2245–2267)

```
fn merge_app_requirements_descending_preserves_higher_tool_approval_mode()
```

**Purpose**: Verifies that an existing higher-precedence tool approval mode is not overwritten by a lower-precedence one.

**Data flow**: Builds conflicting tool approval fixtures, merges them, and asserts the higher-precedence approval remains.

**Call relations**: Covers the tool-level precedence rule in `merge_app_requirements_descending`.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, app_tool_requirements).


##### `tests::merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing`  (lines 2270–2288)

```
fn merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing()
```

**Purpose**: Checks that a lower-precedence tool approval is copied in when the higher-precedence app has no tool-specific approval.

**Data flow**: Merges an app fixture lacking tool approvals with a lower fixture containing one, then asserts the tool approval appears.

**Call relations**: Covers the fill-missing branch for tool approvals.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 3 external calls (assert_eq!, app_tool_requirements, apps_requirements).


##### `tests::merge_unset_fields_merges_apps_across_sources_with_enabled_evaluation`  (lines 2291–2330)

```
fn merge_unset_fields_merges_apps_across_sources_with_enabled_evaluation()
```

**Purpose**: Verifies that `merge_unset_fields` uses app-specific merge semantics across sources and retains the higher-precedence source on the resulting `apps` field.

**Data flow**: Merges a higher-precedence apps layer and then a lower-precedence one with overlapping and distinct apps, then asserts merged enablement values and that the stored source remains the higher source.

**Call relations**: Tests the special `apps` branch inside `merge_unset_fields`.

*Call graph*: 4 external calls (default, assert_eq!, default, apps_requirements).


##### `tests::merge_unset_fields_apps_empty_higher_source_does_not_block_lower_disables`  (lines 2333–2355)

```
fn merge_unset_fields_apps_empty_higher_source_does_not_block_lower_disables()
```

**Purpose**: Ensures an empty higher-precedence `apps` section does not prevent a later lower-precedence disable from taking effect.

**Data flow**: Merges an empty apps set, then a disabling apps set, and asserts the disable is present afterward.

**Call relations**: Covers an edge case where mere presence of an empty apps field should not block meaningful lower-layer data.

*Call graph*: 4 external calls (default, assert_eq!, default, apps_requirements).


##### `tests::constraint_error_includes_requirement_source`  (lines 2358–2409)

```
fn constraint_error_includes_requirement_source() -> Result<()>
```

**Purpose**: Checks that compiled constraints embed the originating requirement source in validation errors for approval policy, permission profile, and approvals reviewer.

**Data flow**: Parses requirements TOML, merges it with a concrete system-file source, compiles `ConfigRequirements`, probes disallowed values with `can_set`, and asserts exact `ConstraintError::InvalidValue` contents.

**Call relations**: Exercises the source-capturing closures created inside `ConfigRequirements::try_from`.

*Call graph*: 5 external calls (try_from, assert_eq!, default, system_requirements_toml_file_for_test, from_str).


##### `tests::constraint_error_includes_composite_requirement_source`  (lines 2412–2442)

```
fn constraint_error_includes_composite_requirement_source() -> Result<()>
```

**Purpose**: Verifies that validation errors preserve a composite provenance value when requirements came from multiple layers.

**Data flow**: Builds a composite source, merges a simple approval-policy requirement, compiles constraints, probes a disallowed value, and asserts the error carries the composite source.

**Call relations**: Confirms `RequirementSource::composite` integrates correctly with compiled constraint errors.

*Call graph*: calls 1 internal fn (composite); 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::constrained_fields_store_requirement_source`  (lines 2445–2489)

```
fn constrained_fields_store_requirement_source() -> Result<()>
```

**Purpose**: Checks that normalized constrained and sourced fields retain their originating source after compilation.

**Data flow**: Parses a multi-field requirements TOML, merges it with a legacy source, compiles `ConfigRequirements`, and asserts the `source` fields on several constrained/sourced outputs.

**Call relations**: Covers provenance propagation through `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::deserialize_allowed_approval_policies`  (lines 2492–2544)

```
fn deserialize_allowed_approval_policies() -> Result<()>
```

**Purpose**: Verifies approval-policy allowlists compile into a constrained value whose initial value is the first allowed entry and whose validator rejects disallowed policies with source-aware errors.

**Data flow**: Parses TOML, wraps with unknown source, compiles requirements, then checks the initial value and several `can_set` outcomes.

**Call relations**: Exercises the approval-policy branch of `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_approvals_reviewers`  (lines 2547–2573)

```
fn deserialize_allowed_approvals_reviewers() -> Result<()>
```

**Purpose**: Checks approvals-reviewer allowlists compile correctly and choose the first allowed reviewer as the initial value.

**Data flow**: Parses TOML, compiles requirements, asserts the initial reviewer, and verifies allowed reviewers pass `can_set`.

**Call relations**: Covers the reviewer branch of `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_windows_sandbox_implementations`  (lines 2576–2603)

```
fn deserialize_allowed_windows_sandbox_implementations() -> Result<()>
```

**Purpose**: Verifies Windows sandbox implementation allowlists compile into a constrained optional mode that accepts only listed implementations and rejects `None`.

**Data flow**: Parses TOML, compiles requirements, asserts the initial value, and probes allowed/disallowed candidates with `can_set`.

**Call relations**: Exercises the Windows-specific branch of `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::empty_allowed_windows_sandbox_implementations_is_rejected`  (lines 2606–2621)

```
fn empty_allowed_windows_sandbox_implementations_is_rejected() -> Result<()>
```

**Purpose**: Ensures an empty Windows sandbox implementation allowlist is rejected as an empty required field.

**Data flow**: Parses TOML, attempts compilation, and asserts the returned `ConstraintError::EmptyField`.

**Call relations**: Covers validation of non-empty Windows implementation lists.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::allowed_windows_sandbox_implementations_prefer_elevated_fallback`  (lines 2624–2638)

```
fn allowed_windows_sandbox_implementations_prefer_elevated_fallback() -> Result<()>
```

**Purpose**: Checks that when both Windows implementations are allowed, the compiled initial value prefers `Elevated`.

**Data flow**: Parses TOML, compiles requirements, and asserts the constrained value is `Some(Elevated)`.

**Call relations**: Covers the initial-value selection rule in the Windows branch.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_legacy_allowed_approvals_reviewer`  (lines 2641–2654)

```
fn deserialize_legacy_allowed_approvals_reviewer() -> Result<()>
```

**Purpose**: Verifies legacy reviewer tokens still deserialize into the modern reviewer enum and compile correctly.

**Data flow**: Parses TOML with legacy reviewer names, compiles requirements, and asserts the resulting initial reviewer.

**Call relations**: Compatibility coverage for reviewer deserialization.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::empty_allowed_approvals_reviewers_is_rejected`  (lines 2657–2673)

```
fn empty_allowed_approvals_reviewers_is_rejected() -> Result<()>
```

**Purpose**: Ensures an empty approvals-reviewer allowlist is rejected during compilation.

**Data flow**: Parses TOML, compiles via `try_from`, captures the error, and asserts it is `ConstraintError::EmptyField` for the correct field.

**Call relations**: Covers non-empty validation for reviewer allowlists.

*Call graph*: 4 external calls (try_from, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_sandbox_modes`  (lines 2676–2728)

```
fn deserialize_allowed_sandbox_modes() -> Result<()>
```

**Purpose**: Verifies sandbox-mode allowlists constrain permission profiles by inferred sandbox category, allowing read-only and workspace-write profiles while rejecting danger-full-access and external profiles.

**Data flow**: Parses TOML, compiles requirements, constructs a workspace-write `PermissionProfile`, and probes several candidate profiles with `can_set`, asserting expected successes and source-aware failures.

**Call relations**: Exercises the permission-profile constraint logic and `sandbox_mode_requirement_for_permission_profile` mapping.

*Call graph*: calls 2 internal fn (workspace_write_with, from_absolute_path); 5 external calls (assert!, assert_eq!, cfg!, with_unknown_source, from_str).


##### `tests::deserialize_remote_sandbox_config_requires_hostname_patterns_list`  (lines 2731–2764)

```
fn deserialize_remote_sandbox_config_requires_hostname_patterns_list() -> Result<()>
```

**Purpose**: Checks that `remote_sandbox_config.hostname_patterns` must be a TOML list and that valid list syntax deserializes correctly.

**Data flow**: Parses a valid TOML snippet and asserts the resulting struct, then parses an invalid string-valued variant and asserts the parse error mentions the wrong type.

**Call relations**: Covers raw schema validation for remote sandbox overrides.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::remote_sandbox_config_first_match_overrides_top_level`  (lines 2767–2824)

```
fn remote_sandbox_config_first_match_overrides_top_level() -> Result<()>
```

**Purpose**: Verifies that applying remote sandbox config uses the first matching hostname-pattern entry to replace top-level allowed sandbox modes before compilation.

**Data flow**: Parses TOML with top-level and multiple remote configs, applies hostname-based override, merges with a source, asserts the chosen allowlist, compiles requirements, and probes resulting permission-profile constraints.

**Call relations**: Exercises `apply_remote_sandbox_config` plus downstream compilation.

*Call graph*: calls 2 internal fn (workspace_write_with, from_absolute_path); 6 external calls (try_from, assert!, assert_eq!, cfg!, default, from_str).


##### `tests::remote_sandbox_config_non_match_preserves_top_level`  (lines 2827–2855)

```
fn remote_sandbox_config_non_match_preserves_top_level() -> Result<()>
```

**Purpose**: Ensures that when no remote sandbox pattern matches, the original top-level sandbox allowlist remains in effect.

**Data flow**: Parses TOML, applies a nonmatching hostname, merges and compiles requirements, then asserts a disallowed profile still fails according to the top-level allowlist.

**Call relations**: Covers the no-match branch of remote sandbox override logic.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::remote_sandbox_config_does_not_override_higher_precedence_sandbox_modes`  (lines 2858–2894)

```
fn remote_sandbox_config_does_not_override_higher_precedence_sandbox_modes() -> Result<()>
```

**Purpose**: Checks that a lower-precedence layer's remote-sandbox-derived allowlist cannot replace an already-set higher-precedence top-level sandbox allowlist.

**Data flow**: Builds high- and low-precedence requirement layers, applies remote sandbox config to both, merges them in precedence order, compiles requirements, and asserts the higher-precedence restriction still governs.

**Call relations**: Demonstrates the interaction between remote override application and `merge_unset_fields` precedence.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::deserialize_allowed_web_search_modes`  (lines 2897–2928)

```
fn deserialize_allowed_web_search_modes() -> Result<()>
```

**Purpose**: Verifies web-search allowlists compile into a constrained mode that always permits `Disabled` and rejects unlisted stronger modes.

**Data flow**: Parses TOML, compiles requirements, asserts the initial mode, and probes `Disabled`, `Live`, and `Cached` with `can_set`.

**Call relations**: Exercises the web-search branch of `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::allowed_web_search_modes_allows_disabled`  (lines 2931–2958)

```
fn allowed_web_search_modes_allows_disabled() -> Result<()>
```

**Purpose**: Checks that an allowlist containing only `disabled` compiles to a constraint that permits only `Disabled`.

**Data flow**: Parses TOML, compiles requirements, asserts the initial mode, and verifies `Cached` is rejected.

**Call relations**: Covers the minimal accepted-set case for web search.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::allowed_web_search_modes_empty_restricts_to_disabled`  (lines 2961–2988)

```
fn allowed_web_search_modes_empty_restricts_to_disabled() -> Result<()>
```

**Purpose**: Ensures an explicitly empty web-search allowlist is interpreted as allowing only `Disabled`, not as an error.

**Data flow**: Parses TOML, compiles requirements, asserts the initial mode is `Disabled`, and verifies `Cached` is rejected.

**Call relations**: Covers the special accepted-set construction that always inserts `Disabled`.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_feature_requirements`  (lines 2991–3014)

```
fn deserialize_feature_requirements() -> Result<()>
```

**Purpose**: Verifies managed feature flags deserialize and are preserved as a sourced feature map after compilation.

**Data flow**: Parses TOML, compiles requirements, and asserts the resulting `feature_requirements` sourced value.

**Call relations**: Exercises feature-map preservation through `ConfigRequirements::try_from`.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_managed_hooks_requirements`  (lines 3017–3040)

```
fn deserialize_managed_hooks_requirements() -> Result<()>
```

**Purpose**: Checks that managed hooks requirements TOML deserializes with directories and hook handlers intact.

**Data flow**: Parses TOML into `ManagedHooksRequirementsToml`, then asserts managed directory fields and handler counts.

**Call relations**: Covers the raw managed-hooks schema used later by requirement compilation.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::merge_unset_fields_does_not_overwrite_existing_hooks`  (lines 3043–3093)

```
fn merge_unset_fields_does_not_overwrite_existing_hooks() -> Result<()>
```

**Purpose**: Ensures a lower-precedence hooks requirement layer does not replace an already-set higher-precedence hooks configuration.

**Data flow**: Merges two hook-bearing requirement layers from different sources and asserts the resulting managed directory and source remain from the first merge.

**Call relations**: Covers ordinary precedence behavior for the `hooks` field in `merge_unset_fields`.

*Call graph*: 3 external calls (assert_eq!, default, system_requirements_toml_file_for_test).


##### `tests::managed_hooks_constraint_rejects_drift`  (lines 3096–3132)

```
fn managed_hooks_constraint_rejects_drift() -> Result<()>
```

**Purpose**: Verifies that compiled managed hooks are constrained to exact equality and reject later mutation to a different hook configuration.

**Data flow**: Parses hook requirements, compiles them, extracts the constrained managed hooks, attempts to `set` a different value, and asserts the resulting `ConstraintError::InvalidValue` carries the expected field and source.

**Call relations**: Exercises the exact-match constraint closure built for managed hooks in `ConfigRequirements::try_from`.

*Call graph*: 5 external calls (assert!, with_unknown_source, default, from, from_str).


##### `tests::network_requirements_are_preserved_as_constraints_with_source`  (lines 3135–3211)

```
fn network_requirements_are_preserved_as_constraints_with_source() -> Result<()>
```

**Purpose**: Checks that canonical managed network requirements survive compilation as sourced `NetworkConstraints` without losing any fields.

**Data flow**: Parses TOML with canonical domain and Unix socket maps, merges with a source, compiles requirements, extracts `network`, and asserts all fields and nested maps.

**Call relations**: Covers network preservation through `NetworkConstraints::from` and `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::legacy_network_requirements_are_preserved_as_constraints_with_source`  (lines 3214–3278)

```
fn legacy_network_requirements_are_preserved_as_constraints_with_source() -> Result<()>
```

**Purpose**: Verifies that legacy network allow/deny list fields are normalized into canonical constraints and preserved with source metadata.

**Data flow**: Parses TOML using legacy fields, merges and compiles requirements, then asserts the resulting canonical domain/socket maps and scalar fields.

**Call relations**: Exercises legacy normalization in `NetworkRequirementsToml::deserialize` plus preservation in `ConfigRequirements::try_from`.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::mixed_legacy_and_canonical_network_requirements_are_rejected`  (lines 3281–3315)

```
fn mixed_legacy_and_canonical_network_requirements_are_rejected()
```

**Purpose**: Ensures network requirements reject mixed use of canonical and legacy domain/socket field shapes.

**Data flow**: Attempts to parse invalid TOML snippets combining `domains` with `allowed_domains` and `unix_sockets` with `allow_unix_sockets`, then asserts the parse errors mention the incompatibility.

**Call relations**: Directly covers the custom validation in `NetworkRequirementsToml::deserialize`.

*Call graph*: 1 external calls (assert!).


##### `tests::network_permission_containers_project_allowed_and_denied_entries`  (lines 3318–3373)

```
fn network_permission_containers_project_allowed_and_denied_entries()
```

**Purpose**: Checks the helper projection methods on canonical network permission containers.

**Data flow**: Constructs domain and socket permission maps in memory, calls `allowed_domains`, `denied_domains`, and `allow_unix_sockets`, and asserts the projected outputs.

**Call relations**: Exercises the convenience methods on `NetworkDomainPermissionsToml` and `NetworkUnixSocketPermissionsToml`.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::deserialize_mcp_server_requirements`  (lines 3376–3412)

```
fn deserialize_mcp_server_requirements() -> Result<()>
```

**Purpose**: Verifies MCP server requirements deserialize into command- and URL-based identities and are preserved as sourced values after compilation.

**Data flow**: Parses TOML, compiles requirements via `with_unknown_source`, and asserts the resulting sourced `mcp_servers` map.

**Call relations**: Covers MCP server requirement schema and preservation.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_plugin_mcp_server_requirements`  (lines 3415–3461)

```
fn deserialize_plugin_mcp_server_requirements() -> Result<()>
```

**Purpose**: Checks plugin-scoped MCP server requirements deserialize and survive compilation.

**Data flow**: Parses TOML with nested plugin MCP server definitions, compiles requirements, and asserts the resulting sourced plugin map.

**Call relations**: Covers plugin requirement schema and preservation.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_exec_policy_requirements`  (lines 3464–3491)

```
fn deserialize_exec_policy_requirements() -> Result<()>
```

**Purpose**: Verifies managed execution rules compile into an executable policy that enforces the configured decision.

**Data flow**: Parses TOML with a prefix rule, compiles requirements, extracts the `exec_policy`, evaluates a tokenized command, and asserts the resulting `Evaluation` and matched rule.

**Call relations**: Exercises the rules-to-policy conversion path in `ConfigRequirements::try_from`.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::exec_policy_error_includes_requirement_source`  (lines 3494–3521)

```
fn exec_policy_error_includes_requirement_source() -> Result<()>
```

**Purpose**: Ensures parse failures while compiling managed execution rules are wrapped in `ConstraintError::ExecPolicyParse` with the originating source.

**Data flow**: Parses invalid rules TOML, merges it with a concrete system-file source, attempts compilation, and asserts the exact error value.

**Call relations**: Covers the error-mapping branch for `RequirementsExecPolicyToml::to_requirements_policy()` inside `ConfigRequirements::try_from`.

*Call graph*: 5 external calls (try_from, assert_eq!, default, system_requirements_toml_file_for_test, from_str).


### `config/src/requirements_layers/layer.rs`

`orchestration` · `requirements layer ingestion before composition`

This file defines the boundary between raw layer inputs and the composition engine. `RequirementsLayerEntry` is the public input type: it stores a `RequirementSource`, either raw TOML text or a prebuilt `toml::Value`, and an optional `AbsolutePathBuf` base directory used while parsing. The helper constructors let callers build entries from strings or values, and `with_base_dir` attaches path context for relative-path resolution under an `AbsolutePathBufGuard`.

The internal `ComposableRequirementsLayer` is what the stack actually merges. `from_entry` parses the same source twice: once into a generic `TomlValue` (`parse_layer_toml`) for ordinary TOML merging, and once into `ConfigRequirementsToml` (`parse_layer_requirements`) so typed requirement-specific transformations can run. If the layer contains `remote_sandbox_config`, hostname resolution is invoked lazily through the supplied callback; the selected sandbox result is applied to the typed requirements before being written back into the generic TOML via `materialize_remote_sandbox_config`, which removes `remote_sandbox_config` and inserts the computed `allowed_sandbox_modes` when present.

Finally, `strip_special_fields` removes fields that are merged elsewhere with custom semantics: `rules`, `hooks`, and `permissions.filesystem.deny_read`. The resulting `regular_toml` contains only fields safe for generic TOML merge, while `domain_fields` carries the extracted `rules`, `hooks`, and `permissions` fragments for specialized mergers. Recursive cleanup in `remove_nested_field_and_prune_empty` ensures stripping `deny_read` does not leave empty intermediate tables behind.

#### Function details

##### `RequirementsLayerEntry::from_toml`  (lines 19–25)

```
fn from_toml(source: RequirementSource, contents: impl Into<String>) -> Self
```

**Purpose**: Builds a layer entry from raw TOML text and a source descriptor. The contents are stored lazily as a string until parsing time.

**Data flow**: Takes a `RequirementSource` and any `contents` convertible into `String`, converts the contents, stores them as `RequirementsLayerToml::String`, sets `base_dir` to `None`, and returns `RequirementsLayerEntry`.

**Call relations**: Used by requirements-loading code and tests to create layer inputs from textual TOML before they are normalized by `ComposableRequirementsLayer::from_entry`.

*Call graph*: called by 2 (load_requirements_toml, layer); 2 external calls (into, String).


##### `RequirementsLayerEntry::from_toml_value`  (lines 27–33)

```
fn from_toml_value(source: RequirementSource, value: TomlValue) -> Self
```

**Purpose**: Builds a layer entry from an already-parsed `toml::Value`. This avoids reparsing when a caller already has structured TOML.

**Data flow**: Takes a `RequirementSource` and `TomlValue`, stores the value as `RequirementsLayerToml::Value`, leaves `base_dir` unset, and returns the entry.

**Call relations**: Called by legacy requirements-loading paths that synthesize TOML values directly before handing them to the composition stack.

*Call graph*: called by 1 (requirements_layers_from_legacy_scheme); 1 external calls (Value).


##### `RequirementsLayerEntry::with_base_dir`  (lines 35–38)

```
fn with_base_dir(mut self, base_dir: AbsolutePathBuf) -> Self
```

**Purpose**: Attaches a base directory to a layer entry so parsing and path resolution can occur relative to that directory. It follows a builder-style API.

**Data flow**: Consumes `self`, writes `Some(base_dir)` into the `base_dir` field, and returns the updated entry.

**Call relations**: Used by callers preparing layer entries before they are parsed by `ComposableRequirementsLayer::from_entry`.


##### `ComposableRequirementsLayer::from_entry`  (lines 55–92)

```
fn from_entry(
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<Self, RequirementsCompositionError>
```

**Purpose**: Parses and normalizes one raw layer into the split representation used by the composition stack. It evaluates per-layer remote sandbox selectors and removes fields that require custom merge logic.

**Data flow**: Consumes a `RequirementsLayerEntry` and a hostname resolver callback. It destructures the entry, optionally installs an `AbsolutePathBufGuard` from `base_dir`, parses generic TOML with `parse_layer_toml`, parses typed requirements with `parse_layer_requirements`, lazily resolves a hostname only if `requirements.remote_sandbox_config` is present, applies remote sandbox selection to the typed requirements, writes the resulting `allowed_sandbox_modes` back into `regular_toml` via `materialize_remote_sandbox_config`, strips `rules`, `hooks`, and `permissions.filesystem.deny_read` from `regular_toml`, and returns a `ComposableRequirementsLayer` containing the source, cleaned TOML, and extracted domain fields.

**Call relations**: Called by `RequirementsLayerStack::add_layer` for every incoming layer. It orchestrates all parsing and normalization helpers in this file.

*Call graph*: calls 4 internal fn (materialize_remote_sandbox_config, parse_layer_requirements, parse_layer_toml, strip_special_fields); called by 1 (add_layer).


##### `parse_layer_toml`  (lines 102–117)

```
fn parse_layer_toml(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<TomlValue, RequirementsCompositionError>
```

**Purpose**: Obtains a generic `toml::Value` view of a layer for ordinary TOML merging. It preserves parse errors with the originating layer source.

**Data flow**: Reads a `RequirementsLayerToml` and `RequirementSource`. For `String`, it parses with `toml::from_str`; for `Value`, it clones the existing value. Parse failures are converted into `RequirementsCompositionError::Parse { layer_source, message }`.

**Call relations**: Used by `ComposableRequirementsLayer::from_entry` to produce the `regular_toml` branch of the normalized layer.

*Call graph*: called by 1 (from_entry); 1 external calls (from_str).


##### `parse_layer_requirements`  (lines 119–141)

```
fn parse_layer_requirements(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<ConfigRequirementsToml, RequirementsCompositionError>
```

**Purpose**: Parses a layer into the typed `ConfigRequirementsToml` structure so requirements-specific transformations can run. It mirrors `parse_layer_toml` but targets the typed schema.

**Data flow**: Accepts a `RequirementsLayerToml` and source. For `String`, it deserializes directly with `toml::from_str`; for `Value`, it clones and `try_into()`s `ConfigRequirementsToml`. Any deserialization error becomes `RequirementsCompositionError::Parse` with the layer source attached.

**Call relations**: Called by `ComposableRequirementsLayer::from_entry` alongside `parse_layer_toml`; the typed result feeds remote sandbox evaluation and extraction of special domain fields.

*Call graph*: called by 1 (from_entry); 1 external calls (from_str).


##### `materialize_remote_sandbox_config`  (lines 143–159)

```
fn materialize_remote_sandbox_config(
    layer_toml: &mut TomlValue,
    requirements: &ConfigRequirementsToml,
) -> Result<(), RequirementsCompositionError>
```

**Purpose**: Rewrites the generic TOML view after typed remote sandbox evaluation. It removes the selector block and inserts the computed `allowed_sandbox_modes` when one was produced.

**Data flow**: Mutably reads and edits `layer_toml`: first removes the top-level `remote_sandbox_config` field, then checks `requirements.allowed_sandbox_modes`. If absent, it returns early. If present and `layer_toml` is a table, it serializes the value with `toml_value_from_serializable` and inserts it under `allowed_sandbox_modes`. Serialization failures become `RequirementsCompositionError::ComposedParse`.

**Call relations**: Invoked by `ComposableRequirementsLayer::from_entry` after `apply_remote_sandbox_config` so the regular TOML merge sees the already-resolved sandbox modes instead of the selector syntax.

*Call graph*: calls 2 internal fn (remove_top_level_field, toml_value_from_serializable); called by 1 (from_entry); 1 external calls (as_table_mut).


##### `toml_value_from_serializable`  (lines 161–167)

```
fn toml_value_from_serializable(
    value: T,
) -> Result<TomlValue, RequirementsCompositionError>
```

**Purpose**: Converts an arbitrary serializable Rust value into `toml::Value` while mapping conversion failures into the composition error type. It is a small adapter around `TomlValue::try_from`.

**Data flow**: Consumes a serializable `value`, attempts `TomlValue::try_from(value)`, and returns either the TOML value or `RequirementsCompositionError::ComposedParse { message }`.

**Call relations**: Used only by `materialize_remote_sandbox_config` when reinserting computed typed data into the generic TOML tree.

*Call graph*: called by 1 (materialize_remote_sandbox_config); 1 external calls (try_from).


##### `strip_special_fields`  (lines 169–173)

```
fn strip_special_fields(layer_toml: &mut TomlValue)
```

**Purpose**: Removes fields from the generic TOML tree that are merged by custom domain-specific logic elsewhere. This prevents them from being merged twice with incompatible semantics.

**Data flow**: Mutably edits `layer_toml` by removing top-level `rules`, top-level `hooks`, and nested `permissions.filesystem.deny_read`; if nested tables become empty, cleanup is delegated to `remove_nested_field_and_prune_empty`.

**Call relations**: Called by `ComposableRequirementsLayer::from_entry` just before returning the normalized layer.

*Call graph*: calls 2 internal fn (remove_nested_field_and_prune_empty, remove_top_level_field); called by 1 (from_entry).


##### `remove_top_level_field`  (lines 175–177)

```
fn remove_top_level_field(value: &mut TomlValue, key: &str) -> Option<TomlValue>
```

**Purpose**: Deletes a named top-level key from a TOML table if present. It is a tiny helper used by field-stripping code.

**Data flow**: Takes `&mut TomlValue` and a key string, obtains the table with `as_table_mut()`, removes the key if possible, and returns the removed `Option<TomlValue>`.

**Call relations**: Used by both `materialize_remote_sandbox_config` and `strip_special_fields` to remove top-level special fields.

*Call graph*: called by 2 (materialize_remote_sandbox_config, strip_special_fields); 1 external calls (as_table_mut).


##### `remove_nested_field_and_prune_empty`  (lines 179–197)

```
fn remove_nested_field_and_prune_empty(value: &mut TomlValue, path: &[&str]) -> Option<TomlValue>
```

**Purpose**: Recursively removes a nested TOML field and deletes any now-empty intermediate tables on the way back out. This keeps the regular TOML tree free of empty `permissions`/`filesystem` shells after stripping `deny_read`.

**Data flow**: Accepts `&mut TomlValue` and a path slice. It descends through table nodes using the path, removes the terminal key when reached, then checks whether the child table at the current level became empty and removes that table too. It returns the removed nested value if one existed.

**Call relations**: Called by `strip_special_fields` for `permissions.filesystem.deny_read`; it encapsulates the recursive cleanup logic.

*Call graph*: called by 1 (strip_special_fields); 1 external calls (as_table_mut).


### Field-specific merge policies
These files implement the special per-field composition rules that override ordinary TOML merging when stacking requirement layers.

### `config/src/requirements_layers/permissions.rs`

`domain_logic` · `requirements layer composition`

This file isolates the one permissions field that does not follow ordinary TOML precedence. `DenyReadMergeState` accumulates a deduplicated `Vec<FilesystemDenyReadPattern>` plus optional source metadata while the stack walks layers from highest to lowest priority. The `merge` method extracts only `incoming.filesystem.deny_read`, ignoring all other permission content and skipping absent or empty lists. Each pattern is appended only if it is not already present, preserving the first-seen order—which, because the stack iterates in reverse, means higher-priority layers appear earlier in the final list. Whenever a new pattern is accepted, `merge_source` updates the aggregate source, combining multiple contributors with `merge_output_source`.

After all layers have been scanned, `apply_to` writes the accumulated deny-read union back into the composed permissions output. If there is no existing permissions block, it constructs a minimal `PermissionsRequirementsToml` containing only `filesystem.deny_read` and default `profiles`. If permissions already exist from the regular TOML merge path, it creates missing `filesystem` or `deny_read` containers as needed and appends any patterns not already present. Source metadata is preserved carefully: a single contributing source is kept as-is, while differing sources are collapsed into `RequirementSource::composite`. The implementation also avoids leaving empty permissions tables behind by returning early when no deny-read patterns were accumulated.

#### Function details

##### `DenyReadMergeState::merge`  (lines 20–39)

```
fn merge(
        &mut self,
        incoming: Option<PermissionsRequirementsToml>,
        source: &RequirementSource,
    )
```

**Purpose**: Extracts and accumulates deny-read filesystem patterns from one layer's permissions block. It ignores all other permission fields and deduplicates patterns across layers.

**Data flow**: Takes mutable `self`, an optional `PermissionsRequirementsToml`, and the layer `RequirementSource`. It drills down through `permissions.filesystem.deny_read`, filters out missing or empty vectors, then iterates each pattern; unseen patterns are pushed into `self.deny_read` and trigger `self.merge_source(source)`. It returns no value and mutates only the accumulator.

**Call relations**: Called from `RequirementsLayerStack::compose` while scanning layers high-to-low, so the first occurrence of a pattern reflects the highest-priority layer.

*Call graph*: calls 1 internal fn (merge_source).


##### `DenyReadMergeState::apply_to`  (lines 41–73)

```
fn apply_to(self, target: &mut Option<Sourced<PermissionsRequirementsToml>>)
```

**Purpose**: Writes the accumulated deny-read union into the composed permissions output. It either creates a minimal permissions structure or augments an existing one from the regular TOML merge path.

**Data flow**: Consumes `self` and mutably updates `target: &mut Option<Sourced<PermissionsRequirementsToml>>`. If `self.deny_read` is empty, it returns immediately. Otherwise it chooses a source, defaulting to `RequirementSource::Unknown` if none was recorded. If `target` is `None`, it creates a new `Sourced<PermissionsRequirementsToml>` with `filesystem.deny_read = Some(self.deny_read)` and default `profiles`. If `target` already exists, it ensures `filesystem` and `deny_read` containers exist, appends any missing patterns, and if the existing source differs from the accumulated source, replaces it with `RequirementSource::composite([existing.source.clone(), source])`.

**Call relations**: Invoked once at the end of `RequirementsLayerStack::compose` after regular TOML fields and other domain-specific fields have been merged.

*Call graph*: calls 2 internal fn (composite, new); 1 external calls (default).


##### `DenyReadMergeState::merge_source`  (lines 75–81)

```
fn merge_source(&mut self, source: &RequirementSource)
```

**Purpose**: Accumulates source provenance for deny-read patterns as multiple layers contribute unique entries. The first source is stored directly; later distinct sources are merged into a composite source.

**Data flow**: Takes `&mut self` and `&RequirementSource`. If `self.source` is empty, it clones and stores the incoming source. Otherwise it mutates the existing source in place via `merge_output_source`.

**Call relations**: Called internally by `DenyReadMergeState::merge` only when a new pattern is actually added, so provenance reflects contributing layers rather than merely inspected ones.

*Call graph*: calls 1 internal fn (merge_output_source); called by 1 (merge); 1 external calls (clone).


### `config/src/requirements_layers/hooks.rs`

`domain_logic` · `requirements layer composition`

This file contains the domain-specific merger for `ManagedHooksRequirementsToml`, which cannot be composed correctly by plain TOML replacement. `HookDirectoryField` identifies the two singleton directory fields, `managed_dir` and `windows_managed_dir`, and provides helpers to choose the active field for the current build target, name fields for diagnostics, and flip to the inactive platform field.

`HookMergeState` carries two pieces of state across layer composition: which directory field is active for this run, and a `BTreeMap<HookDirectoryField, RequirementSource>` recording where each singleton directory value first came from. Its `merge` method ignores absent or logically empty incoming hook blocks, initializes the target on first non-empty input, and otherwise merges three categories separately. For the active platform directory, it extracts the incoming value with `take_hook_dir` and calls `merge_active_singleton`, which fails closed with `composition_conflict` if two different active directories are supplied by different layers. For the inactive platform directory, `fill_singleton` only writes the first seen value and never errors on later disagreement. Hook event groups are merged by `append_hook_events`, which destructures `HookEventsToml` without `..` so adding a new event type forces an explicit merge-policy decision. Each event vector is appended via `append_vec`, preserving high-priority-first ordering because the stack processes layers in reverse. Whenever any part changes, `merge_output_source` updates the composed source metadata.

#### Function details

##### `HookDirectoryField::current_platform`  (lines 25–31)

```
fn current_platform() -> Self
```

**Purpose**: Selects which managed hook directory field is considered active on the current target platform. Non-Windows builds use `ManagedDir`; Windows builds use `WindowsManagedDir`.

**Data flow**: Reads the compile-time `cfg!(windows)` condition and returns the corresponding `HookDirectoryField` variant. It does not touch external state.

**Call relations**: Called by composition entrypoints to initialize hook merging with the correct active singleton field for the current platform.

*Call graph*: called by 2 (compose_requirements_for_hostname, compose_requirements_with_hostname_resolver); 1 external calls (cfg!).


##### `HookDirectoryField::field_name`  (lines 33–38)

```
fn field_name(self) -> &'static str
```

**Purpose**: Returns the TOML field path string used in conflict diagnostics for a directory field. The strings match the user-visible requirements keys.

**Data flow**: Consumes `self` by value, matches the enum variant, and returns a static `&'static str` such as `hooks.managed_dir` or `hooks.windows_managed_dir`.

**Call relations**: Used by `HookMergeState::merge_active_singleton` when constructing a `RequirementsCompositionError::Conflict` message.

*Call graph*: called by 1 (merge_active_singleton).


##### `HookDirectoryField::inactive`  (lines 40–45)

```
fn inactive(self) -> Self
```

**Purpose**: Computes the opposite platform-specific directory field. This lets the merger treat one field as active and the other as passive fill-only state.

**Data flow**: Consumes `self`, matches the variant, and returns the other `HookDirectoryField`.

**Call relations**: Called inside `HookMergeState::merge` to split incoming hook directories into active and inactive merge paths.


##### `HookMergeState::new`  (lines 54–59)

```
fn new(directory_field: HookDirectoryField) -> Self
```

**Purpose**: Creates a fresh hook merge accumulator for a composition run. It starts with no remembered directory sources.

**Data flow**: Takes the chosen active `HookDirectoryField`, stores it, initializes `dir_sources` as an empty `BTreeMap`, and returns `HookMergeState`.

**Call relations**: Constructed by the requirements stack before iterating layers so all hook-specific state lives in one accumulator.

*Call graph*: called by 1 (compose); 1 external calls (new).


##### `HookMergeState::merge`  (lines 61–107)

```
fn merge(
        &mut self,
        target: &mut Option<Sourced<ManagedHooksRequirementsToml>>,
        incoming: Option<ManagedHooksRequirementsToml>,
        source: &RequirementSource,
    ) -> Re
```

**Purpose**: Merges one layer's optional hook requirements into the accumulated hook output. It applies append semantics to event groups, conflict detection to the active managed directory, and first-fill semantics to the inactive directory.

**Data flow**: Accepts mutable access to the composed `target`, an optional incoming `ManagedHooksRequirementsToml`, and the incoming `RequirementSource`. It drops `None` or `is_empty()` inputs. On the first non-empty layer, it records sources for any singleton directories with `track_singleton_source` and stores the whole incoming value in `target` as `Sourced`. For subsequent layers, it computes active/inactive fields, removes those directory values from `incoming` via `take_hook_dir`, merges the active one with `merge_active_singleton`, fills the inactive one with `fill_singleton`, appends each hook event vector with `append_hook_events`, and if anything changed updates `existing.source` through `merge_output_source`. It returns `Ok(())` on success or a composition conflict error when active directories disagree.

**Call relations**: Called from `RequirementsLayerStack::compose` while processing layers high-to-low. It orchestrates all helper functions in this file and is the only path that can emit hook-specific composition conflicts.

*Call graph*: calls 8 internal fn (new, fill_singleton, merge_active_singleton, track_singleton_source, append_hook_events, hook_dir_mut, take_hook_dir, merge_output_source); 1 external calls (clone).


##### `HookMergeState::track_singleton_source`  (lines 109–120)

```
fn track_singleton_source(
        &mut self,
        field: HookDirectoryField,
        value: &Option<PathBuf>,
        source: &RequirementSource,
    )
```

**Purpose**: Records the source of a singleton hook directory field the first time a non-`None` value is seen. This source is later used to explain conflicts accurately.

**Data flow**: Reads `value`; if it is `Some`, inserts `source.clone()` into `dir_sources` for the given field only when no source is already present. It mutates the internal source map but not the hook values themselves.

**Call relations**: Used during the first-layer initialization path in `merge` so later active-directory conflicts can cite the original provider.

*Call graph*: called by 1 (merge).


##### `HookMergeState::merge_active_singleton`  (lines 122–160)

```
fn merge_active_singleton(
        &mut self,
        field: HookDirectoryField,
        existing: &mut Option<PathBuf>,
        incoming: Option<PathBuf>,
        incoming_source: &RequirementSource,
```

**Purpose**: Merges the active platform's managed hook directory with fail-closed semantics. Different non-empty values from different layers are treated as an error rather than allowing one to silently override the other.

**Data flow**: Takes the field identifier, mutable reference to the existing `Option<PathBuf>`, an incoming `Option<PathBuf>`, and the incoming source. If incoming is `None`, it returns `Ok(false)`. If both existing and incoming are present and unequal, it looks up the original source from `dir_sources` (falling back to the incoming source if absent) and returns `Err(composition_conflict(...))` with the field name and both paths in the message. If the values are equal it returns `Ok(false)`. If no existing value is set, it writes the incoming path, records the source in `dir_sources`, and returns `Ok(true)`.

**Call relations**: Invoked only by `HookMergeState::merge` for the currently active directory field; it delegates error construction to `composition_conflict`.

*Call graph*: calls 2 internal fn (field_name, composition_conflict); called by 1 (merge); 2 external calls (clone, format!).


##### `HookMergeState::fill_singleton`  (lines 162–180)

```
fn fill_singleton(
        &mut self,
        field: HookDirectoryField,
        existing: &mut Option<PathBuf>,
        incoming: Option<PathBuf>,
        incoming_source: &RequirementSource,
    ) -
```

**Purpose**: Applies first-fill semantics for the inactive platform's managed hook directory. Later conflicting values are ignored rather than causing composition failure.

**Data flow**: Receives the field, mutable existing `Option<PathBuf>`, incoming `Option<PathBuf>`, and source. If `existing` is `None` and `incoming` is `Some`, it stores the path, records the source in `dir_sources`, and returns `true`; otherwise it leaves state unchanged and returns `false`.

**Call relations**: Called by `HookMergeState::merge` for the inactive directory field so a single layer stack can carry both OS-specific directories without cross-platform conflicts.

*Call graph*: called by 1 (merge).


##### `take_hook_dir`  (lines 183–191)

```
fn take_hook_dir(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> Option<PathBuf>
```

**Purpose**: Extracts one managed-directory field from a mutable `ManagedHooksRequirementsToml`, leaving `None` behind. This lets directory values be merged separately from event vectors.

**Data flow**: Takes `&mut ManagedHooksRequirementsToml` and a `HookDirectoryField`, matches the field, calls `.take()` on the corresponding `Option<PathBuf>`, and returns the removed value.

**Call relations**: Used by `HookMergeState::merge` before merging singleton directories so the remaining `incoming.hooks` can be appended independently.

*Call graph*: called by 1 (merge).


##### `hook_dir_mut`  (lines 193–201)

```
fn hook_dir_mut(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> &mut Option<PathBuf>
```

**Purpose**: Returns a mutable reference to one managed-directory slot inside `ManagedHooksRequirementsToml`. It provides field selection without duplicating match logic at call sites.

**Data flow**: Accepts `&mut ManagedHooksRequirementsToml` and a `HookDirectoryField`, matches the field, and returns `&mut Option<PathBuf>` for the chosen directory member.

**Call relations**: Called by `HookMergeState::merge` to hand the correct existing directory slot to `merge_active_singleton` or `fill_singleton`.

*Call graph*: called by 1 (merge).


##### `append_hook_events`  (lines 203–231)

```
fn append_hook_events(existing: &mut HookEventsToml, incoming: HookEventsToml) -> bool
```

**Purpose**: Appends every hook event group from one `HookEventsToml` into another and reports whether anything changed. The explicit destructuring forces future event additions to choose merge behavior intentionally.

**Data flow**: Consumes `incoming: HookEventsToml`, destructures all event vectors (`pre_tool_use`, `permission_request`, `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop`), appends each into the corresponding vector in `existing` via `append_vec`, ORs the per-field change flags, and returns a final `bool`.

**Call relations**: Used by `HookMergeState::merge` after singleton directories are handled, so event groups always compose additively.

*Call graph*: calls 1 internal fn (append_vec); called by 1 (merge).


##### `append_vec`  (lines 233–237)

```
fn append_vec(existing: &mut Vec<T>, mut incoming: Vec<T>) -> bool
```

**Purpose**: Moves all items from one vector into another and indicates whether the source vector was non-empty. It is the primitive used for append-only hook event merging.

**Data flow**: Takes `&mut Vec<T>` and `mut incoming: Vec<T>`, computes `changed` as `!incoming.is_empty()`, appends all incoming elements into `existing`, and returns that boolean.

**Call relations**: Called repeatedly by `append_hook_events` for each hook event list.

*Call graph*: called by 1 (append_hook_events).


### `config/src/requirements_layers/rules.rs`

`domain_logic` · `requirements layer composition`

This file is intentionally small because requirements rule composition is simple but nonstandard. The exported `merge` function accepts the current composed `Option<Sourced<RequirementsExecPolicyToml>>`, an optional incoming rules block, and the incoming `RequirementSource`. If the incoming layer has no rules, it does nothing. If this is the first rules-bearing layer, it wraps the incoming `RequirementsExecPolicyToml` in `Sourced::new` using the layer source. Otherwise it destructures the incoming value to obtain its `prefix_rules` vector and extends the existing vector with those rules.

The important behavior is not in the mechanics but in how the stack calls it: `RequirementsLayerStack::compose` iterates layers in reverse priority order before invoking this function. That means `extend` appends lower-priority rules after higher-priority ones, preserving visible priority in the final `rules.prefix_rules` list. Source metadata is also merged rather than replaced; `merge_output_source` collapses multiple contributing layers into a composite source when necessary. This keeps the regular TOML merge path from accidentally overriding or deduplicating execution-policy rules, which are intended to remain additive.

#### Function details

##### `merge`  (lines 10–26)

```
fn merge(
    target: &mut Option<Sourced<RequirementsExecPolicyToml>>,
    incoming: Option<RequirementsExecPolicyToml>,
    source: &RequirementSource,
)
```

**Purpose**: Adds one layer's `RequirementsExecPolicyToml` into the accumulated rules output using append semantics. It preserves all prefix rules and updates provenance when multiple layers contribute.

**Data flow**: Takes mutable `target`, optional `incoming`, and `source`. If `incoming` is `None`, it returns immediately. If `target` is empty, it stores `Sourced::new(incoming, source.clone())`. Otherwise it destructures `incoming` to get `prefix_rules`, extends `existing.value.prefix_rules` with them, and updates `existing.source` through `merge_output_source`.

**Call relations**: Called from `RequirementsLayerStack::compose` during the high-to-low pass over domain-specific fields so higher-priority rules are inserted before lower-priority ones.

*Call graph*: calls 2 internal fn (new, merge_output_source); called by 1 (compose); 1 external calls (clone).


### Stack assembly and downstream hook state
These files assemble the full layered requirements result and then derive effective hook-related persisted state from the resulting configuration stack.

### `config/src/requirements_layers/stack.rs`

`orchestration` · `requirements composition`

This file is the driver for requirements-layer composition. It defines `RequirementsCompositionError` for parse failures, merged-output parse failures, and explicit field conflicts, plus an `io::Error` conversion that maps all composition failures to `InvalidData`. The public entrypoint `compose_requirements` delegates to a hostname-aware helper using `crate::host_name`; test-only variants inject a fixed hostname and/or hook-directory field.

The core flow lives in `compose_requirements_with_hostname_resolver_and_hook_directory`. It wraps the hostname resolver in a `OnceCell` so hostname lookup is lazy and shared across all layers, then builds a `RequirementsLayerStack`, adds each `RequirementsLayerEntry` by normalizing it into a `ComposableRequirementsLayer`, and finally composes the stack. `RequirementsLayerStack::compose` first merges each layer's `regular_toml` low-to-high with `merge_toml_values`, parses the merged TOML back into `ConfigRequirementsToml`, and populates `ConfigRequirementsWithSources` for ordinary fields using `populate_merged_regular_fields_with_sources`. That helper explicitly destructures every top-level requirements field so new fields must choose between regular and special merge paths; source attribution comes from `source_for_top_level_keys`, which returns the winning source for scalars and a composite source for merged tables.

After regular fields, the stack performs a second pass over layers in reverse order for domain-specific fields: `super::rules::merge` appends execution rules, `HookMergeState` appends hook events and enforces active-directory conflicts, and `DenyReadMergeState` unions `permissions.filesystem.deny_read`. The final output is dropped to `None` if converting it back to TOML yields an empty document. Utility helpers `merge_output_source` and `composition_conflict` centralize provenance merging and conflict construction.

#### Function details

##### `Error::from`  (lines 53–55)

```
fn from(error: RequirementsCompositionError) -> Self
```

**Purpose**: Converts a `RequirementsCompositionError` into an `std::io::Error` with kind `InvalidData`. This lets callers surface composition failures through I/O-oriented APIs.

**Data flow**: Consumes a `RequirementsCompositionError`, passes it to `io::Error::new(io::ErrorKind::InvalidData, error)`, and returns the resulting `io::Error`.

**Call relations**: Used implicitly where a composition error must be adapted to an I/O error boundary.

*Call graph*: 1 external calls (new).


##### `compose_requirements`  (lines 58–62)

```
fn compose_requirements(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError>
```

**Purpose**: Public entrypoint for composing requirements layers using the real hostname resolver. It is the production-facing wrapper around the more configurable helper.

**Data flow**: Accepts an iterator of `RequirementsLayerEntry`, forwards it to `compose_requirements_with_hostname_resolver` together with `crate::host_name`, and returns the resulting optional composed requirements or composition error.

**Call relations**: Top-level API used by non-test callers; it delegates all substantive work to the hostname-aware helper.

*Call graph*: calls 1 internal fn (compose_requirements_with_hostname_resolver).


##### `compose_requirements_for_hostname`  (lines 65–75)

```
fn compose_requirements_for_hostname(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositi
```

**Purpose**: Test-only helper that composes layers against a fixed optional hostname while using the current platform's active hook directory field. It makes remote sandbox behavior deterministic in tests.

**Data flow**: Takes layers and `Option<&str>`, clones the hostname into an owned `Option<String>` captured by a closure, computes `HookDirectoryField::current_platform()`, and forwards everything to `compose_requirements_with_hostname_resolver_and_hook_directory`.

**Call relations**: Invoked by many tests in `stack_tests.rs` to exercise composition without depending on actual DNS or machine hostname.

*Call graph*: calls 2 internal fn (current_platform, compose_requirements_with_hostname_resolver_and_hook_directory).


##### `compose_requirements_for_hostname_and_hook_directory`  (lines 78–89)

```
fn compose_requirements_for_hostname_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
    hook_directory_field: HookDirectoryField,
) -> Re
```

**Purpose**: Test-only helper that fixes both the hostname and which hook directory field is considered active. It allows explicit testing of Windows/non-Windows hook conflict behavior.

**Data flow**: Accepts layers, optional hostname, and a `HookDirectoryField`; wraps the hostname in a cloning closure and forwards all inputs to `compose_requirements_with_hostname_resolver_and_hook_directory`.

**Call relations**: Used by hook-specific tests that need to simulate active `managed_dir` versus active `windows_managed_dir` independently of the build platform.

*Call graph*: calls 1 internal fn (compose_requirements_with_hostname_resolver_and_hook_directory).


##### `compose_requirements_with_hostname_resolver`  (lines 91–100)

```
fn compose_requirements_with_hostname_resolver(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
) -> Result<Option<ConfigRequirementsW
```

**Purpose**: Internal wrapper that composes layers with an injected hostname resolver while still selecting the active hook directory from the current platform. It is the shared path for production and some tests.

**Data flow**: Takes layers and a hostname resolver closure, computes `HookDirectoryField::current_platform()`, and delegates to `compose_requirements_with_hostname_resolver_and_hook_directory`.

**Call relations**: Called by `compose_requirements`; tests also call it directly to verify lazy hostname resolution behavior.

*Call graph*: calls 2 internal fn (current_platform, compose_requirements_with_hostname_resolver_and_hook_directory); called by 1 (compose_requirements).


##### `compose_requirements_with_hostname_resolver_and_hook_directory`  (lines 102–116)

```
fn compose_requirements_with_hostname_resolver_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
    hook_directory_
```

**Purpose**: Builds and runs a full composition with injected hostname and hook-directory policies. It ensures hostname resolution is lazy and cached across all layers.

**Data flow**: Accepts layers, a hostname resolver, and the active `HookDirectoryField`. It creates a `OnceCell<Option<String>>`, wraps the resolver in `cached_hostname_resolver` using `get_or_init`, constructs a `RequirementsLayerStack::new(hook_directory_field)`, feeds each layer through `stack.add_layer(layer, &cached_hostname_resolver)?`, then returns `stack.compose()`.

**Call relations**: This is the central orchestration helper called by all public/test entrypoints. It delegates normalization to `add_layer` and final merging to `compose`.

*Call graph*: calls 1 internal fn (new); called by 3 (compose_requirements_for_hostname, compose_requirements_for_hostname_and_hook_directory, compose_requirements_with_hostname_resolver); 1 external calls (new).


##### `RequirementsLayerStack::new`  (lines 124–129)

```
fn new(hook_directory_field: HookDirectoryField) -> Self
```

**Purpose**: Initializes an empty stack of normalized requirements layers with the chosen active hook directory field. It is the mutable accumulator used during composition setup.

**Data flow**: Takes `hook_directory_field`, creates an empty `Vec<ComposableRequirementsLayer>`, stores both fields, and returns `RequirementsLayerStack`.

**Call relations**: Constructed by `compose_requirements_with_hostname_resolver_and_hook_directory` before layers are added.

*Call graph*: called by 1 (compose_requirements_with_hostname_resolver_and_hook_directory); 1 external calls (new).


##### `RequirementsLayerStack::add_layer`  (lines 131–141)

```
fn add_layer(
        &mut self,
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<(), RequirementsCompositionError>
```

**Purpose**: Normalizes one raw layer entry and appends it to the stack. Parsing and per-layer transformations happen here, not during final merge.

**Data flow**: Takes mutable `self`, a `RequirementsLayerEntry`, and a hostname resolver reference. It calls `ComposableRequirementsLayer::from_entry(layer, hostname_resolver)?`, pushes the result into `self.layers`, and returns `Ok(())` or the parse/composition error from normalization.

**Call relations**: Called once per input layer by `compose_requirements_with_hostname_resolver_and_hook_directory`.

*Call graph*: calls 1 internal fn (from_entry).


##### `RequirementsLayerStack::compose`  (lines 143–187)

```
fn compose(
        self,
    ) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError>
```

**Purpose**: Performs the actual two-phase merge of all normalized layers into `ConfigRequirementsWithSources`. It combines generic TOML precedence with custom mergers for rules, hooks, and deny-read permissions.

**Data flow**: Consumes `self`, initializes `merged_toml` as an empty table, and folds `layer.regular_toml` into it with `merge_toml_values` in original low-to-high order. It parses the merged TOML into `ConfigRequirementsToml`, creates a default `ConfigRequirementsWithSources`, and fills regular sourced fields via `populate_merged_regular_fields_with_sources`. It then initializes `rules = None`, `hooks = HookMergeState::new(hook_directory_field)`, `hooks_output = None`, and `deny_read = DenyReadMergeState::default()`. Iterating `layers.iter().rev()`, it merges domain fields with `super::rules::merge`, `hooks.merge(...)?`, and `deny_read.merge(...)`. Finally it assigns `output.rules`, `output.hooks`, applies deny-read into `output.permissions`, checks whether `output.clone().into_toml().is_empty()`, and returns `Some(output)` only when non-empty.

**Call relations**: Called once after all layers are added. It is the central merger and delegates field-specific behavior to helpers in sibling modules.

*Call graph*: calls 4 internal fn (merge_toml_values, new, merge, populate_merged_regular_fields_with_sources); 4 external calls (Table, default, default, new).


##### `populate_merged_regular_fields_with_sources`  (lines 190–266)

```
fn populate_merged_regular_fields_with_sources(
    output: &mut ConfigRequirementsWithSources,
    requirements: ConfigRequirementsToml,
    layers: &[ComposableRequirementsLayer],
)
```

**Purpose**: Transfers regular merged requirement fields from `ConfigRequirementsToml` into `ConfigRequirementsWithSources` while attaching provenance. It explicitly enumerates every top-level field that belongs to the ordinary TOML merge path.

**Data flow**: Takes mutable `output`, the merged typed `requirements`, and the normalized `layers`. It destructures `ConfigRequirementsToml`, ignoring special fields like `remote_sandbox_config`, `hooks`, and `rules`. For each ordinary optional field, the `set_sourced!` macro wraps present values in `Sourced::new(value, source_for_top_level_keys(layers, keys))`. `guardian_policy_config` gets extra filtering so blank strings are omitted. It mutates `output` in place and returns nothing.

**Call relations**: Called by `RequirementsLayerStack::compose` immediately after parsing the merged regular TOML. It relies on `source_for_top_level_keys` to compute provenance.

*Call graph*: calls 2 internal fn (new, source_for_top_level_keys); called by 1 (compose); 1 external calls (set_sourced!).


##### `source_for_top_level_keys`  (lines 268–297)

```
fn source_for_top_level_keys(
    layers: &[ComposableRequirementsLayer],
    keys: &[&str],
) -> RequirementSource
```

**Purpose**: Determines which layer source should be attached to a merged top-level field. Scalars and arrays use the winning highest-priority source, while merged tables may produce a composite source reflecting multiple contributors.

**Data flow**: Reads `layers` and a list of candidate top-level keys. It collects every layer whose `regular_toml` contains one of those keys using `top_level_value_for_keys`, then takes the last match as the winning source/value. If there is no match, it returns `RequirementSource::Unknown`. If the winning value is not a table, it returns the winning source directly. If it is a table, it walks matching layers in reverse priority order, collects sources whose values are tables, and returns `RequirementSource::composite(table_sources)` when more than one table contributed; otherwise it returns the winning source.

**Call relations**: Used by `populate_merged_regular_fields_with_sources` for every regular field to attach accurate provenance after TOML merging.

*Call graph*: calls 1 internal fn (composite); called by 1 (populate_merged_regular_fields_with_sources); 1 external calls (iter).


##### `top_level_value_for_keys`  (lines 299–302)

```
fn top_level_value_for_keys(value: &'a TomlValue, keys: &[&str]) -> Option<&'a TomlValue>
```

**Purpose**: Looks up the first present top-level TOML value among a small set of alternative keys. It supports fields whose serialized key names differ from internal field names.

**Data flow**: Takes `&TomlValue` and a slice of key strings, obtains the top-level table with `as_table()`, scans the keys in order, and returns the first matching `&TomlValue` if any.

**Call relations**: Called by `source_for_top_level_keys` while searching each layer's regular TOML for the field that contributed to a sourced output.

*Call graph*: 1 external calls (as_table).


##### `merge_output_source`  (lines 304–308)

```
fn merge_output_source(existing: &mut RequirementSource, incoming: &RequirementSource)
```

**Purpose**: Combines provenance when two different requirement sources contribute to one composed output field. Equal sources are left unchanged; differing ones become a composite source.

**Data flow**: Mutably reads `existing` and compares it to `incoming`. If they differ, it replaces `*existing` with `RequirementSource::composite([existing.clone(), incoming.clone()])`.

**Call relations**: Shared utility used by the rules merger, hook merger, and deny-read source accumulator whenever multiple layers contribute to one output.

*Call graph*: calls 1 internal fn (composite); called by 3 (merge, merge_source, merge); 1 external calls (clone).


##### `composition_conflict`  (lines 310–322)

```
fn composition_conflict(
    field: String,
    existing_source: RequirementSource,
    incoming_source: RequirementSource,
    message: impl Into<String>,
) -> RequirementsCompositionError
```

**Purpose**: Constructs a standardized `RequirementsCompositionError::Conflict` value for field-level merge failures. It centralizes the shape of conflict diagnostics.

**Data flow**: Consumes a field name, existing and incoming sources, and any message convertible into `String`, then returns `RequirementsCompositionError::Conflict { ... }` with the message materialized.

**Call relations**: Called by hook merging when active managed hook directories disagree across layers.

*Call graph*: called by 1 (merge_active_singleton); 1 external calls (into).


### `hooks/src/config_rules.rs`

`domain_logic` · `hook discovery / config interpretation`

This file extracts per-hook persisted state from configuration layers and merges it into a single `HashMap<String, HookStateToml>`. The central rule is intentionally narrow: only `ConfigLayerSource::User` and `ConfigLayerSource::SessionFlags` are allowed to write hook state, even though other layers may declare hooks. `hook_states_from_stack` walks the provided `ConfigLayerStack` in lowest-precedence-first order, including disabled layers, so later eligible layers can override earlier ones while preserving the same semantics used elsewhere for user preferences.

For each eligible layer, it looks up `config["hooks"]["state"]`, requires that value to be a `TomlValue::Table`, and then iterates each hook key entry. Each entry is cloned and converted with `try_into()` into `HookStateToml`; malformed entries are skipped rather than failing the whole load. Keys are trimmed and empty keys are ignored. Merging is field-by-field: `enabled` and `trusted_hash` are only overwritten when the newer layer explicitly provides that field. This prevents a partial later write from erasing an earlier field value.

The test module exercises precedence, cross-layer field merging, and resilience to malformed unrelated hook config or malformed state entries. The helper builders serialize `HookStateToml` through JSON into `TomlValue` fixtures to mimic realistic config structures.

#### Function details

##### `hook_states_from_stack`  (lines 16–70)

```
fn hook_states_from_stack(
    config_layer_stack: Option<&ConfigLayerStack>,
) -> HashMap<String, HookStateToml>
```

**Purpose**: Builds the effective per-hook state map from the subset of config layers allowed to override user hook preferences. It merges `enabled` and `trusted_hash` independently so partial updates do not erase existing fields.

**Data flow**: It takes an optional `&ConfigLayerStack`; `None` immediately yields an empty `HashMap`. For each layer in precedence order, it reads the layer source, filters to user and session-flag layers, extracts `hooks.state` from the layer’s TOML tree, requires a table, converts each entry into `HookStateToml`, trims and validates the key, and then merges non-`None` fields into the accumulated map entry. It returns the final `HashMap<String, HookStateToml>` without mutating external state.

**Call relations**: This function is called by `discover_handlers` before hook discovery so discovery can apply persisted enablement and trust decisions. It does not delegate to other local helpers; its main control-flow decisions are layer-source filtering and tolerant skipping of malformed state values.

*Call graph*: called by 1 (discover_handlers); 2 external calls (new, matches!).


##### `tests::hook_states_from_stack_respects_layer_precedence`  (lines 83–114)

```
fn hook_states_from_stack_respects_layer_precedence()
```

**Purpose**: Verifies that later eligible layers override earlier ones for the same hook key. The test specifically checks that a session-flags `enabled=true` value wins over a user-layer `enabled=false` value.

**Data flow**: It constructs a `ConfigLayerStack` with two entries using helper fixture builders, invokes `hook_states_from_stack(Some(&stack))`, and compares the returned map against the expected single merged `HookStateToml` using `assert_eq!`.

**Call relations**: This test invokes the production function under a two-layer precedence scenario. It relies on the helper `config_with_hook_override` to build realistic layer configs.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::hook_states_from_stack_merges_fields_across_layers`  (lines 117–160)

```
fn hook_states_from_stack_merges_fields_across_layers()
```

**Purpose**: Checks that field-by-field merging preserves earlier fields when a later layer only supplies another field. It demonstrates that `enabled` from one layer and `trusted_hash` from another coexist in the result.

**Data flow**: It builds a two-layer stack where the first layer sets `enabled` and the second sets only `trusted_hash`, runs `hook_states_from_stack`, and asserts that the returned map contains both fields on the same hook key.

**Call relations**: This test exercises the merge semantics implemented in `hook_states_from_stack`. It uses `config_with_hook_state` to create exact `HookStateToml` payloads for each layer.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::hook_states_from_stack_ignores_malformed_hook_events`  (lines 163–199)

```
fn hook_states_from_stack_ignores_malformed_hook_events()
```

**Purpose**: Confirms that malformed non-state hook configuration does not interfere with extracting valid `hooks.state` entries. The test guards against accidental coupling between hook event parsing and state parsing.

**Data flow**: It constructs a `TomlValue` containing a valid `hooks.state` table plus an invalid `hooks.SessionStart` value, wraps that in a one-layer `ConfigLayerStack`, calls `hook_states_from_stack`, and asserts that the valid state entry is still returned.

**Call relations**: This test calls the production function with a mixed-validity config document. It demonstrates that `hook_states_from_stack` only reads the `hooks.state` subtree and ignores malformed event declarations.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, from_value, json!, vec!).


##### `tests::hook_states_from_stack_ignores_malformed_state_entries`  (lines 202–240)

```
fn hook_states_from_stack_ignores_malformed_state_entries()
```

**Purpose**: Ensures malformed individual state entries are skipped without discarding valid sibling entries. This protects persisted hook state loading from one bad record poisoning the whole map.

**Data flow**: It builds a config where one hook state entry deserializes correctly and another has an invalid `enabled` type, creates a stack, runs `hook_states_from_stack`, and asserts that only the valid entry appears in the returned map.

**Call relations**: This test targets the per-entry `try_into()` failure path inside `hook_states_from_stack`. It uses direct TOML/JSON fixture construction rather than helper wrappers to include malformed data.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, from_value, json!, vec!).


##### `tests::config_with_hook_override`  (lines 242–250)

```
fn config_with_hook_override(key: &str, enabled: Option<bool>) -> TomlValue
```

**Purpose**: Builds a minimal hook-state config fixture that only varies the `enabled` field. It is a convenience wrapper used by precedence-focused tests.

**Data flow**: It accepts a hook key and an `Option<bool>` for `enabled`, constructs a `HookStateToml` with `trusted_hash: None`, and forwards both to `config_with_hook_state`. It returns the resulting `TomlValue` fixture.

**Call relations**: This helper is only used by tests that care about enablement precedence. It delegates all actual fixture serialization and TOML shaping to `config_with_hook_state`.

*Call graph*: 1 external calls (config_with_hook_state).


##### `tests::config_with_hook_state`  (lines 252–262)

```
fn config_with_hook_state(key: &str, state: HookStateToml) -> TomlValue
```

**Purpose**: Constructs a `TomlValue` fixture containing a `hooks.state` table with one serialized `HookStateToml` entry. It centralizes the test-side shape of hook-state config documents.

**Data flow**: It takes a hook key and a `HookStateToml`, serializes the state to JSON with `serde_json::to_value`, embeds that value under `hooks.state.<key>` in a JSON object, then deserializes the whole object into `TomlValue` and returns it.

**Call relations**: This helper underpins the test fixtures for the file. Other tests and helpers call it to produce realistic config payloads consumed by `hook_states_from_stack`.

*Call graph*: 3 external calls (from_value, json!, to_value).
