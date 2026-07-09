# Feature flags, provider catalogs, and built-in asset installation  `stage-4.2`

This startup stage assembles the catalogs, toggles, and bundled assets the rest of the system assumes already exist before any session, plugin surface, or UI is created. It begins by resolving feature state: `features` defines typed flag schemas, maps legacy keys, merges layered config with overrides, and emits warnings and telemetry, while `managed_features` applies policy pins and dependency normalization. The TUI’s experimental-features view is the interactive editor for those flags.

It also installs and loads built-in capabilities. Skills configuration schemas and extension config determine whether bundled skills participate; `skills` installs embedded system skills, `core-skills` can clean them up, compute enable/disable rules, discover `SKILL.md` trees from all roots, and build the filtered runtime skill index. Memory extensions seed default instruction files similarly.

For external capability catalogs, marketplace config and CLI manage plugin sources; plugin provider and load-outcome types turn discovered plugins into merged capability roots. MCP declarations are parsed, conflict-resolved in the catalog, and combined into the final server set.

Finally, this stage prepares static runtime catalogs: model-provider definitions, model metadata and collaboration presets, approval presets, and built-in pet assets and manifests, including downloading and validating cached spritesheets.

## Files in this stage

### Feature flag resolution
These files define feature schemas, legacy mappings, canonical resolution, managed enforcement, and the UI used to inspect and persist experimental toggles.

### `features/src/feature_configs.rs`

`config` · `config definition and load-time interpretation`

This file is primarily a schema definition module. It declares three feature-specific config structs with `Serialize`, `Deserialize`, `JsonSchema`, and `deny_unknown_fields` so they can be loaded from TOML, emitted back out, and documented in generated schemas. `CodeModeConfigToml` carries an optional `enabled` flag plus an optional list of excluded tool namespaces. `MultiAgentV2ConfigToml` is richer, with optional concurrency, timeout, usage-hint, namespace, and visibility settings; several fields carry `schemars` constraints such as minimum thread count, bounded timeout ranges, and a regex/length restriction for `tool_namespace`. `NetworkProxyConfigToml` models proxy enablement and policy, including proxy URLs, SOCKS settings, upstream allowances, domain and Unix-socket permission maps, and a mode enum.

The only behavior in the file is the `FeatureConfig` trait implementation for the three public config structs. Each implementation simply exposes the optional `enabled` field and provides a setter that writes `Some(enabled)`. The rest of the types are pure data carriers: a removed internal config struct retained for compatibility, plus small enums for proxy mode and allow/deny permissions. Because the file contains almost no control flow, its main value is in the exact field set, serde behavior, and schema annotations that constrain configuration shape.

#### Function details

##### `CodeModeConfigToml::enabled`  (lines 18–20)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: Returns the optional enabled state stored in the code-mode config.

**Data flow**: It reads `self.enabled` and returns that `Option<bool>` unchanged.

**Call relations**: This method satisfies the shared `FeatureConfig` trait contract for code-mode configuration consumers.


##### `CodeModeConfigToml::set_enabled`  (lines 22–24)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: Sets the code-mode config's enabled flag to an explicit value.

**Data flow**: It takes a mutable reference and a `bool`, writes `Some(enabled)` into `self.enabled`, and returns unit.

**Call relations**: This is the mutation half of the `FeatureConfig` trait implementation for `CodeModeConfigToml`.


##### `MultiAgentV2ConfigToml::enabled`  (lines 62–64)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: Returns the optional enabled state stored in the multi-agent v2 config.

**Data flow**: It reads and returns `self.enabled` as `Option<bool>`.

**Call relations**: Implements the common `FeatureConfig` getter for the multi-agent v2 feature.


##### `MultiAgentV2ConfigToml::set_enabled`  (lines 66–68)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: Sets the multi-agent v2 config's enabled flag to an explicit value.

**Data flow**: It takes `enabled: bool`, stores `Some(enabled)` in `self.enabled`, and returns unit.

**Call relations**: Implements the common `FeatureConfig` setter for the multi-agent v2 feature.


##### `NetworkProxyConfigToml::enabled`  (lines 110–112)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: Returns the optional enabled state stored in the network-proxy config.

**Data flow**: It reads `self.enabled` and returns it unchanged.

**Call relations**: Implements the `FeatureConfig` getter for network-proxy configuration handling.


##### `NetworkProxyConfigToml::set_enabled`  (lines 114–116)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: Sets the network-proxy config's enabled flag to an explicit value.

**Data flow**: It writes `Some(enabled)` into `self.enabled` on the mutable config struct.

**Call relations**: Implements the `FeatureConfig` setter for network-proxy configuration handling.


### `features/src/legacy.rs`

`config` · `config normalization and feature-toggle application`

This file is a compatibility layer for older configuration keys. It defines a private `Alias` struct and a static `ALIASES` table that maps legacy string keys such as `connectors`, `web_search`, and `experimental_use_unified_exec_tool` to current `Feature` enum variants. Two public-facing helpers expose that mapping: `legacy_feature_keys` iterates the known legacy strings, and `feature_for_key` resolves one key to a `Feature` while logging a deprecation-style message when the alias differs from the canonical feature key.

The second half of the file handles a small legacy toggle struct, `LegacyFeatureToggles`, currently containing `experimental_use_unified_exec_tool`. Its `apply` method pushes any populated legacy values into a mutable `Features` set through `set_if_some`. That helper centralizes the compatibility behavior: if a legacy option is present, it enables or disables the target feature, logs the alias usage, and records the legacy key through `features.record_legacy_usage`. `set_feature` is intentionally tiny and just dispatches to `features.enable` or `features.disable`.

A subtle design choice is that `log_alias` suppresses logging when the alias string already equals the canonical feature key, so only true legacy spellings produce the informational tracing event. This keeps compatibility support visible without spamming logs for canonical usage.

#### Function details

##### `legacy_feature_keys`  (lines 50–52)

```
fn legacy_feature_keys() -> impl Iterator<Item = &'static str>
```

**Purpose**: Returns an iterator over all recognized legacy feature-key strings.

**Data flow**: It iterates the static `ALIASES` slice and maps each `Alias` to its `legacy_key`, yielding `&'static str` items.

**Call relations**: Used by feature-resolution code to know which deprecated keys should still be recognized during configuration materialization.

*Call graph*: called by 1 (materialize_resolved_enabled).


##### `feature_for_key`  (lines 54–62)

```
fn feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: Looks up a legacy key in the alias table and returns the corresponding canonical `Feature`.

**Data flow**: It takes a string key, scans `ALIASES` for a matching `legacy_key`, and if found logs the alias via `log_alias` before returning `Some(alias.feature)`; otherwise it returns `None`.

**Call relations**: This resolver is called by higher-level feature lookup logic when interpreting configuration keys. On successful matches it delegates to `log_alias` so deprecated usage is surfaced.

*Call graph*: called by 1 (feature_for_key).


##### `LegacyFeatureToggles::apply`  (lines 70–77)

```
fn apply(self, features: &mut Features)
```

**Purpose**: Applies populated fields from the legacy toggle struct onto the mutable `Features` collection.

**Data flow**: It consumes `self`, takes a mutable `Features`, and forwards the `experimental_use_unified_exec_tool` option plus its target `Feature::UnifiedExec` and alias string to `set_if_some`.

**Call relations**: This is the entry point for struct-based legacy toggles; it delegates all conditional logic and side effects to `set_if_some`.

*Call graph*: calls 1 internal fn (set_if_some).


##### `set_if_some`  (lines 80–91)

```
fn set_if_some(
    features: &mut Features,
    feature: Feature,
    maybe_value: Option<bool>,
    alias_key: &'static str,
)
```

**Purpose**: Conditionally applies one legacy boolean toggle, logs the alias, and records that legacy configuration was used.

**Data flow**: It takes mutable `Features`, a target `Feature`, an `Option<bool>`, and the alias key. If the option is `Some(enabled)`, it calls `set_feature` to enable or disable the feature, calls `log_alias` to emit the compatibility message, and then calls `features.record_legacy_usage(alias_key, feature)`. If the option is `None`, it does nothing.

**Call relations**: Called by `LegacyFeatureToggles::apply`. It orchestrates the three side effects associated with honoring a legacy toggle.

*Call graph*: calls 3 internal fn (record_legacy_usage, log_alias, set_feature); called by 1 (apply).


##### `set_feature`  (lines 93–99)

```
fn set_feature(features: &mut Features, feature: Feature, enabled: bool)
```

**Purpose**: Applies a boolean value to a feature by enabling or disabling it on the `Features` collection.

**Data flow**: It takes mutable `Features`, a `Feature`, and `enabled: bool`; if true it calls `features.enable(feature)`, otherwise `features.disable(feature)`.

**Call relations**: Used only by `set_if_some` as the low-level state mutation step.

*Call graph*: calls 2 internal fn (disable, enable); called by 1 (set_if_some).


##### `log_alias`  (lines 101–111)

```
fn log_alias(alias: &str, feature: Feature)
```

**Purpose**: Emits an informational tracing message when a legacy alias is used instead of the feature's canonical key.

**Data flow**: It takes the alias string and `Feature`, computes the canonical key with `feature.key()`, returns immediately if alias and canonical are identical, and otherwise logs an `info!` event containing both names and guidance to prefer `[features].{canonical}`.

**Call relations**: Called from both `feature_for_key` and `set_if_some` so alias usage is visible whether it comes from key lookup or legacy toggle application.

*Call graph*: calls 1 internal fn (key); called by 1 (set_if_some); 1 external calls (info!).


### `features/src/lib.rs`

`config` · `config load and feature resolution`

This file is the central feature model for the system. It declares the `Stage` lifecycle enum, the large `Feature` enum of all known toggles, and the `FEATURES` registry that binds each feature ID to its string key, rollout stage, and built-in default. `Feature::info` is the invariant-enforcing lookup: every enum variant must have a corresponding `FeatureSpec`, and missing entries are treated as unreachable.

Runtime state lives in `Features`, which stores enabled flags in a `BTreeSet<Feature>` plus a sorted set of `LegacyFeatureUsage` notices. Construction starts from `Features::with_defaults`, then `Features::from_sources` layers base config, profile config, legacy toggle shims, and explicit `FeatureOverrides`, finally calling `normalize_dependencies` so dependent flags are auto-enabled (`SpawnCsv` implies `Collab`, `CodeModeOnly` implies `CodeMode`).

Config parsing is split between plain booleans and structured feature configs. `FeaturesToml` flattens arbitrary `[features]` booleans into `entries`, while selected features (`code_mode`, `multi_agent_v2`, `network_proxy`) can also be represented as `FeatureToml<T>` values carrying richer config structs. `entries()` materializes those structured `enabled` bits back into a simple map for resolution, and `materialize_resolved_enabled()` writes a fully resolved feature state back into TOML while stripping legacy aliases and removed compatibility-only fields.

A notable design choice is that removed/deprecated keys still parse, but many are ignored or only recorded as legacy usage. `apply_map` contains the compatibility policy in one place: some keys are no-ops, some emit deprecation notices, and unknown keys only log a warning. The file also exposes lookup helpers (`feature_for_key`, `canonical_feature_for_key`, `is_known_feature_key`) and `unstable_features_warning_event`, which inspects the effective TOML table and only warns about under-development features that are both explicitly enabled in config and actually active after resolution.

#### Function details

##### `Stage::experimental_menu_name`  (lines 49–54)

```
fn experimental_menu_name(self) -> Option<&'static str>
```

**Purpose**: Returns the display name for a feature only when its stage is `Stage::Experimental`.

**Data flow**: Reads `self` and pattern-matches on the enum variant. It returns `Some(name)` for `Experimental { name, .. }` and `None` for all other stages without mutating any state.

**Call relations**: Used by callers that need to surface experimental features in UI menus; it is a pure accessor over the stage metadata embedded in the registry.


##### `Stage::experimental_menu_description`  (lines 56–63)

```
fn experimental_menu_description(self) -> Option<&'static str>
```

**Purpose**: Extracts the menu description text from an experimental stage definition.

**Data flow**: Consumes `self` by value, matches on `Stage::Experimental { menu_description, .. }`, and returns that static string wrapped in `Some`; all non-experimental stages yield `None`.

**Call relations**: Supports presentation logic for experimental-feature menus by exposing only the description field when the stage actually carries one.


##### `Stage::experimental_announcement`  (lines 65–73)

```
fn experimental_announcement(self) -> Option<&'static str>
```

**Purpose**: Returns the announcement string for experimental features, but suppresses empty announcements.

**Data flow**: Matches `self`; for `Experimental { announcement: "", .. }` it returns `None`, for non-empty experimental announcements it returns `Some(announcement)`, and for all other stages it returns `None`.

**Call relations**: This accessor is used where the UI or config tooling wants optional announcement copy without treating an empty string as meaningful content.


##### `Feature::key`  (lines 277–279)

```
fn key(self) -> &'static str
```

**Purpose**: Maps a `Feature` enum variant to its canonical string key from the registry.

**Data flow**: Reads `self`, delegates to `Feature::info`, and returns the `key` field from the matched `FeatureSpec`.

**Call relations**: Called when generating deprecation notices and alias tracking so all outward-facing references use the registry’s canonical key rather than hard-coded strings.

*Call graph*: calls 1 internal fn (info); called by 3 (record_legacy_usage, log_alias, legacy_usage_notice).


##### `Feature::stage`  (lines 281–283)

```
fn stage(self) -> Stage
```

**Purpose**: Returns the rollout stage metadata for a feature.

**Data flow**: Reads `self`, looks up the corresponding `FeatureSpec` via `info`, and returns its `stage` field.

**Call relations**: Used by validation and tests to assert rollout policy, and by any code that needs to distinguish stable, experimental, deprecated, or removed flags.

*Call graph*: calls 1 internal fn (info).


##### `Feature::default_enabled`  (lines 285–287)

```
fn default_enabled(self) -> bool
```

**Purpose**: Reports whether a feature is enabled in the built-in default feature set.

**Data flow**: Reads `self`, resolves its `FeatureSpec` through `info`, and returns the `default_enabled` boolean.

**Call relations**: Feeds tests, metrics comparisons, and default-set construction so the registry remains the single source of truth for defaults.

*Call graph*: calls 1 internal fn (info).


##### `Feature::info`  (lines 289–294)

```
fn info(self) -> &'static FeatureSpec
```

**Purpose**: Finds the `FeatureSpec` entry corresponding to a `Feature` enum variant.

**Data flow**: Iterates over the global `FEATURES` slice, finds the spec whose `id` equals `self`, and returns a shared reference to that spec. If no spec exists, it panics via `unreachable!`, enforcing registry completeness.

**Call relations**: This is the internal lookup primitive behind `key`, `stage`, and `default_enabled`; those accessors all depend on this registry search.

*Call graph*: called by 3 (default_enabled, key, stage).


##### `FeatureOverrides::apply`  (lines 324–333)

```
fn apply(self, features: &mut Features)
```

**Purpose**: Applies ad hoc runtime overrides that are not represented directly as normal feature-table entries.

**Data flow**: Consumes `self` and mutably borrows `Features`. If `web_search_request` is `Some(true)` it enables `Feature::WebSearchRequest`; if `Some(false)` it disables it. In either override case it records legacy usage under the alias `web_search_request`.

**Call relations**: Invoked at the end of `Features::from_sources` after base/profile config has been applied, so explicit overrides win over config-derived state.

*Call graph*: calls 3 internal fn (disable, enable, record_legacy_usage); called by 1 (from_sources).


##### `Features::with_defaults`  (lines 338–349)

```
fn with_defaults() -> Self
```

**Purpose**: Constructs a fresh effective feature set from the registry’s built-in defaults.

**Data flow**: Creates an empty `BTreeSet`, iterates over `FEATURES`, inserts every `spec.id` whose `default_enabled` is true, and returns a `Features` with that enabled set and an empty `legacy_usages` set.

**Call relations**: This is the starting point for all feature resolution and many tests; `from_sources` builds on top of it rather than starting from an empty set.

*Call graph*: called by 60 (web_search_mode_defaults_to_none_if_unset, web_search_mode_disabled_overrides_legacy_request, web_search_mode_prefers_config_over_legacy_flags, codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result, default_available_modes, default_mode_enabled_available_modes, elevated_flag_works_by_itself (+15 more)); 1 external calls (new).


##### `Features::enabled`  (lines 351–353)

```
fn enabled(&self, f: Feature) -> bool
```

**Purpose**: Checks whether a specific feature is currently enabled in the effective set.

**Data flow**: Reads `self.enabled` and returns whether the `BTreeSet` contains the requested `Feature`.

**Call relations**: This is the main query primitive used throughout the file by dependency normalization, metrics emission, auth gating, warning generation, and config materialization.

*Call graph*: called by 12 (validate_pinned_features_constraint, resolve_web_search_mode, from_features, apps_enabled_for_auth, emit_metrics, normalize_dependencies, use_legacy_landlock, materialize_resolved_enabled, unstable_features_warning_event, shell_command_backend_for_features (+2 more)); 1 external calls (contains).


##### `Features::apps_enabled_for_auth`  (lines 355–357)

```
fn apps_enabled_for_auth(&self, has_chatgpt_auth: bool) -> bool
```

**Purpose**: Determines whether apps should be considered available for auth-dependent flows.

**Data flow**: Reads the `Apps` feature state via `enabled` and combines it with the `has_chatgpt_auth` argument using logical AND. It returns a boolean and does not mutate state.

**Call relations**: Used by higher-level auth logic that needs both the feature flag and a valid auth condition before exposing apps behavior.

*Call graph*: calls 1 internal fn (enabled).


##### `Features::use_legacy_landlock`  (lines 359–361)

```
fn use_legacy_landlock(&self) -> bool
```

**Purpose**: Provides a named query for the deprecated legacy Linux sandbox toggle.

**Data flow**: Reads the enabled set through `enabled(Feature::UseLegacyLandlock)` and returns that boolean.

**Call relations**: Acts as a semantic wrapper for callers deciding sandbox behavior, keeping direct feature-ID checks out of downstream code.

*Call graph*: calls 1 internal fn (enabled).


##### `Features::enable`  (lines 363–366)

```
fn enable(&mut self, f: Feature) -> &mut Self
```

**Purpose**: Turns on a feature in the effective set.

**Data flow**: Mutably borrows `self`, inserts the given `Feature` into the `enabled` `BTreeSet`, and returns `&mut Self` for chaining.

**Call relations**: Used by override application, map application, dependency normalization, and generic setters whenever a flag must be forced on.

*Call graph*: called by 5 (apply, apply_map, normalize_dependencies, set_enabled, set_feature); 1 external calls (insert).


##### `Features::disable`  (lines 368–371)

```
fn disable(&mut self, f: Feature) -> &mut Self
```

**Purpose**: Turns off a feature in the effective set.

**Data flow**: Mutably borrows `self`, removes the given `Feature` from the `enabled` `BTreeSet`, and returns `&mut Self` for chaining.

**Call relations**: Used symmetrically with `enable` by config application and setters whenever a flag must be forced off.

*Call graph*: called by 4 (apply, apply_map, set_enabled, set_feature); 1 external calls (remove).


##### `Features::set_enabled`  (lines 373–379)

```
fn set_enabled(&mut self, f: Feature, enabled: bool) -> &mut Self
```

**Purpose**: Sets a feature to a requested boolean state through one unified API.

**Data flow**: Takes a `Feature` and `enabled: bool`; if true it delegates to `enable`, otherwise to `disable`, returning the same mutable receiver.

**Call relations**: Called by normalization code outside this file that wants to assign a computed state without branching itself.

*Call graph*: calls 2 internal fn (disable, enable); called by 1 (normalize_candidate).


##### `Features::record_legacy_usage_force`  (lines 381–389)

```
fn record_legacy_usage_force(&mut self, alias: &str, feature: Feature)
```

**Purpose**: Adds a deprecation/alias usage record even when the alias equals the canonical key.

**Data flow**: Takes an alias string and target `Feature`, computes `(summary, details)` via `legacy_usage_notice`, constructs a `LegacyFeatureUsage`, and inserts it into the sorted `legacy_usages` set.

**Call relations**: Used by `apply_map` for compatibility keys that should always produce a notice, and by `record_legacy_usage` after it filters out canonical names.

*Call graph*: calls 1 internal fn (legacy_usage_notice); called by 2 (apply_map, record_legacy_usage); 1 external calls (insert).


##### `Features::record_legacy_usage`  (lines 391–396)

```
fn record_legacy_usage(&mut self, alias: &str, feature: Feature)
```

**Purpose**: Records legacy usage only when the provided alias differs from the feature’s canonical key.

**Data flow**: Reads the feature’s canonical key via `Feature::key`; if `alias == canonical` it returns early, otherwise it delegates to `record_legacy_usage_force`.

**Call relations**: Called from override and config application paths whenever a legacy alias may have been used, avoiding redundant notices for canonical config.

*Call graph*: calls 2 internal fn (key, record_legacy_usage_force); called by 3 (apply, apply_map, set_if_some).


##### `Features::legacy_feature_usages`  (lines 398–400)

```
fn legacy_feature_usages(&self) -> impl Iterator<Item = &LegacyFeatureUsage> + '_
```

**Purpose**: Exposes the accumulated legacy-usage notices as an iterator.

**Data flow**: Borrows `self.legacy_usages` immutably and returns its iterator.

**Call relations**: Used by callers that need to surface deprecation notices after config resolution without taking ownership of the set.

*Call graph*: 1 external calls (iter).


##### `Features::emit_metrics`  (lines 402–418)

```
fn emit_metrics(&self, otel: &SessionTelemetry)
```

**Purpose**: Emits telemetry counters for features whose effective state differs from their built-in default, excluding removed flags.

**Data flow**: Iterates over `FEATURES`, skips specs whose stage is `Removed`, compares `self.enabled(spec.id)` against `spec.default_enabled`, and for each mismatch increments the `codex.feature.state` counter on the provided `SessionTelemetry` with `feature` and `value` labels.

**Call relations**: Called after feature resolution to report non-default rollout state; it depends on `enabled` and the registry metadata to avoid emitting noise for unchanged defaults.

*Call graph*: calls 2 internal fn (enabled, counter); 1 external calls (matches!).


##### `Features::apply_map`  (lines 421–496)

```
fn apply_map(&mut self, m: &BTreeMap<String, bool>)
```

**Purpose**: Applies a flat map of feature-key booleans, including compatibility handling for legacy, deprecated, removed, and unknown keys.

**Data flow**: Mutably borrows `self` and iterates over `BTreeMap<String, bool>`. It first special-cases certain keys: some force legacy notices (`web_search_request`, `web_search_cached`, `use_legacy_landlock`), while many removed compatibility keys are ignored with `continue`. It then resolves each remaining key through `feature_for_key`; known keys may record alias usage if the input key differs from the canonical key, and are enabled or disabled according to the boolean value. Unknown keys trigger a tracing warning.

**Call relations**: This is the core boolean-toggle application path, called by `apply_toml`. It centralizes backward-compatibility policy so `from_sources` can simply feed it normalized entries.

*Call graph*: calls 5 internal fn (disable, enable, record_legacy_usage, record_legacy_usage_force, feature_for_key); called by 1 (apply_toml); 2 external calls (matches!, warn!).


##### `Features::from_sources`  (lines 498–520)

```
fn from_sources(
        base: FeatureConfigSource<'_>,
        profile: FeatureConfigSource<'_>,
        overrides: FeatureOverrides,
    ) -> Self
```

**Purpose**: Builds the final effective feature set from layered config sources plus explicit overrides.

**Data flow**: Starts from `Features::with_defaults()`. For each of the two `FeatureConfigSource` inputs (`base`, then `profile`), it applies `LegacyFeatureToggles` derived from `experimental_use_unified_exec_tool`, then if a `FeaturesToml` is present it applies that TOML via `apply_toml`. After both layers, it applies `FeatureOverrides`, normalizes dependencies, and returns the resulting `Features`.

**Call relations**: This is the main entry point used by config loading and validation code. It orchestrates all lower-level application steps and establishes precedence: defaults < base < profile < overrides < dependency normalization.

*Call graph*: calls 2 internal fn (apply, with_defaults); called by 12 (load_config_with_layer_stack, resolve_bootstrap_auth_keyring_backend_kind, validate_feature_requirements_in_config_toml, from_sources_applies_base_profile_and_overrides, from_sources_ignores_removed_apply_patch_freeform_feature_key, from_sources_ignores_removed_image_detail_original_feature_key, from_sources_ignores_removed_js_repl_feature_keys, from_sources_ignores_removed_plugin_hooks_feature_key, from_sources_ignores_removed_terminal_resize_reflow_feature_key, from_sources_ignores_removed_undo_feature_key (+2 more)).


##### `Features::enabled_features`  (lines 522–524)

```
fn enabled_features(&self) -> Vec<Feature>
```

**Purpose**: Returns the enabled feature set as a sorted vector.

**Data flow**: Iterates over the internal `BTreeSet<Feature>`, copies each feature, collects them into a `Vec<Feature>`, and returns it.

**Call relations**: Used by callers that need a concrete list rather than repeated membership checks; ordering follows the set’s natural sort.

*Call graph*: 1 external calls (iter).


##### `Features::normalize_dependencies`  (lines 526–533)

```
fn normalize_dependencies(&mut self)
```

**Purpose**: Enforces one-way feature dependencies after all direct config inputs have been applied.

**Data flow**: Reads current feature state with `enabled`. If `SpawnCsv` is on and `Collab` is off, it enables `Collab`. If `CodeModeOnly` is on and `CodeMode` is off, it enables `CodeMode`. It mutates the enabled set in place and returns nothing.

**Call relations**: Called at the end of `from_sources` and by normalization tests to ensure dependent features are present even if users only enabled the narrower child flag.

*Call graph*: calls 2 internal fn (enable, enabled); called by 1 (normalize_candidate).


##### `legacy_usage_notice`  (lines 536–584)

```
fn legacy_usage_notice(alias: &str, feature: Feature) -> (String, Option<String>)
```

**Purpose**: Builds the human-readable deprecation or alias-migration message associated with a legacy feature key.

**Data flow**: Takes an alias string and target `Feature`, derives the canonical key via `Feature::key`, and matches on the feature. Web-search aliases get a special summary plus `web_search_details`; `UseLegacyLandlock` gets a custom deprecation/removal message; all other aliases produce a generic "use `[features].canonical` instead" summary and optional details when alias and canonical differ. It returns `(summary, Option<details>)`.

**Call relations**: Used exclusively by `record_legacy_usage_force` so all legacy notices are generated consistently from one policy table.

*Call graph*: calls 2 internal fn (key, web_search_details); called by 1 (record_legacy_usage_force); 1 external calls (format!).


##### `web_search_details`  (lines 586–588)

```
fn web_search_details() -> &'static str
```

**Purpose**: Provides the fixed explanatory text for deprecated web-search feature aliases.

**Data flow**: Returns a static string literal describing the supported `web_search` config values.

**Call relations**: Called only from `legacy_usage_notice` for web-search-related deprecation messages.

*Call graph*: called by 1 (legacy_usage_notice).


##### `feature_for_key`  (lines 591–598)

```
fn feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: Resolves either a canonical feature key or a legacy alias to a `Feature` enum value.

**Data flow**: Scans the canonical `FEATURES` registry for an exact key match; if none is found, it delegates to `legacy::feature_for_key(key)` and returns that result.

**Call relations**: This is the permissive lookup used by config application and key validation so old config names continue to parse.

*Call graph*: calls 1 internal fn (feature_for_key); called by 2 (apply_map, is_known_feature_key).


##### `canonical_feature_for_key`  (lines 600–605)

```
fn canonical_feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: Resolves only canonical registry keys, excluding legacy aliases.

**Data flow**: Searches `FEATURES` for a spec whose `key` equals the input string and maps the found spec to its `id`; otherwise returns `None`.

**Call relations**: Used where callers need to distinguish canonical names from compatibility aliases rather than accepting both.


##### `is_known_feature_key`  (lines 608–610)

```
fn is_known_feature_key(key: &str) -> bool
```

**Purpose**: Checks whether a string is recognized as any valid feature key, canonical or legacy.

**Data flow**: Delegates to `feature_for_key` and returns whether the result is `Some(_)`.

**Call relations**: Provides a simple validation helper for config or CLI parsing paths that only need a yes/no answer.

*Call graph*: calls 1 internal fn (feature_for_key).


##### `Features::apply_toml`  (lines 629–632)

```
fn apply_toml(&mut self, features: &FeaturesToml)
```

**Purpose**: Applies a deserialized `FeaturesToml` table to the effective feature set.

**Data flow**: Calls `features.entries()` to flatten structured feature configs into a `BTreeMap<String, bool>`, then passes that map to `apply_map` for actual mutation.

**Call relations**: This is the bridge between TOML-specific representation and the generic map-based application logic used by `from_sources`.

*Call graph*: calls 2 internal fn (apply_map, entries).


##### `FeaturesToml::clear_removed_compatibility_entries`  (lines 638–641)

```
fn clear_removed_compatibility_entries(&mut self)
```

**Purpose**: Removes compatibility-only fields that should not survive into newly materialized config.

**Data flow**: Mutably borrows `self`, sets `removed_apps_mcp_path_override` to `None`, and removes the `apps_mcp_path_override` key from the flattened `entries` map.

**Call relations**: Called before writing resolved feature state back into TOML so obsolete compatibility inputs are not preserved.

*Call graph*: called by 1 (materialize_resolved_enabled).


##### `FeaturesToml::entries`  (lines 643–655)

```
fn entries(&self) -> BTreeMap<String, bool>
```

**Purpose**: Produces a flat key→bool view of the feature table, including `enabled` bits extracted from structured feature configs.

**Data flow**: Clones `self.entries`, then for `code_mode`, `multi_agent_v2`, and `network_proxy` checks whether the optional `FeatureToml` contains an enabled value via `FeatureToml::enabled`; when present, it inserts the canonical feature key with that boolean into the returned map.

**Call relations**: Used by `Features::apply_toml` and tests to normalize mixed TOML shapes into the same boolean map consumed by feature resolution.

*Call graph*: called by 1 (apply_toml).


##### `FeaturesToml::materialize_resolved_enabled`  (lines 657–681)

```
fn materialize_resolved_enabled(&mut self, features: &Features)
```

**Purpose**: Overwrites the TOML representation so it explicitly reflects a resolved `Features` state while preserving structured config payloads.

**Data flow**: Mutably borrows `self` and reads `features`. It first clears removed compatibility entries, removes all legacy alias keys from `entries`, then iterates over every `FeatureSpec` in `FEATURES`. For `CodeMode`, `MultiAgentV2`, and `NetworkProxy`, it updates or creates the corresponding structured `FeatureToml` via `materialize_resolved_feature_enabled`; for all other features it writes the canonical key and current enabled boolean into `entries`.

**Call relations**: Used when persisting or replaying resolved config so the serialized feature table is canonical, complete, and still retains extra structured settings for richer features.

*Call graph*: calls 4 internal fn (enabled, clear_removed_compatibility_entries, legacy_feature_keys, materialize_resolved_feature_enabled).


##### `materialize_resolved_feature_enabled`  (lines 684–692)

```
fn materialize_resolved_feature_enabled(
    feature: &mut Option<FeatureToml<T>>,
    enabled: bool,
)
```

**Purpose**: Sets the `enabled` state inside an optional structured feature config, creating a simple boolean form when absent.

**Data flow**: Takes `&mut Option<FeatureToml<T>>` and a boolean. If the option is `Some`, it mutates the contained `FeatureToml` via `set_enabled`; if `None`, it replaces it with `Some(FeatureToml::Enabled(enabled))`.

**Call relations**: Called by `FeaturesToml::materialize_resolved_enabled` for the small set of features that support richer nested config.

*Call graph*: called by 1 (materialize_resolved_enabled); 1 external calls (Enabled).


##### `FeaturesToml::from`  (lines 695–700)

```
fn from(entries: BTreeMap<String, bool>) -> Self
```

**Purpose**: Builds a `FeaturesToml` from an already-flat map of boolean entries.

**Data flow**: Consumes a `BTreeMap<String, bool>` and returns a `FeaturesToml` with that map in `entries` and all other fields filled from `Default::default()`.

**Call relations**: Used heavily in tests and simple callers that only need boolean feature toggles without structured sub-configs.

*Call graph*: called by 11 (resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature, feature_table_overrides_legacy_flags, memory_tool_makes_memories_root_readable_without_creating_or_widening_writes, responses_websocket_features_do_not_change_wire_api, resolve_windows_sandbox_mode_falls_back_to_legacy_keys, from_sources_ignores_removed_apply_patch_freeform_feature_key, from_sources_ignores_removed_image_detail_original_feature_key, from_sources_ignores_removed_js_repl_feature_keys, from_sources_ignores_removed_plugin_hooks_feature_key, from_sources_ignores_removed_terminal_resize_reflow_feature_key (+1 more)); 1 external calls (default).


##### `FeatureToml::enabled`  (lines 713–718)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: Extracts the effective enabled bit from either a plain boolean feature value or a structured feature config.

**Data flow**: Matches on `self`: `Enabled(bool)` returns `Some(bool)`, while `Config(T)` delegates to the config object’s `FeatureConfig::enabled()` method and returns that optional value.

**Call relations**: Used when flattening TOML into boolean entries so structured feature sections participate in normal feature resolution.


##### `FeatureToml::set_enabled`  (lines 720–725)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: Mutates the enabled bit regardless of whether the feature is stored as a bare boolean or a structured config object.

**Data flow**: Matches on `self`: for `Enabled(value)` it overwrites the bool directly; for `Config(config)` it delegates to `FeatureConfig::set_enabled(enabled)`.

**Call relations**: Used during config materialization to preserve structured settings while synchronizing their `enabled` field with resolved feature state.


##### `unstable_features_warning_event`  (lines 1278–1325)

```
fn unstable_features_warning_event(
    effective_features: Option<&Table>,
    suppress_unstable_features_warning: bool,
    features: &Features,
    config_path: &str,
) -> Option<Event>
```

**Purpose**: Builds a protocol warning event listing under-development features that are explicitly enabled in config and active in the resolved feature set.

**Data flow**: Takes an optional TOML `Table`, a suppression flag, the resolved `Features`, and the config path. It returns early with `None` if suppression is enabled. Otherwise it scans the table entries, treating either `key = true` or `{ enabled = true }` as enabled, resolves each key against the canonical registry, filters to features that are both enabled in `features` and staged `UnderDevelopment`, sorts their keys, and if any remain constructs an `Event { msg: EventMsg::Warning(WarningEvent { message }) }` with a message mentioning the config path. If none qualify, it returns `None`.

**Call relations**: Called after config resolution to surface a user-facing warning. It intentionally cross-checks both raw config and resolved state so disabled or ignored entries do not produce false positives.

*Call graph*: calls 1 internal fn (enabled); 5 external calls (new, new, format!, matches!, Warning).


### `core/src/config/managed_features.rs`

`config` · `config load and later feature mutation`

This file centers on `ManagedFeatures`, a small stateful wrapper containing a `ConstrainedWithSource<Features>` and a `BTreeMap<Feature, bool>` of pinned feature requirements. The wrapper exists so feature policy is enforced both at construction time and on later mutations: every candidate `Features` value is first rewritten by `normalize_candidate`, which force-applies pinned values and then calls `Features::normalize_dependencies()` so dependent flags settle into a valid shape before validation runs. Construction accepts optional sourced `FeatureRequirementsToml`; those requirements are parsed into canonical `Feature` keys, with compatibility handling for the legacy `auto_review` key and warnings for legacy aliases or unknown entries.

Validation happens in two forms. `validate_pinned_features_constraint` produces a `ConstraintError::InvalidValue` with the original `RequirementSource` when a normalized feature set still disagrees with required pins; `validate_pinned_features` adapts that into `std::io::Error` for config-loading paths. The file also validates raw `ConfigToml` before feature synthesis: `explicit_feature_settings_in_config` extracts only user-explicit feature settings from both `[features]` and the special `experimental_use_unified_exec_tool` field, and `validate_explicit_feature_settings_in_config_toml` rejects direct config values that contradict pinned requirements. A separate helper, `validate_feature_requirements_in_config_toml`, builds `Features` via `Features::from_sources` and then reuses `ManagedFeatures` construction, ensuring the same normalization and policy checks are applied during config validation as during runtime feature management.

#### Function details

##### `ManagedFeatures::default`  (lines 30–38)

```
fn default() -> Self
```

**Purpose**: Builds an unconstrained `ManagedFeatures` with default `Features` and no pinned requirements. It is the zero-policy baseline used when no feature requirements source exists.

**Data flow**: Reads no external state. It creates `Features::default()`, wraps it in `Constrained::allow_any`, then in `ConstrainedWithSource::new` with `source` set to `None`, and initializes `pinned_features` as an empty `BTreeMap`.

**Call relations**: This is the default constructor for the type rather than part of the policy-loading path. It delegates all constraint wrapper setup to the `codex_config` constructors so later methods can use the same `ConstrainedWithSource` API regardless of whether requirements were present.

*Call graph*: calls 2 internal fn (new, allow_any); 2 external calls (new, default).


##### `ManagedFeatures::from_configured`  (lines 42–51)

```
fn from_configured(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
    ) -> std::io::Result<Self>
```

**Purpose**: Constructs a managed feature set from already-computed `Features` plus optional sourced requirements, without collecting startup warnings. It is the standard entry used by validation and runtime setup when warnings are not needed by the caller.

**Data flow**: Consumes `configured_features` and an optional `Sourced<FeatureRequirementsToml>`, forwards them with `None` for warning storage, and returns either a validated `ManagedFeatures` or an `std::io::Error` if requirements are violated.

**Call relations**: It is invoked by config-validation and bootstrap-related callers that need a yes/no result. The function is only a thin wrapper over `ManagedFeatures::from_configured_with_optional_warnings`, centralizing the real parsing, normalization, and validation there.

*Call graph*: called by 3 (resolve_bootstrap_auth_keyring_backend_kind, validate_feature_requirements_in_config_toml, guardian_review_session_config_allows_pinned_disabled_feature); 1 external calls (from_configured_with_optional_warnings).


##### `ManagedFeatures::from_configured_with_warnings`  (lines 53–63)

```
fn from_configured_with_warnings(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
        startup_warnings: &mut Vec<String>,
    ) -> st
```

**Purpose**: Constructs a managed feature set like `from_configured`, but also records non-fatal parsing warnings such as legacy or unknown requirement keys. It is used when config loading wants to surface warnings to the user.

**Data flow**: Consumes `configured_features`, optional sourced requirements, and a mutable `Vec<String>` for warnings; passes the warning sink as `Some(&mut Vec<String>)` into the shared constructor and returns the same `std::io::Result<ManagedFeatures>`.

**Call relations**: This path is used by the layered config loader so warnings can be accumulated during startup. It delegates all substantive work to `ManagedFeatures::from_configured_with_optional_warnings`.

*Call graph*: called by 1 (load_config_with_layer_stack); 1 external calls (from_configured_with_optional_warnings).


##### `ManagedFeatures::from_configured_with_optional_warnings`  (lines 65–87)

```
fn from_configured_with_optional_warnings(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
        startup_warnings: Option<&mut Vec<Stri
```

**Purpose**: Performs the full construction pipeline: parse requirement pins, normalize the configured feature set against those pins, validate the result, and store both the normalized value and requirement source. This is the file's main constructor.

**Data flow**: Takes owned `configured_features`, optional sourced `FeatureRequirementsToml`, and an optional mutable warning sink. If requirements are present, it destructures `Sourced` into `value` and `source`, parses entries into a `BTreeMap<Feature, bool>`, and preserves the source; otherwise it uses empty pins and no source. It then rewrites the candidate through `normalize_candidate`, validates pinned consistency via `validate_pinned_features`, and on success returns a `ManagedFeatures` whose `value` is `ConstrainedWithSource::new(Constrained::allow_any(normalized_features), source)` and whose `pinned_features` are the parsed pins.

**Call relations**: Both public constructors funnel into this method. It orchestrates the helper functions in order—parse, normalize, validate—so all callers get identical behavior and error formatting.

*Call graph*: calls 5 internal fn (new, allow_any, normalize_candidate, parse_feature_requirements, validate_pinned_features); 1 external calls (new).


##### `ManagedFeatures::get`  (lines 89–91)

```
fn get(&self) -> &Features
```

**Purpose**: Returns an immutable reference to the current underlying `Features` value. It is the canonical accessor used internally and by deref.

**Data flow**: Reads `self.value` and returns `self.value.get()`, exposing `&Features` without modifying any state.

**Call relations**: Called by `ManagedFeatures::deref` to support transparent access and by `ManagedFeatures::set_enabled` to clone the current feature set before mutation.

*Call graph*: called by 2 (deref, set_enabled); 1 external calls (get).


##### `ManagedFeatures::normalize_and_validate`  (lines 93–102)

```
fn normalize_and_validate(&self, candidate: Features) -> ConstraintResult<Features>
```

**Purpose**: Applies the same normalization and policy checks used at construction time to a prospective replacement `Features` value. It is the shared gate for mutation APIs.

**Data flow**: Consumes an owned candidate `Features`, rewrites it with `normalize_candidate` using `self.pinned_features`, asks `self.value.can_set(&normalized)` to satisfy any underlying `Constrained` rules, then checks pinned-feature consistency with `validate_pinned_features_constraint` using the stored requirement source. On success it returns the normalized `Features`; on failure it returns a `ConstraintError`.

**Call relations**: This helper is called by both `ManagedFeatures::can_set` and `ManagedFeatures::set`. It centralizes mutation-time enforcement so probing and actual updates use identical normalization and validation logic.

*Call graph*: calls 2 internal fn (normalize_candidate, validate_pinned_features_constraint); called by 2 (can_set, set); 1 external calls (can_set).


##### `ManagedFeatures::can_set`  (lines 104–106)

```
fn can_set(&self, candidate: &Features) -> ConstraintResult<()>
```

**Purpose**: Checks whether a candidate feature set would be accepted after normalization, without mutating the current state. It is the non-destructive validation API.

**Data flow**: Borrows a candidate `&Features`, clones it to obtain ownership for normalization, passes it to `normalize_and_validate`, and maps a successful normalized result to `()`. It writes no state.

**Call relations**: This is the read-only counterpart to `ManagedFeatures::set`. It exists for callers that need to test a change path before committing, while still exercising the same normalization and pinned-feature checks.

*Call graph*: calls 1 internal fn (normalize_and_validate); 1 external calls (clone).


##### `ManagedFeatures::set`  (lines 108–111)

```
fn set(&mut self, candidate: Features) -> ConstraintResult<()>
```

**Purpose**: Replaces the current feature set with a normalized, validated candidate. It is the main mutation primitive for the wrapper.

**Data flow**: Consumes an owned candidate `Features`, transforms it through `normalize_and_validate`, and if validation succeeds writes the normalized value into `self.value.value` via the inner `Constrained::set`. It returns `ConstraintResult<()>` indicating success or the specific constraint failure.

**Call relations**: Called by `ManagedFeatures::set_enabled` after toggling a single flag. It relies on `normalize_and_validate` so all updates preserve pinned requirements and dependency normalization.

*Call graph*: calls 1 internal fn (normalize_and_validate); called by 1 (set_enabled).


##### `ManagedFeatures::set_enabled`  (lines 113–117)

```
fn set_enabled(&mut self, feature: Feature, enabled: bool) -> ConstraintResult<()>
```

**Purpose**: Toggles one specific `Feature` on a copy of the current feature set and then commits the change through full validation. It provides a convenient single-flag mutation API.

**Data flow**: Reads the current `Features` via `get()`, clones it, applies `next.set_enabled(feature, enabled)`, then passes the modified copy into `set`. Any normalization side effects or constraint failures happen in that downstream call.

**Call relations**: This helper underpins both `ManagedFeatures::enable` and `ManagedFeatures::disable`. It keeps single-feature edits on the same code path as whole-set replacement.

*Call graph*: calls 2 internal fn (get, set); called by 2 (disable, enable).


##### `ManagedFeatures::enable`  (lines 119–121)

```
fn enable(&mut self, feature: Feature) -> ConstraintResult<()>
```

**Purpose**: Enables one feature through the managed mutation path. It is a convenience wrapper for callers that want a semantic enable operation.

**Data flow**: Takes a `Feature`, forwards it with `enabled = true` to `set_enabled`, and returns the resulting `ConstraintResult<()>`.

**Call relations**: This is a thin wrapper over `ManagedFeatures::set_enabled`, used when callers want to express intent directly rather than pass a boolean.

*Call graph*: calls 1 internal fn (set_enabled).


##### `ManagedFeatures::disable`  (lines 123–125)

```
fn disable(&mut self, feature: Feature) -> ConstraintResult<()>
```

**Purpose**: Disables one feature through the managed mutation path. It is the symmetric convenience wrapper to `enable`.

**Data flow**: Takes a `Feature`, forwards it with `enabled = false` to `set_enabled`, and returns the resulting `ConstraintResult<()>`.

**Call relations**: Like `ManagedFeatures::enable`, this delegates all real work to `ManagedFeatures::set_enabled` so disable operations still undergo normalization and pinned-feature enforcement.

*Call graph*: calls 1 internal fn (set_enabled).


##### `ManagedFeatures::from`  (lines 132–140)

```
fn from(features: Features) -> Self
```

**Purpose**: Provides a test-only conversion from raw `Features` into unconstrained `ManagedFeatures`. It lets tests construct the wrapper without supplying requirement metadata.

**Data flow**: Consumes a `Features` value, wraps it in `Constrained::allow_any`, then `ConstrainedWithSource::new` with no source, and initializes an empty `pinned_features` map.

**Call relations**: This implementation is compiled only under `#[cfg(test)]` and is used by tests that need a `ManagedFeatures` instance but are not exercising requirement parsing or validation.

*Call graph*: calls 2 internal fn (new, allow_any); called by 4 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result); 1 external calls (new).


##### `ManagedFeatures::deref`  (lines 146–148)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows `ManagedFeatures` to be used as `&Features` through Rust's deref coercion. It makes the wrapper ergonomic for read-only feature access.

**Data flow**: Borrows `self`, calls `get()`, and returns the resulting `&Features` as `&Self::Target`.

**Call relations**: This is a convenience adapter over `ManagedFeatures::get`; it does not participate in validation logic but reduces call-site boilerplate.

*Call graph*: calls 1 internal fn (get).


##### `normalize_candidate`  (lines 151–160)

```
fn normalize_candidate(
    mut candidate: Features,
    pinned_features: &BTreeMap<Feature, bool>,
) -> Features
```

**Purpose**: Rewrites a candidate feature set so pinned requirements are applied first and feature dependency rules are then normalized. It ensures validation sees the post-normalization state rather than the raw input.

**Data flow**: Takes an owned mutable `Features` and a borrowed `BTreeMap<Feature, bool>`. It iterates over every pinned `(feature, enabled)` pair, calling `candidate.set_enabled(*feature, *enabled)`, then calls `candidate.normalize_dependencies()`, and returns the modified `Features`.

**Call relations**: Used during both initial construction and later mutation validation. By centralizing this rewrite step, the file guarantees that pinned values and dependency-derived values are computed consistently everywhere.

*Call graph*: calls 2 internal fn (normalize_dependencies, set_enabled); called by 2 (from_configured_with_optional_warnings, normalize_and_validate).


##### `validate_pinned_features_constraint`  (lines 162–187)

```
fn validate_pinned_features_constraint(
    normalized_features: &Features,
    pinned_features: &BTreeMap<Feature, bool>,
    source: Option<&RequirementSource>,
) -> ConstraintResult<()>
```

**Purpose**: Checks that a normalized feature set still matches every pinned requirement and, if not, produces a structured `ConstraintError` that includes the requirement source and allowed values display. It is the core policy-enforcement check.

**Data flow**: Reads `normalized_features`, the pinned-feature map, and an optional `RequirementSource`. If no source is present it returns `Ok(())` immediately. Otherwise it builds an allowed-values string with `feature_requirements_display`, iterates through each pinned feature, compares `normalized_features.enabled(*feature)` to the required boolean, and returns `ConstraintError::InvalidValue` on the first mismatch; otherwise it returns success.

**Call relations**: Called directly from `ManagedFeatures::normalize_and_validate` for mutation-time constraint reporting and indirectly from config-loading paths through `validate_pinned_features`. It depends on the candidate already being normalized so mismatches represent true policy violations.

*Call graph*: calls 2 internal fn (feature_requirements_display, enabled); called by 2 (normalize_and_validate, validate_pinned_features); 1 external calls (format!).


##### `validate_pinned_features`  (lines 189–196)

```
fn validate_pinned_features(
    normalized_features: &Features,
    pinned_features: &BTreeMap<Feature, bool>,
    source: Option<&RequirementSource>,
) -> std::io::Result<()>
```

**Purpose**: Adapts pinned-feature validation into an `std::io::Result` suitable for config parsing and startup code. It bridges the constraint system with I/O-oriented error handling.

**Data flow**: Borrows normalized features, pinned features, and optional source; calls `validate_pinned_features_constraint`; on error wraps the returned `ConstraintError` in `std::io::ErrorKind::InvalidData`; otherwise returns `Ok(())`.

**Call relations**: Used by `ManagedFeatures::from_configured_with_optional_warnings`, where construction is part of config loading and therefore expected to report `std::io::Error` rather than `ConstraintError`.

*Call graph*: calls 1 internal fn (validate_pinned_features_constraint); called by 1 (from_configured_with_optional_warnings).


##### `feature_requirements_display`  (lines 198–204)

```
fn feature_requirements_display(feature_requirements: &BTreeMap<Feature, bool>) -> String
```

**Purpose**: Formats the pinned feature requirements into a stable bracketed string like `[feature_a=true, feature_b=false]` for diagnostics. It is used to populate the `allowed` field in validation errors.

**Data flow**: Borrows a `BTreeMap<Feature, bool>`, iterates in map order, converts each pair into `"<feature.key()>=<bool>"`, collects them into a `Vec<String>`, joins with `, `, and returns the final bracketed `String`.

**Call relations**: This helper is called by both pinned-feature validation and explicit-config validation so all user-facing errors describe the allowed requirement set in the same format.

*Call graph*: called by 2 (validate_explicit_feature_settings_in_config_toml, validate_pinned_features_constraint); 1 external calls (format!).


##### `parse_feature_requirements`  (lines 206–242)

```
fn parse_feature_requirements(
    feature_requirements: FeatureRequirementsToml,
    source: &RequirementSource,
    mut startup_warnings: Option<&mut Vec<String>>,
) -> BTreeMap<Feature, bool>
```

**Purpose**: Converts `FeatureRequirementsToml` entries into canonical pinned `Feature` booleans, while preserving backward compatibility and emitting warnings for legacy or unknown keys. It is the parser for policy requirements.

**Data flow**: Consumes `FeatureRequirementsToml`, borrows its `RequirementSource`, and optionally borrows a mutable warning vector. It iterates over `feature_requirements.entries`; the special key `auto_review` is mapped directly to `Feature::GuardianApproval`; canonical keys are resolved with `canonical_feature_for_key`; legacy-but-known keys are resolved with `feature_for_key` and generate a warning recommending `feature.key()`; unknown keys generate an ignore warning. Recognized entries are inserted into a `BTreeMap<Feature, bool>`, which is returned.

**Call relations**: Called during managed-feature construction and during explicit-config validation. It delegates warning emission to `push_feature_requirement_warning`, keeping parsing logic focused on key interpretation and map construction.

*Call graph*: calls 1 internal fn (push_feature_requirement_warning); called by 2 (from_configured_with_optional_warnings, validate_explicit_feature_settings_in_config_toml); 4 external calls (new, canonical_feature_for_key, feature_for_key, format!).


##### `push_feature_requirement_warning`  (lines 244–252)

```
fn push_feature_requirement_warning(
    startup_warnings: &mut Option<&mut Vec<String>>,
    message: String,
)
```

**Purpose**: Emits a feature-requirement warning to tracing and optionally stores the same message for startup reporting. It keeps warning side effects consistent across parsing cases.

**Data flow**: Takes a mutable optional warning sink and an owned message string. It logs the message with `tracing::warn!`, then, if a `Vec<String>` is present inside the option, pushes the same message into that vector.

**Call relations**: Used only by `parse_feature_requirements` for legacy-key and unknown-key cases. It separates warning transport from parsing decisions so callers can choose whether to collect warnings.

*Call graph*: called by 1 (parse_feature_requirements); 1 external calls (warn!).


##### `explicit_feature_settings_in_config`  (lines 254–272)

```
fn explicit_feature_settings_in_config(cfg: &ConfigToml) -> Vec<(String, Feature, bool)>
```

**Purpose**: Extracts only the feature values explicitly set in `ConfigToml`, along with their config paths and resolved `Feature` identities. This lets validation distinguish direct user settings from derived defaults.

**Data flow**: Borrows `ConfigToml` and builds a `Vec<(String, Feature, bool)>`. It scans `cfg.features` if present, iterates over `features.entries()`, resolves each key with `feature_for_key`, and records tuples like `("features.<key>", feature, enabled)` for recognized keys. It also checks `cfg.experimental_use_unified_exec_tool` and, if set, records it as `("experimental_use_unified_exec_tool", Feature::UnifiedExec, enabled)`.

**Call relations**: This helper feeds `validate_explicit_feature_settings_in_config_toml`. It intentionally focuses on explicit config knobs rather than normalized feature state so error messages can point to the exact conflicting field.

*Call graph*: called by 1 (validate_explicit_feature_settings_in_config_toml); 3 external calls (new, feature_for_key, format!).


##### `validate_explicit_feature_settings_in_config_toml`  (lines 274–314)

```
fn validate_explicit_feature_settings_in_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Rejects `ConfigToml` files that explicitly set a feature value contrary to pinned requirements, before broader feature synthesis occurs. It catches direct config contradictions with precise field-path diagnostics.

**Data flow**: Borrows `ConfigToml` and an optional sourced requirements object. If no requirements are present, it returns success. Otherwise it clones and parses the requirements into pinned features, returns early if the parsed map is empty, computes the allowed display string, then iterates over tuples from `explicit_feature_settings_in_config`. For each explicit setting, if the same feature is pinned to the opposite boolean, it returns `std::io::ErrorKind::InvalidData` containing `ConstraintError::InvalidValue` with `candidate` formatted as `<path>=<enabled>` and the cloned requirement source. If no conflicts are found, it returns `Ok(())`.

**Call relations**: Called by higher-level config validation before or alongside broader feature checks. It delegates requirement parsing and explicit-setting extraction to helpers so this function can focus on conflict detection and error construction.

*Call graph*: calls 3 internal fn (explicit_feature_settings_in_config, feature_requirements_display, parse_feature_requirements); called by 1 (validate_feature_requirements_for_config_toml); 2 external calls (new, format!).


##### `validate_feature_requirements_in_config_toml`  (lines 316–329)

```
fn validate_feature_requirements_in_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Validates that the effective feature set derived from `ConfigToml` satisfies feature requirements after normal feature-source merging and dependency normalization. It is the end-to-end config-level requirement check.

**Data flow**: Borrows `ConfigToml` and optional sourced requirements. It constructs `configured_features` by calling `Features::from_sources` with a `FeatureConfigSource` built from `cfg.features` and `cfg.experimental_use_unified_exec_tool`, plus default secondary source and default overrides. It then clones the optional requirements and passes both into `ManagedFeatures::from_configured`; success is mapped to `()`, and any construction failure becomes the returned `std::io::Error`.

**Call relations**: This function is invoked by higher-level config validation code. Rather than reimplementing policy logic, it routes through `ManagedFeatures::from_configured` so config validation uses the exact same normalization and pinned-feature enforcement as runtime feature management.

*Call graph*: calls 2 internal fn (from_configured, from_sources); called by 1 (validate_feature_requirements_for_config_toml); 2 external calls (default, default).


### `tui/src/bottom_pane/experimental_features_view.rs`

`domain_logic` · `interactive popup handling`

This file defines two structs: `ExperimentalFeatureItem`, which pairs a concrete `Feature` enum value with display strings and an `enabled` flag, and `ExperimentalFeaturesView`, which owns the popup UI state. The view stores the feature list, a shared `ScrollState` for selection and scrolling, a `complete` flag used by the bottom-pane lifecycle, an `AppEventSender` for persistence, a prebuilt header renderable, a footer hint line, and the configured `ListKeymap`.

Construction builds a two-line header, computes the footer hint, and initializes selection to the first row when any features exist. Rendering uses the shared popup styling (`user_message_style`), computes header and row heights with `measure_rows_height`, and delegates row drawing to `render_rows`. Each row is synthesized from the current feature state as `› [x] Name` or `  [ ] Name`, with the description shown underneath. Empty lists still render a stable popup with the fallback message "No experimental features available for now".

Keyboard handling is intentionally simple: list-navigation keys move within the bounded popup window, space toggles the currently selected feature in memory, and either accept or cancel triggers `on_ctrl_c`, which is treated as the save-and-close path. On close, the view emits a single `AppEvent::UpdateFeatureFlags { updates }` containing every feature’s current boolean state, but only if the list is non-empty. The design choice here is that there is no separate dirty tracking or explicit save keypath—closing always commits the current toggles.

#### Function details

##### `ExperimentalFeaturesView::new`  (lines 52–74)

```
fn new(
        features: Vec<ExperimentalFeatureItem>,
        app_event_tx: AppEventSender,
        keymap: ListKeymap,
    ) -> Self
```

**Purpose**: Constructs the popup view from a prepared list of experimental features, the app event sender, and the list keymap. It also builds the static header and footer hint content and ensures the initial selection is valid.

**Data flow**: Consumes `features: Vec<ExperimentalFeatureItem>`, `app_event_tx: AppEventSender`, and `keymap: ListKeymap` → creates a `ColumnRenderable` header with bold title and dim explanatory subtitle, stores all fields in `ExperimentalFeaturesView`, computes `footer_hint` via `experimental_popup_hint_line`, then calls `initialize_selection` → returns a fully initialized view with `complete = false` and `ScrollState::new()`.

**Call relations**: This is the entry constructor used when the experimental-features popup is opened or instantiated in tests. After construction, later interaction flows through `handle_key_event`, rendering through `render`, and final persistence through `on_ctrl_c`.

*Call graph*: calls 3 internal fn (experimental_popup_hint_line, new, new); called by 3 (open_experimental_popup, experimental_features_popup_snapshot, experimental_features_toggle_saves_on_exit); 2 external calls (new, from).


##### `ExperimentalFeaturesView::initialize_selection`  (lines 76–82)

```
fn initialize_selection(&mut self)
```

**Purpose**: Sets the initial selected row based on whether any features are visible. It avoids overwriting an existing selection if one is already present.

**Data flow**: Reads `self.features.len()` through `visible_len` and the current `self.state.selected_idx` → if there are no rows, clears selection to `None`; otherwise, if no selection exists yet, sets it to `Some(0)` → mutates only `self.state.selected_idx`.

**Call relations**: Called during construction to normalize selection state before the popup is first rendered. It depends on `visible_len` so the same empty/non-empty logic stays centralized.

*Call graph*: calls 1 internal fn (visible_len).


##### `ExperimentalFeaturesView::visible_len`  (lines 84–86)

```
fn visible_len(&self) -> usize
```

**Purpose**: Reports how many feature rows the popup currently exposes. In this view there is no filtering, so it is just the feature vector length.

**Data flow**: Reads `self.features` → returns `self.features.len()` as `usize` without mutating state.

**Call relations**: Used by all navigation helpers and initialization so movement and selection bounds always reflect the current feature count.

*Call graph*: called by 7 (initialize_selection, jump_bottom, jump_top, move_down, move_up, page_down, page_up).


##### `ExperimentalFeaturesView::build_rows`  (lines 88–107)

```
fn build_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Transforms the internal feature list into the generic row model expected by the shared popup row renderer. It embeds both selection state and enabled state into the row label.

**Data flow**: Reads `self.features` and `self.state.selected_idx` → iterates over each item, computes a leading selection glyph (`›` or space), a checkbox marker (`x` or space), formats the visible name string, clones the item description into `GenericDisplayRow.description`, and collects rows into a `Vec<GenericDisplayRow>` → returns the rendered row model.

**Call relations**: This is the bridge between domain state and generic popup rendering. Both `render` and `desired_height` call it so measurement and drawing use identical row content.

*Call graph*: called by 2 (desired_height, render); 3 external calls (default, with_capacity, format!).


##### `ExperimentalFeaturesView::move_up`  (lines 109–116)

```
fn move_up(&mut self)
```

**Purpose**: Moves the selection upward with wraparound and keeps the selected row inside the visible popup window. It is a no-op when there are no features.

**Data flow**: Reads current row count via `visible_len` → if zero, returns immediately; otherwise mutates `self.state` with `move_up_wrap(len)` and then `ensure_visible(len, MAX_POPUP_ROWS.min(len))` → returns unit.

**Call relations**: Invoked from `handle_key_event` when the configured up binding is pressed. It delegates all cursor arithmetic and scroll-window maintenance to `ScrollState`.

*Call graph*: calls 3 internal fn (visible_len, ensure_visible, move_up_wrap); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::move_down`  (lines 118–125)

```
fn move_down(&mut self)
```

**Purpose**: Moves the selection downward with wraparound and updates scroll position so the selected row remains visible. It ignores input when the list is empty.

**Data flow**: Reads row count via `visible_len` → if zero, exits; otherwise mutates `self.state` using `move_down_wrap(len)` and `ensure_visible(len, MAX_POPUP_ROWS.min(len))` → returns unit.

**Call relations**: Triggered by `handle_key_event` for the down binding. It mirrors `move_up` but advances forward through the feature list.

*Call graph*: calls 3 internal fn (visible_len, ensure_visible, move_down_wrap); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::page_up`  (lines 127–131)

```
fn page_up(&mut self)
```

**Purpose**: Moves selection upward by a page without wrapping, clamped to the top of the list. The page size is the smaller of the popup row cap and the current list length.

**Data flow**: Reads `len = visible_len()` and computes `visible = MAX_POPUP_ROWS.min(len)` → mutates `self.state` via `page_up_clamped(len, visible)` → returns unit.

**Call relations**: Called from `handle_key_event` for page-up bindings. It relies on `ScrollState` for the exact clamped paging behavior.

*Call graph*: calls 2 internal fn (visible_len, page_up_clamped); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::page_down`  (lines 133–137)

```
fn page_down(&mut self)
```

**Purpose**: Moves selection downward by a page without wrapping, clamped to the bottom of the list. It uses the popup’s maximum visible row count as the page size.

**Data flow**: Reads `len = visible_len()` and computes `visible = MAX_POPUP_ROWS.min(len)` → mutates `self.state` with `page_down_clamped(len, visible)` → returns unit.

**Call relations**: Reached from `handle_key_event` when the page-down binding is pressed. It is the downward counterpart to `page_up`.

*Call graph*: calls 2 internal fn (visible_len, page_down_clamped); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::jump_top`  (lines 139–143)

```
fn jump_top(&mut self)
```

**Purpose**: Moves selection directly to the first row and adjusts scroll state accordingly. It uses the same visible-window size as the other navigation helpers.

**Data flow**: Reads `len = visible_len()` and `visible = MAX_POPUP_ROWS.min(len)` → mutates `self.state` through `jump_top(len, visible)` → returns unit.

**Call relations**: Dispatched by `handle_key_event` for the jump-to-top binding. It centralizes top-of-list behavior in `ScrollState`.

*Call graph*: calls 2 internal fn (visible_len, jump_top); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::jump_bottom`  (lines 145–149)

```
fn jump_bottom(&mut self)
```

**Purpose**: Moves selection directly to the last row and scrolls so the bottom selection is visible. It is safe even when the list is empty because `ScrollState` handles the bounds.

**Data flow**: Reads `len = visible_len()` and `visible = MAX_POPUP_ROWS.min(len)` → mutates `self.state` via `jump_bottom(len, visible)` → returns unit.

**Call relations**: Called from `handle_key_event` for the jump-to-bottom binding. It complements `jump_top`.

*Call graph*: calls 2 internal fn (visible_len, jump_bottom); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::toggle_selected`  (lines 151–159)

```
fn toggle_selected(&mut self)
```

**Purpose**: Flips the `enabled` flag of the currently selected experimental feature in local UI state. It does not persist immediately.

**Data flow**: Reads `self.state.selected_idx` → if no selection, returns; otherwise looks up the mutable `ExperimentalFeatureItem` at that index and negates `item.enabled` → mutates `self.features[selected_idx].enabled` in place.

**Call relations**: Used only from `handle_key_event` when the user presses plain space. Persistence is deferred until `on_ctrl_c` sends the aggregate update event.

*Call graph*: called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::rows_width`  (lines 161–163)

```
fn rows_width(total_width: u16) -> u16
```

**Purpose**: Computes the effective width available to row rendering inside the popup content area. It reserves two columns from the total width.

**Data flow**: Takes `total_width: u16` → returns `total_width.saturating_sub(2)`.

**Call relations**: A small measurement helper used by both `render` and `desired_height` so row measurement and row drawing agree on available width.


##### `ExperimentalFeaturesView::handle_key_event`  (lines 167–187)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Maps keyboard input to list navigation, toggling, and popup completion. Accept and cancel intentionally share the same save-and-close path.

**Data flow**: Consumes a `KeyEvent` and reads `self.keymap` plus literal space matching → dispatches to movement helpers, `toggle_selected`, or `on_ctrl_c`; unmatched keys are ignored → mutates selection, feature flags, and possibly completion state / outbound events.

**Call relations**: This is the main interaction entrypoint required by `BottomPaneView`. It fans out to the navigation helpers for movement and to `on_ctrl_c` when the user accepts or cancels.

*Call graph*: calls 8 internal fn (jump_bottom, jump_top, move_down, move_up, on_ctrl_c, page_down, page_up, toggle_selected).


##### `ExperimentalFeaturesView::is_complete`  (lines 189–191)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the popup has finished and should be removed from the bottom pane.

**Data flow**: Reads `self.complete` → returns it as `bool`.

**Call relations**: Queried by the surrounding bottom-pane controller after `handle_key_event` or cancellation paths update completion.


##### `ExperimentalFeaturesView::on_ctrl_c`  (lines 193–207)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Commits the current feature toggle states and marks the popup complete. In this view, Ctrl+C semantics are repurposed as the generic close/save action.

**Data flow**: Reads `self.features` → if non-empty, maps each `ExperimentalFeatureItem` to `(item.feature, item.enabled)` and sends `AppEvent::UpdateFeatureFlags { updates }` through `self.app_event_tx`; then sets `self.complete = true` → returns `CancellationEvent::Handled`.

**Call relations**: Reached from `handle_key_event` for both accept and cancel bindings. It is the only place that emits the persistence event, so all exits converge here.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::render`  (lines 211–267)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the popup surface, header, feature rows, and footer hint into the provided buffer. It also handles empty-area and empty-list cases gracefully.

**Data flow**: Reads `area`, `self.header`, `self.state`, `self.features`, and `self.footer_hint` → early-returns on zero-sized areas; splits the area into content and footer, paints a styled `Block`, measures header and rows, insets the content, renders the header, renders rows via `render_rows` with an empty-list message, then renders the dimmed footer hint shifted two columns right → writes styled cells into `buf`.

**Call relations**: Called by the TUI rendering pipeline whenever the popup is visible. It depends on `build_rows` and `measure_rows_height` so the visual layout matches `desired_height`.

*Call graph*: calls 5 internal fn (build_rows, measure_rows_height, render_rows, vh, user_message_style); 7 external calls (default, Fill, Length, Max, vertical, clone, rows_width).


##### `ExperimentalFeaturesView::desired_height`  (lines 269–282)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes how tall the popup wants to be for a given width, including header, list rows, spacing, and footer. The result tracks wrapped row descriptions.

**Data flow**: Reads `width`, builds rows with `build_rows`, computes row width via `rows_width`, measures row height with `measure_rows_height`, asks the header for its desired height, then adds fixed spacing and one footer line → returns total `u16` height using saturating arithmetic.

**Call relations**: Used by layout code before rendering. It mirrors the same row-building and measurement logic used in `render` so the allocated area is sufficient.

*Call graph*: calls 2 internal fn (build_rows, measure_rows_height); 1 external calls (rows_width).


##### `experimental_popup_hint_line`  (lines 285–293)

```
fn experimental_popup_hint_line() -> Line<'static>
```

**Purpose**: Builds the static footer instruction line shown at the bottom of the experimental-features popup.

**Data flow**: Constructs a `Line<'static>` from literal spans and key-hint spans for space and Enter → returns the composed line.

**Call relations**: Called only by `ExperimentalFeaturesView::new` to precompute the footer hint once instead of rebuilding it on every render.

*Call graph*: called by 1 (new); 2 external calls (from, vec!).


### Skills configuration and installation
These files describe skill-related config, install bundled system skills, seed extension assets, and load the final filtered skill set for runtime use.

### `config/src/skills_config.rs`

`data_model` · `config load`

This file is a compact data-model module for skill configuration. `SkillConfig` represents one rule entry with two optional selectors — `path: Option<AbsolutePathBuf>` for path-based matching and `name: Option<String>` for name-based matching — plus a required `enabled: bool` flag. `SkillsConfig` groups the overall settings: an optional `bundled` block, an optional `include_instructions` toggle controlling whether turns receive the automatic skills instructions block, and a `config: Vec<SkillConfig>` list of explicit rules. `BundledSkillsConfig` currently contains only `enabled`, but it is modeled as its own struct so the bundled-skills subsection can evolve independently.

All three structs derive `Serialize`, `Deserialize`, `JsonSchema`, and equality/debug traits, and use `#[schemars(deny_unknown_fields)]` so schema generation and strict deserialization reject stray keys. Serialization is intentionally sparse: optional fields are omitted when `None`, and the rule list is omitted when empty. The bundled-skills `enabled` field defaults to `true`, both through serde (`default_enabled`) and the manual `Default` impl, preserving the invariant that bundled skills are on unless explicitly disabled. The `TryFrom<toml::Value>` impl makes raw TOML values directly deserializable into `SkillsConfig`, which is the bridge used by higher-level config loading code.

#### Function details

##### `default_enabled`  (lines 8–10)

```
fn default_enabled() -> bool
```

**Purpose**: Supplies the serde default for `BundledSkillsConfig.enabled`. It hard-codes bundled skills to be enabled when the field is omitted.

**Data flow**: Takes no inputs and reads no external state. It returns the boolean literal `true`, which serde uses while deserializing missing `enabled` fields.

**Call relations**: This helper is referenced by the `#[serde(default = "default_enabled")]` attribute on `BundledSkillsConfig.enabled`; it is not part of runtime control flow beyond deserialization defaults.


##### `BundledSkillsConfig::default`  (lines 46–48)

```
fn default() -> Self
```

**Purpose**: Constructs the default bundled-skills subsection with `enabled` set to true. It mirrors the serde default so programmatic construction and deserialization behave the same way.

**Data flow**: Consumes no arguments and creates a new `BundledSkillsConfig { enabled: true }`. It writes no state and returns the struct by value.

**Call relations**: Called anywhere a default bundled-skills config is needed through Rust's `Default` trait; it exists to keep the type's default aligned with the field-level serde default.


##### `SkillsConfig::try_from`  (lines 54–56)

```
fn try_from(value: toml::Value) -> Result<Self, Self::Error>
```

**Purpose**: Deserializes a raw `toml::Value` into the typed `SkillsConfig` structure. This is the entry point for converting merged or extracted TOML config into the skill-specific schema.

**Data flow**: Takes ownership of a `toml::Value`, passes it into `SkillsConfig::deserialize`, and returns either a populated `SkillsConfig` or a `toml::de::Error`. It does not mutate external state.

**Call relations**: Used by higher-level config parsing when a TOML subtree needs to become a `SkillsConfig`. Its only delegation is to serde deserialization, relying on the struct annotations in this file for validation and defaults.

*Call graph*: 1 external calls (deserialize).


### `ext/skills/src/config.rs`

`config` · `config load`

This file contains a single configuration data model, `SkillsExtensionConfig`, derived with `Clone`, `Debug`, `Eq`, and `PartialEq` so it can be copied, logged, and compared in setup and tests. The struct has two boolean fields with distinct effects. `include_instructions` controls whether the available-skills catalog is injected into model-visible context, which affects prompt construction and discoverability from the model’s perspective. `bundled_skills_enabled` controls whether built-in or packaged skills are eligible to appear during discovery, allowing hosts to disable bundled content while still potentially using other providers. There is no parsing or validation logic here; the file’s role is to define the shape of configuration passed in from elsewhere. The design is intentionally narrow and explicit: rather than a generic map of options, the extension consumes a typed config object with stable field names, making feature gating straightforward and reducing ambiguity about which behaviors are host-controlled.


### `skills/src/lib.rs`

`domain_logic` · `startup`

This library exposes the on-disk cache location for embedded skills and the installation routine that materializes those assets under `CODEX_HOME/skills/.system`. The embedded source tree is compiled in with `include_dir!` as `SYSTEM_SKILLS_DIR`; constants define the destination directory names and the marker filename used for change detection.

`install_system_skills` first ensures `CODEX_HOME/skills` exists, computes the destination `.system` directory, and derives an expected fingerprint from the embedded directory contents. If the destination already exists as a directory and its marker file matches the current fingerprint, installation is skipped entirely. Otherwise any existing destination tree is removed, the embedded directory is written out recursively, and a marker file containing the fingerprint plus newline is written afterward.

Fingerprinting is deterministic: `collect_fingerprint_items` traverses embedded directories, recording directory paths with `None` and file paths with a content hash, and `embedded_system_skills_fingerprint` sorts those items by path before hashing a version salt plus each path/hash pair with `DefaultHasher`. This means both structure and file contents affect the marker. `write_embedded_dir` recreates directories and writes file bytes from the embedded tree, wrapping all filesystem failures in `SystemSkillsError::Io` with an action string. One subtle implementation detail is that recursive writes for subdirectories still join paths against the original destination root, relying on embedded paths being relative to the root tree.

#### Function details

##### `system_cache_root_dir`  (lines 18–22)

```
fn system_cache_root_dir(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Computes the absolute destination directory where embedded system skills should live under a given CODEX_HOME. It standardizes the `skills/.system` path layout.

**Data flow**: It takes an `&AbsolutePathBuf` for `codex_home`, appends `SKILLS_DIR_NAME` and then `SYSTEM_SKILLS_DIR_NAME` with `join`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: It is used by `install_system_skills` to derive the destination tree before marker checks and writes.

*Call graph*: calls 1 internal fn (join); called by 1 (install_system_skills).


##### `install_system_skills`  (lines 32–56)

```
fn install_system_skills(codex_home: &AbsolutePathBuf) -> Result<(), SystemSkillsError>
```

**Purpose**: Installs the embedded system skills tree into the user cache, skipping work when an on-disk fingerprint marker already matches the embedded assets. It is the main public entry point of the crate.

**Data flow**: It takes `codex_home`, creates `CODEX_HOME/skills`, computes `dest_system` via `system_cache_root_dir`, builds `marker_path`, and computes `expected_fingerprint` with `embedded_system_skills_fingerprint`. If `dest_system` is already a directory and `read_marker` returns the same fingerprint, it returns `Ok(())`. Otherwise it removes any existing destination directory, recursively writes the embedded tree with `write_embedded_dir`, writes the marker file containing the fingerprint and newline, and returns success. All filesystem errors are mapped into `SystemSkillsError::Io` with action labels.

**Call relations**: This function orchestrates the whole install flow, delegating marker reading, fingerprint computation, destination-path derivation, and recursive writes to the file’s helpers.

*Call graph*: calls 5 internal fn (embedded_system_skills_fingerprint, read_marker, system_cache_root_dir, write_embedded_dir, join); 4 external calls (format!, create_dir_all, remove_dir_all, write).


##### `read_marker`  (lines 58–63)

```
fn read_marker(path: &AbsolutePathBuf) -> Result<String, SystemSkillsError>
```

**Purpose**: Reads and normalizes the installed fingerprint marker file. It trims trailing whitespace so the stored newline does not affect comparisons.

**Data flow**: It takes a marker `AbsolutePathBuf`, reads the file as a string with `fs::read_to_string`, maps any I/O failure into `SystemSkillsError::io("read system skills marker", ...)`, trims the resulting text, converts it back to an owned `String`, and returns it.

**Call relations**: It is called by `install_system_skills` only when the destination directory already exists and a marker comparison may allow skipping the reinstall.

*Call graph*: calls 1 internal fn (as_path); called by 1 (install_system_skills); 1 external calls (read_to_string).


##### `embedded_system_skills_fingerprint`  (lines 65–77)

```
fn embedded_system_skills_fingerprint() -> String
```

**Purpose**: Computes a deterministic fingerprint of the embedded skills directory structure and file contents. The fingerprint is used to decide whether installation work can be skipped.

**Data flow**: It creates an empty `Vec<(String, Option<u64>)>`, fills it by calling `collect_fingerprint_items` on `SYSTEM_SKILLS_DIR`, sorts the items by path, initializes a `DefaultHasher`, hashes the version salt constant, then hashes each path and optional content hash into the hasher. Finally it formats the resulting `u64` digest as lowercase hexadecimal and returns it.

**Call relations**: This helper is called by `install_system_skills` before any filesystem mutation so the marker file can be compared or rewritten.

*Call graph*: calls 1 internal fn (collect_fingerprint_items); called by 1 (install_system_skills); 3 external calls (new, new, format!).


##### `collect_fingerprint_items`  (lines 79–96)

```
fn collect_fingerprint_items(dir: &Dir<'_>, items: &mut Vec<(String, Option<u64>)>)
```

**Purpose**: Traverses an embedded `include_dir::Dir` and records every directory path and file-content hash needed for fingerprinting. It captures both tree shape and file bytes.

**Data flow**: It takes a directory reference and a mutable vector accumulator. For each entry from `dir.entries()`, it pushes `(path, None)` for subdirectories and recurses into them, or computes a `DefaultHasher` over `file.contents()` and pushes `(path, Some(contents_hash))` for files.

**Call relations**: It is the recursive worker behind `embedded_system_skills_fingerprint`, and tests call it directly to verify nested entries are included.

*Call graph*: called by 2 (embedded_system_skills_fingerprint, fingerprint_traverses_nested_entries); 2 external calls (new, entries).


##### `write_embedded_dir`  (lines 101–128)

```
fn write_embedded_dir(dir: &Dir<'_>, dest: &AbsolutePathBuf) -> Result<(), SystemSkillsError>
```

**Purpose**: Materializes an embedded directory tree onto disk under the destination root. It recreates directories and writes each embedded file’s bytes.

**Data flow**: It takes an embedded `Dir` and destination `AbsolutePathBuf`, ensures the destination directory exists, then iterates `dir.entries()`. For subdirectories it computes `subdir_dest`, creates that directory, and recursively calls `write_embedded_dir` on the subdir; for files it joins the embedded file path onto `dest`, creates the parent directory if needed, and writes `file.contents()` to disk. Every filesystem error is wrapped with a specific `SystemSkillsError::io` action string.

**Call relations**: This is the recursive write worker invoked by `install_system_skills` after any stale destination tree has been removed.

*Call graph*: calls 2 internal fn (as_path, join); called by 1 (install_system_skills); 3 external calls (entries, create_dir_all, write).


##### `SystemSkillsError::io`  (lines 141–143)

```
fn io(action: &'static str, source: std::io::Error) -> Self
```

**Purpose**: Constructs the crate’s structured I/O error variant with an action label. It standardizes how filesystem failures are annotated throughout installation.

**Data flow**: It takes a static action string and a `std::io::Error`, wraps them into `SystemSkillsError::Io { action, source }`, and returns that enum value.

**Call relations**: All helper functions in this file use it when mapping raw filesystem errors into the public error type.


##### `tests::fingerprint_traverses_nested_entries`  (lines 152–168)

```
fn fingerprint_traverses_nested_entries()
```

**Purpose**: Verifies that fingerprint collection descends into nested directories and records deeply nested files. It protects against regressions where only top-level entries would be hashed.

**Data flow**: The test creates an empty items vector, calls `collect_fingerprint_items` on `SYSTEM_SKILLS_DIR`, extracts just the path strings, sorts them, and asserts via binary search that known nested sample files are present.

**Call relations**: It directly exercises `collect_fingerprint_items`, validating the traversal behavior relied on by `embedded_system_skills_fingerprint`.

*Call graph*: calls 1 internal fn (collect_fingerprint_items); 2 external calls (new, assert!).


### `core-skills/src/system.rs`

`io_transport` · `setup/reset and cleanup`

This file is intentionally minimal. It publicly re-exports `install_system_skills` and `system_cache_root_dir` for use elsewhere in the crate, then adds one local helper, `uninstall_system_skills`, that removes the entire system-skill cache directory under a given Codex home.

The implementation computes the cache root by calling `system_cache_root_dir(codex_home)` and passes that path to `std::fs::remove_dir_all`. The result is explicitly ignored with `let _ = ...`, so uninstall is best-effort: missing directories, permission failures, or partial cleanup errors do not propagate. That design suggests this function is used in flows where cleanup should not block broader initialization or reconfiguration logic.

Because the file contains no additional state or validation, its main value is centralizing the exact cache-root computation and the policy that uninstall should be silent and non-fatal. Readers should note that this removes the whole system-skill cache subtree recursively rather than uninstalling individual skills.

#### Function details

##### `uninstall_system_skills`  (lines 6–8)

```
fn uninstall_system_skills(codex_home: &AbsolutePathBuf)
```

**Purpose**: Recursively deletes the system-skill cache directory under the provided Codex home path, ignoring any deletion error.

**Data flow**: It takes `&AbsolutePathBuf codex_home`, derives the cache directory with `system_cache_root_dir`, calls `std::fs::remove_dir_all` on that path, and discards the `Result`. It performs filesystem deletion but does not return status to the caller.

**Call relations**: This helper is invoked from higher-level initialization/restriction logic when system skills need to be removed without making cleanup failures fatal.

*Call graph*: called by 1 (new_with_restriction_product); 2 external calls (system_cache_root_dir, remove_dir_all).


### `memories/write/src/extensions/ad_hoc.rs`

`io_transport` · `startup`

This file defines the embedded instruction payload for the `ad_hoc` extension and the async routine that materializes it under the memories extensions tree. `INSTRUCTIONS` is compiled in from `templates/extensions/ad_hoc/instructions.md`, so startup code can write a known default file without depending on runtime template lookup.

The core flow computes `<memory_root>/extensions/ad_hoc/instructions.md` by calling `memory_extensions_root(memory_root)` and appending the extension-specific path segments. It first ensures the `ad_hoc` directory exists with `tokio::fs::create_dir_all`, then attempts to open the target file with `OpenOptions` configured for write plus `create_new(true)`. That choice is the key invariant in this file: the instructions file is only created if it does not already exist. If creation succeeds, the function writes the embedded markdown bytes and flushes the handle before returning. If the file already exists, it treats that as a successful no-op rather than overwriting local edits. Any other filesystem error is propagated to the caller.

Because the function is async and uses Tokio I/O throughout, it fits directly into startup seeding without blocking the runtime. The module is narrowly scoped and intentionally only exposes this one seeding operation to its parent extension orchestration code.

#### Function details

##### `seed_instructions`  (lines 8–26)

```
async fn seed_instructions(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: Creates the `ad_hoc` extension directory and writes the default `instructions.md` file exactly once. If the file is already present, it leaves the existing contents untouched.

**Data flow**: Takes `memory_root: &Path`, derives `extension_root` via `memory_extensions_root(memory_root).join("ad_hoc")`, then derives `instructions_path` by appending `instructions.md`. It creates the directory tree, attempts an exclusive create/open of the file, writes `INSTRUCTIONS.as_bytes()` and flushes on success, returns `Ok(())` when the file already exists, and otherwise returns the encountered `std::io::Error`.

**Call relations**: This function is invoked by `seed_extension_instructions` during extension startup seeding. Within its own flow it depends on the shared path helper `memory_extensions_root` to place the file under the canonical extensions root, and all remaining work is direct Tokio filesystem I/O to enforce the create-only-if-missing behavior.

*Call graph*: called by 1 (seed_extension_instructions); 3 external calls (memory_extensions_root, new, create_dir_all).


### `memories/write/src/extensions/mod.rs`

`orchestration` · `startup and maintenance dispatch`

This module groups extension-related functionality into a single internal API. It declares two submodules: `ad_hoc`, which seeds built-in extension instructions, and `prune`, which removes stale extension resource files. The only function defined here, `seed_extension_instructions`, is a thin async wrapper that forwards the provided memories root to `ad_hoc::seed_instructions`. That wrapper gives the rest of the crate a stable extension-seeding entrypoint without exposing the specific built-in extension layout directly.

The module also publicly re-exports `prune::prune_old_extension_resources`, making pruning available from the crate root while keeping the implementation in its own file. This split reflects the two extension lifecycle concerns: startup-time initialization of required instruction files, and later cleanup of old resource artifacts.

Although the code is minimal, its design matters: callers such as startup orchestration only need to know that extension instructions should be seeded, not which extension modules currently exist. As more built-in extensions are added, this file is the natural place to sequence multiple seeding calls or aggregate extension setup policy.

#### Function details

##### `seed_extension_instructions`  (lines 6–8)

```
async fn seed_extension_instructions(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: Acts as the crate-internal entrypoint for seeding built-in extension instruction files. At present it delegates entirely to the `ad_hoc` extension seeder.

**Data flow**: Accepts `memory_root: &Path`, passes it unchanged into `ad_hoc::seed_instructions(memory_root).await`, and returns the resulting `std::io::Result<()>` directly without additional transformation.

**Call relations**: This function is called by startup orchestration such as `start_memories_startup_task` and by a phase-two model request test harness. It currently delegates to `seed_instructions` as the sole concrete seeding step, centralizing extension setup behind one call site.

*Call graph*: calls 1 internal fn (seed_instructions); called by 2 (start_memories_startup_task, run_memory_phase_two_model_request_test).


### `core-skills/src/config_rules.rs`

`domain_logic` · `config load and skill/plugin resolution`

This file turns the generic `skills` section from a `ConfigLayerStack` into a compact, ordered rule list and then applies those rules to loaded skill metadata. Its core types are `SkillConfigRuleSelector`, which identifies a skill either by `Name(String)` or canonicalized `Path(AbsolutePathBuf)`, `SkillConfigRule`, which pairs that selector with an `enabled` flag, and `SkillConfigRules`, a simple wrapper around an ordered `Vec<SkillConfigRule>`.

The first phase, `skill_config_rules_from_stack`, walks config layers in `LowestPrecedenceFirst` order while explicitly including disabled layers, but only honors layers whose source is `ConfigLayerSource::User` or `ConfigLayerSource::SessionFlags`. For each such layer it extracts `layer.config["skills"]`, deserializes it into `SkillsConfig`, warns and skips invalid payloads, then converts each `SkillConfig` entry into a selector. Invalid selectors are rejected with warnings: empty names, entries with both `path` and `name`, or entries with neither. Before appending a new rule, the function removes any earlier rule with the same selector so later layers or later entries override earlier ones while preserving overall order.

The second phase, `resolve_disabled_skill_paths`, interprets those ordered rules against actual `SkillMetadata` values. Path rules directly add/remove a path from a `HashSet`; name rules scan all loaded skills with that name and add/remove each matching `path_to_skills_md`. This means name-based overrides can affect multiple loaded skills and can supersede earlier path-specific decisions when they appear later in the ordered rule list.

#### Function details

##### `skill_config_rules_from_stack`  (lines 30–69)

```
fn skill_config_rules_from_stack(config_layer_stack: &ConfigLayerStack) -> SkillConfigRules
```

**Purpose**: Builds an ordered `SkillConfigRules` value from the layered application configuration, keeping only user/session skill overrides and collapsing repeated selectors so the last occurrence wins.

**Data flow**: It takes a borrowed `ConfigLayerStack`, reads its layers via `get_layers(ConfigLayerStackOrdering::LowestPrecedenceFirst, true)`, filters to `ConfigLayerSource::User` and `ConfigLayerSource::SessionFlags`, then looks up the `"skills"` key in each layer's config map. That value is cloned and converted into `SkillsConfig`; deserialization failures emit `warn!` and are skipped. Each `SkillConfig` entry is passed to `skill_config_rule_selector`; valid selectors are paired with `entry.enabled`, earlier rules with the same selector are removed from the accumulating `Vec`, and the new rule is appended. It returns `SkillConfigRules { entries }` with precedence encoded by vector order.

**Call relations**: This is the entry point for deriving skill enable/disable rules before downstream loading and filtering. It is invoked by higher-level skill/plugin assembly paths such as `load_plugins_from_layer_stack`, `plugins_for_config_with_force_reload`, `read_plugin_detail_for_marketplace_plugin`, `skills_for_config`, and `skills_for_cwd`, as well as tests that verify precedence behavior. Within this file it delegates selector validation and normalization to `skill_config_rule_selector` so malformed config entries are dropped consistently.

*Call graph*: calls 2 internal fn (get_layers, skill_config_rule_selector); called by 9 (load_plugins_from_layer_stack, plugins_for_config_with_force_reload, read_plugin_detail_for_marketplace_plugin, skills_for_config, skills_for_cwd, disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 3 external calls (new, matches!, warn!).


##### `resolve_disabled_skill_paths`  (lines 71–103)

```
fn resolve_disabled_skill_paths(
    skills: &[SkillMetadata],
    rules: &SkillConfigRules,
) -> HashSet<AbsolutePathBuf>
```

**Purpose**: Applies the ordered rule list to concrete loaded skills and returns the final set of skill markdown paths that should be treated as disabled.

**Data flow**: It accepts a slice of `SkillMetadata` and a borrowed `SkillConfigRules`, initializes an empty `HashSet<AbsolutePathBuf>`, and processes `rules.entries` in order. For `SkillConfigRuleSelector::Path`, it directly inserts or removes that path depending on `enabled`. For `SkillConfigRuleSelector::Name`, it iterates the provided skills, filters those whose `skill.name` equals the configured name, maps them to `skill.path_to_skills_md.clone()`, and inserts or removes each path. The final `HashSet` is returned as the resolved disabled-path set.

**Call relations**: This function sits after rule extraction and after skill discovery, when actual `SkillMetadata` records are available. It is called by `load_plugin_skills` and `build_skill_outcome` to convert abstract name/path rules into concrete disabled files. It does not call back into config parsing; instead it consumes the normalized ordering produced earlier and relies on sequential set mutation so later rules override earlier ones.

*Call graph*: called by 2 (load_plugin_skills, build_skill_outcome); 2 external calls (new, iter).


##### `skill_config_rule_selector`  (lines 105–128)

```
fn skill_config_rule_selector(entry: &SkillConfig) -> Option<SkillConfigRuleSelector>
```

**Purpose**: Validates a single `SkillConfig` selector and converts it into either a normalized path selector or a trimmed name selector, rejecting ambiguous or empty forms.

**Data flow**: It reads `entry.path` and `entry.name` from a borrowed `SkillConfig` and pattern-matches the four possible combinations. A path-only entry becomes `SkillConfigRuleSelector::Path`, using `path.canonicalize()` when possible and falling back to the original cloned path on failure. A name-only entry trims whitespace; non-empty names become `SkillConfigRuleSelector::Name(name.to_string())`, while empty names trigger `warn!` and return `None`. Entries with both selectors or neither also emit `warn!` and return `None`.

**Call relations**: This helper is only used from `skill_config_rules_from_stack` while that function is translating raw config entries into normalized rules. Its role is to centralize selector validation and normalization so the outer loop can simply skip `None` results and continue building precedence-ordered rules.

*Call graph*: called by 1 (skill_config_rules_from_stack); 3 external calls (Name, Path, warn!).


### `core-skills/src/loader.rs`

`domain_logic` · `startup`

This file is the main skill-loading engine. It defines the on-disk parsing schema (`SkillFrontmatter`, `SkillMetadataFile`, `Interface`, `Dependencies`, `Policy`, `DependencyTool`), the `SkillRoot` input describing where and how to scan, and `SkillParseError` for user-visible parse failures. `load_skills_from_roots` orchestrates the full load: it canonicalizes each root for identity, scans it, records which filesystem serves each discovered skill, deduplicates by canonical `path_to_skills_md` while preserving first-root precedence, trims root/file-system maps to retained skills, and finally sorts skills by scope priority (`Repo`, `User`, `System`, `Admin`), then by name and path.

Root discovery is split out. `skill_roots` and `skill_roots_with_home_dir` combine config-derived roots, plugin roots, runtime extra roots, and repo-local `.agents/skills` directories found between the project root and cwd. Project-root detection merges non-project config layers to compute root markers, then walks ancestors using the supplied executor filesystem. Root lists are deduplicated by path.

Scanning in `discover_skills_under_root` is breadth-first with explicit limits: hidden entries are skipped, traversal depth is capped at 6, and each root is capped at 2000 visited directories. Symlinked directories are followed only for repo/user/admin scopes, never for system scope; symlinked files are effectively ignored because symlink handling short-circuits before file parsing. Canonicalized visited-directory tracking prevents cycles.

`parse_skill_file` reads `SKILL.md`, extracts YAML frontmatter delimited by `---`, sanitizes whitespace to single-line strings, derives a default name from the containing directory when needed, optionally namespaces plugin skills, validates character-count limits, and merges optional metadata from `agents/openai.yaml`. Metadata loading is fail-open: malformed or unreadable metadata logs warnings and yields no interface/dependencies/policy rather than rejecting the skill. Interface resolution enforces that icon paths stay under `assets/`, with a special plugin-only escape hatch allowing `..` only when the normalized result remains under the plugin’s shared `assets/` directory. Dependency and policy parsing similarly sanitize and validate fields while dropping invalid optional entries instead of failing the whole skill.

#### Function details

##### `SkillParseError::fmt`  (lines 138–150)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats parse and validation failures into human-readable error messages stored in `SkillError` entries.

**Data flow**: Reads the `SkillParseError` variant and writes a descriptive string into the provided formatter, including nested error text or field-specific reasons.

**Call relations**: Used implicitly whenever parse errors are converted to strings, especially in `discover_skills_under_root` when non-system skill parse failures are recorded.

*Call graph*: 1 external calls (write!).


##### `load_skills_from_roots`  (lines 163–233)

```
async fn load_skills_from_roots(roots: I) -> SkillLoadOutcome
```

**Purpose**: Loads all skills from a sequence of roots, tracks per-skill filesystem/root metadata, deduplicates by canonical path, and sorts the final skill list by scope and name.

**Data flow**: Consumes `SkillRoot` items. For each root it canonicalizes the root path, remembers the current skill count, calls `discover_skills_under_root`, then for newly added skills records the root path and filesystem in maps keyed by skill path. After scanning all roots it removes duplicate skills by `path_to_skills_md`, trims root and filesystem maps to retained skills, computes the used root list, stores these structures into `SkillLoadOutcome`, sorts `outcome.skills` by scope rank/name/path, and returns the outcome.

**Call relations**: This is the loader’s top-level entry, called by the manager and tests. It delegates actual scanning to `discover_skills_under_root` and canonical identity handling to `canonicalize_for_skill_identity`.

*Call graph*: calls 3 internal fn (canonicalize_for_skill_identity, discover_skills_under_root, new); called by 4 (load_plugin_skills, build_skill_outcome, list, skill_loading_and_reads_use_the_supplied_executor_file_system); 5 external calls (new, new, new, new, default).


##### `skill_roots`  (lines 235–253)

```
async fn skill_roots(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    plugin_skill_roots: Vec<PluginSkillRoot>,
    extra_skill_r
```

**Purpose**: Builds the effective list of skill roots using the real home directory when available.

**Data flow**: Takes an optional repo filesystem, config stack, cwd, plugin skill roots, and extra roots. It resolves `home_dir()` into an `AbsolutePathBuf` when possible and forwards all inputs to `skill_roots_with_home_dir`, returning its result.

**Call relations**: Called by `SkillsManager` when computing roots for config-based or cwd-based loads.

*Call graph*: calls 1 internal fn (skill_roots_with_home_dir); called by 2 (skill_roots_for_config, skills_for_cwd); 1 external calls (home_dir).


##### `skill_roots_with_home_dir`  (lines 255–281)

```
async fn skill_roots_with_home_dir(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    home_dir: Option<&AbsolutePathBuf>,
    plugi
```

**Purpose**: Combines config-derived roots, plugin roots, runtime extra roots, and repo `.agents/skills` roots into one deduplicated root list.

**Data flow**: Starts with `skill_roots_from_layer_stack_inner`, extends that vector with `PluginSkillRoot` values mapped to user-scoped `SkillRoot`s on `LOCAL_FS`, extends again with extra user roots, appends repo-local roots from `repo_agents_skill_roots`, deduplicates by path, and returns the final `Vec<SkillRoot>`.

**Call relations**: Used by production `skill_roots` and the test-only `skill_roots_from_layer_stack`. It is the central root-composition function.

*Call graph*: calls 3 internal fn (dedupe_skill_roots_by_path, repo_agents_skill_roots, skill_roots_from_layer_stack_inner); called by 2 (skill_roots, skill_roots_from_layer_stack).


##### `skill_roots_from_layer_stack_inner`  (lines 283–362)

```
fn skill_roots_from_layer_stack_inner(
    config_layer_stack: &ConfigLayerStack,
    home_dir: Option<&AbsolutePathBuf>,
    repo_fs: Option<Arc<dyn ExecutorFileSystem>>,
) -> Vec<SkillRoot>
```

**Purpose**: Derives baseline skill roots from config layers, mapping layer source types to skill scopes and conventional directories.

**Data flow**: Iterates config layers in highest-precedence-first order, skipping layers without a config folder. Project layers contribute `<config_folder>/skills` as repo scope when a repo filesystem is available; user layers contribute deprecated `<config_folder>/skills`, `$HOME/.agents/skills` when `home_dir` exists, and the bundled system cache root under the user config folder; system layers contribute `<config_folder>/skills` as admin scope. Other layer types contribute nothing. It returns the accumulated roots.

**Call relations**: Called by `skill_roots_with_home_dir` as the base root source before plugin, extra, and repo-agent additions.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (skill_roots_with_home_dir); 3 external calls (clone, new, system_cache_root_dir).


##### `repo_agents_skill_roots`  (lines 364–398)

```
async fn repo_agents_skill_roots(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
) -> Vec<SkillRoot>
```

**Purpose**: Finds repo-scoped `.agents/skills` directories between the project root and the current working directory using the supplied executor filesystem.

**Data flow**: If no filesystem is provided, returns an empty vector. Otherwise it computes project-root markers via `project_root_markers_from_stack`, finds the project root with `find_project_root`, computes all directories from project root to cwd via `dirs_between_project_root_and_cwd`, and for each directory stats `<dir>/.agents/skills`. Existing directories become repo-scoped `SkillRoot`s using the repo filesystem; missing paths are ignored and other stat errors are warned.

**Call relations**: Appended by `skill_roots_with_home_dir` after config/plugin/extra roots so repo-local agent skills are included.

*Call graph*: calls 4 internal fn (dirs_between_project_root_and_cwd, find_project_root, project_root_markers_from_stack, from_abs_path); called by 1 (skill_roots_with_home_dir); 3 external calls (clone, new, warn!).


##### `project_root_markers_from_stack`  (lines 400–420)

```
fn project_root_markers_from_stack(config_layer_stack: &ConfigLayerStack) -> Vec<String>
```

**Purpose**: Computes the effective project-root marker list by merging non-project config layers and falling back to defaults on absence or parse errors.

**Data flow**: Starts with an empty TOML table, iterates config layers in lowest-precedence-first order excluding project layers, merges each layer’s config into the accumulator, then asks `project_root_markers_from_config` for markers. It returns configured markers, default markers when none are set, or default markers after logging a warning on invalid config.

**Call relations**: Used only by `repo_agents_skill_roots` to decide how project-root discovery should walk ancestors.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (repo_agents_skill_roots); 7 external calls (Table, default_project_root_markers, merge_toml_values, project_root_markers_from_config, matches!, new, warn!).


##### `find_project_root`  (lines 422–449)

```
async fn find_project_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
    project_root_markers: &[String],
) -> AbsolutePathBuf
```

**Purpose**: Walks upward from cwd to find the nearest ancestor containing any configured project-root marker.

**Data flow**: If the marker list is empty, returns `cwd.clone()`. Otherwise it iterates `cwd.ancestors()`, joins each marker name onto each ancestor, stats the resulting path through the executor filesystem, and returns the first ancestor where any marker exists. Not-found errors are ignored; other stat failures are warned. If no marker is found, it returns `cwd.clone()`.

**Call relations**: Called by `repo_agents_skill_roots` before computing which `.agents/skills` directories are in scope.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (repo_agents_skill_roots); 3 external calls (get_metadata, warn!, clone).


##### `dirs_between_project_root_and_cwd`  (lines 451–470)

```
fn dirs_between_project_root_and_cwd(
    cwd: &AbsolutePathBuf,
    project_root: &AbsolutePathBuf,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the inclusive directory chain from project root down to cwd in ascending order.

**Data flow**: Iterates `cwd.ancestors()` with a stateful scan that stops after including `project_root`, collects the directories, reverses the vector, and returns it.

**Call relations**: Used by `repo_agents_skill_roots` to probe `.agents/skills` at each level without escaping above the project root.

*Call graph*: calls 1 internal fn (ancestors); called by 1 (repo_agents_skill_roots).


##### `dedupe_skill_roots_by_path`  (lines 472–475)

```
fn dedupe_skill_roots_by_path(roots: &mut Vec<SkillRoot>)
```

**Purpose**: Removes duplicate root entries that point at the same absolute path, keeping the first occurrence.

**Data flow**: Maintains a `HashSet<AbsolutePathBuf>` of seen paths and retains only roots whose path is newly inserted.

**Call relations**: Applied by `skill_roots_with_home_dir` after all root sources have been combined.

*Call graph*: called by 1 (skill_roots_with_home_dir); 1 external calls (new).


##### `canonicalize_for_skill_identity`  (lines 477–486)

```
async fn canonicalize_for_skill_identity(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
) -> AbsolutePathBuf
```

**Purpose**: Canonicalizes a path through the executor filesystem for identity and deduplication, falling back to the original path on failure.

**Data flow**: Converts the absolute path to `PathUri`, calls `fs.canonicalize`, converts the result back to `AbsolutePathBuf`, and returns that canonical path or the original clone if any step fails.

**Call relations**: Used for root identity, visited-directory tracking, plugin-root normalization, and final skill path normalization.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (discover_skills_under_root, load_skills_from_roots, parse_skill_file); 1 external calls (canonicalize).


##### `discover_skills_under_root`  (lines 488–637)

```
async fn discover_skills_under_root(
    fs: &dyn ExecutorFileSystem,
    root: &AbsolutePathBuf,
    scope: SkillScope,
    plugin_id: Option<&str>,
    plugin_root: Option<&AbsolutePathBuf>,
    out
```

**Purpose**: Breadth-first scans one root directory for `SKILL.md` files, following allowed symlinked directories, enforcing traversal limits, and appending parsed skills or errors into the shared outcome.

**Data flow**: Consumes a filesystem, root path, scope, optional plugin identifiers, and mutable `SkillLoadOutcome`. It canonicalizes the plugin root if present, stats the root and returns early unless it is an existing directory, initializes visited-directory and queue state, and repeatedly reads directories from the queue. Hidden entries are skipped. Symlink entries are followed only when the scope allows symlink traversal and only if they can be read as directories; resolved directories are canonicalized and enqueued through the local `enqueue_dir` helper, which enforces max depth and max directory count. Regular directories are likewise canonicalized and enqueued. Regular files named `SKILL.md` are parsed with `parse_skill_file`; successful parses are pushed into `outcome.skills`, while non-system parse failures become `SkillError` entries in `outcome.errors`. If the directory cap is hit, a warning is logged after traversal.

**Call relations**: Called by `load_skills_from_roots` once per root. It delegates file parsing to `parse_skill_file` and path identity normalization to `canonicalize_for_skill_identity`.

*Call graph*: calls 3 internal fn (canonicalize_for_skill_identity, parse_skill_file, from_abs_path); called by 1 (load_skills_from_roots); 8 external calls (new, from, error!, get_metadata, read_directory, matches!, warn!, clone).


##### `parse_skill_file`  (lines 639–705)

```
async fn parse_skill_file(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    scope: SkillScope,
    plugin_id: Option<&str>,
    plugin_root: Option<&AbsolutePathBuf>,
) -> Result<Skill
```

**Purpose**: Reads and validates one `SKILL.md`, extracts frontmatter fields, loads optional metadata, applies plugin namespacing, and returns a normalized `SkillMetadata`.

**Data flow**: Reads the file text via the executor filesystem, extracts YAML frontmatter with `extract_frontmatter`, deserializes it into `SkillFrontmatter`, sanitizes and defaults the base name, computes the final possibly namespaced name via `namespaced_skill_name`, sanitizes description and optional short description, loads optional metadata from `load_skill_metadata`, validates length limits for required and optional fields, canonicalizes the skill path for identity, and returns a populated `SkillMetadata`. Any read, parse, missing-field, or validation failure becomes a `SkillParseError`.

**Call relations**: Invoked from `discover_skills_under_root` for each candidate `SKILL.md`. It is the central parser and delegates metadata loading, namespacing, frontmatter extraction, and length validation to helpers.

*Call graph*: calls 7 internal fn (canonicalize_for_skill_identity, extract_frontmatter, load_skill_metadata, namespaced_skill_name, validate_len, read_file_text, from_abs_path); called by 1 (discover_skills_under_root); 1 external calls (from_str).


##### `default_skill_name`  (lines 707–717)

```
fn default_skill_name(path: &AbsolutePathBuf) -> String
```

**Purpose**: Derives a fallback skill name from the containing directory name when frontmatter omits `name`.

**Data flow**: Looks up the parent directory of the skill file, then its final path component, converts it to UTF-8, sanitizes whitespace, filters out empty results, and returns that string or the literal `skill` if no usable directory name exists.

**Call relations**: Used by `parse_skill_file` only when the frontmatter name is absent or sanitizes to empty.

*Call graph*: calls 1 internal fn (parent).


##### `namespaced_skill_name`  (lines 719–728)

```
async fn namespaced_skill_name(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    base_name: &str,
) -> String
```

**Purpose**: Prefixes a base skill name with the plugin namespace when the skill path belongs to a plugin.

**Data flow**: Asks `plugin_namespace_for_skill_path(fs, path)` for an optional namespace and returns either `"{namespace}:{base_name}"` or `base_name.to_string()`.

**Call relations**: Called by `parse_skill_file` so plugin skills get stable qualified names without changing non-plugin skills.

*Call graph*: called by 1 (parse_skill_file); 1 external calls (plugin_namespace_for_skill_path).


##### `load_skill_metadata`  (lines 730–799)

```
async fn load_skill_metadata(
    fs: &dyn ExecutorFileSystem,
    skill_path: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
) -> LoadedSkillMetadata
```

**Purpose**: Loads optional `agents/openai.yaml` metadata adjacent to a skill and resolves it into internal interface, dependency, and policy structures without failing the skill on metadata errors.

**Data flow**: Finds the skill directory, constructs `agents/openai.yaml`, stats it, and returns default metadata if it is missing, not a file, or cannot be read. If readable, it parses the YAML under an `AbsolutePathBufGuard` rooted at the skill directory, logs and returns defaults on parse failure, then resolves the parsed `interface`, `dependencies`, and `policy` sections through `resolve_interface`, `resolve_dependencies`, and `resolve_policy`, returning a `LoadedSkillMetadata` bundle.

**Call relations**: Called by `parse_skill_file` after frontmatter parsing. It intentionally fails open so optional metadata never blocks loading the core skill.

*Call graph*: calls 7 internal fn (resolve_dependencies, resolve_interface, resolve_policy, read_file_text, parent, new, from_abs_path); called by 1 (parse_skill_file); 4 external calls (default, get_metadata, from_str, warn!).


##### `resolve_interface`  (lines 801–844)

```
fn resolve_interface(
    interface: Option<Interface>,
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
) -> Option<SkillInterface>
```

**Purpose**: Converts optional parsed interface metadata into a validated `SkillInterface`, dropping invalid fields and returning `None` if nothing usable remains.

**Data flow**: Consumes an optional parsed `Interface`, the skill directory, and optional plugin root. It resolves each field individually: strings through `resolve_str`, colors through `resolve_color_str`, and icon paths through `resolve_asset_path`. It then checks whether any resolved field is present and returns `Some(SkillInterface)` only in that case.

**Call relations**: Used by `load_skill_metadata` to transform raw metadata into the runtime interface model.

*Call graph*: calls 3 internal fn (resolve_asset_path, resolve_color_str, resolve_str); called by 1 (load_skill_metadata).


##### `resolve_dependencies`  (lines 846–858)

```
fn resolve_dependencies(dependencies: Option<Dependencies>) -> Option<SkillDependencies>
```

**Purpose**: Converts parsed dependency metadata into `SkillDependencies`, dropping invalid tool entries and returning `None` when no valid tools remain.

**Data flow**: Consumes an optional `Dependencies`, maps each `DependencyTool` through `resolve_dependency_tool`, collects only `Some` results into a `Vec<SkillToolDependency>`, and returns `Some(SkillDependencies { tools })` if non-empty.

**Call relations**: Called by `load_skill_metadata` as the dependency section resolver.

*Call graph*: called by 1 (load_skill_metadata).


##### `resolve_policy`  (lines 860–865)

```
fn resolve_policy(policy: Option<Policy>) -> Option<SkillPolicy>
```

**Purpose**: Maps parsed policy metadata directly into the runtime `SkillPolicy` structure.

**Data flow**: Transforms `Option<Policy>` into `Option<SkillPolicy>` by copying `allow_implicit_invocation` and `products` when present.

**Call relations**: Used by `load_skill_metadata`; unlike interface/dependencies, it performs no additional validation beyond deserialization.

*Call graph*: called by 1 (load_skill_metadata).


##### `resolve_dependency_tool`  (lines 867–903)

```
fn resolve_dependency_tool(tool: DependencyTool) -> Option<SkillToolDependency>
```

**Purpose**: Validates and converts one parsed dependency tool entry into `SkillToolDependency`.

**Data flow**: Consumes a `DependencyTool`, resolves required `type` and `value` through `resolve_required_str`, resolves optional `description`, `transport`, `command`, and `url` through `resolve_str`, and returns `Some(SkillToolDependency)` only if the required fields survive validation.

**Call relations**: Applied by `resolve_dependencies` to each declared tool dependency.

*Call graph*: calls 2 internal fn (resolve_required_str, resolve_str).


##### `resolve_asset_path`  (lines 905–952)

```
fn resolve_asset_path(
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
    field: &'static str,
    path: Option<PathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Validates interface icon paths, requiring them to be relative and under `assets/`, with controlled plugin-only support for `..` paths into shared plugin assets.

**Data flow**: Consumes the skill directory, optional plugin root, field name, and optional relative `PathBuf`. It rejects missing or empty paths and absolute paths. It then normalizes lexical components: `.` is ignored, normal components are accumulated, `..` triggers delegation to `resolve_plugin_shared_asset_path`, and other component kinds are rejected. For non-`..` paths it requires the first normalized component to be `assets`; if so it joins the normalized path onto `skill_dir` and returns the resulting absolute path.

**Call relations**: Called by `resolve_interface` for `icon_small` and `icon_large`. It delegates the special plugin shared-assets case to `resolve_plugin_shared_asset_path`.

*Call graph*: calls 2 internal fn (resolve_plugin_shared_asset_path, join); called by 1 (resolve_interface); 2 external calls (new, warn!).


##### `resolve_plugin_shared_asset_path`  (lines 954–978)

```
fn resolve_plugin_shared_asset_path(
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
    field: &'static str,
    path: &Path,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Allows plugin skill icon paths containing `..` only when the normalized result stays within the plugin’s shared `assets/` directory.

**Data flow**: Requires `plugin_root`; without it, logs a warning and returns `None`. It lexically normalizes both `<plugin_root>/assets` and `skill_dir.join(path)`, checks that the resolved path starts with the plugin assets directory, then converts the normalized path into `AbsolutePathBuf`, warning and returning `None` on failure.

**Call relations**: Used only by `resolve_asset_path` to support plugin-level shared icons safely.

*Call graph*: calls 3 internal fn (lexically_normalize, join, try_from); called by 1 (resolve_asset_path); 1 external calls (warn!).


##### `lexically_normalize`  (lines 980–994)

```
fn lexically_normalize(path: &Path) -> PathBuf
```

**Purpose**: Normalizes a path syntactically by removing `.` components and applying `..` pops without touching the filesystem.

**Data flow**: Iterates `path.components()`, skipping `CurDir`, popping on `ParentDir`, and pushing prefixes, roots, and normal components into a new `PathBuf`, which it returns.

**Call relations**: Supports plugin shared-asset validation where lexical containment matters even if paths do not exist.

*Call graph*: called by 1 (resolve_plugin_shared_asset_path); 2 external calls (components, new).


##### `sanitize_single_line`  (lines 996–998)

```
fn sanitize_single_line(raw: &str) -> String
```

**Purpose**: Collapses arbitrary whitespace in a string into single spaces for user-facing metadata fields.

**Data flow**: Splits the input on whitespace, collects the pieces, joins them with single spaces, and returns the normalized `String`.

**Call relations**: Used by frontmatter and metadata string resolvers so multiline or irregular spacing becomes stable single-line text.

*Call graph*: called by 1 (resolve_str).


##### `validate_len`  (lines 1000–1015)

```
fn validate_len(
    value: &str,
    max_len: usize,
    field_name: &'static str,
) -> Result<(), SkillParseError>
```

**Purpose**: Enforces non-empty and maximum character-count constraints for required frontmatter fields.

**Data flow**: Reads a string value, maximum length, and field name. It returns `MissingField` if the value is empty, `InvalidField` if `chars().count()` exceeds the limit, or `Ok(())` otherwise.

**Call relations**: Called by `parse_skill_file` for required frontmatter-derived fields and optional short description when present.

*Call graph*: called by 1 (parse_skill_file); 2 external calls (MissingField, format!).


##### `resolve_str`  (lines 1017–1029)

```
fn resolve_str(value: Option<String>, max_len: usize, field: &'static str) -> Option<String>
```

**Purpose**: Sanitizes and validates an optional metadata string field, logging and dropping invalid values instead of failing the skill.

**Data flow**: Consumes `Option<String>`, returns `None` immediately if absent, otherwise sanitizes with `sanitize_single_line`, rejects empty or overlong values with warnings, and returns `Some(String)` for valid values.

**Call relations**: Shared by interface and dependency metadata resolution, and reused by `resolve_required_str`.

*Call graph*: calls 1 internal fn (sanitize_single_line); called by 3 (resolve_dependency_tool, resolve_interface, resolve_required_str); 1 external calls (warn!).


##### `resolve_required_str`  (lines 1031–1041)

```
fn resolve_required_str(
    value: Option<String>,
    max_len: usize,
    field: &'static str,
) -> Option<String>
```

**Purpose**: Validates a required metadata string field while logging missing values instead of aborting the whole skill load.

**Data flow**: If the input `Option<String>` is `None`, logs a warning and returns `None`; otherwise forwards the value to `resolve_str` and returns its result.

**Call relations**: Used by `resolve_dependency_tool` for required dependency fields.

*Call graph*: calls 1 internal fn (resolve_str); called by 1 (resolve_dependency_tool); 1 external calls (warn!).


##### `resolve_color_str`  (lines 1043–1057)

```
fn resolve_color_str(value: Option<String>, field: &'static str) -> Option<String>
```

**Purpose**: Validates optional interface brand colors, accepting only `#RRGGBB` hex strings.

**Data flow**: Consumes `Option<String>`, trims whitespace, rejects empty strings, then checks for length 7, leading `#`, and all remaining ASCII hex digits. It returns the original color string on success or `None` after logging a warning on failure.

**Call relations**: Called by `resolve_interface` for `brand_color`.

*Call graph*: called by 1 (resolve_interface); 1 external calls (warn!).


##### `extract_frontmatter`  (lines 1059–1080)

```
fn extract_frontmatter(contents: &str) -> Option<String>
```

**Purpose**: Extracts the YAML frontmatter block from a `SKILL.md` file when it is delimited by opening and closing `---` lines.

**Data flow**: Iterates the file’s lines, requires the first trimmed line to equal `---`, collects subsequent lines until another trimmed `---`, rejects empty frontmatter or missing closing delimiter, and returns the joined frontmatter string on success.

**Call relations**: Used by `parse_skill_file` before YAML deserialization.

*Call graph*: called by 1 (parse_skill_file); 2 external calls (new, matches!).


##### `skill_roots_from_layer_stack`  (lines 1082–1097)

```
async fn skill_roots_from_layer_stack(
    fs: Arc<dyn ExecutorFileSystem>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    home_dir: Option<&AbsolutePathBuf>,
) -> Vec<Skill
```

**Purpose**: Test-only wrapper that exposes `skill_roots_with_home_dir` with no plugin or extra roots.

**Data flow**: Takes a filesystem, config stack, cwd, and optional home dir, forwards them to `skill_roots_with_home_dir` with empty plugin and extra root vectors, and returns the resulting roots.

**Call relations**: Used by loader tests to exercise root selection deterministically.

*Call graph*: calls 1 internal fn (skill_roots_with_home_dir); 1 external calls (new).


### `core-skills/src/manager.rs`

`orchestration` · `config load`

This file provides the higher-level skills service used by the rest of the application. `SkillsLoadInput` packages the cwd, effective plugin roots, config stack, and bundled-skills flag for one load request. `SkillsManager` owns the codex home path, an optional product restriction, mutable extra roots, and two caches guarded by `RwLock`: one keyed only by cwd for legacy/local-fs loads, and one keyed by effective skill-relevant config state for safer session-aware reuse.

Construction in `new_with_restriction_product` also manages bundled system skills on disk. If bundled skills are disabled, it best-effort removes the cached `skills/.system` directory; otherwise it installs bundled skills and logs any failure. Runtime root overrides are handled by `set_extra_roots`, which replaces the stored list and clears both caches.

There are two load paths. `skills_for_config` computes roots with `skill_roots_for_config`, derives `SkillConfigRules` from the config stack, builds a `ConfigSkillsCacheKey` from root paths/scope ranks/plugin IDs plus the rules, and uses the config-aware cache so session-local overrides do not bleed across requests sharing a cwd. `skills_for_cwd` is the older path: it only uses the cwd cache when an executor filesystem is present, can be bypassed with `force_reload`, and determines bundled-skill inclusion from the effective config stack. Both paths delegate actual loading to `build_skill_outcome`.

`build_skill_outcome` runs `load_skills_from_roots`, filters by product restriction, resolves disabled skill paths from config rules, and passes the result to `finalize_skill_outcome`. Finalization stores `disabled_paths` and builds the implicit invocation indexes from `allowed_skills_for_implicit_invocation()`, ensuring disabled or policy-blocked skills are excluded from command-based implicit detection.

#### Function details

##### `SkillsLoadInput::new`  (lines 37–49)

```
fn new(
        cwd: AbsolutePathBuf,
        effective_skill_roots: Vec<PluginSkillRoot>,
        config_layer_stack: ConfigLayerStack,
        bundled_skills_enabled: bool,
    ) -> Self
```

**Purpose**: Constructs the immutable input bundle used for one skills load request.

**Data flow**: Takes a cwd, plugin skill roots, config layer stack, and bundled-skills flag, stores them directly into a new `SkillsLoadInput`, and returns it.

**Call relations**: Used by callers and tests to package the state consumed by `SkillsManager` load methods.

*Call graph*: called by 8 (register_thread_config, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_with_stack, skills_for_cwd_loads_repo_and_user_roots_with_local_fs, skills_for_cwd_uses_cached_result_until_force_reload, skills_for_cwd_without_fs_skips_repo_roots, skills_load_input_from_config).


##### `SkillsManager::new`  (lines 61–63)

```
fn new(codex_home: AbsolutePathBuf, bundled_skills_enabled: bool) -> Self
```

**Purpose**: Creates a manager with the default product restriction of `Product::Codex`.

**Data flow**: Forwards the codex home and bundled-skills flag to `new_with_restriction_product` with `Some(Product::Codex)` and returns the resulting manager.

**Call relations**: Convenience constructor used by most production code and tests.

*Call graph*: called by 17 (new_with_disabled_bundled_skills_removes_stale_cached_system_skills, set_extra_roots_applies_to_config_loads_and_empty_clears, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_loads_repo_and_user_roots_with_local_fs, skills_for_cwd_uses_cached_result_until_force_reload, skills_for_cwd_without_fs_skips_repo_roots (+7 more)); 1 external calls (new_with_restriction_product).


##### `SkillsManager::new_with_restriction_product`  (lines 65–85)

```
fn new_with_restriction_product(
        codex_home: AbsolutePathBuf,
        bundled_skills_enabled: bool,
        restriction_product: Option<Product>,
    ) -> Self
```

**Purpose**: Initializes manager state, caches, and bundled-system-skill installation policy.

**Data flow**: Stores the codex home, optional restriction product, empty extra-root vector, and empty cwd/config caches inside `RwLock`s. If bundled skills are disabled it calls `uninstall_system_skills` best-effort; otherwise it calls `install_system_skills` and logs an error if installation fails. It returns the initialized manager.

**Call relations**: Called by `new` and specialized test constructors. It is the only place that mutates bundled system skills on disk.

*Call graph*: calls 1 internal fn (uninstall_system_skills); called by 2 (new, with_models_provider_home_and_state_for_tests); 5 external calls (new, new, new, install_system_skills, error!).


##### `SkillsManager::set_extra_roots`  (lines 87–96)

```
fn set_extra_roots(&self, extra_roots: Vec<AbsolutePathBuf>)
```

**Purpose**: Replaces the runtime-supplied extra skill roots and invalidates all cached outcomes.

**Data flow**: Acquires the `extra_roots` write lock, overwrites the stored vector with the provided roots, releases the lock, then calls `clear_cache`.

**Call relations**: Used when runtime configuration changes the effective root set; cache clearing ensures subsequent loads see the new roots.

*Call graph*: calls 1 internal fn (clear_cache).


##### `SkillsManager::skills_for_config`  (lines 105–124)

```
async fn skills_for_config(
        &self,
        input: &SkillsLoadInput,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> SkillLoadOutcome
```

**Purpose**: Loads skills using a cache keyed by effective skill-relevant configuration rather than cwd alone.

**Data flow**: Takes `SkillsLoadInput` and optional filesystem, computes roots via `skill_roots_for_config`, derives `SkillConfigRules` from the config stack, builds a `ConfigSkillsCacheKey`, checks `cached_outcome_for_config`, and if absent calls `build_skill_outcome`. It then inserts the cloned outcome into `cache_by_config` and returns it.

**Call relations**: Used when the caller already has a constructed config stack and needs session-safe caching. It delegates root computation, cache-key construction, and actual loading to helpers.

*Call graph*: calls 5 internal fn (skill_config_rules_from_stack, build_skill_outcome, cached_outcome_for_config, skill_roots_for_config, config_skills_cache_key); called by 1 (skills_for_config_with_stack).


##### `SkillsManager::skill_roots_for_config`  (lines 126–143)

```
async fn skill_roots_for_config(
        &self,
        input: &SkillsLoadInput,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> Vec<SkillRoot>
```

**Purpose**: Computes the effective root list for a config-based load and removes system roots when bundled skills are disabled in the input.

**Data flow**: Calls `skill_roots` with the provided filesystem, config stack, cwd, cloned plugin roots, and current extra roots. If `input.bundled_skills_enabled` is false, it filters out roots whose scope is `SkillScope::System`. It returns the resulting root vector.

**Call relations**: Called by `skills_for_config` before cache-key generation so the cache reflects the actual root set.

*Call graph*: calls 2 internal fn (skill_roots, extra_roots); called by 1 (skills_for_config).


##### `SkillsManager::skills_for_cwd`  (lines 145–180)

```
async fn skills_for_cwd(
        &self,
        input: &SkillsLoadInput,
        force_reload: bool,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> SkillLoadOutcome
```

**Purpose**: Loads skills for a cwd using the legacy cwd-keyed cache when possible, with optional forced reload.

**Data flow**: Determines whether cwd caching is allowed based on `fs.is_some()`. If caching is allowed and `force_reload` is false, it checks `cached_outcome_for_cwd` and returns a hit immediately. Otherwise it computes roots with `skill_roots`, filters out system roots when `bundled_skills_enabled_from_stack` says bundled skills are disabled, derives `SkillConfigRules`, builds the outcome via `build_skill_outcome`, stores it in `cache_by_cwd` when cwd caching is enabled, and returns it.

**Call relations**: This is the older load path used by callers keyed primarily on cwd. It shares the same loader/finalizer pipeline as `skills_for_config` but uses a coarser cache.

*Call graph*: calls 6 internal fn (skill_config_rules_from_stack, skill_roots, build_skill_outcome, cached_outcome_for_cwd, extra_roots, bundled_skills_enabled_from_stack).


##### `SkillsManager::build_skill_outcome`  (lines 183–194)

```
async fn build_skill_outcome(
        &self,
        roots: Vec<SkillRoot>,
        skill_config_rules: &SkillConfigRules,
    ) -> SkillLoadOutcome
```

**Purpose**: Runs the full load/filter/finalize pipeline for a concrete root set and skill config rules.

**Data flow**: Consumes roots and `SkillConfigRules`, calls `load_skills_from_roots`, filters the result through `filter_skill_load_outcome_for_product` using the manager’s restriction product, computes disabled paths with `resolve_disabled_skill_paths`, passes both into `finalize_skill_outcome`, and returns the finalized outcome.

**Call relations**: Shared by both public load paths so product filtering, disabled-skill resolution, and implicit-index construction happen consistently.

*Call graph*: calls 3 internal fn (resolve_disabled_skill_paths, load_skills_from_roots, finalize_skill_outcome); called by 2 (skills_for_config, skills_for_cwd); 1 external calls (filter_skill_load_outcome_for_product).


##### `SkillsManager::clear_cache`  (lines 196–217)

```
fn clear_cache(&self)
```

**Purpose**: Clears both cwd-keyed and config-keyed caches and logs how many entries were removed.

**Data flow**: Acquires write locks on `cache_by_cwd` and `cache_by_config`, records each map’s length, clears both maps, sums the counts, and emits an info log with the total cleared entries.

**Call relations**: Called by `set_extra_roots`; may also be useful to callers needing explicit cache invalidation.

*Call graph*: called by 1 (set_extra_roots); 1 external calls (info!).


##### `SkillsManager::cached_outcome_for_cwd`  (lines 219–224)

```
fn cached_outcome_for_cwd(&self, cwd: &AbsolutePathBuf) -> Option<SkillLoadOutcome>
```

**Purpose**: Reads a cloned cached outcome for one cwd, tolerating poisoned locks.

**Data flow**: Attempts a read lock on `cache_by_cwd`; on success or poison recovery it looks up the cwd key, clones the stored `SkillLoadOutcome` if present, and returns `Option<SkillLoadOutcome>`.

**Call relations**: Used only by `skills_for_cwd` on the fast path.

*Call graph*: called by 1 (skills_for_cwd).


##### `SkillsManager::cached_outcome_for_config`  (lines 226–234)

```
fn cached_outcome_for_config(
        &self,
        cache_key: &ConfigSkillsCacheKey,
    ) -> Option<SkillLoadOutcome>
```

**Purpose**: Reads a cloned cached outcome for one config-derived cache key, tolerating poisoned locks.

**Data flow**: Attempts a read lock on `cache_by_config`; on success or poison recovery it looks up the key, clones the stored outcome if present, and returns it.

**Call relations**: Used only by `skills_for_config` before rebuilding outcomes.

*Call graph*: called by 1 (skills_for_config).


##### `SkillsManager::extra_roots`  (lines 236–241)

```
fn extra_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the current runtime extra roots, tolerating poisoned locks.

**Data flow**: Reads the `extra_roots` lock and clones the stored `Vec<AbsolutePathBuf>`, recovering from poison if necessary.

**Call relations**: Used by both root-computation paths so runtime overrides are included in effective roots.

*Call graph*: called by 2 (skill_roots_for_config, skills_for_cwd).


##### `bundled_skills_enabled_from_stack`  (lines 250–270)

```
fn bundled_skills_enabled_from_stack(
    config_layer_stack: &codex_config::ConfigLayerStack,
) -> bool
```

**Purpose**: Reads the effective config stack to determine whether bundled/system skills are enabled, defaulting to enabled on absence or invalid config.

**Data flow**: Obtains the effective config TOML value, looks up the `skills` table, attempts to deserialize it into `SkillsConfig`, logs a warning and returns `true` on deserialization failure, and otherwise returns `skills.bundled.unwrap_or_default().enabled`.

**Call relations**: Used by `skills_for_cwd` and by callers/tests constructing `SkillsLoadInput`.

*Call graph*: calls 1 internal fn (effective_config); called by 2 (skills_for_cwd, bundled_skills_enabled); 1 external calls (warn!).


##### `config_skills_cache_key`  (lines 272–291)

```
fn config_skills_cache_key(
    roots: &[SkillRoot],
    skill_config_rules: &SkillConfigRules,
) -> ConfigSkillsCacheKey
```

**Purpose**: Builds the cache key representing the effective skill-relevant configuration state for config-aware caching.

**Data flow**: Consumes a root slice and `SkillConfigRules`, maps each root to `(path, scope_rank, plugin_id)` where scope rank is `Repo=0, User=1, System=2, Admin=3`, clones the rules, and returns `ConfigSkillsCacheKey { roots, skill_config_rules }`.

**Call relations**: Used by `skills_for_config` so cache reuse depends on roots and enable/disable rules, not just cwd.

*Call graph*: called by 1 (skills_for_config); 2 external calls (clone, iter).


##### `finalize_skill_outcome`  (lines 293–303)

```
fn finalize_skill_outcome(
    mut outcome: SkillLoadOutcome,
    disabled_paths: HashSet<AbsolutePathBuf>,
) -> SkillLoadOutcome
```

**Purpose**: Attaches disabled-path state and builds implicit invocation indexes from the subset of skills still allowed for implicit invocation.

**Data flow**: Takes a mutable `SkillLoadOutcome` and a `HashSet<AbsolutePathBuf>` of disabled paths, stores the disabled paths into the outcome, calls `allowed_skills_for_implicit_invocation()`, builds script/doc indexes with `build_implicit_skill_path_indexes`, wraps them in `Arc`, stores them back into the outcome, and returns the updated outcome.

**Call relations**: Called only by `SkillsManager::build_skill_outcome` as the final normalization step before caching or returning results.

*Call graph*: calls 1 internal fn (allowed_skills_for_implicit_invocation); called by 1 (build_skill_outcome); 2 external calls (new, build_implicit_skill_path_indexes).


### Plugin marketplaces and MCP catalogs
These files resolve marketplace roots, describe plugin loading outcomes, normalize plugin MCP declarations, and build the final runtime MCP server catalog.

### `core-plugins/src/installed_marketplaces.rs`

`config` · `config load / marketplace discovery`

This utility module is the bridge between `[marketplaces]` user configuration and the on-disk directories scanned by marketplace listing code. `INSTALLED_MARKETPLACES_DIR` defines the default install location under CODEX_HOME. `marketplace_install_root` simply appends that directory name to the provided home path.

The main routine, `installed_marketplace_roots_from_layer_stack`, reads the effective user config from a `ConfigLayerStack` and looks up the `marketplaces` table. It returns an empty vector if there is no user config, no `marketplaces` key, or the key is not a TOML table; malformed structures are logged with `warn!`. For each marketplace entry it requires the value to be a table and validates the marketplace name with `validate_plugin_segment`, again warning and skipping invalid entries. It then delegates path resolution to `resolve_configured_marketplace_root`: `source_type = "local"` uses the configured non-empty `source` path directly, while all other source types fall back to `<default_install_root>/<marketplace_name>`. Only roots where `find_marketplace_manifest_path` succeeds are kept, and successful paths are converted to `AbsolutePathBuf`. The final list is sorted by path for deterministic downstream behavior.

A subtle design choice is that non-local marketplaces are always mapped to the standard installed-marketplace directory, regardless of their original remote source URL; this file is about where the marketplace is materialized locally, not how it was fetched.

#### Function details

##### `marketplace_install_root`  (lines 13–15)

```
fn marketplace_install_root(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the default directory under CODEX_HOME where installed marketplaces are stored. It is the canonical base path for non-local marketplace materialization.

**Data flow**: Takes `codex_home: &Path` → appends `INSTALLED_MARKETPLACES_DIR` with `join` → returns the resulting `PathBuf`.

**Call relations**: Used by marketplace-management and discovery code whenever it needs the standard installed-marketplace root, including `installed_marketplace_roots_from_layer_stack`.

*Call graph*: called by 18 (marketplace_remove_deletes_config_and_installed_root, write_installed_marketplace, configured_marketplace_sources_by_root, configured_marketplace_snapshot_issues, marketplace_add_local_directory_source, marketplace_remove_json_prints_remove_outcome, write_installed_marketplace, installed_marketplace_roots_from_layer_stack, list_marketplaces_ignores_installed_roots_missing_from_config, list_marketplaces_includes_installed_marketplace_roots (+8 more)); 1 external calls (join).


##### `installed_marketplace_roots_from_layer_stack`  (lines 17–61)

```
fn installed_marketplace_roots_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    codex_home: &Path,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Extracts valid marketplace root directories from the effective user config. It filters out malformed entries and only returns roots that actually contain a marketplace manifest.

**Data flow**: Reads `config_layer_stack` and `codex_home` → obtains `effective_user_config`, reads the `marketplaces` TOML table, computes `default_install_root` via `marketplace_install_root`, iterates each configured marketplace entry, validates entry shape and marketplace name, resolves a root path with `resolve_configured_marketplace_root`, keeps only paths where `find_marketplace_manifest_path` succeeds, converts them to `AbsolutePathBuf`, sorts the vector by path, and returns it. Invalid config shapes and names are logged with `warn!` and skipped.

**Call relations**: Called by higher-level marketplace root assembly in manager code; it supplies the configured marketplace roots that are merged with curated and caller-provided roots.

*Call graph*: calls 2 internal fn (effective_user_config, marketplace_install_root); called by 1 (marketplace_roots); 2 external calls (new, warn!).


##### `resolve_configured_marketplace_root`  (lines 63–76)

```
fn resolve_configured_marketplace_root(
    marketplace_name: &str,
    marketplace: &toml::Value,
    default_install_root: &Path,
) -> Option<PathBuf>
```

**Purpose**: Maps one marketplace config entry to the local directory that should be scanned. Local sources use their explicit path; all other source types use the default installed root plus marketplace name.

**Data flow**: Takes `marketplace_name`, the marketplace `toml::Value`, and `default_install_root` → reads `source_type`; if it is `"local"`, reads non-empty `source` and converts it to `PathBuf`, otherwise joins `default_install_root` with `marketplace_name` → returns `Option<PathBuf>`.

**Call relations**: Delegated to by `installed_marketplace_roots_from_layer_stack` and other marketplace-resolution helpers so path policy is centralized.

*Call graph*: called by 3 (configured_marketplace_snapshot_issues, find_marketplace_root_by_name, installed_marketplace_root_for_source); 2 external calls (join, get).


### `cli/src/marketplace_cmd.rs`

`orchestration` · `on demand during `codex plugin marketplace ...` command handling`

This file owns the nested `codex plugin marketplace` command tree. `MarketplaceCli` carries raw config overrides plus a `MarketplaceSubcommand`, and its `run` method parses overrides once and dispatches to add/list/upgrade/remove handlers. The add and remove paths operate directly on `CODEX_HOME` using `find_codex_home` and the marketplace add/remove request types from `codex_core_plugins`, then print either concise status lines or JSON wrappers derived from the returned outcome structs.

The list path is more involved. It loads the full `Config` with CLI overrides, constructs a `PluginsManager`, sets its auth mode using the shared plugin helper, and asks the manager to discover marketplaces for the effective plugin config. It then merges two classes of load problems: snapshot/config issues detected by `configured_marketplace_snapshot_issues`, and any additional discovery errors not already represented by path. If any issue remains, it aborts with a multi-line error enumerating marketplace name, path, and message. Successful listing deduplicates marketplaces by resolved root directory, because multiple entries can point at the same root. JSON output includes optional source metadata reconstructed from the user config by `configured_marketplace_sources_by_root`; text output prints a width-aligned `MARKETPLACE  ROOT` table.

Upgrade loads config and plugin inputs, runs `upgrade_configured_marketplaces_for_config`, and then prints either JSON or human summaries. Both output modes first emit per-marketplace failures to stderr and bail if any upgrade failed, so partial failures are never silently treated as success.

#### Function details

##### `MarketplaceCli::run`  (lines 124–142)

```
async fn run(self) -> Result<()>
```

**Purpose**: Dispatches the parsed marketplace subcommand after converting raw CLI overrides into typed TOML overrides.

**Data flow**: Consumes `self`, parses `config_overrides` into `Vec<(String, toml::Value)>`, then matches `subcommand`: `Add` ignores the parsed overrides and calls `run_add`, while `List`, `Upgrade`, and `Remove` forward the parsed overrides or args into their respective async handlers. Returns `Ok(())` after the selected handler succeeds.

**Call relations**: Called from the plugin branch in `cli_main` when `PluginSubcommand::Marketplace` is selected. It is the single entrypoint for this file’s command tree.

*Call graph*: calls 4 internal fn (run_add, run_list, run_remove, run_upgrade).


##### `run_add`  (lines 145–187)

```
async fn run_add(args: AddMarketplaceArgs) -> Result<()>
```

**Purpose**: Adds a local or Git marketplace source to the user’s configured marketplace set and reports the installed root.

**Data flow**: Consumes `AddMarketplaceArgs`, resolves `CODEX_HOME`, builds a `MarketplaceAddRequest` from `source`, `ref_name`, and `sparse_paths`, and awaits `add_marketplace`. If `json` is true it converts the `MarketplaceAddOutcome` into `JsonMarketplaceAddOutput` and prints pretty JSON; otherwise it prints whether the marketplace was newly added or already present plus the installed root path.

**Call relations**: Invoked by `MarketplaceCli::run` for the `Add` subcommand. It delegates the actual add/install logic to `codex_core_plugins::marketplace_add::add_marketplace`.

*Call graph*: calls 3 internal fn (from_outcome, add_marketplace, find_codex_home); called by 1 (run); 1 external calls (println!).


##### `JsonMarketplaceAddOutput::from_outcome`  (lines 198–204)

```
fn from_outcome(outcome: MarketplaceAddOutcome) -> Self
```

**Purpose**: Converts a marketplace add outcome into the compact JSON shape exposed by the CLI.

**Data flow**: Consumes `MarketplaceAddOutcome` and copies out `marketplace_name`, stringifies `installed_root`, and preserves `already_added`. Returns a serializable struct.

**Call relations**: Used only by `run_add` when `--json` is requested.

*Call graph*: called by 1 (run_add).


##### `run_list`  (lines 207–295)

```
async fn run_list(overrides: Vec<(String, toml::Value)>, args: ListMarketplaceArgs) -> Result<()>
```

**Purpose**: Lists the marketplaces currently in scope for plugin discovery, failing fast if configured marketplace snapshots cannot be loaded cleanly.

**Data flow**: Takes parsed config overrides and `ListMarketplaceArgs`, loads `Config`, constructs a `PluginsManager`, sets auth mode via `load_cli_auth_mode`, and derives `plugins_input`. It calls `discover_marketplaces_for_config`, computes snapshot/config issues with `configured_marketplace_snapshot_issues`, merges in any additional discovery errors by unique path, and bails with a formatted multi-line error if any issue exists. On success it either emits JSON using `configured_marketplace_sources_by_root` and `JsonMarketplaceListOutput::from_marketplaces`, or deduplicates marketplaces by resolved root and prints a width-aligned table.

**Call relations**: Invoked by `MarketplaceCli::run` for `List`. It depends on helpers from `plugin_cmd` to keep marketplace-source and snapshot-validation logic consistent with plugin listing.

*Call graph*: calls 6 internal fn (from_marketplaces, configured_marketplace_sources_by_root, configured_marketplace_snapshot_issues, load_cli_auth_mode, new, marketplace_root_dir); called by 1 (run); 5 external calls (new, new, load_with_cli_overrides, bail!, println!).


##### `JsonMarketplaceListOutput::from_marketplaces`  (lines 304–325)

```
fn from_marketplaces(
        marketplaces: Vec<codex_core_plugins::marketplace::Marketplace>,
        marketplace_sources: &HashMap<PathBuf, JsonMarketplaceSource>,
    ) -> Self
```

**Purpose**: Builds the JSON marketplace listing, deduplicating entries that resolve to the same root directory.

**Data flow**: Consumes a vector of configured marketplace structs plus a map from root path to `JsonMarketplaceSource`. It iterates marketplaces, resolves each root with `marketplace_root_dir`, skips entries whose root cannot be resolved or has already been seen, and produces `JsonMarketplaceListEntry` values containing name, root string, and optional source metadata.

**Call relations**: Called by `run_list` only for JSON output.

*Call graph*: called by 1 (run_list); 1 external calls (new).


##### `configured_marketplace_sources_by_root`  (lines 337–365)

```
fn configured_marketplace_sources_by_root(
    codex_home: &Path,
    plugins_input: &PluginsConfigInput,
) -> HashMap<PathBuf, JsonMarketplaceSource>
```

**Purpose**: Reconstructs marketplace source metadata keyed by resolved install root rather than marketplace name.

**Data flow**: Reads `codex_home` and `PluginsConfigInput`, first deriving name-keyed source metadata via `configured_marketplace_sources`. It then inspects the effective user config’s `[marketplaces]` table, computes the default install root, resolves each configured marketplace’s root with `resolve_configured_marketplace_root`, and returns a `HashMap<PathBuf, JsonMarketplaceSource>` keyed by that root.

**Call relations**: Used by `run_list` so JSON output can attach source metadata even after marketplaces have been deduplicated by root.

*Call graph*: calls 2 internal fn (configured_marketplace_sources, marketplace_install_root); called by 1 (run_list); 1 external calls (new).


##### `run_upgrade`  (lines 367–389)

```
async fn run_upgrade(
    overrides: Vec<(String, toml::Value)>,
    args: UpgradeMarketplaceArgs,
) -> Result<()>
```

**Purpose**: Refreshes one configured Git marketplace or all configured Git marketplaces and prints the result in JSON or human form.

**Data flow**: Consumes parsed overrides and `UpgradeMarketplaceArgs`, loads `Config`, resolves `CODEX_HOME`, constructs a `PluginsManager`, derives `plugins_input`, and calls `upgrade_configured_marketplaces_for_config` with an optional marketplace name filter. It then routes the resulting `PluginMarketplaceUpgradeOutcome` to either `print_upgrade_outcome_json` or `print_upgrade_outcome`.

**Call relations**: Invoked by `MarketplaceCli::run` for `Upgrade`. It delegates all formatting and failure policy to the two print helpers.

*Call graph*: calls 4 internal fn (print_upgrade_outcome, print_upgrade_outcome_json, new, find_codex_home); called by 1 (run); 1 external calls (load_with_cli_overrides).


##### `run_remove`  (lines 391–418)

```
async fn run_remove(args: RemoveMarketplaceArgs) -> Result<()>
```

**Purpose**: Removes a configured marketplace source and optionally its installed root, then reports what was removed.

**Data flow**: Consumes `RemoveMarketplaceArgs`, resolves `CODEX_HOME`, builds a `MarketplaceRemoveRequest`, and awaits `remove_marketplace`. If `json` is set it converts the outcome into `JsonMarketplaceRemoveOutput` and prints pretty JSON; otherwise it prints the marketplace name and, when present, the removed installed root path.

**Call relations**: Invoked by `MarketplaceCli::run` for `Remove`. It delegates the actual config/cache mutation to `codex_core_plugins::marketplace_remove::remove_marketplace`.

*Call graph*: calls 3 internal fn (from_outcome, remove_marketplace, find_codex_home); called by 1 (run); 1 external calls (println!).


##### `JsonMarketplaceRemoveOutput::from_outcome`  (lines 428–435)

```
fn from_outcome(outcome: MarketplaceRemoveOutcome) -> Self
```

**Purpose**: Converts a marketplace removal outcome into the JSON shape exposed by the CLI.

**Data flow**: Consumes `MarketplaceRemoveOutcome`, copies the marketplace name, and maps the optional removed root path into an optional display string.

**Call relations**: Used only by `run_remove` when `--json` is requested.

*Call graph*: called by 1 (run_remove).


##### `print_upgrade_outcome_json`  (lines 438–452)

```
fn print_upgrade_outcome_json(outcome: &PluginMarketplaceUpgradeOutcome) -> Result<()>
```

**Purpose**: Prints upgrade results as JSON but still treats any marketplace-specific failure as an overall command failure.

**Data flow**: Reads a `PluginMarketplaceUpgradeOutcome`, prints each error to stderr, checks `all_succeeded()`, bails with a count-based message if any failure occurred, otherwise converts the outcome with `JsonMarketplaceUpgradeOutput::from_outcome`, prints pretty JSON, and returns success.

**Call relations**: Called by `run_upgrade` for `--json`. It shares the same failure semantics as the human formatter while exposing structured success data.

*Call graph*: calls 1 internal fn (from_outcome); called by 1 (run_upgrade); 4 external calls (all_succeeded, bail!, eprintln!, println!).


##### `JsonMarketplaceUpgradeOutput::from_outcome`  (lines 463–480)

```
fn from_outcome(outcome: &PluginMarketplaceUpgradeOutcome) -> Self
```

**Purpose**: Converts an upgrade outcome into a serializable JSON summary.

**Data flow**: Borrows `PluginMarketplaceUpgradeOutcome`, clones `selected_marketplaces`, stringifies each upgraded root path, maps each error into `JsonMarketplaceUpgradeError`, and returns the assembled struct.

**Call relations**: Used only by `print_upgrade_outcome_json`.

*Call graph*: called by 1 (print_upgrade_outcome_json).


##### `print_upgrade_outcome`  (lines 490–526)

```
fn print_upgrade_outcome(
    outcome: &PluginMarketplaceUpgradeOutcome,
    marketplace_name: Option<&str>,
) -> Result<()>
```

**Purpose**: Formats marketplace upgrade results for humans, distinguishing no-op, already-up-to-date, single-marketplace, and multi-marketplace cases.

**Data flow**: Reads the upgrade outcome and optional selected marketplace name, prints each error to stderr, bails if `all_succeeded()` is false, then chooses one of several messages: no configured Git marketplaces, already up to date, upgraded one named marketplace, or upgraded N marketplaces. In upgrade cases it also prints each installed root path.

**Call relations**: Called by `run_upgrade` for non-JSON output. It is the human-facing counterpart to `print_upgrade_outcome_json`.

*Call graph*: called by 1 (run_upgrade); 4 external calls (all_succeeded, bail!, eprintln!, println!).


##### `tests::sparse_paths_parse_before_or_after_source`  (lines 534–561)

```
fn sparse_paths_parse_before_or_after_source()
```

**Purpose**: Verifies that repeated `--sparse` flags parse correctly whether they appear before or after the source positional.

**Data flow**: Parses several `AddMarketplaceArgs` argv shapes and asserts the resulting `source` and `sparse_paths` values.

**Call relations**: Parser regression test for `AddMarketplaceArgs`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::upgrade_subcommand_parses_optional_marketplace_name`  (lines 564–570)

```
fn upgrade_subcommand_parses_optional_marketplace_name()
```

**Purpose**: Checks that marketplace upgrade accepts an optional marketplace name positional.

**Data flow**: Parses `upgrade` with and without a name and asserts `marketplace_name` is `None` or `Some("debug")` accordingly.

**Call relations**: Parser coverage for `UpgradeMarketplaceArgs`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remove_subcommand_parses_marketplace_name`  (lines 573–576)

```
fn remove_subcommand_parses_marketplace_name()
```

**Purpose**: Checks that marketplace remove captures the required marketplace name positional.

**Data flow**: Parses `remove debug` and asserts the parsed `marketplace_name` string.

**Call relations**: Parser coverage for `RemoveMarketplaceArgs`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


### `plugin/src/provider.rs`

`orchestration` · `plugin discovery and resolution`

This file models a plugin after discovery but before activation. `PluginResourceLocator` and `ResolvedPluginLocation` currently each have an `Environment` variant that pairs an `environment_id` with an absolute path, making resource ownership explicit across potentially different filesystems or execution environments. `ResolvedPlugin` then bundles four pieces of information: the opaque selected capability-root ID, the package location, the manifest resource path, and the parsed manifest whose resource fields have been rewritten to use `PluginResourceLocator` instead of raw paths.

The key constructor is `ResolvedPlugin::from_environment`. It accepts a selected-root ID, environment ID, package root, manifest path, and a `PluginManifest<AbsolutePathBuf>`. It first validates that the manifest path lies under the package root, then uses `PluginManifest::try_map_resources` with the same root-checking conversion to rewrite every manifest resource path into an environment-owned locator. Any resource outside the package root causes `ResolvedPluginError::ResourceOutsideRoot`, preventing inconsistent descriptors that could escape the package boundary.

The remaining methods are simple accessors used by later loading stages. The `PluginProvider` trait abstracts source-specific resolution: implementations perform filesystem access through the authority named by a `SelectedCapabilityRoot` and asynchronously return either `None` for non-plugin roots or a fully resolved inert descriptor.

#### Function details

##### `ResolvedPlugin::from_environment`  (lines 51–70)

```
fn from_environment(
        selected_root_id: String,
        environment_id: String,
        root: AbsolutePathBuf,
        manifest_path: AbsolutePathBuf,
        manifest: PluginManifest<AbsoluteP
```

**Purpose**: Builds a resolved plugin descriptor for a package rooted in a specific environment and validates that every referenced resource stays inside that package root. It converts raw absolute manifest paths into authority-bound locators in one pass.

**Data flow**: It takes owned IDs and paths plus a `PluginManifest<AbsolutePathBuf>`. It first converts `manifest_path` with `environment_resource(&environment_id, &root, manifest_path)?`, then consumes the manifest and calls `try_map_resources` with a closure that applies the same `environment_resource` check to each resource path. On success it returns `ResolvedPlugin` containing the selected root ID, `ResolvedPluginLocation::Environment { environment_id, root }`, the converted manifest path, and the converted manifest; on failure it returns `ResolvedPluginError`.

**Call relations**: Filesystem-backed plugin resolution code and tests call this after parsing a manifest. It delegates all per-resource validation and conversion to `environment_resource` and the manifest’s generic mapping routine so the constructor enforces package-boundary consistency uniformly.

*Call graph*: calls 2 internal fn (try_map_resources, environment_resource); called by 5 (host_and_executor_sources_parse_the_same_manifest, resolve_plugin_root, resolved_plugin, environment_descriptor_binds_every_manifest_resource, environment_descriptor_rejects_resources_outside_package_root).


##### `ResolvedPlugin::selected_root_id`  (lines 73–75)

```
fn selected_root_id(&self) -> &str
```

**Purpose**: Returns the opaque identifier of the selected capability root that produced this plugin. It preserves source-level identity for later orchestration layers.

**Data flow**: It borrows and returns `&self.selected_root_id` as `&str`. No allocation or mutation occurs.

**Call relations**: The file-system loading path reads this when it needs to correlate a resolved plugin back to the selected root that was scanned.

*Call graph*: called by 1 (load_from_file_system).


##### `ResolvedPlugin::location`  (lines 78–80)

```
fn location(&self) -> &ResolvedPluginLocation
```

**Purpose**: Exposes the authority-bound package location for the resolved plugin. It lets later stages know which environment owns the plugin root.

**Data flow**: It returns a shared reference to `self.location`. No transformation occurs.

**Call relations**: Loading code consults this accessor when it needs the package root and owning environment to continue reading plugin contents.

*Call graph*: called by 1 (load_from_file_system).


##### `ResolvedPlugin::manifest_path`  (lines 83–85)

```
fn manifest_path(&self) -> &PluginResourceLocator
```

**Purpose**: Returns the authority-bound locator for the manifest file used to resolve the package. It distinguishes the manifest resource itself from the package root and from other manifest-declared resources.

**Data flow**: It returns `&self.manifest_path` directly. No computation or mutation occurs.

**Call relations**: Tests inspect this accessor to verify that manifest-path binding happened correctly during construction.


##### `ResolvedPlugin::manifest`  (lines 88–90)

```
fn manifest(&self) -> &PluginManifest<PluginResourceLocator>
```

**Purpose**: Returns the parsed manifest whose resource fields have already been rebound to source authority. It is the main metadata accessor for downstream loading stages.

**Data flow**: It returns a shared reference to `self.manifest`. No transformation occurs.

**Call relations**: The file-system loading path reads this to inspect plugin metadata and component resource locators after resolution. Tests also compare it against expected fully-bound manifests.

*Call graph*: called by 1 (load_from_file_system).


##### `environment_resource`  (lines 93–108)

```
fn environment_resource(
    environment_id: &str,
    root: &AbsolutePathBuf,
    path: AbsolutePathBuf,
) -> Result<PluginResourceLocator, ResolvedPluginError>
```

**Purpose**: Validates that a resource path is inside a plugin package root and wraps it in an environment-owned locator. It is the package-boundary enforcement primitive used during resolved-plugin construction.

**Data flow**: It takes `environment_id`, `root`, and an owned absolute `path`. It checks `path.as_path().starts_with(root.as_path())`; if false, it returns `ResolvedPluginError::ResourceOutsideRoot { root: root.clone(), path }`. Otherwise it returns `PluginResourceLocator::Environment { environment_id: environment_id.to_string(), path }`.

**Call relations**: Only `ResolvedPlugin::from_environment` calls this, both for the manifest path itself and indirectly for every manifest resource via `try_map_resources`. That makes it the single source of truth for package-root containment checks.

*Call graph*: calls 1 internal fn (as_path); called by 1 (from_environment); 1 external calls (clone).


### `plugin/src/load_outcome.rs`

`domain_logic` · `plugin load and capability aggregation`

This file defines two central runtime models. `LoadedPlugin<M>` is the per-plugin record produced by loading: config and manifest names/descriptions, filesystem root, enablement state, skill roots and disabled skill paths, whether any skills remain enabled, merged MCP server configs keyed by name, declared apps, hook sources and warnings, and an optional load error. Its `is_active` invariant is strict: a plugin contributes runtime capabilities only when `enabled` is true and `error` is `None`.

`plugin_capability_summary_from_loaded` converts one active plugin into a `PluginCapabilitySummary`. It sorts MCP server names for deterministic output, normalizes descriptions through `prompt_safe_plugin_description`, and deduplicates app connectors. It deliberately suppresses summaries for inactive plugins and for active plugins that expose no skills, MCP servers, or apps, preventing empty capability entries from reaching model-facing surfaces.

`PluginLoadOutcome<M>` stores both the original plugin list and precomputed capability summaries. `from_plugins` is the canonical constructor; `Default` delegates to it with an empty list. The effective-* methods all filter to active plugins first, then merge data with specific precedence rules: skill roots are sorted/deduped globally; `effective_plugin_skill_roots` preserves the first plugin associated with a shared path before sorting by path; MCP servers use first-wins insertion by server name; apps are deduplicated in iteration order; hook sources and warnings are concatenated. The `EffectiveSkillRoots` trait exists so downstream code can depend on skill-root access without naming the generic MCP config type.

#### Function details

##### `LoadedPlugin::is_active`  (lines 34–36)

```
fn is_active(&self) -> bool
```

**Purpose**: Determines whether a loaded plugin should contribute runtime capabilities. A plugin is active only if it is enabled and has no recorded load error.

**Data flow**: It reads `self.enabled` and `self.error`, computes `self.enabled && self.error.is_none()`, and returns that boolean. It does not mutate any state.

**Call relations**: Capability-summary derivation calls this as the gate before exposing any plugin metadata. Other effective aggregation methods inline the same active-plugin filtering logic conceptually, so this method captures the file’s core activation rule.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `LoadedPlugin::display_name`  (lines 38–40)

```
fn display_name(&self) -> &str
```

**Purpose**: Returns the human-facing plugin name, preferring the manifest-provided name when present. It falls back to the configuration name when no manifest name exists.

**Data flow**: It reads `self.manifest_name`, converts the `Option<String>` to `Option<&str>` with `as_deref`, and returns either that borrowed manifest name or `&self.config_name`. No allocation or mutation occurs.

**Call relations**: The capability-summary builder uses this to populate `PluginCapabilitySummary.display_name`, ensuring summaries reflect manifest branding when available.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `plugin_capability_summary_from_loaded`  (lines 43–66)

```
fn plugin_capability_summary_from_loaded(
    plugin: &LoadedPlugin<M>,
) -> Option<PluginCapabilitySummary>
```

**Purpose**: Builds a model-facing capability summary from one loaded plugin, but only when the plugin is active and actually contributes at least one capability. It is the filtering and normalization step behind `PluginLoadOutcome`’s precomputed summaries.

**Data flow**: It takes `&LoadedPlugin<M>`, first checks `plugin.is_active()` and returns `None` early for inactive plugins. For active plugins it clones and sorts MCP server names from `plugin.mcp_servers.keys()`, derives a display name via `plugin.display_name()`, sanitizes `plugin.manifest_description` with `prompt_safe_plugin_description`, and deduplicates app connectors from `plugin.apps` via `app_connector_ids_from_declarations`. It constructs a `PluginCapabilitySummary` and returns `Some(summary)` only if `has_skills` is true or either capability list is non-empty; otherwise it returns `None`.

**Call relations**: This helper is used exclusively during `PluginLoadOutcome::from_plugins` construction to precompute summaries once. It delegates to the plugin activation/name helpers and to description/app normalization helpers so the constructor can remain a simple iterator pipeline.

*Call graph*: calls 3 internal fn (display_name, is_active, prompt_safe_plugin_description); 1 external calls (app_connector_ids_from_declarations).


##### `prompt_safe_plugin_description`  (lines 69–84)

```
fn prompt_safe_plugin_description(description: Option<&str>) -> Option<String>
```

**Purpose**: Normalizes a plugin description for inclusion in capability summaries that may be shown to or consumed by models. It strips formatting-like whitespace variation and enforces a maximum length.

**Data flow**: It accepts `Option<&str>`. `None` returns immediately. For `Some`, it splits on whitespace, rejoins tokens with single spaces, returns `None` if the normalized string is empty, otherwise truncates to `MAX_CAPABILITY_SUMMARY_DESCRIPTION_LEN` characters and returns the resulting `String`.

**Call relations**: The capability-summary builder calls this before embedding manifest descriptions into summaries. Its normalization prevents multiline or excessively long descriptions from leaking directly into prompt-facing metadata.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `PluginLoadOutcome::default`  (lines 96–98)

```
fn default() -> Self
```

**Purpose**: Creates an empty plugin-load outcome with no plugins and therefore no derived capabilities. It provides a generic-friendly default for callers that need a baseline outcome before loading.

**Data flow**: It constructs an empty `Vec<LoadedPlugin<M>>` and delegates to `Self::from_plugins`, returning the resulting `PluginLoadOutcome<M>`. No external state is touched.

**Call relations**: Configuration-loading paths use this when no plugins are available or before layering plugin sources. By routing through `from_plugins`, it preserves the invariant that `capability_summaries` always matches the stored plugin list.

*Call graph*: called by 2 (plugins_for_config_with_force_reload, plugins_for_layer_stack); 2 external calls (from_plugins, new).


##### `PluginLoadOutcome::from_plugins`  (lines 102–111)

```
fn from_plugins(plugins: Vec<LoadedPlugin<M>>) -> Self
```

**Purpose**: Constructs the canonical runtime outcome from a concrete list of loaded plugins and eagerly derives capability summaries. It centralizes the invariant that summaries are computed from the same plugin snapshot they accompany.

**Data flow**: It takes ownership of `Vec<LoadedPlugin<M>>`, iterates over borrowed plugins, applies `filter_map(plugin_capability_summary_from_loaded)`, collects the resulting summaries into a `Vec<PluginCapabilitySummary>`, and returns `Self { plugins, capability_summaries }`.

**Call relations**: This is the main constructor used by plugin-resolution code and tests. All later accessor methods rely on the stored plugin list, while summary consumers use the precomputed `capability_summaries` generated here.

*Call graph*: called by 3 (resolve_loaded_plugins_for_auth, capability_index_filters_inactive_and_zero_capability_plugins, effective_plugin_skill_roots_preserves_first_plugin_for_shared_root).


##### `PluginLoadOutcome::effective_mcp_servers`  (lines 144–154)

```
fn effective_mcp_servers(&self) -> HashMap<String, M>
```

**Purpose**: Merges MCP server definitions from all active plugins into one map, keeping the first definition seen for each server name. It produces the runtime-effective MCP configuration set.

**Data flow**: It iterates through `self.plugins`, filters to active plugins, then iterates each plugin’s `mcp_servers` map. For each `(name, config)`, it inserts into a new `HashMap<String, M>` with `entry(...).or_insert_with(|| config.clone())`, so later duplicates are ignored. It returns the merged map.

**Call relations**: Callers that need the final MCP server set invoke this after plugin loading. The first-wins insertion rule means plugin iteration order determines precedence when multiple active plugins declare the same server name.

*Call graph*: called by 1 (sorted_effective_mcp_server_names); 1 external calls (new).


##### `PluginLoadOutcome::effective_apps`  (lines 156–163)

```
fn effective_apps(&self) -> Vec<AppConnectorId>
```

**Purpose**: Computes the deduplicated list of app connector IDs contributed by active plugins. It collapses duplicate connectors across plugins while preserving first-seen order.

**Data flow**: It iterates over `self.plugins`, filters to active plugins, flattens each plugin’s `apps.iter()`, and passes that iterator of `&AppDeclaration` into `app_connector_ids_from_declarations`. The returned `Vec<AppConnectorId>` is the effective app list.

**Call relations**: This method is the app counterpart to effective MCP server and skill-root aggregation. It delegates deduplication policy to the crate-level helper so app connector ordering stays consistent with capability-summary generation.

*Call graph*: 1 external calls (app_connector_ids_from_declarations).


##### `PluginLoadOutcome::effective_plugin_hook_sources`  (lines 165–171)

```
fn effective_plugin_hook_sources(&self) -> Vec<PluginHookSource>
```

**Purpose**: Collects all hook source records from active plugins into one flat list. It exposes the concrete hook files and metadata that should participate at runtime.

**Data flow**: It iterates over active plugins, clones each `PluginHookSource` from `plugin.hook_sources`, collects them into a `Vec<PluginHookSource>`, and returns it. No sorting or deduplication is applied.

**Call relations**: Consumers call this after plugin loading when they need to register or inspect hooks. Its behavior mirrors the plugin iteration order and intentionally preserves every active hook source.


##### `PluginLoadOutcome::effective_plugin_hook_warnings`  (lines 173–179)

```
fn effective_plugin_hook_warnings(&self) -> Vec<String>
```

**Purpose**: Aggregates hook-loading warnings from all active plugins. It provides a single list of non-fatal hook issues to surface to callers or logs.

**Data flow**: It iterates over active plugins, clones each warning string from `plugin.hook_load_warnings`, collects them into a `Vec<String>`, and returns that vector.

**Call relations**: This is typically consumed alongside effective hook sources so callers can both activate hooks and report any partial-load problems. It does not transform warning content beyond flattening and cloning.


##### `PluginLoadOutcome::capability_summaries`  (lines 181–183)

```
fn capability_summaries(&self) -> &[PluginCapabilitySummary]
```

**Purpose**: Returns the precomputed slice of capability summaries derived at construction time. It is the read-only accessor for model-facing plugin capability metadata.

**Data flow**: It borrows `self.capability_summaries` and returns `&[PluginCapabilitySummary]`. No computation or mutation occurs.

**Call relations**: Callers use this instead of recomputing summaries from plugins. Its contents are guaranteed to reflect the plugin list passed to `from_plugins`.


##### `PluginLoadOutcome::plugins`  (lines 185–187)

```
fn plugins(&self) -> &[LoadedPlugin<M>]
```

**Purpose**: Exposes the underlying loaded-plugin records for inspection. It is the raw accessor when callers need more than the derived effective views.

**Data flow**: It borrows `self.plugins` and returns `&[LoadedPlugin<M>]`. No transformation occurs.

**Call relations**: This accessor supports code that needs per-plugin details such as errors, roots, or disabled paths rather than merged capability outputs.


##### `PluginLoadOutcome::effective_skill_roots`  (lines 199–201)

```
fn effective_skill_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the sorted, deduplicated set of skill root paths from active plugins. It is the simplest filesystem-oriented view of enabled plugin skills.

**Data flow**: It iterates over active plugins, clones every path in `plugin.skill_roots` into a `Vec<AbsolutePathBuf>`, sorts the vector with `sort_unstable`, removes duplicates with `dedup`, and returns it.

**Call relations**: This method backs the `EffectiveSkillRoots` trait implementation and is used by downstream skill-loading code that only needs paths, not plugin provenance.


##### `PluginLoadOutcome::effective_plugin_skill_roots`  (lines 203–205)

```
fn effective_plugin_skill_roots(&self) -> Vec<PluginSkillRoot>
```

**Purpose**: Returns active skill roots annotated with the plugin that first claimed each path. It preserves provenance for shared roots while still deduplicating by filesystem path.

**Data flow**: It creates an output `Vec<PluginSkillRoot>` and a `HashSet<AbsolutePathBuf>` of seen paths. Iterating active plugins in stored order, it clones each unseen skill root path and pushes a `PluginSkillRoot { path, plugin_id: plugin.config_name.clone(), plugin_root: plugin.root.clone() }`. After collection it sorts the vector by `path` and returns it.

**Call relations**: The trait implementation delegates here when callers need both paths and plugin ownership. The first-seen rule is intentional and is covered by the file’s unit test for shared roots.

*Call graph*: 2 external calls (new, new).


##### `tests::test_path`  (lines 212–215)

```
fn test_path(name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute temporary test path from a simple name. It keeps test fixtures concise while ensuring `AbsolutePathBuf` validation is exercised.

**Data flow**: It reads the process temp directory via `std::env::temp_dir()`, joins the provided `name`, converts the result with `AbsolutePathBuf::from_absolute_path_checked`, and returns the validated absolute path or panics in the test if conversion fails.

**Call relations**: The test helper is used by fixture construction and assertions in this module’s tests so expected plugin roots and skill roots are generated consistently.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (temp_dir).


##### `tests::loaded_plugin`  (lines 217–233)

```
fn loaded_plugin(config_name: &str, skill_roots: Vec<AbsolutePathBuf>) -> LoadedPlugin<()>
```

**Purpose**: Constructs a minimal active `LoadedPlugin<()>` fixture for tests. It fills nonessential fields with empty/default values while allowing tests to vary config name and skill roots.

**Data flow**: It takes a `config_name` and `Vec<AbsolutePathBuf>` skill roots, allocates strings and empty collections for the remaining fields, derives `root` from `test_path(config_name)`, sets `enabled: true`, `has_enabled_skills: true`, and `error: None`, and returns the assembled `LoadedPlugin<()>`.

**Call relations**: The shared-root test uses this helper to create concise plugin fixtures without repeating boilerplate field initialization.

*Call graph*: 4 external calls (new, new, new, test_path).


##### `tests::effective_plugin_skill_roots_preserves_first_plugin_for_shared_root`  (lines 236–251)

```
fn effective_plugin_skill_roots_preserves_first_plugin_for_shared_root()
```

**Purpose**: Verifies that when two active plugins share the same skill-root path, the effective plugin-skill-root list keeps the first plugin’s identity. This locks in the precedence rule implemented by `effective_plugin_skill_roots`.

**Data flow**: It creates one shared absolute path, builds a `PluginLoadOutcome` from two fixture plugins that both reference it, calls `outcome.effective_plugin_skill_roots()`, and asserts equality against a single-element vector naming only the first plugin and its root.

**Call relations**: This test exercises the constructor plus the provenance-preserving aggregation path, specifically guarding against regressions that would overwrite first ownership with later plugins.

*Call graph*: calls 1 internal fn (from_plugins); 3 external calls (assert_eq!, test_path, vec!).


### `codex-mcp/src/plugin_config.rs`

`config` · `plugin config load`

This file is the bridge between plugin-authored JSON and the crate's internal `McpServerConfig` model. It accepts either a top-level `{ "mcpServers": ... }` object or a bare server-name map via the untagged `PluginMcpFile` enum, then parses each server independently so one malformed declaration does not invalidate the rest. The result type, `PluginMcpConfigParseOutcome`, deliberately separates successfully normalized servers from `PluginMcpServerParseError` entries keyed by server name.

Normalization has two modes. `PluginMcpServerPlacement::Declared` preserves the plugin's declared placement but rewrites relative `cwd` values under the plugin root. `Environment { environment_id }` forcibly binds stdio servers to a specific environment, defaults missing or null `cwd` to the plugin root, resolves relative `cwd` beneath that root while rejecting path escapes like `..`, and rewrites `env_vars` according to whether the target environment is local or executor-owned. In executor-owned environments, bare env-var names become `McpServerEnvVar::Config { source: Some("remote") }`; invalid `source: "local"` entries are rejected. In local environments, `source: "remote"` is rejected.

The file also performs schema-shape cleanup before deserialization: it tolerates several transport `type` spellings, warns on unknown transport types, drops plugin-level OAuth `callbackPort` because Codex uses global callback settings, and renames OAuth `clientId` to the snake_case `client_id` expected by `McpServerConfig`. Final deserialization is done through `serde_json::from_value`, so any remaining structural mismatch becomes a per-server string error.

#### Function details

##### `PluginMcpFile::into_mcp_servers`  (lines 50–55)

```
fn into_mcp_servers(self) -> BTreeMap<String, JsonValue>
```

**Purpose**: Extracts the server-name map from either supported plugin MCP file shape. It hides whether the JSON used a top-level `mcpServers` wrapper or a bare map.

**Data flow**: Consumes `self` and returns the contained `BTreeMap<String, JsonValue>`, either from `PluginMcpServersFile.mcp_servers` or directly from the `ServerMap` variant.

**Call relations**: This helper is used by `parse_plugin_mcp_config` after top-level deserialization so the rest of the parser can iterate a uniform server map.


##### `parse_plugin_mcp_config`  (lines 62–82)

```
fn parse_plugin_mcp_config(
    plugin_root: &Path,
    contents: &str,
    placement: PluginMcpServerPlacement<'_>,
) -> Result<PluginMcpConfigParseOutcome, serde_json::Error>
```

**Purpose**: Parses a plugin MCP JSON document and normalizes each declared server independently. Top-level JSON syntax/schema errors fail the whole parse, but per-server normalization failures are accumulated alongside successful servers.

**Data flow**: Reads `plugin_root`, raw JSON `contents`, and a `PluginMcpServerPlacement`. It deserializes `contents` into `PluginMcpFile`, initializes a default `PluginMcpConfigParseOutcome`, iterates over `parsed.into_mcp_servers()`, and for each `(name, config_value)` either inserts the normalized `McpServerConfig` into `outcome.servers` or pushes `PluginMcpServerParseError { name, message }` into `outcome.errors`. It returns `Ok(outcome)` unless top-level deserialization failed.

**Call relations**: This is the public entry point for plugin MCP parsing. It delegates all per-server rewriting and validation to `normalize_plugin_mcp_server`.

*Call graph*: calls 1 internal fn (normalize_plugin_mcp_server); 1 external calls (default).


##### `normalize_plugin_mcp_server`  (lines 84–120)

```
fn normalize_plugin_mcp_server(
    plugin_root: &Path,
    value: JsonValue,
    placement: PluginMcpServerPlacement<'_>,
) -> Result<McpServerConfig, String>
```

**Purpose**: Normalizes one plugin-declared server JSON value into a concrete `McpServerConfig`. It applies placement-specific rewrites before deserializing and optionally rebinding environment-variable sources.

**Data flow**: Reads `plugin_root`, a `JsonValue`, and placement. It first obtains a mutable JSON object from `normalize_plugin_mcp_server_value`. In `Environment` placement it overwrites `environment_id`, and for stdio-like objects (`command` present) it rewrites `cwd`: relative strings are resolved with `executor_plugin_cwd`, null or missing values become the plugin root, and non-string values are left untouched. It then deserializes the object into `McpServerConfig`; if placement is `Environment`, it mutably passes the config through `bind_environment_env_vars`. It returns the config or a string error.

**Call relations**: This worker is called by `parse_plugin_mcp_config` for each server. It delegates path safety to `executor_plugin_cwd`, env-var authority rules to `bind_environment_env_vars`, and schema cleanup to `normalize_plugin_mcp_server_value`.

*Call graph*: calls 3 internal fn (bind_environment_env_vars, executor_plugin_cwd, normalize_plugin_mcp_server_value); called by 1 (parse_plugin_mcp_config); 4 external calls (Object, String, to_string_lossy, matches!).


##### `executor_plugin_cwd`  (lines 122–139)

```
fn executor_plugin_cwd(plugin_root: &Path, configured_cwd: &str) -> Result<PathBuf, String>
```

**Purpose**: Resolves a plugin-declared working directory for executor-owned placement while preventing escapes outside the plugin root. Absolute paths are accepted as-is; relative paths must stay strictly beneath the plugin root.

**Data flow**: Reads `plugin_root` and `configured_cwd`. It parses `configured_cwd` as a `Path`; if absolute, it returns that path unchanged. Otherwise it scans path components and rejects any `ParentDir`, `RootDir`, or Windows prefix component with a formatted error. Safe relative paths are joined onto `plugin_root` and returned.

**Call relations**: This helper is used only by `normalize_plugin_mcp_server` when environment placement needs to rewrite a relative stdio `cwd` safely.

*Call graph*: called by 1 (normalize_plugin_mcp_server); 3 external calls (join, new, format!).


##### `bind_environment_env_vars`  (lines 141–175)

```
fn bind_environment_env_vars(config: &mut McpServerConfig) -> Result<(), String>
```

**Purpose**: Rewrites or validates `env_vars` for stdio servers after an environment has been forced onto the config. It enforces that local environments use local sources and executor-owned environments use remote sources.

**Data flow**: Mutably reads an `McpServerConfig`. If the transport is not `Stdio`, it returns `Ok(())`. Otherwise it computes `is_local_environment` and iterates `env_vars`: bare `Name(name)` entries become `Config { name, source: Some("remote") }` for non-local environments and remain unchanged for local ones; `Config` entries are validated against `(is_local_environment, source)` and may have missing remote sources filled in or produce formatted errors for invalid local/remote combinations. It mutates the config in place and returns success or the first error.

**Call relations**: This helper is called by `normalize_plugin_mcp_server` only for `Environment` placement, after deserialization has produced a typed config.

*Call graph*: calls 1 internal fn (is_local_environment); called by 1 (normalize_plugin_mcp_server); 3 external calls (format!, take, unreachable!).


##### `normalize_plugin_mcp_server_value`  (lines 177–228)

```
fn normalize_plugin_mcp_server_value(
    plugin_root: &Path,
    value: JsonValue,
    placement: PluginMcpServerPlacement<'_>,
) -> JsonMap<String, JsonValue>
```

**Purpose**: Performs JSON-shape cleanup on one plugin server declaration before typed deserialization. It tolerates plugin-facing field names and placement-specific path rewriting while warning about ignored or unknown fields.

**Data flow**: Reads `plugin_root`, a raw `JsonValue`, and placement. Non-object values become an empty JSON object. For object values, it removes `type` and warns if the string is not one of `http`, `streamable_http`, `streamable-http`, or `stdio`. It removes `oauth`, drops any `callbackPort` with a warning, renames `clientId` to `client_id` when needed, and reinserts non-empty OAuth objects. In `Declared` placement, if `cwd` is a relative string, it rewrites it to `plugin_root.join(cwd)` as a string. It returns the normalized `JsonMap<String, JsonValue>`.

**Call relations**: This is the first normalization stage used by `normalize_plugin_mcp_server`, keeping plugin-facing JSON quirks out of the typed deserialization path.

*Call graph*: called by 1 (normalize_plugin_mcp_server); 7 external calls (new, Object, String, join, new, matches!, warn!).


### `codex-mcp/src/catalog.rs`

`domain_logic` · `configuration resolution`

This file is the core data model and resolution logic for MCP server registration precedence. `McpPluginAttribution` stores plugin identity for later tool attribution, while `McpServerSource` distinguishes where a registration came from and encodes one subtle policy: disabled selected-plugin registrations do not become name-scoped vetoes for later higher-precedence runtime overlays. `RegistrationPrecedence` orders sources by tier and, for plugins and selected plugins, uses `Reverse<usize>` so earlier discovery or selection order wins within that tier.

`McpServerRegistration` is the pre-resolution declaration type, with constructors for each source category. `CatalogAction` extends that model to include removals, allowing compatibility and extension layers to explicitly delete a logical server name. `McpCatalogBuilder` accumulates actions plus a `BTreeSet` of disabled names. In `build`, actions are stably sorted by precedence so insertion order breaks ties within equal precedence. The builder then computes the last action per name as the winner, groups actions by `(name, tier)` to emit `McpServerConflict` records only for same-tier collisions, and finally materializes `ResolvedMcpServer` entries for winning registrations while dropping winning removals.

The disabled-name logic is easy to miss: if a winning registration is disabled either by its own config or by a legacy disabled-name veto, its `config.enabled` is forced false; and for sources whose disabled state should persist as a name veto, that name is reinserted into the disabled set so later overlays built from `to_builder` inherit the veto. `ResolvedMcpCatalog` then exposes lookup, cloning back to a builder, extraction of plain configs, plugin attribution for winning plugin-owned servers, selected-plugin server-name iteration, and conflict inspection.

#### Function details

##### `McpPluginAttribution::new`  (lines 16–21)

```
fn new(plugin_id: String, display_name: String) -> Self
```

**Purpose**: Constructs plugin attribution metadata from a plugin ID and display name. The resulting value is attached to plugin-sourced MCP registrations and later surfaced for provenance.

**Data flow**: Consumes two `String` values, stores them in a new `McpPluginAttribution`, and returns the struct without side effects.

**Call relations**: It is called by tests and higher-level configuration assembly when creating plugin or selected-plugin registrations that need attribution preserved through catalog resolution.

*Call graph*: called by 6 (plugin, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, tool_plugin_provenance_collects_app_and_mcp_sources, to_mcp_config_with_plugin_registrations, selected_plugin_wins_after_discovered_plugin_requirements, runtime_config_with_context).


##### `McpPluginAttribution::plugin_id`  (lines 23–25)

```
fn plugin_id(&self) -> &str
```

**Purpose**: Returns the stored plugin identifier string slice. This is the stable identity used for provenance and joins.

**Data flow**: Reads `self.plugin_id` and returns `&str` referencing it.

**Call relations**: This accessor supports downstream provenance consumers; it does not participate in catalog resolution itself.


##### `McpPluginAttribution::display_name`  (lines 27–29)

```
fn display_name(&self) -> &str
```

**Purpose**: Returns the human-facing plugin display name. It preserves the label associated with the registration source.

**Data flow**: Reads `self.display_name` and returns `&str` referencing it.

**Call relations**: Like `plugin_id`, this accessor is used by downstream attribution logic rather than by the builder’s precedence algorithm.


##### `McpServerSource::disabled_registration_is_name_veto`  (lines 49–53)

```
fn disabled_registration_is_name_veto(&self) -> bool
```

**Purpose**: Determines whether a disabled winning registration should persist as a legacy name-scoped veto across later catalog extensions. Selected-plugin registrations are explicitly excluded from this persistence rule.

**Data flow**: Reads the enum variant in `self`, applies a `matches!` check, and returns `false` only for `SelectedPlugin`, `true` for all other sources.

**Call relations**: It is consulted inside `McpCatalogBuilder::build` when deciding whether a disabled winner should reinsert its name into the persistent disabled-name set.

*Call graph*: 1 external calls (matches!).


##### `RegistrationPrecedence::tier`  (lines 66–74)

```
fn tier(self) -> u8
```

**Purpose**: Maps detailed precedence values to a coarse tier number used for conflict grouping. Different orders within the same source class collapse to the same tier.

**Data flow**: Matches on `self` and returns a `u8` tier: plugin 0, selected plugin 1, config 2, compatibility 3, extension 4.

**Call relations**: This helper is used during `McpCatalogBuilder::build` to group actions by `(name, tier)` so only same-tier collisions become `McpServerConflict` entries.


##### `McpServerRegistration::from_config`  (lines 87–94)

```
fn from_config(name: String, config: McpServerConfig) -> Self
```

**Purpose**: Creates a registration sourced from static config with config-tier precedence. Config registrations outrank plugins and selected plugins but lose to compatibility and extension overlays under the current ordering.

**Data flow**: Consumes a logical server name and `McpServerConfig`, wraps them with `McpServerSource::Config` and `RegistrationPrecedence::Config`, and returns the new registration via `McpServerRegistration::new`.

**Call relations**: Called by configuration assembly and tests whenever a config-defined server should enter the catalog with the standard config precedence.

*Call graph*: called by 5 (disabled_winner_remains_a_veto_when_the_catalog_is_extended, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, effective_mcp_servers_preserve_runtime_servers, to_mcp_config_with_plugin_registrations); 1 external calls (new).


##### `McpServerRegistration::from_plugin`  (lines 96–108)

```
fn from_plugin(
        name: String,
        attribution: McpPluginAttribution,
        plugin_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration declared by a discovered plugin. Earlier plugin discovery order wins within the plugin tier.

**Data flow**: Consumes a server name, `McpPluginAttribution`, plugin order index, and `McpServerConfig`; wraps the source as `McpServerSource::Plugin` and precedence as `RegistrationPrecedence::Plugin(Reverse(plugin_order))`; returns the registration.

**Call relations**: Used when importing plugin-provided MCP servers into the catalog. Its precedence encoding is what lets earlier plugins beat later ones in same-tier conflicts.

*Call graph*: called by 6 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, earlier_plugin_wins_with_an_explicit_conflict, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, tool_plugin_provenance_collects_app_and_mcp_sources, to_mcp_config_with_plugin_registrations); 4 external calls (new, Plugin, Plugin, Reverse).


##### `McpServerRegistration::from_selected_plugin`  (lines 111–123)

```
fn from_selected_plugin(
        name: String,
        attribution: McpPluginAttribution,
        selection_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration for a thread-selected plugin, positioned above discovered plugins and below config. Earlier selection order wins within the selected-plugin tier.

**Data flow**: Consumes a server name, plugin attribution, selection order, and config; wraps them in `McpServerSource::SelectedPlugin` and `RegistrationPrecedence::SelectedPlugin(Reverse(selection_order))`; returns the registration.

**Call relations**: Used by runtime capability-root selection flows and tests that verify selected plugins override discovered plugins but do not create persistent disabled-name vetoes.

*Call graph*: called by 5 (disabled_selected_plugin_does_not_veto_runtime_overlays, selected_plugins_override_discovered_plugins_but_not_config, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, selected_plugin_wins_after_discovered_plugin_requirements, runtime_config_with_context); 4 external calls (new, SelectedPlugin, SelectedPlugin, Reverse).


##### `McpServerRegistration::from_compatibility`  (lines 125–136)

```
fn from_compatibility(
        name: String,
        id: impl Into<String>,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a compatibility-layer registration with compatibility precedence and a string identifier for the compatibility source. This source can also later be removed by name.

**Data flow**: Consumes a server name, an ID convertible into `String`, and config; converts the ID, wraps it in `McpServerSource::Compatibility`, assigns `RegistrationPrecedence::Compatibility`, and returns the registration.

**Call relations**: Used when legacy or compatibility shims contribute MCP servers that should sit above config and below extensions in the precedence order.

*Call graph*: called by 3 (equal_precedence_uses_insertion_order_not_source_identity, source_precedence_preserves_the_winning_registration, runtime_config_with_context); 2 external calls (into, new).


##### `McpServerRegistration::from_extension`  (lines 138–150)

```
fn from_extension(
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates an extension-contributed registration with extension precedence and explicit contribution order. Extension registrations are the highest-precedence source in this resolver.

**Data flow**: Consumes a server name, extension ID, contribution order, and config; converts the ID, wraps it in `McpServerSource::Extension`, assigns `RegistrationPrecedence::Extension(contribution_order)`, and returns the registration.

**Call relations**: Used by runtime extension overlays and tests that verify extensions can replace lower-precedence winners while still being affected by persisted disabled-name vetoes.

*Call graph*: called by 6 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, source_precedence_preserves_the_winning_registration, runtime_config_with_context); 3 external calls (into, new, Extension).


##### `McpServerRegistration::new`  (lines 152–164)

```
fn new(
        name: String,
        source: McpServerSource,
        config: McpServerConfig,
        precedence: RegistrationPrecedence,
    ) -> Self
```

**Purpose**: Internal constructor that stores the registration’s name, source, config, and precedence without applying any policy. It is the common endpoint for all source-specific constructors.

**Data flow**: Consumes the four fields and returns `Self { name, source, config, precedence }`.

**Call relations**: All public `from_*` constructors delegate here so the struct layout is initialized consistently.


##### `CatalogAction::name`  (lines 194–199)

```
fn name(&self) -> &str
```

**Purpose**: Returns the logical server name targeted by a register or remove action. This lets the builder treat both action kinds uniformly when grouping and selecting winners.

**Data flow**: Matches on `self` and returns a borrowed `&str` from either the boxed registration or the remove action’s `name` field.

**Call relations**: Used inside `McpCatalogBuilder::build` when indexing winners and conflict groups by server name.


##### `CatalogAction::precedence`  (lines 201–206)

```
fn precedence(&self) -> RegistrationPrecedence
```

**Purpose**: Returns the precedence associated with a register or remove action. This allows stable sorting and winner selection across both action kinds.

**Data flow**: Matches on `self` and returns the stored `RegistrationPrecedence`, dereferencing the remove action’s field when needed.

**Call relations**: Used by `McpCatalogBuilder::build` as the sort key and as input to tier grouping.


##### `CatalogAction::conflict_action`  (lines 208–215)

```
fn conflict_action(&self) -> McpServerConflictAction
```

**Purpose**: Converts an internal action into the public conflict-reporting enum that records whether a contender registered or removed a server. The source is cloned into the public value.

**Data flow**: Matches on `self`; for registrations it returns `McpServerConflictAction::Register(registration.source.clone())`, and for removals it returns `McpServerConflictAction::Remove(source.clone())`.

**Call relations**: Called during conflict construction in `McpCatalogBuilder::build` so the resolved catalog can expose human-meaningful same-tier contenders and outcomes.

*Call graph*: 2 external calls (Register, Remove).


##### `McpCatalogBuilder::register`  (lines 226–229)

```
fn register(&mut self, registration: McpServerRegistration)
```

**Purpose**: Adds a registration action to the mutable builder. Registrations are stored in insertion order until resolution time.

**Data flow**: Consumes an `McpServerRegistration`, boxes it, wraps it in `CatalogAction::Register`, and pushes it onto `self.actions`.

**Call relations**: This is the primary mutation API used by callers and tests to feed declarations into the catalog before `build` resolves precedence.

*Call graph*: 2 external calls (new, Register).


##### `McpCatalogBuilder::disable`  (lines 232–234)

```
fn disable(&mut self, name: String)
```

**Purpose**: Adds a legacy disabled-name veto for a logical server name. The veto is applied after source resolution to the winning registration for that name.

**Data flow**: Consumes a `String` name and inserts it into `self.disabled_server_names`.

**Call relations**: Used by callers and tests to model legacy disable semantics; `build` later consults this set when finalizing winning registrations.

*Call graph*: 1 external calls (insert).


##### `McpCatalogBuilder::remove_compatibility`  (lines 236–242)

```
fn remove_compatibility(&mut self, name: String, id: impl Into<String>)
```

**Purpose**: Adds a compatibility-layer removal action for a logical server name. If it wins by precedence and insertion order, the server disappears from the resolved catalog.

**Data flow**: Consumes a name and compatibility ID, converts the ID into `String`, constructs `CatalogAction::Remove` with compatibility source and precedence, and pushes it into `self.actions`.

**Call relations**: Used when compatibility overlays need to explicitly delete a server name rather than replace it with another registration.

*Call graph*: 1 external calls (into).


##### `McpCatalogBuilder::remove_extension`  (lines 244–255)

```
fn remove_extension(
        &mut self,
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
    )
```

**Purpose**: Adds an extension-layer removal action with explicit contribution order. This lets runtime overlays remove a server name at extension precedence.

**Data flow**: Consumes a name, extension ID, and contribution order; converts the ID, constructs a remove action with `McpServerSource::Extension` and matching precedence, and appends it to `self.actions`.

**Call relations**: Used by extension/runtime flows and tests that need removal to participate in the same precedence and conflict machinery as registrations.

*Call graph*: 2 external calls (into, Extension).


##### `McpCatalogBuilder::build`  (lines 257–322)

```
fn build(mut self) -> ResolvedMcpCatalog
```

**Purpose**: Resolves all accumulated actions into an immutable `ResolvedMcpCatalog`. It applies precedence, stable tie-breaking, same-tier conflict reporting, and disabled-name persistence rules.

**Data flow**: Consumes the builder mutably. It stable-sorts `self.actions` by `CatalogAction::precedence`, walks the sorted actions to compute the last action per name as the winner and to group actions by `(name, tier)`, builds `McpServerConflict` entries for groups with multiple same-tier contenders, then iterates winners: winning registrations become `ResolvedMcpServer` entries, possibly with `config.enabled` forced false if the config was disabled or the name is in the disabled set; winning removals are dropped. When a disabled winner’s source returns true from `disabled_registration_is_name_veto`, the name is reinserted into the disabled set so future `to_builder` extensions inherit the veto. It returns `ResolvedMcpCatalog { actions, disabled_server_names, servers, conflicts }`.

**Call relations**: This is the file’s central resolver. All builder mutation methods feed into it, and `ResolvedMcpCatalog::to_builder` exists specifically so callers can extend a previously built catalog while preserving actions and persisted disabled-name state.

*Call graph*: 3 external calls (new, new, new).


##### `ResolvedMcpServer::source`  (lines 333–335)

```
fn source(&self) -> &McpServerSource
```

**Purpose**: Returns the winning server’s source metadata. Consumers use this to inspect provenance after resolution.

**Data flow**: Reads `self.source` and returns `&McpServerSource`.

**Call relations**: Used by catalog consumers and by helper methods like `plugin_attributions_by_server_name` and `selected_plugin_server_names`.


##### `ResolvedMcpServer::config`  (lines 337–339)

```
fn config(&self) -> &McpServerConfig
```

**Purpose**: Returns the winning server’s resolved configuration, including any forced `enabled = false` applied during build. This is the final config visible to downstream runtime setup.

**Data flow**: Reads `self.config` and returns `&McpServerConfig`.

**Call relations**: Used by callers that need the final effective MCP server configuration after precedence and disable resolution.


##### `ResolvedMcpCatalog::builder`  (lines 352–354)

```
fn builder() -> McpCatalogBuilder
```

**Purpose**: Creates a fresh empty catalog builder. It is the standard entry point for assembling registrations before resolution.

**Data flow**: Calls `McpCatalogBuilder::default()` and returns the new builder.

**Call relations**: Widely used by tests and configuration assembly as the starting point for catalog construction.

*Call graph*: called by 12 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, earlier_plugin_wins_with_an_explicit_conflict, equal_precedence_uses_insertion_order_not_source_identity, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, effective_mcp_servers_preserve_runtime_servers, selected_mcp_attribution_does_not_join_an_unrelated_local_summary (+2 more)); 1 external calls (default).


##### `ResolvedMcpCatalog::to_builder`  (lines 356–361)

```
fn to_builder(&self) -> McpCatalogBuilder
```

**Purpose**: Clones a resolved catalog back into a mutable builder while preserving action history and persisted disabled-name vetoes. This supports incremental extension of an already-resolved catalog.

**Data flow**: Reads `self.actions` and `self.disabled_server_names`, clones both collections, and returns a new `McpCatalogBuilder` containing them.

**Call relations**: Used in tests and runtime flows that first resolve one layer, then add later overlays while keeping prior disable semantics intact.

*Call graph*: 1 external calls (clone).


##### `ResolvedMcpCatalog::server`  (lines 363–365)

```
fn server(&self, name: &str) -> Option<&ResolvedMcpServer>
```

**Purpose**: Looks up the winning resolved server by logical name. It returns `None` if the name has no winning registration or was removed.

**Data flow**: Reads `self.servers` and returns `Option<&ResolvedMcpServer>` from the map lookup.

**Call relations**: This is the direct lookup API used by tests and downstream runtime code after catalog resolution.


##### `ResolvedMcpCatalog::configured_servers`  (lines 367–372)

```
fn configured_servers(&self) -> HashMap<String, McpServerConfig>
```

**Purpose**: Exports the resolved catalog as a plain `HashMap<String, McpServerConfig>`. This strips source metadata and keeps only final configs keyed by server name.

**Data flow**: Iterates `self.servers`, clones each name and each server config, collects them into a `HashMap`, and returns it.

**Call relations**: Used by downstream configuration consumers that only need effective configs, not provenance or conflict details.


##### `ResolvedMcpCatalog::plugin_attributions_by_server_name`  (lines 375–388)

```
fn plugin_attributions_by_server_name(&self) -> HashMap<String, McpPluginAttribution>
```

**Purpose**: Returns plugin attribution only for winning servers owned by plugins or selected plugins. Non-plugin sources are omitted.

**Data flow**: Iterates `self.servers`, inspects each `ResolvedMcpServer::source()`, clones the server name and `McpPluginAttribution` for `Plugin` and `SelectedPlugin` variants, filters out `Config`, `Compatibility`, and `Extension`, and collects the result into a `HashMap`.

**Call relations**: This method bridges catalog resolution to tool provenance logic by exposing which winning server names came from which plugins.


##### `ResolvedMcpCatalog::selected_plugin_server_names`  (lines 391–395)

```
fn selected_plugin_server_names(&self) -> impl Iterator<Item = &str>
```

**Purpose**: Iterates the names of winning servers supplied specifically by selected plugins. It is restricted to crate visibility because it supports internal runtime behavior.

**Data flow**: Iterates `self.servers`, checks each source for `McpServerSource::SelectedPlugin(_)`, and yields `&str` names for matching entries.

**Call relations**: Used internally where runtime behavior depends on whether a winning server came from a thread-selected plugin rather than a discovered plugin or config.


##### `ResolvedMcpCatalog::conflicts`  (lines 397–399)

```
fn conflicts(&self) -> &[McpServerConflict]
```

**Purpose**: Returns the recorded same-tier conflicts discovered during build. These conflicts describe contenders and the final outcome after precedence and insertion-order tie-breaking.

**Data flow**: Reads `self.conflicts` and returns it as a slice `&[McpServerConflict]`.

**Call relations**: Used by tests and diagnostics to inspect collisions that occurred during catalog resolution.


### `core/src/mcp.rs`

`orchestration` · `config resolution / MCP setup`

This file defines `McpManager`, a small orchestration object that owns a `PluginsManager` and an extension registry and exposes progressively richer MCP views. The core work happens in `runtime_config_with_context`. It first creates an `McpServerContributionContext`, either global or thread-scoped, then asynchronously walks every extension contributor and collects three kinds of contributions: ordered `Set` overlays, ordered `Remove` overlays, and selected-plugin registrations. The code tracks a single monotonically increasing `contribution_order` across all contributors so conflict resolution reflects actual emission order rather than contributor grouping.

Next it asks `Config::to_mcp_config_with_plugin_registrations` for the base config, seeded with any selected-plugin registrations. It then mutates the catalog builder with a compatibility registration for the legacy Codex Apps MCP server when `apps_enabled` is true, or removes that compatibility entry otherwise. Extension overlays are applied afterward as extension registrations/removals, preserving contributor ID and contribution order for conflict accounting. Once built, the final catalog is scanned for conflicts and each resolved conflict is logged with contenders and outcome.

The remaining methods are convenience projections over that machinery: `configured_servers` returns only config/plugin-backed servers without runtime overlays, `runtime_servers` returns configured plus host-contributed servers before auth gating, and `effective_servers` applies auth gating to produce `EffectiveMcpServer` values.

#### Function details

##### `McpManager::new`  (lines 44–49)

```
fn new(plugins_manager: Arc<PluginsManager>) -> Self
```

**Purpose**: Constructs an `McpManager` that uses plugins but no host-installed extension contributions. It initializes the extension registry to an empty registry.

**Data flow**: Takes `plugins_manager: Arc<PluginsManager>` and returns `McpManager { plugins_manager, extensions: empty_extension_registry() }`.

**Call relations**: This is the common constructor used by many runtime and test call sites that do not need extension overlays. It funnels into the same manager behavior as `new_with_extensions`, just with an empty registry.

*Call graph*: called by 14 (run_get, run_list, run_login, run_logout, list_accessible_connectors_from_mcp_tools_with_environment_manager, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx (+4 more)); 1 external calls (empty_extension_registry).


##### `McpManager::new_with_extensions`  (lines 52–60)

```
fn new_with_extensions(
        plugins_manager: Arc<PluginsManager>,
        extensions: Arc<ExtensionRegistry<Config>>,
    ) -> Self
```

**Purpose**: Constructs an `McpManager` with both plugin support and an explicit extension registry. It enables host-installed MCP contributors to participate in runtime resolution.

**Data flow**: Accepts `plugins_manager: Arc<PluginsManager>` and `extensions: Arc<ExtensionRegistry<Config>>`, then returns a `McpManager` storing both.

**Call relations**: Used by callers that need extension-contributed MCP servers or removals. It is the more general constructor; `new` is the simplified variant that supplies an empty registry.

*Call graph*: called by 3 (new, installed_manager, later_extension_can_remove_same_name_registration).


##### `McpManager::runtime_config`  (lines 64–67)

```
async fn runtime_config(&self, config: &Config) -> McpConfig
```

**Purpose**: Builds the runtime MCP configuration in the global context, including compatibility built-ins and extension overlays. It is the public convenience wrapper for non-thread-specific resolution.

**Data flow**: Takes `&self` and `config: &Config`, forwards to `runtime_config_with_context(config, None)`, and returns the resulting `McpConfig`.

**Call relations**: Called by `runtime_servers` and `effective_servers` when they need the fully overlaid runtime config. It delegates all substantive work to `runtime_config_with_context`.

*Call graph*: calls 1 internal fn (runtime_config_with_context); called by 2 (effective_servers, runtime_servers).


##### `McpManager::runtime_config_for_thread`  (lines 69–76)

```
async fn runtime_config_for_thread(
        &self,
        config: &Config,
        thread_init: &ExtensionDataInit,
    ) -> McpConfig
```

**Purpose**: Builds the runtime MCP configuration using thread-specific extension initialization data. This allows extensions to contribute servers based on per-thread context.

**Data flow**: Accepts `config: &Config` and `thread_init: &ExtensionDataInit`, forwards to `runtime_config_with_context(config, Some(thread_init))`, and returns `McpConfig`.

**Call relations**: This is the thread-aware sibling of `runtime_config`. It exists for flows that need extension contributions scoped to a particular thread rather than the global environment.

*Call graph*: calls 1 internal fn (runtime_config_with_context).


##### `McpManager::runtime_config_with_context`  (lines 78–183)

```
async fn runtime_config_with_context(
        &self,
        config: &Config,
        thread_init: Option<&ExtensionDataInit>,
    ) -> McpConfig
```

**Purpose**: Resolves the full runtime MCP configuration by merging config, selected-plugin registrations, compatibility registrations, and ordered extension set/remove overlays. It is the file’s main composition routine.

**Data flow**: Consumes `config` plus optional `thread_init`. It builds a contribution context (`global` or `for_thread`), iterates extension contributors asynchronously, and accumulates `selected_plugin_registrations` plus ordered `OrderedMcpOverlay` actions. It then awaits `config.to_mcp_config_with_plugin_registrations(...)`, converts the catalog to a builder, conditionally registers or removes the legacy Codex Apps compatibility server, applies each overlay as an extension registration/removal, builds the catalog, logs any conflicts, stores the built catalog back into `mcp_config.mcp_server_catalog`, and returns the updated `McpConfig`.

**Call relations**: This private method is the implementation behind both `runtime_config` and `runtime_config_for_thread`. It delegates base-config creation to `Config`, registration construction to `McpServerRegistration` constructors, and final server extraction to other methods in this file.

*Call graph*: calls 6 internal fn (new, from_compatibility, from_extension, from_selected_plugin, for_thread, global); called by 2 (runtime_config, runtime_config_for_thread); 4 external calls (new, to_mcp_config_with_plugin_registrations, codex_apps_mcp_server_config, warn!).


##### `McpManager::configured_servers`  (lines 186–189)

```
async fn configured_servers(&self, config: &Config) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns only the MCP servers that come from static config and plugin-backed config, without runtime extension overlays. It is the narrowest server view exposed by the manager.

**Data flow**: Awaits `config.to_mcp_config(self.plugins_manager.as_ref())`, then passes the resulting `McpConfig` to `configured_mcp_servers`, returning `HashMap<String, McpServerConfig>`.

**Call relations**: Used when callers want the configured baseline rather than runtime overlays or auth-gated effective servers. It bypasses `runtime_config_with_context` entirely.

*Call graph*: 2 external calls (to_mcp_config, configured_mcp_servers).


##### `McpManager::runtime_servers`  (lines 192–195)

```
async fn runtime_servers(&self, config: &Config) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns the configured and host-contributed MCP servers before auth gating. It exposes the runtime catalog as plain `McpServerConfig` values.

**Data flow**: Awaits `self.runtime_config(config)`, then extracts a `HashMap<String, McpServerConfig>` via `configured_mcp_servers(&mcp_config)`.

**Call relations**: This method sits between `runtime_config` and `effective_servers`: it includes runtime overlays but does not apply auth-based filtering or transformation into `EffectiveMcpServer`.

*Call graph*: calls 1 internal fn (runtime_config); 1 external calls (configured_mcp_servers).


##### `McpManager::effective_servers`  (lines 198–205)

```
async fn effective_servers(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: Returns the final runtime MCP servers after auth gating and compatibility handling. It is the highest-level server view in this file.

**Data flow**: Awaits `self.runtime_config(config)` and then passes the resulting `McpConfig` plus optional `CodexAuth` to `effective_mcp_servers`, returning `HashMap<String, EffectiveMcpServer>`.

**Call relations**: Called by higher-level runtime code that needs the actual usable MCP server set. It depends on `runtime_config` for overlay resolution and delegates auth gating to `effective_mcp_servers`.

*Call graph*: calls 1 internal fn (runtime_config); 1 external calls (effective_mcp_servers).


### Model and provider presets
These files define provider registries, model-manager configuration and helpers, collaboration presets, approval presets, and lightweight TUI wrappers around model data and update actions.

### `model-provider-info/src/lib.rs`

`domain_logic` · `config load and provider selection/setup`

This crate is the canonical data and policy layer for model provider definitions. It declares `WireApi`, currently only `Responses`, with custom deserialization that rejects the removed `chat` value using a tailored migration error. `ModelProviderInfo` is the main schema: display name, base URL, multiple auth mechanisms (`env_key`, bearer token, command auth, AWS SigV4), optional query params and headers, retry/timeouts, and capability flags such as `requires_openai_auth` and `supports_websockets`. `ModelProviderAwsAuthInfo` carries optional AWS profile and region.

Behavior lives on `ModelProviderInfo`. `validate` enforces mutually exclusive auth combinations, especially around AWS and command auth, and forbids AWS plus websockets. `build_header_map` merges literal `http_headers` with environment-backed `env_http_headers`, silently skipping invalid header names/values and unset or blank env vars. `to_api_provider` chooses a default base URL based on `AuthMode` (ChatGPT Codex endpoint for ChatGPT/PAT-style auth, otherwise OpenAI API), builds headers, clamps retry counts and timeouts through helper accessors, and returns a `codex_api::Provider`. `api_key` resolves a non-empty env var or returns a structured `CodexErr::EnvVar` with optional instructions.

The file also defines built-in provider constructors: `create_openai_provider` injects version and organization/project headers and enables OpenAI auth/websockets; `create_amazon_bedrock_provider` sets the Mantle base URL, AWS auth defaults, and the required `x-amzn-mantle-client-agent: codex` header; `create_oss_provider` and `create_oss_provider_with_base_url` derive localhost-compatible providers from environment overrides. `built_in_model_providers` assembles the default catalog, and `merge_configured_model_providers` extends it while allowing only `aws.profile`/`aws.region` overrides for the built-in Amazon Bedrock entry. The overall design keeps provider definitions serializable, validated, and directly convertible into runtime HTTP client configuration.

#### Function details

##### `WireApi::fmt`  (lines 60–65)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the wire API enum as the lowercase string used in config and diagnostics.

**Data flow**: It matches `self`, maps `WireApi::Responses` to the literal `"responses"`, and writes that string into the provided formatter.

**Call relations**: This is standard display support for provider config values; it is used wherever a `WireApi` needs to be rendered textually.

*Call graph*: 1 external calls (write_str).


##### `WireApi::deserialize`  (lines 69–79)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes the wire API from config text while providing a migration-specific error for the removed `chat` protocol.

**Data flow**: It deserializes an input string, matches it against known variants, returns `WireApi::Responses` for `"responses"`, emits `serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)` for `"chat"`, and otherwise returns an unknown-variant error listing only `responses`.

**Call relations**: Serde invokes this during `ModelProviderInfo` deserialization from TOML/JSON, making unsupported legacy config fail with a targeted remediation message.

*Call graph*: 3 external calls (deserialize, custom, unknown_variant).


##### `ModelProviderInfo::validate`  (lines 150–208)

```
fn validate(&self) -> std::result::Result<(), String>
```

**Purpose**: Checks a provider definition for invalid combinations of auth and capability settings before runtime use.

**Data flow**: It reads the provider’s `aws`, `supports_websockets`, `env_key`, `experimental_bearer_token`, `auth`, and `requires_openai_auth` fields. If `aws` is present, it rejects websocket support and accumulates any conflicting auth-related fields into an error string. If command `auth` is present, it rejects an empty trimmed `auth.command` and similarly rejects coexistence with `env_key`, `experimental_bearer_token`, or `requires_openai_auth`. It returns `Ok(())` only when no conflicts are found.

**Call relations**: Higher-level config validation calls this to reject unsupported provider definitions early; it encapsulates the policy constraints around mutually exclusive auth modes.

*Call graph*: 2 external calls (new, format!).


##### `ModelProviderInfo::build_header_map`  (lines 210–235)

```
fn build_header_map(&self) -> CodexResult<HeaderMap>
```

**Purpose**: Constructs the HTTP header set that should be attached to requests for this provider, combining static and environment-derived headers.

**Data flow**: It computes an initial capacity from the lengths of `http_headers` and `env_http_headers`, creates a `HeaderMap`, inserts each static header whose name and value successfully parse, then iterates environment-backed headers, reading each env var and inserting the header only when the env var exists, is non-blank after trimming, and both header name and value parse successfully. It returns the populated `HeaderMap` wrapped in `CodexResult`.

**Call relations**: Only `to_api_provider` calls this. It isolates header parsing and env-var expansion from the rest of provider conversion.

*Call graph*: called by 1 (to_api_provider); 4 external calls (with_capacity, try_from, try_from, var).


##### `ModelProviderInfo::to_api_provider`  (lines 237–273)

```
fn to_api_provider(&self, auth_mode: Option<AuthMode>) -> CodexResult<ApiProvider>
```

**Purpose**: Converts a serializable provider definition into the lower-level `codex_api::Provider` used by the HTTP client layer.

**Data flow**: It takes an optional `AuthMode`, chooses a default base URL of `CHATGPT_CODEX_BASE_URL` for ChatGPT/PAT/agent-identity auth modes or `https://api.openai.com/v1` otherwise, overrides that with `self.base_url` when present, builds headers via `build_header_map`, constructs an `ApiRetryConfig` using `self.request_max_retries()` and fixed retry policy flags, and returns an `ApiProvider` containing the provider name, base URL, optional query params clone, headers, retry config, and `self.stream_idle_timeout()`.

**Call relations**: Model-listing and other runtime setup paths call this when they need a concrete API client configuration. It delegates header assembly and effective retry/timeout calculation to helper methods.

*Call graph*: calls 3 internal fn (build_header_map, request_max_retries, stream_idle_timeout); called by 1 (list_models); 2 external calls (from_millis, matches!).


##### `ModelProviderInfo::api_key`  (lines 278–294)

```
fn api_key(&self) -> CodexResult<Option<String>>
```

**Purpose**: Resolves the provider’s API key from the configured environment variable, enforcing that the value exists and is non-empty when `env_key` is configured.

**Data flow**: If `self.env_key` is `Some`, it reads that environment variable, filters out blank values, and returns `Ok(Some(value))`; if the variable is missing or blank it returns `CodexErr::EnvVar` containing the variable name and optional instructions. If `env_key` is `None`, it returns `Ok(None)`.

**Call relations**: Authentication setup paths such as bearer-token resolution call this when a provider uses env-var API key auth.

*Call graph*: called by 2 (realtime_api_key, bearer_auth_for_provider); 1 external calls (var).


##### `ModelProviderInfo::request_max_retries`  (lines 297–301)

```
fn request_max_retries(&self) -> u64
```

**Purpose**: Computes the effective request retry count by applying the default and hard cap.

**Data flow**: It reads `self.request_max_retries`, falls back to `DEFAULT_REQUEST_MAX_RETRIES` when absent, clamps the result to `MAX_REQUEST_MAX_RETRIES`, and returns the final `u64`.

**Call relations**: `to_api_provider` uses this when building `ApiRetryConfig`, ensuring user config cannot exceed the hard retry cap.

*Call graph*: called by 1 (to_api_provider).


##### `ModelProviderInfo::stream_max_retries`  (lines 304–308)

```
fn stream_max_retries(&self) -> u64
```

**Purpose**: Computes the effective maximum number of stream reconnection attempts with defaulting and clamping.

**Data flow**: It reads `self.stream_max_retries`, substitutes `DEFAULT_STREAM_MAX_RETRIES` when absent, clamps to `MAX_STREAM_MAX_RETRIES`, and returns the resulting `u64`.

**Call relations**: This accessor is used by higher-level streaming logic outside this file to obtain a bounded reconnection policy from provider config.


##### `ModelProviderInfo::stream_idle_timeout`  (lines 311–315)

```
fn stream_idle_timeout(&self) -> Duration
```

**Purpose**: Returns the effective idle timeout for streaming responses as a `Duration`.

**Data flow**: It maps `self.stream_idle_timeout_ms` through `Duration::from_millis` when present, otherwise returns `Duration::from_millis(DEFAULT_STREAM_IDLE_TIMEOUT_MS)`.

**Call relations**: `to_api_provider` uses this to populate the runtime provider’s stream idle timeout.

*Call graph*: called by 1 (to_api_provider); 1 external calls (from_millis).


##### `ModelProviderInfo::websocket_connect_timeout`  (lines 318–322)

```
fn websocket_connect_timeout(&self) -> Duration
```

**Purpose**: Returns the effective timeout for establishing a websocket connection.

**Data flow**: It converts `self.websocket_connect_timeout_ms` to a `Duration` when configured, otherwise returns the default `DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS` as a `Duration`.

**Call relations**: Higher-level websocket transport setup reads this accessor when deciding how long to wait for provider websocket connections.

*Call graph*: 1 external calls (from_millis).


##### `ModelProviderInfo::create_openai_provider`  (lines 324–359)

```
fn create_openai_provider(base_url: Option<String>) -> ModelProviderInfo
```

**Purpose**: Builds the built-in OpenAI provider definition with Codex-specific defaults for auth, headers, and websocket support.

**Data flow**: It takes an optional base URL override and returns a `ModelProviderInfo` named `OpenAI` with that base URL, no explicit env-key auth, `wire_api: Responses`, static `http_headers` containing a `version` header from `CARGO_PKG_VERSION`, environment-backed headers for `OpenAI-Organization` and `OpenAI-Project`, default retry/timeout fields left unset, `requires_openai_auth: true`, and `supports_websockets: true`.

**Call relations**: Built-in catalog assembly and many tests use this constructor as the canonical OpenAI provider baseline.

*Call graph*: called by 17 (model_client_with_counting_attestation, test_model_client_session, installed_extension_contributes_web_run_when_enabled, test_personal_access_token_uses_chatgpt_codex_base_url, test_supports_remote_compaction_for_openai, test_validate_provider_aws_rejects_conflicting_auth, test_validate_provider_aws_rejects_websockets, openai_provider_rejects_bedrock_api_key_auth, provider_info_with_command_auth, provider_without_command_auth_reports_no_command_auth (+7 more)); 1 external calls (env!).


##### `ModelProviderInfo::create_amazon_bedrock_provider`  (lines 361–389)

```
fn create_amazon_bedrock_provider(
        aws: Option<ModelProviderAwsAuthInfo>,
    ) -> ModelProviderInfo
```

**Purpose**: Builds the built-in Amazon Bedrock provider definition targeting the Bedrock Mantle OpenAI-compatible endpoint.

**Data flow**: It takes an optional `ModelProviderAwsAuthInfo`, substitutes a default `{ profile: None, region: None }` when absent, and returns a `ModelProviderInfo` named `Amazon Bedrock` with the Mantle base URL, `aws` auth configured, `wire_api: Responses`, a static `x-amzn-mantle-client-agent: codex` header, no env-key or bearer-token auth, and websocket support disabled.

**Call relations**: This constructor is used by `built_in_model_providers` and by tests that verify Bedrock-specific defaults and header behavior.

*Call graph*: called by 14 (guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4, use_bedrock_provider, test_amazon_bedrock_provider_adds_mantle_client_agent_header, api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint, approval_review_preferred_model_uses_bedrock_gpt_5_4, capabilities_disable_unsupported_hosted_tools, managed_auth_takes_precedence_over_aws_auth, openai_auth_is_not_exposed_to_bedrock, amazon_bedrock_provider_creates_static_models_manager, amazon_bedrock_provider_returns_bedrock_account_state (+4 more)); 1 external calls (from).


##### `ModelProviderInfo::is_openai`  (lines 391–393)

```
fn is_openai(&self) -> bool
```

**Purpose**: Identifies whether a provider is the built-in OpenAI provider by display name.

**Data flow**: It compares `self.name` to the constant `OPENAI_PROVIDER_NAME` and returns a boolean.

**Call relations**: Other auth and capability logic uses this quick predicate, including `supports_remote_compaction`.

*Call graph*: called by 2 (realtime_api_key, supports_remote_compaction).


##### `ModelProviderInfo::is_amazon_bedrock`  (lines 395–397)

```
fn is_amazon_bedrock(&self) -> bool
```

**Purpose**: Identifies whether a provider is the built-in Amazon Bedrock provider by display name.

**Data flow**: It compares `self.name` to `AMAZON_BEDROCK_PROVIDER_NAME` and returns a boolean.

**Call relations**: Provider creation/selection logic uses this to branch into Bedrock-specific handling.

*Call graph*: called by 1 (create_model_provider).


##### `ModelProviderInfo::supports_remote_compaction`  (lines 399–401)

```
fn supports_remote_compaction(&self) -> bool
```

**Purpose**: Determines whether the provider can use Codex’s remote compaction path.

**Data flow**: It returns true when `self.is_openai()` is true or when `codex_api::is_azure_responses_provider(&self.name, self.base_url.as_deref())` recognizes the provider as Azure Responses-compatible; otherwise it returns false.

**Call relations**: Higher-level compaction selection logic calls this to decide whether to offload compaction remotely.

*Call graph*: calls 1 internal fn (is_openai); called by 1 (should_use_remote_compact_task); 1 external calls (is_azure_responses_provider).


##### `ModelProviderInfo::has_command_auth`  (lines 403–405)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Reports whether the provider uses command-backed auth configuration.

**Data flow**: It checks `self.auth.is_some()` and returns the resulting boolean.

**Call relations**: External auth-selection code uses this as a simple predicate when deciding how to obtain credentials.

*Call graph*: called by 1 (has_command_auth).


##### `built_in_model_providers`  (lines 415–441)

```
fn built_in_model_providers(
    openai_base_url: Option<String>,
) -> HashMap<String, ModelProviderInfo>
```

**Purpose**: Constructs the default provider registry shipped with Codex.

**Data flow**: It takes an optional OpenAI base URL override, creates the built-in OpenAI and Amazon Bedrock providers, creates OSS providers for Ollama and LM Studio using their default ports and `WireApi::Responses`, then collects those `(id, provider)` pairs into a `HashMap<String, ModelProviderInfo>`.

**Call relations**: Config-loading code uses this as the starting catalog before applying user-defined providers or overrides.

*Call graph*: calls 1 internal fn (create_oss_provider); 2 external calls (create_amazon_bedrock_provider, create_openai_provider).


##### `merge_configured_model_providers`  (lines 448–479)

```
fn merge_configured_model_providers(
    mut model_providers: HashMap<String, ModelProviderInfo>,
    configured_model_providers: HashMap<String, ModelProviderInfo>,
) -> Result<HashMap<String, ModelP
```

**Purpose**: Merges user-configured providers into the built-in provider catalog while enforcing special override rules for Amazon Bedrock.

**Data flow**: It takes an existing provider map and a configured-provider map. For each configured entry, if the key is `amazon-bedrock`, it extracts `provider.aws`, verifies the remaining provider equals `ModelProviderInfo::default()` and errors otherwise, then applies only `profile` and `region` overrides into the built-in Bedrock provider’s nested `aws` struct. For any other key, it inserts the configured provider only if that key is not already present. It returns the merged map or an explanatory `Err(String)`.

**Call relations**: This function sits between config deserialization and runtime provider use, combining built-ins with user additions while preventing unsupported replacement of protected built-in fields.

*Call graph*: 2 external calls (format!, default).


##### `create_oss_provider`  (lines 481–498)

```
fn create_oss_provider(default_provider_port: u16, wire_api: WireApi) -> ModelProviderInfo
```

**Purpose**: Builds a localhost-style OSS provider definition, honoring experimental environment overrides for port or full base URL.

**Data flow**: It takes a default port and `WireApi`, reads `CODEX_OSS_PORT`, trims and parses it as `u16` when present, falls back to the supplied default port, formats `http://localhost:<port>/v1` as the default base URL, then reads `CODEX_OSS_BASE_URL` and uses it when non-empty. Finally it delegates to `create_oss_provider_with_base_url` with the chosen URL and wire API.

**Call relations**: `built_in_model_providers` calls this to create the default Ollama and LM Studio entries while allowing environment-based local overrides.

*Call graph*: calls 1 internal fn (create_oss_provider_with_base_url); called by 1 (built_in_model_providers); 2 external calls (format!, var).


##### `create_oss_provider_with_base_url`  (lines 500–520)

```
fn create_oss_provider_with_base_url(base_url: &str, wire_api: WireApi) -> ModelProviderInfo
```

**Purpose**: Constructs a generic OSS-compatible provider definition for a specific base URL and wire protocol.

**Data flow**: It takes a base URL string and `WireApi`, then returns a `ModelProviderInfo` named `gpt-oss` with that base URL, no auth configuration, no extra headers or query params, unset retry/timeout overrides, and both `requires_openai_auth` and `supports_websockets` set to false.

**Call relations**: This is the final constructor used by `create_oss_provider` after environment override resolution.

*Call graph*: called by 1 (create_oss_provider).


### `models-manager/src/config.rs`

`config` · `config load`

This file contains a single data structure, `ModelsManagerConfig`, which centralizes the tunable inputs consumed by the models-management layer. The struct is `Debug`, `Clone`, and `Default`, making it easy to log, duplicate, and instantiate with all fields unset or false. Most fields are optional to distinguish between an explicit configured value and the absence of configuration: `model_context_window` and `model_auto_compact_token_limit` carry token-count limits as `Option<i64>`, `tool_output_token_limit` uses `Option<usize>` for output sizing, `base_instructions` carries optional prompt text, `model_supports_reasoning_summaries` records an optional capability override, and `model_catalog` can embed a full `codex_protocol::openai_models::ModelsResponse` catalog for model discovery. The only non-optional field is `personality_enabled`, a boolean feature toggle that defaults to `false`. The shape of this struct suggests the manager merges static configuration, runtime capability detection, and catalog-derived metadata elsewhere; this file’s role is to preserve those inputs in a typed form without imposing policy. An important invariant is that `None` means “leave unspecified / derive elsewhere,” not zero or empty-string semantics, which lets higher layers distinguish omission from intentional override.


### `models-manager/src/model_presets.rs`

`config` · `config load`

This file is a compatibility shim consisting of two public string constants: `HIDE_GPT5_1_MIGRATION_PROMPT_CONFIG` and `HIDE_GPT_5_1_CODEX_MAX_MIGRATION_PROMPT_CONFIG`. The module-level comment explains the context: the system no longer ships hardcoded model presets, and model listings now come from the active catalog, but older migration flows or persisted configuration may still reference these keys. By keeping the exact legacy names in one place, the codebase can continue to recognize or suppress old migration notices without scattering string literals across parsing and UI logic. The constants encode the historical config keys exactly, including the mixed punctuation in `hide_gpt-5.1-codex-max_migration_prompt`, which is easy to mistype and therefore benefits from centralization. There is no behavior here; the value of the file is semantic continuity during upgrades. A reader should understand that these constants do not imply the corresponding presets still exist—only that compatibility with prior configuration and migration prompts is intentionally maintained.


### `models-manager/src/lib.rs`

`util` · `startup`

This library root declares the crate's internal and public modules, re-exports `AuthMode` and `ModelsManagerConfig`, and defines two utility-style functions used elsewhere in the models manager. `bundled_models_response` embeds `../models.json` at compile time with `include_str!` and deserializes it into `codex_protocol::openai_models::ModelsResponse` using `serde_json::from_str`. Because it returns `Result<ModelsResponse, serde_json::Error>`, callers can decide whether parse failures should propagate or be converted into panics.

The second helper, `client_version_to_whole`, converts the crate's Cargo package version into a stable `major.minor.patch` string by reading the compile-time `CARGO_PKG_VERSION_*` environment macros and formatting them together. This intentionally strips any prerelease or build metadata from the full semantic version, matching the comment example of turning `1.2.3-alpha.4` into `1.2.3`.

Although small, these functions are foundational: the bundled catalog loader seeds managers with an offline/default model list, and the normalized version string is used in cache eligibility and remote `/models` requests so cache entries and provider responses are keyed to a coarse client version rather than a prerelease suffix.

#### Function details

##### `bundled_models_response`  (lines 13–16)

```
fn bundled_models_response() -> std::result::Result<codex_protocol::openai_models::ModelsResponse, serde_json::Error>
```

**Purpose**: Loads and parses the bundled `models.json` file shipped with the crate. It gives callers a typed `ModelsResponse` snapshot of the built-in catalog.

**Data flow**: It takes no arguments, reads the compile-time embedded JSON string from `include_str!("../models.json")`, deserializes it with `serde_json::from_str`, and returns either a `ModelsResponse` or a `serde_json::Error`. It does not mutate any state.

**Call relations**: This helper is used by manager code that needs the authoritative bundled catalog, especially during initialization and merge logic. It delegates all parsing to Serde and leaves error handling to its callers.

*Call graph*: 2 external calls (include_str!, from_str).


##### `client_version_to_whole`  (lines 19–26)

```
fn client_version_to_whole() -> String
```

**Purpose**: Builds a normalized `major.minor.patch` client version string from Cargo package metadata. It intentionally omits prerelease qualifiers.

**Data flow**: It takes no inputs and reads the compile-time `CARGO_PKG_VERSION_MAJOR`, `MINOR`, and `PATCH` values. It formats them into a single dotted `String` and returns that string without side effects.

**Call relations**: This helper is consumed by cache and remote-refresh paths that need a stable version identifier. It does not call into crate logic beyond standard formatting.

*Call graph*: 1 external calls (format!).


### `models-manager/src/model_info.rs`

`domain_logic` · `request handling`

This module contains the concrete rules for producing and mutating `codex_protocol::openai_models::ModelInfo`. It embeds the shared base prompt from `prompt.md` as `BASE_INSTRUCTIONS`, defines a default personality header and two local personality variants, and exposes two public functions.

`with_config_overrides` takes an existing `ModelInfo` and applies selected `ModelsManagerConfig` fields. The overrides are intentionally asymmetric: `model_supports_reasoning_summaries = Some(true)` can enable support, but `Some(false)` does not disable an already-supported model. `model_context_window` is clamped to `max_context_window` when present. `model_auto_compact_token_limit` is copied directly. `tool_output_token_limit` rewrites `truncation_policy` while preserving whether the model truncates by bytes or tokens; byte limits are derived from token counts using `approx_bytes_for_tokens` and saturate to `i64::MAX` on conversion overflow. Prompt-related config also has precedence rules: explicit `base_instructions` replaces the model's base instructions and clears `model_messages`, while disabling personality clears `model_messages` without changing base instructions.

`model_info_from_slug` builds a minimal but usable fallback descriptor for unknown slugs. It logs a warning, mirrors the slug into `display_name`, marks visibility as `None`, sets conservative defaults for reasoning, truncation, context window, tools, and feature flags, and marks `used_fallback_model_metadata = true`. For a small allowlist of local slugs, `local_personality_messages_for_slug` attaches a `ModelMessages` template whose instructions interpolate a `{{ personality }}` placeholder between a fixed header and the shared base instructions.

#### Function details

##### `with_config_overrides`  (lines 23–63)

```
fn with_config_overrides(mut model: ModelInfo, config: &ModelsManagerConfig) -> ModelInfo
```

**Purpose**: Applies `ModelsManagerConfig` overrides to a `ModelInfo` while preserving important model invariants such as max context window and truncation mode. It is the final mutation step after catalog lookup or fallback synthesis.

**Data flow**: It takes `mut model: ModelInfo` and `config: &ModelsManagerConfig`. It conditionally enables `supports_reasoning_summaries`, clamps `context_window` to `max_context_window` when `model_context_window` is set, copies `model_auto_compact_token_limit`, rewrites `truncation_policy` based on `tool_output_token_limit` using either `TruncationPolicyConfig::bytes` with `approx_bytes_for_tokens` or `TruncationPolicyConfig::tokens`, and then either replaces `base_instructions` plus clears `model_messages` when `base_instructions` is configured or clears `model_messages` when `personality_enabled` is false. It returns the modified `ModelInfo`.

**Call relations**: This function is called by `construct_model_info_from_candidates` after a model has been resolved from remote candidates or fallback metadata. It delegates byte estimation to `approx_bytes_for_tokens` and uses protocol constructors for truncation-policy rebuilding.

*Call graph*: calls 2 internal fn (bytes, tokens); called by 1 (construct_model_info_from_candidates); 2 external calls (approx_bytes_for_tokens, try_from).


##### `model_info_from_slug`  (lines 66–108)

```
fn model_info_from_slug(slug: &str) -> ModelInfo
```

**Purpose**: Constructs a fallback `ModelInfo` for unknown or missing model slugs so the system can continue operating with conservative defaults. It also attaches local personality templates for a small set of special slugs.

**Data flow**: It takes `slug: &str`, logs a warning, and returns a fully populated `ModelInfo` whose `slug` and `display_name` are the input slug, whose prompt fields use `BASE_INSTRUCTIONS` and `local_personality_messages_for_slug(slug)`, whose truncation policy defaults to `TruncationPolicyConfig::bytes(10_000)`, whose context windows default to `Some(272_000)`, and whose many capability flags are set to safe defaults; `used_fallback_model_metadata` is set to `true`.

**Call relations**: This function is used when `construct_model_info_from_candidates` cannot match a requested slug to the active catalog, and it is also reused by tests and other code that need a baseline `ModelInfo`. It delegates optional personality-message construction to `local_personality_messages_for_slug`.

*Call graph*: calls 3 internal fn (local_personality_messages_for_slug, bytes, default_input_modalities); called by 5 (model_with_default_service_tier, remote_model, build_stage_one_input_message_truncates_rollout_using_model_context_window, build_stage_one_input_message_uses_default_limit_when_model_context_window_missing, construct_model_info_from_candidates); 2 external calls (new, warn!).


##### `local_personality_messages_for_slug`  (lines 110–124)

```
fn local_personality_messages_for_slug(slug: &str) -> Option<ModelMessages>
```

**Purpose**: Returns special local `ModelMessages` templates for a small allowlist of slugs that support personality injection. All other slugs receive no extra message template.

**Data flow**: It takes `slug: &str`, matches it against `"gpt-5.2-codex"` and `"exp-codex-personality"`, and for those cases returns `Some(ModelMessages { instructions_template, instructions_variables })` where the template concatenates the default header, `{{ personality }}`, and `BASE_INSTRUCTIONS`, and the variables provide empty/default, friendly, and pragmatic personality strings. For any other slug it returns `None`.

**Call relations**: This helper is called only by `model_info_from_slug` while constructing fallback metadata. It isolates the slug-specific personality behavior from the larger fallback descriptor.

*Call graph*: called by 1 (model_info_from_slug); 2 external calls (new, format!).


### `models-manager/src/collaboration_mode_presets.rs`

`domain_logic` · `request handling`

This file is a small domain-logic module that materializes the two shipped collaboration modes: `Plan` and `Default`. It imports the raw instruction text for both modes from `codex_collaboration_mode_templates`, plus protocol types such as `CollaborationModeMask`, `ModeKind`, `ReasoningEffort`, and the `TUI_VISIBLE_COLLABORATION_MODES` list. The `DEFAULT` template is parsed once into a `LazyLock<Template>` so rendering work and parse validation happen centrally rather than on every call.

The exported entrypoint, `builtin_collaboration_mode_presets`, returns the presets in a fixed order: plan first, default second. `plan_preset` is fully static except for deriving its display name from `ModeKind::Plan`; it explicitly sets `reasoning_effort` to `Some(Some(ReasoningEffort::Medium))` and embeds the plan instructions verbatim. `default_preset` instead computes its instructions dynamically through `default_mode_instructions`, because the default prompt contains a `KNOWN_MODE_NAMES` placeholder. That helper formats the visible mode names from `TUI_VISIBLE_COLLABORATION_MODES` into human-readable English and renders the parsed template with that substitution.

A notable detail is the formatting policy in `format_mode_names`: zero modes becomes the literal string `none`, one mode is returned directly, two modes use `"A and B"`, and three or more are comma-joined without a final conjunction. Both template parse and render failures are treated as programmer errors and panic immediately.

#### Function details

##### `builtin_collaboration_mode_presets`  (lines 16–18)

```
fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask>
```

**Purpose**: Builds the complete built-in collaboration mode preset list used by managers and mode-listing code. It returns exactly the plan preset followed by the default preset.

**Data flow**: It takes no arguments and reads no mutable state. It invokes the local preset constructors, collects their `CollaborationModeMask` results into a `Vec`, and returns that vector without side effects.

**Call relations**: This is the file's public aggregation point. It is used when model-manager implementations need to expose collaboration modes, and it delegates the actual field population to `plan_preset` and `default_preset`.

*Call graph*: called by 4 (builtin_collaboration_mode_presets, list_collaboration_modes, list_collaboration_modes, filtered_presets); 1 external calls (vec!).


##### `plan_preset`  (lines 20–28)

```
fn plan_preset() -> CollaborationModeMask
```

**Purpose**: Constructs the built-in `Plan` collaboration mode mask with its fixed reasoning and instruction settings. The preset is named from `ModeKind::Plan.display_name()` rather than hard-coded text.

**Data flow**: It takes no inputs. It creates a `CollaborationModeMask` whose `name` and `mode` come from `ModeKind::Plan`, whose `model` is `None`, whose `reasoning_effort` is `Some(Some(ReasoningEffort::Medium))`, and whose `developer_instructions` wraps the imported `COLLABORATION_MODE_PLAN` string; it returns that struct.

**Call relations**: This helper is only used as one element of `builtin_collaboration_mode_presets`. It does not delegate further because all of its fields are static constants or enum-derived values.


##### `default_preset`  (lines 30–38)

```
fn default_preset() -> CollaborationModeMask
```

**Purpose**: Constructs the built-in `Default` collaboration mode mask, including dynamically rendered developer instructions. Unlike the plan preset, it leaves reasoning effort unspecified.

**Data flow**: It takes no inputs. It builds a `CollaborationModeMask` with `name` and `mode` derived from `ModeKind::Default`, `model` set to `None`, `reasoning_effort` set to `None`, and `developer_instructions` set to the string returned by `default_mode_instructions`; it returns the completed struct.

**Call relations**: This helper contributes the second preset in `builtin_collaboration_mode_presets`. It delegates prompt generation to `default_mode_instructions` because the default instructions depend on the current visible mode list.

*Call graph*: calls 1 internal fn (default_mode_instructions).


##### `default_mode_instructions`  (lines 40–45)

```
fn default_mode_instructions() -> String
```

**Purpose**: Renders the default collaboration-mode instruction template after substituting the visible mode names. It is the only place where the parsed `Template` static is used.

**Data flow**: It reads `TUI_VISIBLE_COLLABORATION_MODES`, passes that slice to `format_mode_names`, then renders `COLLABORATION_MODE_DEFAULT_TEMPLATE` with a single key-value binding from `KNOWN_MODE_NAMES_TEMPLATE_KEY` to the formatted names. It returns the rendered `String`, panicking if rendering fails.

**Call relations**: This function is called only by `default_preset` when constructing the default mode's `developer_instructions`. It delegates the English list formatting to `format_mode_names` and relies on the lazily parsed template prepared at module initialization.

*Call graph*: calls 1 internal fn (format_mode_names); called by 1 (default_preset).


##### `format_mode_names`  (lines 47–55)

```
fn format_mode_names(modes: &[ModeKind]) -> String
```

**Purpose**: Converts a slice of `ModeKind` values into a human-readable phrase for prompt insertion. It chooses different wording depending on how many modes are present.

**Data flow**: It accepts `modes: &[ModeKind]`, maps each mode to its `display_name`, and matches on the resulting slice length. It returns `"none"` for an empty slice, the sole name for one element, `"first and second"` for two elements, or a comma-joined string for longer lists.

**Call relations**: This helper exists solely to support `default_mode_instructions`. It isolates the prompt-facing formatting rule so the template renderer receives a ready-to-insert string.

*Call graph*: called by 1 (default_mode_instructions); 2 external calls (format!, iter).


### `utils/approval-presets/src/lib.rs`

`domain_logic` · `startup and settings selection`

This file is a compact domain table for approval and permission defaults. Its main data type, `ApprovalPreset`, is a plain struct containing a stable `id`, user-facing `label` and `description`, an `AskForApproval` policy, an `ActivePermissionProfile` identifying the selected built-in profile, and the concrete `PermissionProfile` to apply. `builtin_approval_presets()` returns three hard-coded presets: `read-only`, which uses `AskForApproval::OnRequest` plus the built-in read-only profile; `auto`/`Default`, which grants workspace write access while still requiring approval for broader actions; and `full-access`, which disables approval prompts and uses the dangerous full-access profile with `PermissionProfile::Disabled`. The descriptions are intentionally UI-ready strings but the module itself stays UI-agnostic so both TUI and MCP server code can consume the same definitions. The second function, `builtin_permission_profile_for_active_permission_profile`, is a narrow resolver for built-in active-profile IDs. It first rejects any profile with `extends` set, ensuring only direct built-ins are recognized, then matches the profile ID string against the three built-in constants and returns the corresponding concrete `PermissionProfile`, or `None` for unknown/custom IDs.

#### Function details

##### `builtin_approval_presets`  (lines 28–61)

```
fn builtin_approval_presets() -> Vec<ApprovalPreset>
```

**Purpose**: Returns the complete built-in list of approval presets used by clients to present standard approval/permission combinations. The list is fixed and ordered.

**Data flow**: Constructs and returns a `Vec<ApprovalPreset>` containing three literal `ApprovalPreset` values. Each entry embeds static strings, a concrete `AskForApproval` variant, an `ActivePermissionProfile::new(...)` built from a built-in ID constant, and the matching `PermissionProfile` constructor or variant.

**Call relations**: Callers use this function when populating UI choices or default policy menus. It does not depend on runtime state and delegates only to the protocol types' constructors for the active-profile wrappers and permission profiles.

*Call graph*: 1 external calls (vec!).


##### `builtin_permission_profile_for_active_permission_profile`  (lines 64–77)

```
fn builtin_permission_profile_for_active_permission_profile(
    active_permission_profile: &ActivePermissionProfile,
) -> Option<PermissionProfile>
```

**Purpose**: Maps a built-in `ActivePermissionProfile` identifier back to its concrete `PermissionProfile`, but only for non-extended built-ins. It rejects custom inheritance chains by returning `None` when `extends` is present.

**Data flow**: Reads `active_permission_profile: &ActivePermissionProfile`, first checks `active_permission_profile.extends.is_some()` and returns `None` if true. Otherwise it matches `active_permission_profile.id.as_str()` against the three built-in ID constants and returns `Some(PermissionProfile::read_only())`, `Some(PermissionProfile::workspace_write())`, `Some(PermissionProfile::Disabled)`, or `None` for unknown IDs.

**Call relations**: This function is called by code that needs to recover the concrete permission profile from a selected built-in active profile. Its control flow is a simple guard-plus-match and it delegates only to the `PermissionProfile` constructors for the recognized built-ins.

*Call graph*: calls 2 internal fn (read_only, workspace_write).


### `tui/src/model_catalog.rs`

`data_model` · `configuration and model-selection flows`

This file defines `ModelCatalog`, a minimal data holder used by the TUI to expose available models. Internally it stores a `Vec<ModelPreset>` and offers only two methods: construction and listing. There is no indexing, filtering, caching, or I/O here; the catalog is simply cloned back out on request. The use of `Result<Vec<ModelPreset>, Infallible>` in `try_list_models` is a deliberate interface choice: callers can treat this catalog like other model providers that may fail, while this implementation guarantees success. That keeps higher-level code generic without introducing special cases for tests or static catalogs.

Because the catalog owns its vector and returns clones, callers cannot mutate the internal list through shared references. The file therefore acts as a lightweight adapter between configuration/test setup and UI flows that expect a catalog-like object.

#### Function details

##### `ModelCatalog::new`  (lines 10–12)

```
fn new(models: Vec<ModelPreset>) -> Self
```

**Purpose**: Constructs a catalog from an owned vector of `ModelPreset` entries.

**Data flow**: It takes `models: Vec<ModelPreset>` by value and stores it directly in `Self { models }`. It returns a new `ModelCatalog` and does not touch external state.

**Call relations**: This constructor is used by runtime and test setup code that needs a concrete catalog instance before passing it into model-selection or service-tier logic.

*Call graph*: called by 5 (run, set_fast_mode_test_catalog, test_model_catalog, model_switch_recomputes_catalog_default_service_tier, service_tier_commands_lowercase_catalog_names).


##### `ModelCatalog::try_list_models`  (lines 14–16)

```
fn try_list_models(&self) -> Result<Vec<ModelPreset>, Infallible>
```

**Purpose**: Returns the catalog contents as a cloned vector through a fallible-looking API that cannot actually fail.

**Data flow**: It reads `self.models`, clones the vector, wraps it in `Ok(...)`, and returns `Result<Vec<ModelPreset>, Infallible>`. No internal state is modified.

**Call relations**: This method serves callers that expect a `try_*` listing interface. Its `Infallible` error type signals that this implementation is a simple local source rather than a remote or computed catalog.


### `tui/src/update_action.rs`

`domain_logic` · `startup and update prompting/execution`

This file is the narrow translation layer between how Codex was installed and what command should be shown or executed to update it. Its core type is the `UpdateAction` enum, whose variants encode the supported upgrade paths: global npm, global bun, Homebrew cask, and standalone Unix or Windows installers. In release builds and tests, `UpdateAction::from_install_context` inspects `codex_install_context::InstallContext.method` and maps each known `InstallMethod` to one enum variant; `InstallMethod::Other` intentionally yields `None`, which suppresses update prompting and automatic update execution for unknown packaging environments.

The enum also owns the exact command payload. `command_args` returns a program name plus a static slice of arguments, with standalone variants deliberately re-running the latest hosted installer script rather than trying to patch an existing local install. `command_str` turns that tuple into a shell-escaped display string using `shlex::try_join`, with a plain concatenation fallback if quoting fails. The top-level `get_update_action` is only compiled in non-debug builds and asks `InstallContext::current()` for the runtime installation context before delegating to the enum mapper.

Tests pin down both the install-context mapping and the exact standalone command lines, which is important because the prompt UI renders these strings verbatim and the updater later executes the same command tuple.

#### Function details

##### `UpdateAction::from_install_context`  (lines 25–36)

```
fn from_install_context(context: &InstallContext) -> Option<Self>
```

**Purpose**: Maps a detected `InstallContext` into the specific `UpdateAction` the application knows how to present and run.

**Data flow**: It reads `context.method` and pattern-matches on the `InstallMethod` variant. Known package managers become fixed `UpdateAction` variants; standalone installs branch again on `StandalonePlatform` to choose Unix vs. Windows; `Other` becomes `None`. It returns `Option<UpdateAction>` and does not mutate external state.

**Call relations**: This is the decision point used by `get_update_action` after runtime install detection. Its `None` result propagates upward so callers can skip update UI or execution when the install origin is unsupported.

*Call graph*: called by 1 (get_update_action).


##### `UpdateAction::command_args`  (lines 39–61)

```
fn command_args(self) -> (&'static str, &'static [&'static str])
```

**Purpose**: Returns the exact executable name and argument vector needed to perform the selected update action.

**Data flow**: It consumes `self` by value and matches each enum variant to a `(&'static str, &'static [&'static str])` pair. Package-manager variants produce direct commands like `npm install -g @openai/codex`; standalone variants produce shell or PowerShell invocations that fetch and run the latest installer script. It returns only static data and writes no state.

**Call relations**: This function feeds both display and execution paths: `command_str` formats its output for the prompt, and `run_update_action` uses the same tuple to spawn the updater so the shown command matches the executed one.

*Call graph*: called by 2 (run_update_action, command_str).


##### `UpdateAction::command_str`  (lines 64–68)

```
fn command_str(self) -> String
```

**Purpose**: Builds a human-readable shell command string from the structured command tuple for display in the UI.

**Data flow**: It first calls `command_args` to get the program and arguments, then chains the command with the arg slice and passes the iterator to `shlex::try_join` for shell-safe quoting. If quoting fails, it falls back to `format!("{command} {}", args.join(" "))`. It returns an owned `String` and does not modify shared state.

**Call relations**: This is used where the update command must be rendered to the user, notably in `render_ref`, and also by `run_update_action` when it needs a printable representation alongside actual execution.

*Call graph*: calls 1 internal fn (command_args); called by 2 (run_update_action, render_ref); 2 external calls (try_join, once).


##### `get_update_action`  (lines 72–74)

```
fn get_update_action() -> Option<UpdateAction>
```

**Purpose**: Looks up the current installation method at runtime and converts it into an optional update action.

**Data flow**: It calls `InstallContext::current()` to obtain the process's detected install context, then passes that reference into `UpdateAction::from_install_context`. The returned `Option<UpdateAction>` is forwarded unchanged.

**Call relations**: This is the release-build entry into the file's logic. It is consulted by startup/update flows such as `run`, `run_update_prompt_if_needed`, and `get_upgrade_version` so those callers can tailor update checks and prompts to the actual installation channel.

*Call graph*: calls 2 internal fn (current, from_install_context); called by 3 (run, run_update_prompt_if_needed, get_upgrade_version).


##### `tests::maps_install_context_to_update_action`  (lines 83–138)

```
fn maps_install_context_to_update_action()
```

**Purpose**: Verifies that every supported `InstallMethod` maps to the intended `UpdateAction`, and that unsupported installs map to `None`.

**Data flow**: The test constructs several `InstallContext` values, including standalone contexts with temporary absolute paths, then compares `UpdateAction::from_install_context` results against expected enum variants using `assert_eq!`. It reads temporary filesystem paths only to satisfy standalone context construction.

**Call relations**: This test exercises the enum-mapping branch table directly, guarding the behavior relied on by `get_update_action` and all higher-level update flows.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (assert_eq!, temp_dir).


##### `tests::standalone_update_commands_rerun_latest_installer`  (lines 141–164)

```
fn standalone_update_commands_rerun_latest_installer()
```

**Purpose**: Pins the standalone update commands to the hosted installer re-execution strategy on Unix and Windows.

**Data flow**: It calls `command_args` on `UpdateAction::StandaloneUnix` and `UpdateAction::StandaloneWindows` and asserts the returned command/argument tuples exactly match the expected shell and PowerShell invocations. It returns no value and mutates no state.

**Call relations**: This test protects the command definitions consumed by both UI rendering and actual update execution, ensuring standalone installs always rerun the latest installer rather than a stale local path.

*Call graph*: 1 external calls (assert_eq!).


### Built-in pet assets
These files define the built-in pet catalog, acquire and validate cached spritesheets, and load normalized pet manifests from built-in or user-provided sources.

### `tui/src/pets/catalog.rs`

`data_model` · `cross-cutting static metadata used during pet lookup, validation, and tests`

This file is almost entirely declarative. It establishes the default frame geometry used by app-compatible pets—192×208 pixel frames arranged in an 8×9 grid—and derives the full spritesheet dimensions from those constants. The `BuiltinPet` struct is a compact copyable record containing the stable pet id, display name, description, and versioned spritesheet filename. `BUILTIN_PETS` is the complete catalog array, currently including `codex`, `dewey`, `fireball`, `rocky`, `seedy`, `stacky`, `bsod`, and `null-signal`.

The small amount of behavior here exists to support lookup and testing. `builtin_pet` performs a linear search over the static slice and returns a copied `BuiltinPet` when the id matches exactly; this is the entry point used by higher layers to distinguish built-in pets from custom ones. In test builds, `write_test_spritesheet` creates a blank RGBA image with the exact catalog spritesheet dimensions and saves it to disk, allowing asset-pack and model tests to exercise validation and loading logic without shipping real art assets. The important invariant carried by this file is that all built-in pets share one fixed spritesheet geometry, which downstream code assumes when validating downloads, slicing frames, and generating default animations.

#### Function details

##### `builtin_pet`  (lines 69–71)

```
fn builtin_pet(id: &str) -> Option<BuiltinPet>
```

**Purpose**: Looks up a built-in pet definition by its stable id string. It returns a copied catalog entry so callers can use the metadata without borrowing the static slice.

**Data flow**: Input is `id: &str`. It iterates `BUILTIN_PETS`, copies each `BuiltinPet`, finds the first entry whose `pet.id == id`, and returns `Option<BuiltinPet>`.

**Call relations**: Used by asset-pack orchestration and pet-model loading to decide whether a selector refers to a built-in pet, and by tests that verify URL generation.

*Call graph*: called by 3 (builtin_pet_url_uses_public_cdn_path, ensure_builtin_pack_for_pet, load_with_codex_home).


##### `write_test_spritesheet`  (lines 74–77)

```
fn write_test_spritesheet(path: &std::path::Path)
```

**Purpose**: Writes a synthetic blank spritesheet file with the exact built-in dimensions for use in tests. This provides a structurally valid image without requiring real pet artwork.

**Data flow**: Input is `path: &Path`. It creates an `image::RgbaImage` with `SPRITESHEET_WIDTH` and `SPRITESHEET_HEIGHT`, saves it to `path`, and panics on failure via `unwrap()` because it is test-only.

**Call relations**: Called by test helpers in the asset-pack and model modules whenever they need a valid spritesheet fixture.

*Call graph*: called by 4 (write_test_pack, write_pet_manifest, write_legacy_avatar, write_pet); 1 external calls (new).


### `tui/src/pets/asset_pack.rs`

`io_transport` · `asset fetch and cache validation before built-in pet load or preview`

This module is the built-in asset boundary for pets. It distinguishes built-in pets from custom pets by treating the CDN-facing spritesheet filename as the cache key and storing validated files under `cache/tui-pets/<version>/assets/`. `builtin_spritesheet_path` and `pack_dir` centralize that directory layout.

`ensure_builtin_pet` is the main workflow. It first checks whether the destination file already exists and passes `validate_cached_spritesheet`; if so, it exits immediately. Otherwise it constructs a public HTTPS URL from the catalog entry, downloads the bytes with a hard timeout and byte limit, creates the parent assets directory, writes the payload to a uniquely named staging file, validates the staging image dimensions, and then attempts an atomic rename into place. If the rename fails—typically because another process raced to install the same asset—it revalidates the destination and accepts the race winner if valid, cleaning up the staging file. Only if the destination exists but is still invalid does it remove it and retry installation.

The helper functions enforce important safety constraints: URLs must parse and use `https`, redirects are revalidated, oversized downloads are rejected both by `Content-Length` and by capped streaming reads, and cached spritesheets must exactly match the catalog’s expected width and height. Test-only helpers can populate a complete fake built-in pack by writing blank spritesheets with the correct geometry.

#### Function details

##### `builtin_spritesheet_path`  (lines 33–35)

```
fn builtin_spritesheet_path(codex_home: &Path, file: &str) -> PathBuf
```

**Purpose**: Computes the on-disk cache path for a built-in pet spritesheet file under the versioned pet asset pack. It is the canonical location used by both download/install and later model loading.

**Data flow**: Inputs are `codex_home: &Path` and the CDN filename `file: &str`. It derives `pack_dir(codex_home)`, appends `assets`, appends `file`, and returns the resulting `PathBuf`.

**Call relations**: Used by `ensure_builtin_pet` to choose the destination path and by tests to verify that `write_test_pack` installed all built-ins in the expected location.

*Call graph*: calls 1 internal fn (pack_dir); called by 2 (ensure_builtin_pet, write_test_pack_installs_all_builtins).


##### `ensure_builtin_pet`  (lines 45–83)

```
fn ensure_builtin_pet(codex_home: &Path, pet: catalog::BuiltinPet) -> Result<()>
```

**Purpose**: Ensures that a built-in pet’s spritesheet exists locally and has the exact expected dimensions, downloading and atomically installing it if necessary. It also tolerates concurrent installers by accepting a valid destination that appears after a failed rename.

**Data flow**: Inputs are `codex_home` and a `catalog::BuiltinPet`. It computes the destination path, validates any existing cached file, otherwise builds the CDN URL, downloads bytes with `download_bytes_with_limit`, creates the parent directory, writes a uniquely named staging file, validates the staging image, tries `install_downloaded_spritesheet`, and on failure revalidates or replaces the destination. It writes directories/files under the cache and may remove invalid staging or destination files; it returns `Result<()>`.

**Call relations**: Called by the higher-level `ensure_builtin_pack_for_pet` orchestration only for catalog pets. It delegates URL construction, download, validation, and final rename to helpers so each failure mode is isolated and contextualized.

*Call graph*: calls 5 internal fn (builtin_pet_url, builtin_spritesheet_path, download_bytes_with_limit, install_downloaded_spritesheet, validate_cached_spritesheet); called by 1 (ensure_builtin_pack_for_pet); 4 external calls (format!, create_dir_all, remove_file, write).


##### `builtin_pet_url`  (lines 85–89)

```
fn builtin_pet_url(pet: catalog::BuiltinPet) -> Result<String>
```

**Purpose**: Builds the public CDN URL for a built-in pet’s spritesheet filename and validates that the resulting URL is acceptable for download. The filename itself is taken directly from the catalog entry.

**Data flow**: Input is a `catalog::BuiltinPet`. It formats `https://persistent.oaistatic.com/codex/pets/v1/<spritesheet_file>`, passes that string through `validate_download_url`, and returns the validated URL string.

**Call relations**: Used by `ensure_builtin_pet` before downloading and by a unit test that locks the public path format.

*Call graph*: calls 1 internal fn (validate_download_url); called by 2 (ensure_builtin_pet, builtin_pet_url_uses_public_cdn_path); 1 external calls (format!).


##### `pack_dir`  (lines 91–93)

```
fn pack_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the root directory for the current built-in pet asset-pack version under `CODEX_HOME`. This isolates versioning so future asset-pack revisions can coexist cleanly.

**Data flow**: Input is `codex_home: &Path`. It joins `cache/tui-pets` and the constant version string `v1`, returning a `PathBuf`.

**Call relations**: Used by `builtin_spritesheet_path` and the test helper `write_test_pack` to keep all built-in asset paths under the same versioned root.

*Call graph*: called by 2 (builtin_spritesheet_path, write_test_pack); 1 external calls (join).


##### `download_bytes_with_limit`  (lines 95–121)

```
fn download_bytes_with_limit(url: &str, max_bytes: u64) -> Result<Vec<u8>>
```

**Purpose**: Downloads a pet asset over HTTPS with a fixed timeout and strict maximum size enforcement. It rejects oversized responses both before and during streaming.

**Data flow**: Inputs are a URL string and `max_bytes`. It validates the URL, builds a blocking `reqwest` client with `PET_DOWNLOAD_TIMEOUT`, performs a GET, requires a successful HTTP status, revalidates the final response URL after redirects, checks `content_length` if present, then streams at most `max_bytes + 1` bytes into a `Vec<u8>` and errors if the actual byte count exceeds the limit. It returns the downloaded bytes.

**Call relations**: Called only from `ensure_builtin_pet`. It delegates URL safety checks to `validate_download_url` and exists to keep network I/O and size-limit logic separate from installation flow.

*Call graph*: calls 1 internal fn (validate_download_url); called by 1 (ensure_builtin_pet); 3 external calls (new, builder, bail!).


##### `install_downloaded_spritesheet`  (lines 123–125)

```
fn install_downloaded_spritesheet(staging: &Path, destination: &Path) -> Result<()>
```

**Purpose**: Atomically installs a validated staging file into its final cache location using filesystem rename. This keeps callers from observing partially written spritesheets.

**Data flow**: Inputs are `staging: &Path` and `destination: &Path`. It performs `fs::rename(staging, destination)` with contextual error reporting and returns `Result<()>`.

**Call relations**: Used by `ensure_builtin_pet` after staging validation and again during the race-recovery path.

*Call graph*: called by 1 (ensure_builtin_pet); 1 external calls (rename).


##### `validate_download_url`  (lines 127–133)

```
fn validate_download_url(value: &str) -> Result<()>
```

**Purpose**: Rejects malformed or non-HTTPS download URLs before network access or after redirects. This prevents accidental use of unsupported schemes.

**Data flow**: Input is a URL string. It parses the string with `Url::parse`, checks that `url.scheme() == "https"`, and returns `Ok(())` or an error.

**Call relations**: Called by both `builtin_pet_url` and `download_bytes_with_limit`, so both the initial URL and any redirected final URL must satisfy the same HTTPS-only rule.

*Call graph*: called by 2 (builtin_pet_url, download_bytes_with_limit); 2 external calls (parse, bail!).


##### `validate_cached_spritesheet`  (lines 135–149)

```
fn validate_cached_spritesheet(path: &Path) -> Result<()>
```

**Purpose**: Checks that a cached spritesheet file decodes successfully and matches the exact built-in catalog dimensions. It treats any mismatch as an invalid cache entry.

**Data flow**: Input is `path: &Path`. It reads image dimensions via `image::image_dimensions`, compares them against `catalog::SPRITESHEET_WIDTH` and `catalog::SPRITESHEET_HEIGHT`, and returns `Ok(())` or a descriptive error.

**Call relations**: This validator is used repeatedly by `ensure_builtin_pet` on both destination and staging files, and by tests to confirm that generated fixtures match the expected geometry.

*Call graph*: called by 2 (ensure_builtin_pet, write_test_pack_installs_all_builtins); 2 external calls (bail!, image_dimensions).


##### `write_test_pack`  (lines 152–159)

```
fn write_test_pack(codex_home: &Path)
```

**Purpose**: Populates a temporary built-in asset pack with valid test spritesheets for every catalog pet. It exists only in test builds.

**Data flow**: Input is `codex_home: &Path`. It computes the assets directory under `pack_dir(codex_home)`, creates it, iterates `catalog::BUILTIN_PETS`, and for each pet writes a synthetic spritesheet file using `catalog::write_test_spritesheet`.

**Call relations**: Used by tests in this module and in the pet model module to simulate a fully installed built-in asset cache without network access.

*Call graph*: calls 2 internal fn (pack_dir, write_test_spritesheet); called by 2 (write_test_pack_installs_all_builtins, load_builtin_pet_uses_app_catalog_storage); 1 external calls (create_dir_all).


##### `tests::builtin_pet_url_uses_public_cdn_path`  (lines 167–176)

```
fn builtin_pet_url_uses_public_cdn_path()
```

**Purpose**: Verifies that catalog pet ids map to the expected public CDN URL format. This protects the externally visible asset path contract.

**Data flow**: It looks up the `dewey` catalog entry, calls `builtin_pet_url`, unwraps the result, and asserts the returned string equals the expected CDN URL.

**Call relations**: This test exercises `catalog::builtin_pet` plus `builtin_pet_url` together to lock down the URL-building convention.

*Call graph*: calls 2 internal fn (builtin_pet_url, builtin_pet); 1 external calls (assert_eq!).


##### `tests::write_test_pack_installs_all_builtins`  (lines 179–189)

```
fn write_test_pack_installs_all_builtins()
```

**Purpose**: Checks that the test helper writes every built-in spritesheet into the correct cache location and that each file passes structural validation. It ensures the fixture generator mirrors production layout and dimensions.

**Data flow**: It creates a temporary directory, calls `write_test_pack`, iterates `catalog::BUILTIN_PETS`, computes each expected path with `builtin_spritesheet_path`, asserts the file exists, and validates it with `validate_cached_spritesheet`.

**Call relations**: This test validates the interaction between `write_test_pack`, `builtin_spritesheet_path`, and `validate_cached_spritesheet`.

*Call graph*: calls 3 internal fn (builtin_spritesheet_path, validate_cached_spritesheet, write_test_pack); 2 external calls (assert!, tempdir).


### `tui/src/pets/model.rs`

`domain_logic` · `pet selection resolution and manifest load before frame extraction/rendering`

This module is the pet-definition model layer. Its central type, `Pet`, contains normalized metadata: id, display name, description, local spritesheet path, frame geometry, frame count, and a map of named `Animation`s composed of `AnimationFrame { sprite_index, duration }`. The key invariant is that every returned `Pet` points to an existing local spritesheet whose dimensions exactly match the app’s canonical spritesheet size.

`Pet::load_with_codex_home` dispatches selectors in priority order: path-like strings are treated as explicit filesystem paths; `custom:<id>` selectors force custom-pet lookup; otherwise built-in catalog ids are recognized first, and any remaining value falls back to custom-pet lookup. Built-ins load from the managed asset-pack path and receive the shared default geometry and default animation set. Custom and legacy avatar pets load `pet.json` or `avatar.json`, parse `PetFile`, derive display/id defaults, resolve a manifest-relative spritesheet path while forbidding absolute or parent-traversing escapes, validate spritesheet dimensions, validate the frame grid against the spritesheet, and load animations.

Animation loading starts from the built-in default animation map. If the manifest provides no animations, those defaults are retained. Otherwise each custom `AnimationSpec` is validated for non-empty frames, in-range sprite indices, finite FPS within `MAX_ANIMATION_FPS`, fallback naming, and loop shape; an `idle` animation is inserted if absent, and all fallback references are checked. The module also computes a frame-cache key by hashing spritesheet bytes plus frame geometry, ensuring cache invalidation when either art or slicing parameters change. The large test suite covers selector routing, defaults, cache-key behavior, path safety, frame-grid validation, and animation validation.

#### Function details

##### `Animation::total_duration`  (lines 46–51)

```
fn total_duration(&self) -> Duration
```

**Purpose**: Returns the sum of all frame durations in an animation. This is used to decide when non-looping animations have completed.

**Data flow**: It reads `self.frames`, maps each frame to `frame.duration`, sums them into a `Duration`, and returns the total.

**Call relations**: Used by ambient animation timing code when computing loop behavior and fallback transitions.

*Call graph*: called by 1 (current_animation_frame).


##### `Pet::load_with_codex_home`  (lines 82–96)

```
fn load_with_codex_home(value: &str, codex_home: Option<&Path>) -> Result<Self>
```

**Purpose**: Resolves a user-facing pet selector into a concrete validated `Pet`, choosing among explicit paths, forced custom selectors, built-in catalog ids, and default custom lookup. It is the main entry point into the model layer.

**Data flow**: Inputs are `value: &str` and optional `codex_home`. It checks `path_like(value)` first and delegates to `load_pet_path` if true; otherwise it strips the `custom:` prefix and delegates to `load_custom_pet`, or looks up a built-in via `catalog::builtin_pet` and delegates to `load_builtin_pet`, or finally falls back to `load_custom_pet(value, codex_home)`. It returns `Result<Pet>`.

**Call relations**: Called by `AmbientPet::load` and many tests. It orchestrates selector routing while delegating actual loading and validation to the specialized helpers.

*Call graph*: calls 5 internal fn (builtin_pet, load_builtin_pet, load_custom_pet, load_pet_path, path_like); called by 9 (load, custom_pet_rejects_spritesheet_path_escape, custom_pet_selector_falls_back_to_legacy_avatar_manifest, custom_pet_selector_loads_codex_home_pet_manifest, load_builtin_pet_uses_app_catalog_storage, load_pet_error_from_dir, load_pet_from_dir, load_pet_json_path_uses_containing_directory, custom_pet_entries).


##### `Pet::frame_count`  (lines 98–100)

```
fn frame_count(&self) -> usize
```

**Purpose**: Returns the normalized number of frames in the pet’s frame grid. This is a simple accessor used by frame extraction code.

**Data flow**: It reads `self.frame_count` and returns it as `usize`.

**Call relations**: Used by `prepare_png_frames` when constructing the expected frame-cache file list.

*Call graph*: called by 1 (prepare_png_frames).


##### `Pet::frame_cache_key`  (lines 102–110)

```
fn frame_cache_key(&self) -> Result<String>
```

**Purpose**: Computes a stable cache key for extracted frames based on both spritesheet contents and frame geometry. This ensures frame caches are invalidated when either the image or slicing parameters change.

**Data flow**: It reads the spritesheet bytes from `self.spritesheet_path`, hashes them with SHA-256, formats the digest together with `frame_width`, `frame_height`, `columns`, and `rows`, and returns the resulting `String` in a `Result`.

**Call relations**: Used by `AmbientPet::load` to choose a frame-cache directory unique to the current spritesheet and frame spec.

*Call graph*: 3 external calls (digest, format!, read).


##### `FrameSpec::default`  (lines 139–146)

```
fn default() -> Self
```

**Purpose**: Provides the app’s canonical frame geometry for manifests that omit an explicit `frame` section. This keeps custom pets aligned with built-in spritesheet layout by default.

**Data flow**: It returns a `FrameSpec` populated from `catalog::DEFAULT_FRAME_WIDTH`, `DEFAULT_FRAME_HEIGHT`, `DEFAULT_FRAME_COLUMNS`, and `DEFAULT_FRAME_ROWS`.

**Call relations**: Used by `load_pet_manifest` when a manifest does not specify frame geometry.


##### `custom_pet_selector`  (lines 149–151)

```
fn custom_pet_selector(id: &str) -> String
```

**Purpose**: Formats a custom pet id into the explicit `custom:<id>` selector syntax. This lets callers force custom-pet resolution even when an id might collide with a built-in.

**Data flow**: Input is `id: &str`. It formats and returns `custom:<id>` as a `String`.

**Call relations**: Used by tests and by higher-level code that needs an unambiguous selector for custom pet entries.

*Call graph*: called by 4 (custom_pet_rejects_spritesheet_path_escape, custom_pet_selector_falls_back_to_legacy_avatar_manifest, custom_pet_selector_loads_codex_home_pet_manifest, custom_pet_entries); 1 external calls (format!).


##### `load_builtin_pet`  (lines 164–183)

```
fn load_builtin_pet(pet: catalog::BuiltinPet, codex_home: Option<&Path>) -> Result<Pet>
```

**Purpose**: Loads a built-in catalog pet from the managed asset-pack cache and attaches the shared default animation set. It assumes the asset has already been downloaded.

**Data flow**: Inputs are a `catalog::BuiltinPet` and optional `codex_home`. It requires `codex_home`, computes the spritesheet path with `super::builtin_spritesheet_path`, errors if the file does not exist, and returns a `Pet` populated from catalog metadata, default frame geometry, `default_frame_count()`, and `default_animations()`.

**Call relations**: Called only from `Pet::load_with_codex_home` after built-in catalog lookup. It depends on external orchestration to have run `ensure_builtin_pack_for_pet` first.

*Call graph*: calls 2 internal fn (default_animations, default_frame_count); called by 1 (load_with_codex_home); 2 external calls (bail!, builtin_spritesheet_path).


##### `load_custom_pet`  (lines 185–203)

```
fn load_custom_pet(value: &str, codex_home: Option<&Path>) -> Result<Pet>
```

**Purpose**: Loads a custom pet or legacy avatar by id from `CODEX_HOME`. It prefers `pets/<id>/pet.json` and falls back to `avatars/<id>/avatar.json`.

**Data flow**: Inputs are the selector value and optional `codex_home`. It requires `codex_home`, constructs `pets/<value>` and `avatars/<value>` directories, checks for `pet.json` or `avatar.json`, and delegates to `load_pet_manifest` with a cache id from `custom_pet_cache_id(value)`; if neither manifest exists it returns `unknown pet <value>`.

**Call relations**: Called by `Pet::load_with_codex_home` for explicit custom selectors and as the final fallback for non-built-in ids.

*Call graph*: calls 2 internal fn (custom_pet_cache_id, load_pet_manifest); called by 1 (load_with_codex_home); 1 external calls (bail!).


##### `load_pet_path`  (lines 205–230)

```
fn load_pet_path(value: &str) -> Result<Pet>
```

**Purpose**: Loads a pet from an explicit filesystem path pointing either to a pet directory or directly to a manifest file. It canonicalizes the containing directory and supports both `pet.json` and legacy `avatar.json`.

**Data flow**: Input is a selector string path. It expands `~` via `expand_path`, reads metadata to distinguish file vs directory, chooses the containing directory, canonicalizes it, selects `pet.json` if present else `avatar.json`, derives a fallback id from the directory name or `pet`, and delegates to `load_pet_manifest(pet_dir, manifest_file, fallback_id, fallback_id)`.

**Call relations**: Called by `Pet::load_with_codex_home` whenever `path_like(value)` is true.

*Call graph*: calls 2 internal fn (expand_path, load_pet_manifest); called by 1 (load_with_codex_home); 2 external calls (bail!, metadata).


##### `load_pet_manifest`  (lines 232–294)

```
fn load_pet_manifest(
    pet_dir: &Path,
    manifest_file: &str,
    fallback_id: &str,
    cache_id: &str,
) -> Result<Pet>
```

**Purpose**: Parses a pet manifest file, resolves and validates its spritesheet, normalizes ids and display metadata, validates frame geometry, and loads animations into a final `Pet`. It is the core manifest-to-model conversion routine.

**Data flow**: Inputs are `pet_dir`, `manifest_file`, `fallback_id`, and `cache_id`. It reads and parses the JSON manifest into `PetFile`, trims optional `id` and `displayName`, derives `display_name`, chooses `pet_id` based on whether `cache_id` equals `fallback_id`, trims `description`, resolves the spritesheet path with `resolve_spritesheet_path`, checks that the file exists, validates image dimensions with `validate_app_spritesheet_dimensions`, obtains a `FrameSpec` default if absent, validates the frame grid with `validate_frame_spec`, loads animations with `load_animations(file.animations, frame_count)`, and returns the assembled `Pet`.

**Call relations**: Called by both `load_custom_pet` and `load_pet_path`. It delegates path safety, image validation, frame-grid validation, and animation normalization to dedicated helpers.

*Call graph*: calls 4 internal fn (load_animations, resolve_spritesheet_path, validate_app_spritesheet_dimensions, validate_frame_spec); called by 2 (load_custom_pet, load_pet_path); 4 external calls (join, bail!, read_to_string, from_str).


##### `resolve_spritesheet_path`  (lines 302–312)

```
fn resolve_spritesheet_path(pet_dir: &Path, spritesheet_path: &str) -> Result<PathBuf>
```

**Purpose**: Resolves a manifest-relative spritesheet path while forbidding absolute paths and parent-directory traversal. This keeps each custom pet self-contained inside its own directory.

**Data flow**: Inputs are `pet_dir: &Path` and `spritesheet_path: &str`. It constructs a `Path`, rejects it if absolute or if any component is `ParentDir` or Windows `Prefix`, otherwise joins it onto `pet_dir` and returns the resulting `PathBuf`.

**Call relations**: Used only by `load_pet_manifest` before checking file existence and image dimensions.

*Call graph*: called by 1 (load_pet_manifest); 3 external calls (join, new, bail!).


##### `validate_app_spritesheet_dimensions`  (lines 314–325)

```
fn validate_app_spritesheet_dimensions(path: &Path) -> Result<(u32, u32)>
```

**Purpose**: Ensures that a spritesheet image matches the app’s canonical full-sheet dimensions. Custom pets must still use the same overall sheet size even if they choose a different frame grid.

**Data flow**: Input is `path: &Path`. It reads image dimensions, compares them to `catalog::SPRITESHEET_WIDTH` and `catalog::SPRITESHEET_HEIGHT`, and returns `(width, height)` on success or an error on mismatch.

**Call relations**: Called by `load_pet_manifest` before frame-grid validation.

*Call graph*: called by 1 (load_pet_manifest); 2 external calls (bail!, image_dimensions).


##### `validate_frame_spec`  (lines 327–359)

```
fn validate_frame_spec(
    frame: &FrameSpec,
    spritesheet_width: u32,
    spritesheet_height: u32,
) -> Result<usize>
```

**Purpose**: Checks that a frame grid is non-zero, exactly covers the spritesheet dimensions, and does not exceed the maximum allowed frame count. It converts the validated frame count into `usize` for later indexing.

**Data flow**: Inputs are `frame: &FrameSpec`, `spritesheet_width`, and `spritesheet_height`. It rejects zero width/height/columns/rows, computes total grid width and height with checked multiplication, compares them to the spritesheet dimensions, computes `columns * rows` with overflow checks, converts that count to `usize`, rejects counts above `MAX_PET_FRAMES`, and returns the validated frame count.

**Call relations**: Used by `load_pet_manifest` after image-dimension validation and before animation loading.

*Call graph*: called by 1 (load_pet_manifest); 2 external calls (bail!, try_from).


##### `custom_pet_cache_id`  (lines 361–363)

```
fn custom_pet_cache_id(id: &str) -> String
```

**Purpose**: Builds the normalized cache id used for custom pets loaded from `CODEX_HOME`. This distinguishes custom pets from built-ins in frame-cache paths.

**Data flow**: Input is `id: &str`. It formats and returns `custom-<id>`.

**Call relations**: Used by `load_custom_pet` when passing a stable cache id into `load_pet_manifest`.

*Call graph*: called by 1 (load_custom_pet); 1 external calls (format!).


##### `path_like`  (lines 365–374)

```
fn path_like(value: &str) -> bool
```

**Purpose**: Heuristically decides whether a selector string should be treated as a filesystem path rather than a pet id. It recognizes relative path markers, home-relative paths, absolute paths, and path separators.

**Data flow**: Input is `value: &str`. It returns true for `.`, `..`, strings starting with `~/`, `../`, or `./`, absolute paths, or any string containing `/` or `\`; otherwise false.

**Call relations**: Used by `Pet::load_with_codex_home` as the first dispatch check so explicit paths take precedence over id-based lookup.

*Call graph*: called by 1 (load_with_codex_home); 1 external calls (new).


##### `expand_path`  (lines 376–386)

```
fn expand_path(value: &str) -> Result<PathBuf>
```

**Purpose**: Expands `~` and `~/...` selectors using the `HOME` environment variable. Other paths are returned unchanged as `PathBuf`s.

**Data flow**: Input is `value: &str`. If the value is `~` or starts with `~/`, it reads `HOME` from the environment and returns the home directory or a child path under it; otherwise it returns `PathBuf::from(value)`.

**Call relations**: Called by `load_pet_path` before filesystem metadata lookup.

*Call graph*: called by 1 (load_pet_path); 2 external calls (from, var_os).


##### `load_animations`  (lines 388–452)

```
fn load_animations(
    specs: HashMap<String, AnimationSpec>,
    frame_count: usize,
) -> Result<HashMap<String, Animation>>
```

**Purpose**: Builds the final animation map for a pet by starting from default app animations and optionally overlaying validated manifest-defined animations. It also guarantees that an `idle` animation exists and that all fallback references are valid.

**Data flow**: Inputs are a `HashMap<String, AnimationSpec>` and `frame_count`. It initializes `animations` with `default_animations()`. If no specs are provided, it validates the defaults against `frame_count` and returns them. Otherwise it iterates each spec, rejects empty frame lists and out-of-range sprite indices, validates `fps` or defaults to 8.0, converts fps to per-frame `Duration`, chooses fallback `idle` when unspecified, derives `loop_start` from `loop_animation` defaulting to looping, inserts the constructed `Animation`, ensures `idle` exists via `or_insert_with(idle_animation)`, validates all animations with `validate_animation_indices`, and returns the map.

**Call relations**: Called by `load_pet_manifest` and directly by a unit test. It delegates final consistency checks to `validate_animation_indices`.

*Call graph*: calls 2 internal fn (default_animations, validate_animation_indices); called by 2 (load_pet_manifest, custom_animation_specs_keep_manifest_fps_and_loop_shape); 2 external calls (from_secs_f64, bail!).


##### `validate_animation_indices`  (lines 454–478)

```
fn validate_animation_indices(
    animations: &HashMap<String, Animation>,
    frame_count: usize,
) -> Result<()>
```

**Purpose**: Performs cross-animation consistency checks after animation construction. It ensures every animation has frames, every sprite index is within range, and every fallback animation name exists in the map.

**Data flow**: Inputs are `animations: &HashMap<String, Animation>` and `frame_count`. It iterates all animations, rejects empty frame vectors, rejects any `frame.sprite_index >= frame_count`, checks `animations.contains_key(&animation.fallback)`, and returns `Result<()>`.

**Call relations**: Used by `load_animations` both for the default-only path and after overlaying custom specs.

*Call graph*: called by 1 (load_animations); 1 external calls (bail!).


##### `default_frame_count`  (lines 480–482)

```
fn default_frame_count() -> usize
```

**Purpose**: Returns the number of frames implied by the canonical built-in grid dimensions. This is the built-in pet frame count and the baseline for many tests.

**Data flow**: It multiplies `catalog::DEFAULT_FRAME_COLUMNS * catalog::DEFAULT_FRAME_ROWS`, casts to `usize`, and returns the result.

**Call relations**: Used by `load_builtin_pet` and tests that need the canonical frame count.

*Call graph*: called by 2 (load_builtin_pet, custom_animation_specs_keep_manifest_fps_and_loop_shape).


##### `default_animations`  (lines 484–582)

```
fn default_animations() -> HashMap<String, Animation>
```

**Purpose**: Constructs the built-in/default animation map shared by built-in pets and by custom pets that omit animation definitions. It includes both current app-state names and legacy aliases.

**Data flow**: It creates an array of `(name, Animation)` pairs including `idle`, directional movement, waving/jumping aliases, and notification-state animations like `failed`, `waiting`, `running`, and `review`. Most non-idle entries are built with `app_state_animation`, while `idle` uses `idle_animation`; the pairs are collected into a `HashMap<String, Animation>` and returned.

**Call relations**: Used by `load_builtin_pet`, `load_animations`, and several tests that verify row assignments and timing patterns.

*Call graph*: calls 2 internal fn (app_state_animation, idle_animation); called by 5 (load_animations, load_builtin_pet, app_idle_animation_uses_calm_loop, app_notification_states_use_expected_rows, app_running_animation_repeats_then_settles_into_idle).


##### `idle_animation`  (lines 584–596)

```
fn idle_animation() -> Animation
```

**Purpose**: Defines the calm looping idle animation used as the baseline and fallback for other animations. Its frame durations are intentionally uneven to create a less mechanical idle motion.

**Data flow**: It constructs an `Animation` whose frames are sprite indices 0 through 5 with fixed millisecond durations `[1680, 660, 660, 840, 840, 1920]`, `loop_start: Some(0)`, and fallback `idle`.

**Call relations**: Used directly by `default_animations` and appended by `app_state_animation` after repeated primary motion frames.

*Call graph*: called by 2 (app_state_animation, default_animations).


##### `app_state_animation`  (lines 598–627)

```
fn app_state_animation(
    row_index: usize,
    frame_count: usize,
    frame_duration_ms: u64,
    final_frame_duration_ms: u64,
) -> Animation
```

**Purpose**: Builds a notification or movement animation from one spritesheet row, repeating its primary frames three times before settling into the idle sequence. The loop starts at the beginning of the repeated primary section after the initial pass-through.

**Data flow**: Inputs are `row_index`, `frame_count`, `frame_duration_ms`, and `final_frame_duration_ms`. It creates `primary_frames` by mapping columns in the given row to sprite indices with the final frame receiving a longer duration, clones that sequence three times, appends `idle_animation().frames`, computes `primary_frame_count` as the length of the repeated primary section, and returns an `Animation` with `loop_start: Some(primary_frame_count)` and fallback `idle`.

**Call relations**: Used by `default_animations` to generate all non-idle built-in/default animations.

*Call graph*: calls 1 internal fn (idle_animation); called by 1 (default_animations).


##### `tests::write_minimal_pet`  (lines 633–642)

```
fn write_minimal_pet() -> tempfile::TempDir
```

**Purpose**: Creates a temporary pet directory containing a minimal valid manifest and spritesheet. It is a convenience fixture for many model tests.

**Data flow**: It delegates to `write_pet_manifest` with a JSON manifest containing id, display name, description, and default spritesheet path, and returns the resulting `TempDir`.

**Call relations**: Used by multiple tests that need a simple valid custom pet fixture.

*Call graph*: 1 external calls (write_pet_manifest).


##### `tests::write_pet_manifest`  (lines 644–649)

```
fn write_pet_manifest(manifest: &str) -> tempfile::TempDir
```

**Purpose**: Writes an arbitrary manifest string plus a valid test spritesheet into a temporary directory. This is the low-level fixture builder for manifest-loading tests.

**Data flow**: Input is a manifest JSON string. It creates a temp directory, writes `pet.json`, writes a valid `spritesheet.webp` via `catalog::write_test_spritesheet`, and returns the directory.

**Call relations**: Used by `write_minimal_pet` and many validation tests to create custom manifest scenarios.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 2 external calls (write, tempdir).


##### `tests::load_pet_from_dir`  (lines 651–653)

```
fn load_pet_from_dir(dir: &tempfile::TempDir) -> Pet
```

**Purpose**: Loads a pet from a temporary directory fixture and unwraps success. It reduces repetition in tests that expect valid manifests.

**Data flow**: Input is `&tempfile::TempDir`. It converts the directory path to `&str`, calls `Pet::load_with_codex_home(..., None)`, unwraps the result, and returns the `Pet`.

**Call relations**: Used by several tests that validate successful path-based loading.

*Call graph*: calls 1 internal fn (load_with_codex_home); 1 external calls (path).


##### `tests::load_pet_error_from_dir`  (lines 655–657)

```
fn load_pet_error_from_dir(dir: &tempfile::TempDir) -> anyhow::Error
```

**Purpose**: Loads a pet from a temporary directory fixture and unwraps the error. It is a convenience helper for negative validation tests.

**Data flow**: Input is `&tempfile::TempDir`. It converts the directory path to `&str`, calls `Pet::load_with_codex_home(..., None)`, unwraps the error, and returns it.

**Call relations**: Used by tests that verify specific manifest validation failures.

*Call graph*: calls 1 internal fn (load_with_codex_home); 1 external calls (path).


##### `tests::load_builtin_pet_uses_app_catalog_storage`  (lines 660–678)

```
fn load_builtin_pet_uses_app_catalog_storage()
```

**Purpose**: Verifies that built-in pet loading reads metadata from the catalog and spritesheets from the managed asset-pack location. It also checks the default frame geometry.

**Data flow**: It creates a temporary `CODEX_HOME`, populates it with `write_test_pack`, loads `dewey` via `Pet::load_with_codex_home`, and asserts the resulting id, display name, description, spritesheet path, frame width/height, and grid dimensions.

**Call relations**: This test exercises the built-in branch of `Pet::load_with_codex_home` and `load_builtin_pet`.

*Call graph*: calls 2 internal fn (write_test_pack, load_with_codex_home); 2 external calls (assert_eq!, tempdir).


##### `tests::app_idle_animation_uses_calm_loop`  (lines 681–688)

```
fn app_idle_animation_uses_calm_loop()
```

**Purpose**: Checks the exact sprite indices, durations, and loop point of the default idle animation. This locks down the intended idle motion profile.

**Data flow**: It builds `default_animations()`, selects `idle`, derives sprite indices and durations via helper functions, and asserts they match the expected vectors and `loop_start`.

**Call relations**: This test validates `idle_animation` as exposed through `default_animations`.

*Call graph*: calls 1 internal fn (default_animations); 1 external calls (assert_eq!).


##### `tests::app_running_animation_repeats_then_settles_into_idle`  (lines 691–708)

```
fn app_running_animation_repeats_then_settles_into_idle()
```

**Purpose**: Verifies the structure of the default `running` animation: three repetitions of the primary row frames followed by the idle sequence. It also checks the longer final-frame duration and loop start.

**Data flow**: It builds `default_animations()`, selects `running`, compares slices of sprite indices and durations against expected vectors, and asserts the loop start equals 18.

**Call relations**: This test validates the composition logic in `app_state_animation` as used by `default_animations`.

*Call graph*: calls 1 internal fn (default_animations); 2 external calls (assert_eq!, vec!).


##### `tests::app_notification_states_use_expected_rows`  (lines 711–726)

```
fn app_notification_states_use_expected_rows()
```

**Purpose**: Checks that the default `waiting`, `review`, and `failed` animations pull frames from the intended spritesheet rows. This protects the semantic-to-row mapping.

**Data flow**: It builds `default_animations()`, extracts the first frames of the named animations, and asserts their sprite indices match the expected row-based sequences.

**Call relations**: This test validates the row-index arguments passed to `app_state_animation` inside `default_animations`.

*Call graph*: calls 1 internal fn (default_animations); 1 external calls (assert_eq!).


##### `tests::custom_animation_specs_keep_manifest_fps_and_loop_shape`  (lines 729–749)

```
fn custom_animation_specs_keep_manifest_fps_and_loop_shape()
```

**Purpose**: Verifies that manifest-defined animations preserve explicit FPS and non-looping behavior rather than being normalized to default timings. It also checks fallback preservation.

**Data flow**: It calls `load_animations` with a custom spec containing frames `[1,2]`, `fps: 2.0`, `loop: false`, and fallback `idle`, then asserts the resulting animation has sprite indices `[1,2]`, durations `[500,500]`, `loop_start: None`, and fallback `idle`.

**Call relations**: This test directly exercises the custom-spec branch of `load_animations`.

*Call graph*: calls 2 internal fn (default_frame_count, load_animations); 3 external calls (from, assert_eq!, vec!).


##### `tests::load_pet_directory_uses_app_pet_manifest_defaults`  (lines 752–765)

```
fn load_pet_directory_uses_app_pet_manifest_defaults()
```

**Purpose**: Checks that a minimal manifest inherits the default frame geometry and default animations. This is the baseline custom-pet loading behavior.

**Data flow**: It creates a minimal pet fixture, loads it with `load_pet_from_dir`, and asserts id, display name, frame geometry, frame count, and presence of idle animation frames.

**Call relations**: This test exercises `load_pet_manifest` with omitted `frame` and `animations` fields.

*Call graph*: 4 external calls (assert!, assert_eq!, load_pet_from_dir, write_minimal_pet).


##### `tests::frame_cache_key_changes_with_spritesheet_contents`  (lines 768–783)

```
fn frame_cache_key_changes_with_spritesheet_contents()
```

**Purpose**: Verifies that the frame-cache key changes when the spritesheet bytes change, even if the manifest stays the same. This protects frame-cache invalidation on asset updates.

**Data flow**: It creates a minimal pet, loads it and records `frame_cache_key`, overwrites the spritesheet with a different solid-color image of the same dimensions, reloads the pet, and asserts the new key differs from the old one.

**Call relations**: This test exercises `Pet::frame_cache_key` and the content-hash portion of its output.

*Call graph*: 5 external calls (assert_ne!, Rgba, from_pixel, load_pet_from_dir, write_minimal_pet).


##### `tests::frame_cache_key_changes_with_frame_spec`  (lines 786–802)

```
fn frame_cache_key_changes_with_frame_spec()
```

**Purpose**: Checks that the frame-cache key also changes when frame geometry changes, even if the spritesheet contents are structurally valid. This prevents cache collisions between different slicing schemes.

**Data flow**: It loads one pet with default frame spec and another with a custom `frame` section over the same-sized spritesheet, computes both cache keys, and asserts they differ.

**Call relations**: This test validates the geometry suffix included by `Pet::frame_cache_key`.

*Call graph*: 4 external calls (assert_ne!, load_pet_from_dir, write_minimal_pet, write_pet_manifest).


##### `tests::load_pet_json_path_uses_containing_directory`  (lines 805–816)

```
fn load_pet_json_path_uses_containing_directory()
```

**Purpose**: Verifies that passing a direct path to `pet.json` loads the pet relative to that file’s containing directory. This supports explicit manifest-file selectors.

**Data flow**: It creates a minimal pet fixture, calls `Pet::load_with_codex_home` on the `pet.json` path string, canonicalizes the expected spritesheet path, and asserts the loaded `pet.spritesheet_path` matches it.

**Call relations**: This test exercises the file-path branch of `load_pet_path`.

*Call graph*: calls 1 internal fn (load_with_codex_home); 2 external calls (assert_eq!, write_minimal_pet).


##### `tests::custom_pet_selector_loads_codex_home_pet_manifest`  (lines 819–839)

```
fn custom_pet_selector_loads_codex_home_pet_manifest()
```

**Purpose**: Checks that `custom:<id>` selectors load from `CODEX_HOME/pets/<id>/pet.json` and assign the normalized custom cache id. This ensures explicit custom selection bypasses built-in lookup.

**Data flow**: It creates a minimal pet fixture, copies its manifest and spritesheet into `CODEX_HOME/pets/chefito`, loads `custom:chefito`, and asserts the resulting id is `custom-chefito` and the spritesheet path points into the `pets` directory.

**Call relations**: This test exercises `custom_pet_selector`, `Pet::load_with_codex_home`, and `load_custom_pet` on the primary custom-pet path.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 5 external calls (assert_eq!, copy, create_dir_all, tempdir, write_minimal_pet).


##### `tests::custom_pet_selector_falls_back_to_legacy_avatar_manifest`  (lines 842–862)

```
fn custom_pet_selector_falls_back_to_legacy_avatar_manifest()
```

**Purpose**: Verifies that explicit custom selectors also support legacy avatar storage under `CODEX_HOME/avatars/<id>/avatar.json`. This preserves backward compatibility with older pet storage.

**Data flow**: It creates a minimal pet fixture, copies its manifest as `avatar.json` plus spritesheet into `CODEX_HOME/avatars/legacy`, loads `custom:legacy`, and asserts the resulting id is `custom-legacy` and display name is preserved.

**Call relations**: This test exercises the legacy-avatar fallback branch in `load_custom_pet`.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 5 external calls (assert_eq!, copy, create_dir_all, tempdir, write_minimal_pet).


##### `tests::custom_pet_rejects_spritesheet_path_escape`  (lines 865–888)

```
fn custom_pet_rejects_spritesheet_path_escape()
```

**Purpose**: Checks that manifests cannot reference spritesheets outside their own directory via `..` traversal. This enforces the self-contained custom-pet invariant.

**Data flow**: It creates `CODEX_HOME/pets/escape/pet.json` with `spritesheetPath: ../spritesheet.webp`, loads `custom:escape`, captures the error, and asserts the message mentions that the spritesheet path must stay inside the pet directory.

**Call relations**: This test validates `resolve_spritesheet_path` as reached through `load_pet_manifest`.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `tests::custom_pet_rejects_zero_frame_dimensions`  (lines 891–906)

```
fn custom_pet_rejects_zero_frame_dimensions()
```

**Purpose**: Verifies that frame specs with zero dimensions or counts are rejected. This prevents invalid slicing geometry.

**Data flow**: It writes a manifest with `frame.width = 0`, loads it expecting failure via `load_pet_error_from_dir`, and asserts the error mentions non-zero frame dimensions and grid counts.

**Call relations**: This test exercises the zero-check branch in `validate_frame_spec`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_frame_grid_that_does_not_cover_spritesheet`  (lines 909–924)

```
fn custom_pet_rejects_frame_grid_that_does_not_cover_spritesheet()
```

**Purpose**: Checks that the frame grid must exactly cover the spritesheet dimensions. Partial coverage or mismatch is not allowed.

**Data flow**: It writes a manifest with a 7×9 grid over the canonical spritesheet, loads it expecting failure, and asserts the error mentions exact coverage of the spritesheet.

**Call relations**: This test validates the total-width/total-height comparison in `validate_frame_spec`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_excessive_frame_count`  (lines 927–939)

```
fn custom_pet_rejects_excessive_frame_count()
```

**Purpose**: Verifies that extremely dense frame grids exceeding `MAX_PET_FRAMES` are rejected. This bounds memory and indexing assumptions.

**Data flow**: It writes a manifest with a huge 192×234 frame grid, loads it expecting failure, and asserts the error mentions exceeding the maximum.

**Call relations**: This test exercises the frame-count upper-bound check in `validate_frame_spec`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_empty_animation_frames`  (lines 942–959)

```
fn custom_pet_rejects_empty_animation_frames()
```

**Purpose**: Checks that custom animations must contain at least one frame. Empty animation definitions are invalid.

**Data flow**: It writes a manifest whose `idle` animation has an empty `frames` array, loads it expecting failure, and asserts the error mentions that the animation must include at least one frame.

**Call relations**: This test validates the early empty-frame rejection in `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_animation_frame_outside_grid`  (lines 962–979)

```
fn custom_pet_rejects_animation_frame_outside_grid()
```

**Purpose**: Verifies that animation sprite indices must be within the validated frame count. References past the end of the grid are rejected.

**Data flow**: It writes a manifest whose `idle` animation references sprite index 72 on a 72-frame sheet, loads it expecting failure, and asserts the error mentions the out-of-range index.

**Call relations**: This test exercises the sprite-index bounds check in `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_invalid_animation_fps`  (lines 982–999)

```
fn custom_pet_rejects_invalid_animation_fps()
```

**Purpose**: Checks that custom animation FPS must be finite, positive, and no greater than `MAX_ANIMATION_FPS`. Excessive or invalid FPS values are rejected.

**Data flow**: It writes a manifest with `fps: 120.0`, loads it expecting failure, and asserts the error mentions the allowed FPS range.

**Call relations**: This test validates the FPS validation branch in `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_animation_fallback_to_missing_animation`  (lines 1002–1019)

```
fn custom_pet_rejects_animation_fallback_to_missing_animation()
```

**Purpose**: Verifies that non-looping animations cannot name a fallback animation that does not exist. Fallback references are checked after all animations are assembled.

**Data flow**: It writes a manifest with a `wave` animation whose fallback is `missing`, loads it expecting failure, and asserts the error mentions the missing fallback animation.

**Call relations**: This test exercises `validate_animation_indices` after custom animation insertion.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::sprite_indices`  (lines 1021–1027)

```
fn sprite_indices(animation: &Animation) -> Vec<usize>
```

**Purpose**: Extracts the sprite indices from an animation into a vector for concise assertions in tests. It is a pure inspection helper.

**Data flow**: Input is `&Animation`. It iterates `animation.frames`, maps each frame to `frame.sprite_index`, collects into `Vec<usize>`, and returns it.

**Call relations**: Used by animation-structure tests to compare expected frame sequences.


##### `tests::durations_ms`  (lines 1029–1035)

```
fn durations_ms(animation: &Animation) -> Vec<u128>
```

**Purpose**: Extracts frame durations in milliseconds from an animation for test assertions. It simplifies checking timing patterns.

**Data flow**: Input is `&Animation`. It iterates `animation.frames`, maps each frame to `frame.duration.as_millis()`, collects into `Vec<u128>`, and returns it.

**Call relations**: Used by tests that verify idle and running animation timing.
