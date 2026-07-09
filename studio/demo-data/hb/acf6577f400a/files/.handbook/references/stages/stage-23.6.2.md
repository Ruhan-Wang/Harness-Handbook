# Configuration, policy, and environment tests  `stage-23.6.2`

This stage is a cross-cutting regression net around startup-time and configuration-driven behavior: it verifies how the system reads config from disk and cloud sources, merges layers and managed requirements, resolves features and policies, and turns those results into runtime environment, sandbox, hook, prompt, and connector decisions before the main loop begins.

The config crate tests cover the raw mechanics: synthetic cloud bundle builders, cloud fragment/layer conversion, requirements-stack precedence, strict validation, TOML merge normalization, hook and MCP schema variants, state/profile loading, and loader behavior. Core config tests then exercise the higher-level loader and editor pipeline end to end, including schema generation, persistence, auth-keyring backend choice, permissions, network proxy policy, Windows sandbox settings, execution environment construction, and user-facing deprecation or unstable-feature warnings. Feature and tool-policy tests lock down feature resolution and how feature flags shape tool execution modes. Cloud-config and cloud-task tests validate cached managed configuration retrieval and environment-specific task filtering. Supporting suites verify path normalization, fsmonitor probing, Codex-home instruction discovery, hook-engine policy, prompt rendering for permissions, sandbox policy transforms, bubblewrap detection, and memory write guards. Together, these tests ensure configuration semantics stay stable across the whole startup and policy surface.

## Files in this stage

### Config test fixtures and cloud layers
These tests establish the shared fixture builders and validate how managed cloud-config fragments and requirement layers are constructed and named before broader loader and parser coverage uses them.

### `config/src/test_support.rs`

`test` · `test`

This module is a small test-support builder around `CloudConfigBundle`. `CloudConfigBundleFixture` owns a mutable bundle and exposes fluent constructors for the two enterprise-managed fragment lists: `requirements_toml.enterprise_managed` and `config_toml.enterprise_managed`. The convenience constructors `enterprise_requirement` and `enterprise_config` start from `Default` and immediately append one fragment, while the `loader_with_*` helpers go one step further and wrap the resulting bundle in a `CloudConfigBundleLoader` that asynchronously returns `Ok(Some(bundle))`.

The append methods encode a naming and ID convention that tests rely on: requirement fragments are numbered `req_1`, `req_2`, ... with names `Base requirements` for the first and `Requirements N` thereafter; config fragments similarly use `cfg_1`, `cfg_2`, ... with `Base config` / `Config N`. The index is derived from the current vector length plus one, so chained calls preserve insertion order deterministically. `into_bundle` exposes the raw assembled bundle, while `into_loader` converts it into the async loader shape expected by production loading code. The module is explicitly marked test-only and is intended for cross-crate integration tests rather than runtime use.

#### Function details

##### `CloudConfigBundleFixture::enterprise_requirement`  (lines 16–18)

```
fn enterprise_requirement(contents: impl Into<String>) -> Self
```

**Purpose**: Creates a new fixture containing exactly one enterprise requirements fragment. It is the shortest path for tests that only need managed requirements content.

**Data flow**: Takes requirement contents convertible into `String`, starts from `Self::default()`, calls `add_enterprise_requirement(contents)`, and returns the resulting fixture.

**Call relations**: Used directly by tests and indirectly by `loader_with_enterprise_requirement`. It is a convenience wrapper over the fluent append method.

*Call graph*: called by 1 (adds_enterprise_requirements_in_order); 1 external calls (default).


##### `CloudConfigBundleFixture::enterprise_config`  (lines 20–22)

```
fn enterprise_config(contents: impl Into<String>) -> Self
```

**Purpose**: Creates a new fixture containing exactly one enterprise config fragment. It mirrors `enterprise_requirement` for config TOML fragments.

**Data flow**: Takes config contents convertible into `String`, starts from `Self::default()`, calls `add_enterprise_config(contents)`, and returns the resulting fixture.

**Call relations**: Used directly or via `loader_with_enterprise_config` when tests need cloud-managed config rather than requirements.

*Call graph*: 1 external calls (default).


##### `CloudConfigBundleFixture::loader_with_enterprise_requirement`  (lines 24–28)

```
fn loader_with_enterprise_requirement(
        contents: impl Into<String>,
    ) -> CloudConfigBundleLoader
```

**Purpose**: Builds a `CloudConfigBundleLoader` that asynchronously yields a bundle with one enterprise requirements fragment. It packages the fixture into the same loader abstraction production code consumes.

**Data flow**: Takes requirement contents, constructs a fixture with `enterprise_requirement(contents)`, converts it with `into_loader()`, and returns the loader.

**Call relations**: Widely used by tests that exercise config loading with cloud-managed requirements. It composes the fixture builder with the async loader wrapper.

*Call graph*: called by 36 (write_value_rejects_feature_requirement_conflict, load_config_layers_applies_matching_remote_sandbox_config, load_config_layers_can_ignore_managed_requirements, load_config_layers_includes_cloud_config_bundle, load_config_layers_includes_cloud_hook_requirements, load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home, mdm_requirements_take_precedence_over_cloud_config_bundle, active_profile_is_cleared_when_requirements_force_fallback, approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements, browser_feature_requirements_are_valid (+15 more)); 1 external calls (enterprise_requirement).


##### `CloudConfigBundleFixture::loader_with_enterprise_config`  (lines 30–32)

```
fn loader_with_enterprise_config(contents: impl Into<String>) -> CloudConfigBundleLoader
```

**Purpose**: Builds a `CloudConfigBundleLoader` that yields a bundle with one enterprise config fragment. It is the config-side counterpart to the requirements loader helper.

**Data flow**: Takes config contents, constructs a fixture with `enterprise_config(contents)`, converts it with `into_loader()`, and returns the loader.

**Call relations**: Used by tests that need cloud-managed config layers inserted into the stack.

*Call graph*: called by 2 (load_config_layers_inserts_cloud_config_between_system_and_user, strict_config_rejects_unknown_cloud_config_key); 1 external calls (enterprise_config).


##### `CloudConfigBundleFixture::add_enterprise_requirement`  (lines 34–49)

```
fn add_enterprise_requirement(mut self, contents: impl Into<String>) -> Self
```

**Purpose**: Appends one enterprise requirements fragment to the fixture bundle with deterministic ID and display name generation. It supports fluent chaining for multi-fragment bundles.

**Data flow**: Takes ownership of `self` and requirement contents, computes `index` as current enterprise requirements length plus one, pushes a `CloudRequirementsFragment { id, name, contents }` into `self.bundle.requirements_toml.enterprise_managed`, and returns the updated fixture.

**Call relations**: Called by the one-shot constructor and by tests that chain multiple requirement fragments. Its numbering logic is what the companion test verifies.

*Call graph*: 2 external calls (into, format!).


##### `CloudConfigBundleFixture::add_enterprise_config`  (lines 51–66)

```
fn add_enterprise_config(mut self, contents: impl Into<String>) -> Self
```

**Purpose**: Appends one enterprise config fragment to the fixture bundle with deterministic ID and display name generation. It enables fluent construction of multi-fragment config bundles.

**Data flow**: Takes ownership of `self` and config contents, computes `index` from the current enterprise config fragment count, pushes a `CloudConfigFragment { id, name, contents }` into `self.bundle.config_toml.enterprise_managed`, and returns the updated fixture.

**Call relations**: Used by the one-shot config constructor and by tests that need multiple enterprise config fragments in order.

*Call graph*: 2 external calls (into, format!).


##### `CloudConfigBundleFixture::into_bundle`  (lines 68–70)

```
fn into_bundle(self) -> CloudConfigBundle
```

**Purpose**: Extracts the assembled `CloudConfigBundle` from the fixture. It ends the fluent builder chain when tests want direct bundle inspection.

**Data flow**: Consumes `self` and returns `self.bundle` by value, with no further transformation.

**Call relations**: Called directly by tests asserting on bundle contents and internally by `into_loader()`.

*Call graph*: called by 1 (into_loader).


##### `CloudConfigBundleFixture::into_loader`  (lines 72–75)

```
fn into_loader(self) -> CloudConfigBundleLoader
```

**Purpose**: Wraps the assembled bundle in an async `CloudConfigBundleLoader` that returns it once. This lets tests feed synthetic cloud config into production loading paths.

**Data flow**: Consumes `self`, obtains the bundle via `into_bundle()`, then constructs `CloudConfigBundleLoader::new(async move { Ok(Some(bundle)) })` and returns that loader.

**Call relations**: Used by the `loader_with_*` helpers and any tests that want a loader rather than a raw bundle.

*Call graph*: calls 2 internal fn (new, into_bundle).


### `config/src/test_support_tests.rs`

`test` · `test`

This small test module validates the deterministic behavior of `CloudConfigBundleFixture`. The single test constructs a bundle by starting with `enterprise_requirement("first")`, chaining `add_enterprise_requirement("second")`, and then extracting the raw bundle with `into_bundle()`. It asserts that the resulting `enterprise_managed` requirements vector contains two `CloudRequirementsFragment` entries in insertion order, with IDs `req_1` and `req_2`, names `Base requirements` and `Requirements 2`, and the original contents preserved.

Although simple, this test protects an important convention used throughout integration tests: fixture-generated cloud fragments must have predictable IDs, names, and ordering so assertions on loaded layers and diagnostics remain stable. If the builder ever changed its numbering scheme or insertion behavior, this test would fail immediately.

#### Function details

##### `adds_enterprise_requirements_in_order`  (lines 5–25)

```
fn adds_enterprise_requirements_in_order()
```

**Purpose**: Verifies that chaining enterprise requirement additions preserves order and generates the expected IDs and names. It is the regression test for the fixture builder's numbering convention.

**Data flow**: Builds a bundle from a fixture chain, reads `bundle.requirements_toml.enterprise_managed`, and asserts equality with an explicit two-element vector of `CloudRequirementsFragment` values.

**Call relations**: This test directly exercises `CloudConfigBundleFixture::enterprise_requirement`, `add_enterprise_requirement`, and `into_bundle` as one fluent construction path.

*Call graph*: calls 1 internal fn (enterprise_requirement); 1 external calls (assert_eq!).


### `config/src/cloud_config_bundle_tests.rs`

`test` · `test execution`

This test module exercises the semantics encoded in `cloud_config_bundle.rs` rather than introducing new production logic. The async test `shared_future_runs_once` proves that `CloudConfigBundleLoader` wraps its future in `Shared`: two concurrent `get()` calls observe identical results while an `AtomicUsize` counter increments only once.

The remaining tests focus on bundle-to-layer conversion. `bundle_layers_preserve_enterprise_managed_bucket_order` constructs a bundle whose config and requirements fragments are intentionally listed highest-priority first. It verifies that config layers are returned in stack order—lowest precedence first—and that requirements composition yields the highest-priority approval policy after the requirements vector has been reversed into merge order. This catches subtle precedence bugs across the two layer systems, which fold in opposite directions.

`bundle_layers_can_strict_validate_enterprise_managed_config` checks the strict-config path specifically: an unknown TOML key in an enterprise-managed config fragment must surface as `CloudConfigLayerError::Invalid` with the fragment’s id and name preserved in the diagnostic source. Together these tests document the intended insertion semantics, strictness toggle, and single-execution loader behavior.

#### Function details

##### `shared_future_runs_once`  (lines 13–24)

```
async fn shared_future_runs_once()
```

**Purpose**: Verifies that a `CloudConfigBundleLoader` created from one async computation executes that computation only once even when awaited concurrently.

**Data flow**: Creates an `Arc<AtomicUsize>` counter, clones it into an async loader future that increments the counter and returns `Ok(Some(CloudConfigBundle::default()))`, then concurrently awaits `loader.get()` twice with `tokio::join!`. It asserts that both results are equal and that the counter value is exactly 1.

**Call relations**: This test drives `CloudConfigBundleLoader::new` and `get()` under concurrent access to validate the shared-future contract promised by the production loader.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, new, assert_eq!, default, join!).


##### `bundle_layers_preserve_enterprise_managed_bucket_order`  (lines 27–92)

```
fn bundle_layers_preserve_enterprise_managed_bucket_order()
```

**Purpose**: Checks that enterprise-managed config fragments and requirements fragments from a bundle are converted into layer order compatible with their respective merge semantics.

**Data flow**: Builds a temporary absolute base directory, constructs a `CloudConfigBundle` with two config fragments and two requirements fragments ordered high-to-low priority, converts it with `CloudConfigBundleLayers::from_bundle`, then asserts that `enterprise_managed_config` names appear low-to-high in stack order and that composing `enterprise_managed_requirements` yields the expected highest-priority approval policy.

**Call relations**: Exercises the non-strict bundle conversion path and indirectly validates the reversal logic inside `from_bundle_impl` for both config and requirements buckets.

*Call graph*: calls 2 internal fn (from_bundle, from_absolute_path); 3 external calls (assert_eq!, tempdir, vec!).


##### `bundle_layers_can_strict_validate_enterprise_managed_config`  (lines 95–125)

```
fn bundle_layers_can_strict_validate_enterprise_managed_config()
```

**Purpose**: Ensures that strict bundle conversion rejects unknown configuration fields in enterprise-managed config fragments.

**Data flow**: Creates a temporary absolute base directory, constructs a bundle containing one config fragment with `unknown_key = true` and no requirements fragments, calls `CloudConfigBundleLayers::from_bundle_strict_config`, expects an error, and asserts that the returned `CloudConfigLayerError::Invalid` includes the fragment id, name, and unknown-field message.

**Call relations**: Targets the strict-config wrapper specifically, confirming that it routes through strict fragment validation rather than permissive parsing.

*Call graph*: calls 2 internal fn (from_bundle_strict_config, from_absolute_path); 4 external calls (new, assert_eq!, tempdir, vec!).


### `config/src/cloud_config_layers_tests.rs`

`test` · `test execution`

This test module documents the intended semantics of `cloud_config_layers.rs` through focused examples. Three small helpers keep fixtures concise: `fragment` builds `CloudConfigFragment` values, `toml` parses inline TOML into `TomlValue`, and `base_dir` returns a stable absolute test path under `/var/lib/codex`.

The tests cover four main behaviors. First, `layers_are_returned_in_stack_order` proves that backend fragments listed high-to-low priority are reversed into `ConfigLayerStack` order. Second, `strict_layers_reject_unknown_config_fields` verifies the strict parser path emits `CloudConfigLayerError::Invalid` with the fragment source preserved. Third, `enterprise_layers_precede_user_and_override_system` embeds cloud layers between system and user layers in a real `ConfigLayerStack`, showing that enterprise-managed layers override system values but are themselves overridden by user config according to stack ordering.

The path-resolution tests confirm that relative and home-relative path fields such as `model_instructions_file` are rewritten against the cloud base directory using the same helper as production code. Finally, `raw_toml_diagnostics_use_enterprise_layer_name` checks that later schema/type diagnostics point at a synthetic path formatted as `enterprise-managed (Base policy, cfg_123)`, ensuring users see the managed layer’s semantic identity rather than an opaque filesystem path.

#### Function details

##### `fragment`  (lines 15–21)

```
fn fragment(id: &str, name: &str, contents: &str) -> CloudConfigFragment
```

**Purpose**: Creates a `CloudConfigFragment` test fixture from simple string slices.

**Data flow**: Takes `id`, `name`, and `contents` as `&str`, converts each to owned `String`, and returns a `CloudConfigFragment`.

**Call relations**: Used throughout the test module to keep fragment setup concise and readable.


##### `toml`  (lines 23–25)

```
fn toml(contents: &str) -> TomlValue
```

**Purpose**: Parses inline TOML fixture text into a `TomlValue` for expected-value assertions and layer construction.

**Data flow**: Accepts a TOML string slice, parses it with `toml::from_str`, panics if parsing fails, and returns the resulting `TomlValue`.

**Call relations**: Used by the stack-ordering test to build system/user layer configs and expected effective config values.

*Call graph*: called by 1 (enterprise_layers_precede_user_and_override_system); 1 external calls (from_str).


##### `base_dir`  (lines 27–29)

```
fn base_dir() -> AbsolutePathBuf
```

**Purpose**: Provides a stable absolute base directory fixture used when resolving cloud-config relative paths in tests.

**Data flow**: Builds a test path buffer for `/var/lib/codex`, converts it to an absolute path via `.abs()`, and returns the `AbsolutePathBuf`.

**Call relations**: Called by nearly every test in the module so all path-resolution assertions share the same base directory.

*Call graph*: called by 6 (enterprise_layers_precede_user_and_override_system, home_relative_path_fields_are_allowed_and_resolved, layers_are_returned_in_stack_order, raw_toml_diagnostics_use_enterprise_layer_name, relative_absolute_path_fields_resolve_against_base_dir, strict_layers_reject_unknown_config_fields); 1 external calls (test_path_buf).


##### `layers_are_returned_in_stack_order`  (lines 32–59)

```
fn layers_are_returned_in_stack_order()
```

**Purpose**: Verifies that cloud config fragments supplied in backend priority order are returned as layers in lowest-precedence-first stack order.

**Data flow**: Obtains `base_dir()`, calls `cloud_config_layers_from_fragments` with two fragments ordered high then low priority, unwraps the result, extracts each layer’s `name`, and asserts that the resulting order is low then high.

**Call relations**: Exercises the normal conversion path and specifically validates the final `reverse()` in the production implementation.

*Call graph*: calls 1 internal fn (base_dir); 2 external calls (assert_eq!, vec!).


##### `strict_layers_reject_unknown_config_fields`  (lines 62–80)

```
fn strict_layers_reject_unknown_config_fields()
```

**Purpose**: Checks that strict cloud config conversion rejects unknown TOML keys with an `Invalid` error tied to the correct fragment source.

**Data flow**: Builds `base_dir()`, calls `cloud_config_layers_from_fragments_strict` with one fragment containing `unknown_key = true`, expects an error, and asserts exact equality with the expected `CloudConfigLayerError::Invalid` value.

**Call relations**: Targets the strict conversion entrypoint and confirms that unknown-field validation is active there.

*Call graph*: calls 1 internal fn (base_dir); 2 external calls (assert_eq!, vec!).


##### `enterprise_layers_precede_user_and_override_system`  (lines 83–159)

```
fn enterprise_layers_precede_user_and_override_system()
```

**Purpose**: Demonstrates how enterprise-managed cloud layers integrate into a full `ConfigLayerStack` between system and user layers and affect the effective merged config.

**Data flow**: Creates a vector with a system `ConfigLayerEntry`, extends it with cloud layers produced from two fragments, appends a user layer, constructs `ConfigLayerStack::new` with default requirements, then asserts both the final layer ordering and the merged effective config TOML. The expected result keeps the user’s `model`, overrides `model_provider` from the higher-priority cloud layer, and preserves `review_model` from the lower-priority cloud layer.

**Call relations**: This test connects cloud-layer conversion to the broader config stack semantics, proving the returned order is suitable for real stack composition.

*Call graph*: calls 4 internal fn (base_dir, toml, new, new); 5 external calls (default, assert_eq!, test_path_buf, default, vec!).


##### `relative_absolute_path_fields_resolve_against_base_dir`  (lines 162–182)

```
fn relative_absolute_path_fields_resolve_against_base_dir()
```

**Purpose**: Ensures relative path-valued config fields in cloud fragments are rewritten against the managed-config base directory.

**Data flow**: Builds `base_dir()`, converts one fragment containing `model_instructions_file = "instructions.md"`, reads the resolved string from the resulting layer config, computes the expected absolute path with `AbsolutePathBuf::resolve_path_against_base`, and asserts equality.

**Call relations**: Exercises the path-resolution branch inside fragment conversion for ordinary relative paths.

*Call graph*: calls 2 internal fn (base_dir, resolve_path_against_base); 2 external calls (assert_eq!, vec!).


##### `home_relative_path_fields_are_allowed_and_resolved`  (lines 185–205)

```
fn home_relative_path_fields_are_allowed_and_resolved()
```

**Purpose**: Ensures home-relative path-valued config fields are accepted and resolved using the same base-directory helper semantics as production code.

**Data flow**: Builds `base_dir()`, converts one fragment containing `model_instructions_file = "~/instructions.md"`, extracts the resolved path string from the layer config, computes the expected path with `resolve_path_against_base`, and asserts equality.

**Call relations**: Complements the previous path test by covering `~/...` inputs rather than plain relative paths.

*Call graph*: calls 2 internal fn (base_dir, resolve_path_against_base); 2 external calls (assert_eq!, vec!).


##### `raw_toml_diagnostics_use_enterprise_layer_name`  (lines 208–231)

```
async fn raw_toml_diagnostics_use_enterprise_layer_name()
```

**Purpose**: Checks that later raw-TOML validation diagnostics identify enterprise-managed layers by semantic source name instead of a filesystem path.

**Data flow**: Builds `base_dir()`, converts a fragment whose TOML parses structurally but contains a type error (`model = 1`), then calls `first_layer_config_error_from_entries::<ConfigToml>` on the resulting layers. It asserts that the diagnostic path equals `enterprise-managed (Base policy, cfg_123)`, that the reported range points to line 2 column 9, and that the message mentions the invalid integer type.

**Call relations**: Validates the interaction between cloud layer source formatting and downstream config diagnostics, not just the initial fragment conversion.

*Call graph*: calls 1 internal fn (base_dir); 3 external calls (assert!, assert_eq!, vec!).


### `config/src/requirements_layers/stack_tests.rs`

`test` · `test execution`

This file is the behavioral specification for the requirements composition subsystem. It defines a few local helpers—`layer` to build `RequirementsLayerEntry` values with `EnterpriseManaged` sources, `compose` and `compose_with_hook_directory_field` to run the stack and strip source metadata down to plain `ConfigRequirementsToml`, and `expected_requirements` to parse inline TOML fixtures into typed expectations.

The tests cover both generic and custom merge semantics. Several cases verify ordinary TOML precedence and recursive table merging for top-level scalars, feature maps, MCP server maps, network maps, and Windows-specific settings. Others focus on source tracking, asserting that scalar winners keep the highest-priority source while merged tables produce `RequirementSource::composite` in priority order. Remote sandbox tests confirm that `remote_sandbox_config` is evaluated per layer, unmatched selectors do not shadow lower layers, and hostname resolution is lazy and cached across multiple matching layers.

The custom domain mergers are tested directly: rules are appended in priority order; hooks append event groups while rejecting conflicting active managed directories but tolerating conflicts on the inactive platform field; and `permissions.filesystem.deny_read` is unioned without disturbing profile-table precedence or leaving empty permissions tables behind. There is also a parse-error test ensuring diagnostics include the offending layer's human-readable source. Together these tests document the intended composition contract more concretely than comments alone.

#### Function details

##### `layer`  (lines 17–25)

```
fn layer(id: &str, name: &str, contents: &str) -> RequirementsLayerEntry
```

**Purpose**: Creates a `RequirementsLayerEntry` with an `EnterpriseManaged` source for concise test setup. It standardizes how test layers are labeled and sourced.

**Data flow**: Takes `id`, `name`, and TOML `contents`, constructs `RequirementSource::EnterpriseManaged { id, name }`, passes it with the contents to `RequirementsLayerEntry::from_toml`, and returns the entry.

**Call relations**: Used throughout this test module to build layer fixtures before calling the composition helpers.

*Call graph*: calls 1 internal fn (from_toml).


##### `compose`  (lines 27–34)

```
fn compose(
    layers: Vec<RequirementsLayerEntry>,
) -> Result<Option<ConfigRequirementsToml>, RequirementsCompositionError>
```

**Purpose**: Runs composition for a vector of layers with no hostname and returns plain `ConfigRequirementsToml` instead of sourced output. It is the common helper for tests that only care about merged values.

**Data flow**: Accepts `Vec<RequirementsLayerEntry>`, calls `compose_requirements_for_hostname(layers, None)?`, maps any resulting `ConfigRequirementsWithSources` through `into_toml`, wraps the result in `Ok`, and propagates composition errors.

**Call relations**: Called by many tests covering ordinary merge behavior, rule ordering, deny-read unioning, and parse errors.

*Call graph*: called by 10 (deny_read_only_layers_do_not_leave_empty_permissions_tables, empty_layers_compose_to_none, mcp_requirements_use_regular_toml_merge, network_maps_use_regular_toml_merge, parse_error_names_layer, permissions_deny_read_unions_while_profiles_use_regular_toml_merge, regular_toml_merge_recurses_into_tables, rules_are_appended_in_priority_order, top_level_values_use_toml_priority, windows_requirements_use_regular_toml_merge); 1 external calls (compose_requirements_for_hostname).


##### `compose_with_hook_directory_field`  (lines 36–46)

```
fn compose_with_hook_directory_field(
    layers: Vec<RequirementsLayerEntry>,
    hook_directory_field: HookDirectoryField,
) -> Result<Option<ConfigRequirementsToml>, RequirementsCompositionError>
```

**Purpose**: Runs composition with an explicit active hook directory field and no hostname. It lets tests simulate Windows and non-Windows hook conflict behavior deterministically.

**Data flow**: Takes layers and a `HookDirectoryField`, calls `compose_requirements_for_hostname_and_hook_directory(layers, None, hook_directory_field)?`, maps any output through `into_toml`, and returns the result.

**Call relations**: Used by hook-specific tests that need to force either `managed_dir` or `windows_managed_dir` to be the active singleton.

*Call graph*: called by 3 (active_windows_managed_dir_conflicts_fail_closed, hooks_append_groups_and_reject_conflicting_managed_dirs, inactive_hook_dir_conflicts_do_not_fail_composition); 1 external calls (compose_requirements_for_hostname_and_hook_directory).


##### `expected_requirements`  (lines 48–50)

```
fn expected_requirements(contents: impl AsRef<str>) -> ConfigRequirementsToml
```

**Purpose**: Parses inline TOML snippets into `ConfigRequirementsToml` values for assertions. It keeps expected outputs readable in test bodies.

**Data flow**: Accepts any `contents` implementing `AsRef<str>`, borrows the string, parses it with `toml::from_str`, and panics with a fixed message if the fixture is invalid.

**Call relations**: Used by most tests to express expected merged requirements as TOML literals.

*Call graph*: 2 external calls (as_ref, from_str).


##### `empty_layers_compose_to_none`  (lines 53–56)

```
fn empty_layers_compose_to_none()
```

**Purpose**: Verifies that composing zero layers yields `None` rather than an empty requirements object.

**Data flow**: Calls `compose(Vec::new())`, unwraps success, and asserts the result equals `None`.

**Call relations**: Exercises the empty-stack path in `RequirementsLayerStack::compose`.

*Call graph*: calls 1 internal fn (compose); 2 external calls (new, assert_eq!).


##### `top_level_values_use_toml_priority`  (lines 59–109)

```
fn top_level_values_use_toml_priority()
```

**Purpose**: Checks that ordinary top-level scalar/list/table fields follow standard TOML precedence: higher-priority layers override scalars and merge tables recursively.

**Data flow**: Builds low and high layers with overlapping approval, sandbox, default permission, remote-control, and permission-profile fields; composes them; unwraps the result; and compares it to an expected TOML fixture.

**Call relations**: Validates the regular TOML merge path used before special domain mergers run.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `composition_strategy_applies_to_non_cloud_layers`  (lines 112–218)

```
fn composition_strategy_applies_to_non_cloud_layers()
```

**Purpose**: Confirms that the same composition rules apply to non-enterprise sources such as MDM preferences and system requirements files, including source attribution and custom field merging.

**Data flow**: Constructs `RequirementSource::MdmManagedPreferences` and `RequirementSource::SystemRequirementsToml`, builds two layers with regular fields, rules, and deny-read entries, composes them for no hostname, asserts the merged TOML shape, and separately asserts sourced fields retain the expected source metadata.

**Call relations**: Exercises end-to-end composition with heterogeneous source types and verifies both value merging and provenance.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, cfg!, compose_requirements_for_hostname, vec!).


##### `single_regular_layer_keeps_enterprise_managed_source`  (lines 221–245)

```
fn single_regular_layer_keeps_enterprise_managed_source()
```

**Purpose**: Ensures that when only one layer contributes a regular field, the resulting sourced output preserves that exact enterprise-managed source.

**Data flow**: Composes a single layer containing `allow_managed_hooks_only = true`, unwraps the sourced output, and asserts the field equals `Some(Sourced::new(true, EnterpriseManaged { ... }))`.

**Call relations**: Targets source propagation in `populate_merged_regular_fields_with_sources` for the simplest case.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `regular_toml_merge_recurses_into_tables`  (lines 248–307)

```
fn regular_toml_merge_recurses_into_tables()
```

**Purpose**: Verifies recursive table merging for nested structures such as `[features]` and `[apps.*.tools.*]`. Higher-priority values override only the overlapping leaves.

**Data flow**: Builds low and high layers with overlapping nested tables, composes them, and compares the result to an expected TOML fixture showing merged and overridden entries.

**Call relations**: Exercises `merge_toml_values` behavior as used by `RequirementsLayerStack::compose`.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `merged_table_source_is_composite_in_priority_order`  (lines 310–350)

```
fn merged_table_source_is_composite_in_priority_order()
```

**Purpose**: Checks that when a table field is assembled from multiple layers, its source becomes a composite ordered by priority rather than just the winning layer.

**Data flow**: Creates low and high enterprise-managed layers contributing different `[features]` keys, composes them, extracts `feature_requirements`, and asserts it equals a `Sourced` value with a `RequirementSource::composite([high, low])` source.

**Call relations**: Specifically validates `source_for_top_level_keys` for merged table values.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `mcp_requirements_use_regular_toml_merge`  (lines 353–390)

```
fn mcp_requirements_use_regular_toml_merge()
```

**Purpose**: Confirms that `[mcp_servers]` follows ordinary TOML merge semantics rather than any custom requirements-layer behavior.

**Data flow**: Composes low and high layers with overlapping and distinct MCP server entries, then asserts the merged TOML keeps distinct entries and lets the high-priority layer override the shared one.

**Call relations**: Documents that MCP server configuration stays in the regular merge path.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `network_maps_use_regular_toml_merge`  (lines 393–447)

```
fn network_maps_use_regular_toml_merge()
```

**Purpose**: Verifies that experimental network domain and Unix-socket maps merge like ordinary TOML tables, with higher-priority entries overriding matching keys.

**Data flow**: Builds two layers with overlapping and distinct `experimental_network.domains` and `experimental_network.unix_sockets` entries, composes them, and compares against the expected merged map contents.

**Call relations**: Covers another regular-table field to ensure no unintended special handling.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `windows_requirements_use_regular_toml_merge`  (lines 450–481)

```
fn windows_requirements_use_regular_toml_merge()
```

**Purpose**: Checks that the `[windows]` requirements section uses standard precedence, with the higher-priority layer replacing overlapping scalar/list values.

**Data flow**: Composes low and high layers that both set `windows.allowed_sandbox_implementations`, then asserts the result contains only the high-priority value.

**Call relations**: Documents that Windows-specific requirements are not part of any custom merger.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `remote_sandbox_config_is_applied_per_layer`  (lines 484–518)

```
fn remote_sandbox_config_is_applied_per_layer()
```

**Purpose**: Ensures that `remote_sandbox_config` is evaluated within each layer before merging, so a matching selector can override lower-layer sandbox modes.

**Data flow**: Composes a low layer with direct `allowed_sandbox_modes` and a high layer with a matching `remote_sandbox_config`, supplying a hostname that matches case-insensitively with trailing dot normalization, then asserts the final TOML contains the selected high-layer sandbox modes.

**Call relations**: Exercises `ComposableRequirementsLayer::from_entry` and `materialize_remote_sandbox_config` through the public composition API.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `unmatched_remote_sandbox_config_does_not_shadow_lower_layers`  (lines 521–555)

```
fn unmatched_remote_sandbox_config_does_not_shadow_lower_layers()
```

**Purpose**: Verifies that a non-matching `remote_sandbox_config` contributes nothing and therefore does not erase lower-layer sandbox settings.

**Data flow**: Composes a low layer with direct sandbox modes and a high layer whose hostname pattern does not match the supplied hostname, then asserts the low-layer value survives unchanged.

**Call relations**: Tests the negative branch of per-layer remote sandbox evaluation.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `hostname_resolver_is_not_called_without_remote_sandbox_config`  (lines 558–586)

```
fn hostname_resolver_is_not_called_without_remote_sandbox_config()
```

**Purpose**: Confirms that hostname resolution is lazy and skipped entirely when no layer contains `remote_sandbox_config`.

**Data flow**: Creates a `Cell<usize>` counter, composes a layer without remote sandbox selectors using `compose_requirements_with_hostname_resolver` and a closure that increments the counter, then asserts the counter remains zero and the merged TOML is correct.

**Call relations**: Validates the lazy `OnceCell`-backed hostname resolver path in the composition driver.

*Call graph*: 4 external calls (default, assert_eq!, compose_requirements_with_hostname_resolver, vec!).


##### `hostname_resolver_is_called_once_for_multiple_remote_sandbox_layers`  (lines 589–630)

```
fn hostname_resolver_is_called_once_for_multiple_remote_sandbox_layers()
```

**Purpose**: Checks that when multiple layers need hostname-based sandbox evaluation, the resolver is invoked only once and its result is reused.

**Data flow**: Uses a `Cell<usize>` counter and two layers with matching `remote_sandbox_config`, composes them through `compose_requirements_with_hostname_resolver`, then asserts the counter is exactly one and the higher-priority selected sandbox modes win.

**Call relations**: Exercises the cached hostname resolver closure created in `compose_requirements_with_hostname_resolver_and_hook_directory`.

*Call graph*: 4 external calls (default, assert_eq!, compose_requirements_with_hostname_resolver, vec!).


##### `rules_are_appended_in_priority_order`  (lines 633–671)

```
fn rules_are_appended_in_priority_order()
```

**Purpose**: Verifies the custom rule merger appends `rules.prefix_rules` rather than overwriting them, with higher-priority rules appearing first.

**Data flow**: Builds low and high layers each containing one prefix rule, composes them, and asserts the resulting TOML lists the high-layer rule before the low-layer rule.

**Call relations**: Tests the behavior of `requirements_layers::rules::merge` as orchestrated by the stack.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `hooks_append_groups_and_reject_conflicting_managed_dirs`  (lines 674–762)

```
fn hooks_append_groups_and_reject_conflicting_managed_dirs()
```

**Purpose**: Checks both sides of hook merging: event groups append in priority order when managed directories agree, and conflicting active `managed_dir` values produce a fail-closed error.

**Data flow**: First composes two layers with the same `hooks.managed_dir` and distinct `PreToolUse` hooks using `compose_with_hook_directory_field(..., ManagedDir)`, then asserts the merged TOML contains both hook groups in high-to-low order. Next it composes two layers with different active `managed_dir` values, expects an error, and asserts the error string mentions the field and both sources.

**Call relations**: Exercises `HookMergeState::merge`, `append_hook_events`, and active-directory conflict reporting.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 3 external calls (assert!, assert_eq!, vec!).


##### `active_windows_managed_dir_conflicts_fail_closed`  (lines 765–792)

```
fn active_windows_managed_dir_conflicts_fail_closed()
```

**Purpose**: Verifies that when `windows_managed_dir` is the active hook directory field, conflicting values also fail composition closed.

**Data flow**: Calls `compose_with_hook_directory_field` with two layers that set different `hooks.windows_managed_dir` values and `HookDirectoryField::WindowsManagedDir`, expects an error, and asserts the message names the field and both contributing layers.

**Call relations**: Targets the Windows-active branch of `HookMergeState::merge_active_singleton`.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 2 external calls (assert!, vec!).


##### `inactive_hook_dir_conflicts_do_not_fail_composition`  (lines 795–925)

```
fn inactive_hook_dir_conflicts_do_not_fail_composition()
```

**Purpose**: Ensures that conflicts on the inactive platform's managed hook directory are tolerated and first-fill semantics apply, while hook events still append normally.

**Data flow**: Runs two scenarios with `compose_with_hook_directory_field`: one where `managed_dir` is active and `windows_managed_dir` conflicts, and one where `windows_managed_dir` is active and `managed_dir` conflicts. In each case it unwraps success and asserts the merged TOML keeps the active directory consistent, preserves one inactive value, and appends hook groups in priority order.

**Call relations**: Exercises `HookDirectoryField::inactive` and `HookMergeState::fill_singleton` behavior under both platform choices.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 2 external calls (assert_eq!, vec!).


##### `permissions_deny_read_unions_while_profiles_use_regular_toml_merge`  (lines 928–984)

```
fn permissions_deny_read_unions_while_profiles_use_regular_toml_merge()
```

**Purpose**: Checks that `permissions.filesystem.deny_read` is unioned additively while permission profile tables still follow ordinary TOML precedence.

**Data flow**: Builds low and high layers with overlapping deny-read paths and overlapping `permissions.managed-standard` profile content, composes them, and asserts the final TOML contains the unioned deny-read list plus the high-priority profile description merged with the low-priority `extends` field.

**Call relations**: Exercises the interaction between `DenyReadMergeState` and the regular TOML merge path for the rest of `[permissions]`.

*Call graph*: calls 1 internal fn (compose); 3 external calls (assert_eq!, cfg!, vec!).


##### `deny_read_only_layers_do_not_leave_empty_permissions_tables`  (lines 987–1015)

```
fn deny_read_only_layers_do_not_leave_empty_permissions_tables()
```

**Purpose**: Verifies that a layer contributing only `permissions.filesystem.deny_read` produces a clean permissions structure without stray empty tables.

**Data flow**: Composes a single layer containing only a deny-read path and asserts the resulting TOML contains exactly `[permissions.filesystem] deny_read = [...]`.

**Call relations**: Covers the path where `strip_special_fields` removes deny-read from regular TOML and `DenyReadMergeState::apply_to` reconstructs the minimal permissions output.

*Call graph*: calls 1 internal fn (compose); 3 external calls (assert_eq!, cfg!, vec!).


##### `parse_error_names_layer`  (lines 1018–1028)

```
fn parse_error_names_layer()
```

**Purpose**: Ensures parse failures identify the offending layer source in the error message. This makes invalid requirements easier to diagnose in layered setups.

**Data flow**: Composes a single malformed layer where `allowed_approval_policies` has the wrong type, expects an error, and asserts the rendered message contains both the layer name/id and the problematic field name.

**Call relations**: Exercises parse-error propagation from `parse_layer_requirements`/`parse_layer_toml` through the public composition helper.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert!, vec!).


### Config parsing and editing semantics
This group covers the core config data model, strict parsing, merge behavior, specialized sections like hooks and MCP, and the persistence/editing paths that round-trip configuration back to TOML.

### `config/src/types_tests.rs`

`test` · `test`

This test file covers two narrow but important areas of config behavior. The first pair of tests validates `SkillConfig` deserialization for the two supported selector styles: by `name` and by absolute `path`. The path-based test creates a temporary directory, constructs an absolute `SKILL.md` path under it, deserializes TOML containing that path, and compares the result against a `SkillConfig` built with `AbsolutePathBuf::from_absolute_path`, ensuring path normalization and selector exclusivity behave as expected.

The second pair of tests targets `MemoriesConfig::from(MemoriesToml)`, specifically its range-clamping logic. One test confirms that count-like settings which must never be zero (`max_raw_memories_for_consolidation` and `max_rollouts_per_startup`) are clamped up to `1` when TOML provides `0`. The other verifies that `min_rate_limit_remaining_percent` is clamped into the inclusive `0..=100` range, both for an overly large value (`101`) and a negative value (`-1`).

Together these tests pin down behavior that would otherwise be easy to regress because it sits in conversion code rather than in plain data definitions: selector parsing for skills and defensive normalization of user-provided numeric config.

#### Function details

##### `deserialize_skill_config_with_name_selector`  (lines 5–17)

```
fn deserialize_skill_config_with_name_selector()
```

**Purpose**: Verifies that a skill config using the `name` selector deserializes correctly and leaves the `path` selector unset.

**Data flow**: Parses a TOML snippet into `SkillConfig` → asserts `cfg.name` is `Some("github:yeet")`, `cfg.path` is `None`, and `cfg.enabled` is `false`.

**Call relations**: Standalone unit test for one accepted `SkillConfig` input shape.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_skill_config_with_path_selector`  (lines 20–43)

```
fn deserialize_skill_config_with_path_selector()
```

**Purpose**: Verifies that a skill config using an absolute filesystem path deserializes into the expected `AbsolutePathBuf`-backed selector.

**Data flow**: Creates a temporary directory, builds an absolute `skills/demo/SKILL.md` path, formats TOML containing that path, parses it into `SkillConfig`, then asserts equality with a manually constructed `SkillConfig` whose `path` is `Some(AbsolutePathBuf::from_absolute_path(&skill_path))`, `name` is `None`, and `enabled` is `false`.

**Call relations**: Companion to the name-selector test, covering the alternate accepted selector form.

*Call graph*: 4 external calls (assert_eq!, format!, tempdir, from_str).


##### `memories_config_clamps_count_limits_to_nonzero_values`  (lines 46–61)

```
fn memories_config_clamps_count_limits_to_nonzero_values()
```

**Purpose**: Checks that zero values for count-based memories settings are clamped up to the minimum allowed nonzero values.

**Data flow**: Constructs `MemoriesToml` with `max_raw_memories_for_consolidation: Some(0)` and `max_rollouts_per_startup: Some(0)` → converts it with `MemoriesConfig::from` → asserts the result equals a config with those fields set to `1` and all other fields inherited from `MemoriesConfig::default()`.

**Call relations**: Directly exercises the clamping logic in `MemoriesConfig::from`.

*Call graph*: calls 1 internal fn (from); 2 external calls (default, assert_eq!).


##### `memories_config_clamps_rate_limit_remaining_threshold`  (lines 64–88)

```
fn memories_config_clamps_rate_limit_remaining_threshold()
```

**Purpose**: Verifies that the memories rate-limit threshold is clamped both at the upper and lower bounds of its allowed range.

**Data flow**: First converts `MemoriesToml { min_rate_limit_remaining_percent: Some(101), .. }` and asserts the resulting config has `100`; then converts `MemoriesToml { min_rate_limit_remaining_percent: Some(-1), .. }` and asserts the resulting config has `0`, with all other fields matching `MemoriesConfig::default()`.

**Call relations**: Another focused unit test of `MemoriesConfig::from`, covering both sides of the numeric clamp.

*Call graph*: calls 1 internal fn (from); 2 external calls (default, assert_eq!).


### `config/src/merge_tests.rs`

`test` · `test run`

This test file validates the path-sensitive normalization built into `merge_toml_values`. A small helper, `parse_toml`, turns inline TOML snippets into `toml::Value` so each test can focus on merge semantics rather than parsing boilerplate. The first two tests prove that the legacy memories key `no_memories_if_mcp_or_web_search` is normalized to the canonical `disable_on_external_context` whether it appears in the base layer or the overlay layer, and that the merged result still deserializes into the expected `ConfigToml`/`MemoriesToml` structure.

Another test checks conflict resolution when one layer contains both the canonical and legacy names at once: the canonical key wins and only one normalized key remains after merging. The final test covers the special-case path logic for `permissions.<profile>.network.domains`, showing that host keys are normalized before overlaying so `EXAMPLE.COM` in the overlay replaces `example.com` in the base instead of creating a duplicate entry. Together these tests document that merging is not a naive table overlay; it performs semantic normalization before deciding whether keys collide.

#### Function details

##### `parse_toml`  (lines 6–8)

```
fn parse_toml(value: &str) -> TomlValue
```

**Purpose**: Parses a TOML string into a generic `toml::Value` for use in merge tests.

**Data flow**: Takes a `&str`, calls `toml::from_str`, panics with a fixed message if parsing fails, and returns the parsed `TomlValue`.

**Call relations**: All tests in this file use it to build base, overlay, and expected TOML values before invoking `merge_toml_values`.

*Call graph*: called by 4 (merge_toml_values_normalizes_legacy_key_from_base_layer, merge_toml_values_normalizes_legacy_key_from_overlay_layer, merge_toml_values_normalizes_permission_network_domains_before_overlaying, merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names); 1 external calls (from_str).


##### `merge_toml_values_normalizes_legacy_key_from_base_layer`  (lines 11–43)

```
fn merge_toml_values_normalizes_legacy_key_from_base_layer()
```

**Purpose**: Verifies that a legacy memories key in the base layer is normalized and then overridden by the canonical key from the overlay.

**Data flow**: Builds base and overlay TOML values with `parse_toml`, merges overlay into base, compares the merged TOML to an expected canonical form, then deserializes the merged value into `ConfigToml` and asserts the resulting `MemoriesToml` field.

**Call relations**: This test exercises `merge_toml_values` normalization on the base side and confirms the merged output remains deserializable into the typed config model.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


##### `merge_toml_values_normalizes_legacy_key_from_overlay_layer`  (lines 46–78)

```
fn merge_toml_values_normalizes_legacy_key_from_overlay_layer()
```

**Purpose**: Verifies that a legacy memories key in the overlay layer is normalized before it overrides the canonical key in the base layer.

**Data flow**: Parses canonical base TOML and legacy-key overlay TOML, merges them, asserts the merged TOML contains only the canonical key with the overlay value, then deserializes into `ConfigToml` and checks the typed memories field.

**Call relations**: It complements the previous test by proving alias normalization is applied symmetrically to overlay data before merge decisions are made.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


##### `merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names`  (lines 81–100)

```
fn merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names()
```

**Purpose**: Checks that when a single layer contains both canonical and legacy names for the same setting, the canonical key survives normalization.

**Data flow**: Creates an empty table as the base, parses an overlay containing both memories key spellings, merges it, and asserts the result contains only the canonical key/value pair.

**Call relations**: This test targets the alias-resolution policy inside `normalize_key_aliases` as exercised through `merge_toml_values`.

*Call graph*: calls 1 internal fn (parse_toml); 3 external calls (Table, assert_eq!, new).


##### `merge_toml_values_normalizes_permission_network_domains_before_overlaying`  (lines 103–126)

```
fn merge_toml_values_normalizes_permission_network_domains_before_overlaying()
```

**Purpose**: Verifies that permission network-domain keys are host-normalized before overlaying so differently cased hostnames collide.

**Data flow**: Parses base and overlay TOML values under `[permissions.dev.network.domains]` with differently cased host keys, merges them, and asserts the final TOML contains one normalized lowercase key with the overlay permission.

**Call relations**: It exercises the path-specific branch in `merge_toml_values_at_path` that calls `normalize_network_domain_keys` for permission domain tables.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


### `config/src/strict_config_tests.rs`

`test` · `test`

This test module exercises the strict-validation logic from `strict_config.rs` against concrete TOML snippets and exact `ConfigError` values. `ignored_toml_field_errors_accept_non_file_source_names` proves that diagnostics can be anchored to arbitrary display names rather than filesystem paths, which matters for synthetic sources such as base64-encoded managed config. `type_errors_take_precedence_over_ignored_fields` checks the core control-flow rule that a deserialization type mismatch is reported before any unknown-key complaint, preserving the most actionable error.

Two tests cover the custom feature-key scan: one for top-level `[features]` and one for `[profiles.work.features]`. Both assert exact source ranges and message text, confirming that unknown feature keys are treated as unknown configuration fields even if serde itself would otherwise accept the enclosing map shape. Finally, `strict_config_accepts_opaque_desktop_keys` verifies an intentional escape hatch: the desktop subtree may contain arbitrary nested keys without triggering strict unknown-field errors. Together these tests pin down the module's most important edge cases: non-file sources, error precedence, feature-key strictness, and selective schema opacity.

#### Function details

##### `ignored_toml_field_errors_accept_non_file_source_names`  (lines 9–37)

```
fn ignored_toml_field_errors_accept_non_file_source_names()
```

**Purpose**: Verifies that strict unknown-field diagnostics can use a display-name source instead of a real file path. It checks both the source path buffer and the highlighted range/message.

**Data flow**: Builds a TOML string with an unknown key, parses it into `TomlValue`, calls `config_error_from_ignored_toml_value_fields_for_source_name::<ConfigToml>`, unwraps the resulting error, and asserts equality with an explicitly constructed `ConfigError` using `PathBuf::from(source_name)`.

**Call relations**: This test targets the display-name wrapper path in strict validation rather than the file-path entry point.

*Call graph*: 1 external calls (assert_eq!).


##### `type_errors_take_precedence_over_ignored_fields`  (lines 40–66)

```
fn type_errors_take_precedence_over_ignored_fields()
```

**Purpose**: Checks that a type mismatch is reported instead of an unknown-field error when both are present. It locks in the validator's error-priority rule.

**Data flow**: Creates a path and TOML contents containing both an invalid string for `model_context_window` and an `unknown_key`, calls `config_error_from_ignored_toml_fields::<ConfigToml>`, unwraps the error, and asserts exact equality with the expected type-error `ConfigError`.

**Call relations**: This test exercises the error branch in the core validator where `serde_path_to_error` returns a deserialization failure before ignored-field reporting is considered.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_rejects_unknown_feature_key`  (lines 69–89)

```
fn strict_config_rejects_unknown_feature_key()
```

**Purpose**: Verifies that an unrecognized top-level feature flag is rejected as an unknown configuration field. It confirms the custom feature-key scan supplements serde's normal behavior.

**Data flow**: Builds TOML with `[features] foo = true`, calls `config_error_from_ignored_toml_fields::<ConfigToml>`, unwraps the error, and compares it to the expected `ConfigError` pointing at the `foo` key.

**Call relations**: This test specifically covers the top-level branch of `unknown_feature_toml_value_path`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_rejects_unknown_profile_feature_key`  (lines 92–112)

```
fn strict_config_rejects_unknown_profile_feature_key()
```

**Purpose**: Verifies that an unrecognized feature key inside a named profile is also rejected. It ensures profile-scoped feature tables receive the same strict treatment as top-level features.

**Data flow**: Builds TOML with `[profiles.work.features] foo = true`, calls `config_error_from_ignored_toml_fields::<ConfigToml>`, unwraps the error, and asserts equality with the expected profile-qualified unknown-field diagnostic.

**Call relations**: This test covers the profile iteration branch in `unknown_feature_toml_value_path`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_accepts_opaque_desktop_keys`  (lines 115–127)

```
fn strict_config_accepts_opaque_desktop_keys()
```

**Purpose**: Checks that arbitrary keys under the desktop subtree do not trigger strict unknown-field errors. It documents an intentional schema exception.

**Data flow**: Builds TOML containing `desktop.appearanceTheme` and `desktop.workspace.collapsed`, calls `config_error_from_ignored_toml_fields::<ConfigToml>`, and asserts that the result is `None`.

**Call relations**: This test validates that the target config type treats desktop fields opaquely enough for the strict validator to accept them.

*Call graph*: 2 external calls (new, assert_eq!).


### `config/src/hooks_tests.rs`

`test` · `test`

This test file validates that the hook schema in `hook_config.rs` accepts the intended legacy and current formats. The first two tests focus on `HooksFile`, confirming that the old JSON shape with a top-level `hooks` object still deserializes and that root-level event arrays outside that object are rejected because `HooksFile` uses `deny_unknown_fields`. Several TOML tests then verify the arrays-of-tables representation for `HookEventsToml`, including nested `[[PreToolUse.hooks]]` command handlers with timeout and status message fields.

The file also checks the richer `HooksToml` shape, where flattened event definitions coexist with a `[state."..."]` map storing per-hook enablement and trusted hashes. Managed enterprise hooks are covered through `ManagedHooksRequirementsToml`, ensuring that `managed_dir` plus flattened event tables deserialize into the expected structure. Finally, two tests verify that command handlers accept both `command_windows` and camelCase `commandWindows` aliases and normalize both into the same `command_windows` field.

Together these tests pin down the exact serde behavior of the hook schema, especially compatibility-sensitive field names and nesting rules that would be easy to break during refactors.

#### Function details

##### `hooks_file_deserializes_existing_json_shape`  (lines 13–53)

```
fn hooks_file_deserializes_existing_json_shape()
```

**Purpose**: Verifies that the legacy JSON `HooksFile` shape with a nested `hooks` object still deserializes into the current hook event model.

**Data flow**: Parses a JSON string into `HooksFile` and asserts the resulting nested `HookEventsToml` and `HookHandlerConfig::Command` structure.

**Call relations**: Covers backward compatibility for existing `hooks.json`-style inputs.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hooks_file_rejects_events_outside_hooks_object`  (lines 56–77)

```
fn hooks_file_rejects_events_outside_hooks_object()
```

**Purpose**: Ensures root-level hook event arrays are rejected for `HooksFile` instead of being silently accepted.

**Data flow**: Attempts to parse invalid JSON into `HooksFile`, captures the error, and asserts the message mentions the unexpected `SessionStart` field.

**Call relations**: Protects the legacy wrapper shape enforced by `HooksFile`.

*Call graph*: 1 external calls (assert!).


##### `hook_events_deserialize_from_toml_arrays_of_tables`  (lines 80–111)

```
fn hook_events_deserialize_from_toml_arrays_of_tables()
```

**Purpose**: Checks that `HookEventsToml` deserializes from the TOML arrays-of-tables syntax used for event groups and handlers.

**Data flow**: Parses TOML into `HookEventsToml` and asserts the resulting matcher group and command handler fields.

**Call relations**: Covers the primary TOML representation for hook events.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hooks_toml_deserializes_inline_events_and_state_map`  (lines 114–156)

```
fn hooks_toml_deserializes_inline_events_and_state_map()
```

**Purpose**: Verifies that `HooksToml` can deserialize flattened event definitions alongside the `state` map used for per-hook metadata.

**Data flow**: Parses TOML into `HooksToml` and asserts both the `events` structure and the `state` `BTreeMap` contents.

**Call relations**: Covers the combined user-config hook shape rather than just raw event tables.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `managed_hooks_requirements_flatten_hook_events`  (lines 159–194)

```
fn managed_hooks_requirements_flatten_hook_events()
```

**Purpose**: Checks that `ManagedHooksRequirementsToml` accepts `managed_dir` plus flattened hook event tables.

**Data flow**: Parses TOML into `ManagedHooksRequirementsToml` and asserts the managed directory and nested hook event structure.

**Call relations**: Covers the managed-requirements hook schema used by enterprise/system requirements.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hook_events_deserialize_windows_override_from_toml`  (lines 197–229)

```
fn hook_events_deserialize_windows_override_from_toml()
```

**Purpose**: Verifies that command handlers accept the snake_case `command_windows` field in TOML.

**Data flow**: Parses TOML into `HookEventsToml` and asserts the resulting command handler contains the expected Windows override string.

**Call relations**: Covers one of the accepted aliases for platform-specific command overrides.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hook_events_deserialize_camel_case_windows_override_from_toml`  (lines 232–264)

```
fn hook_events_deserialize_camel_case_windows_override_from_toml()
```

**Purpose**: Verifies that command handlers also accept the camelCase `commandWindows` alias in TOML.

**Data flow**: Parses TOML into `HookEventsToml` and asserts the normalized `command_windows` field matches the expected value.

**Call relations**: Complements the snake_case test to lock in alias compatibility.

*Call graph*: 2 external calls (assert_eq!, from_str).


### `config/src/mcp_types_tests.rs`

`test` · `test run`

This test file is the executable specification for `mcp_types.rs`. Each test feeds TOML snippets through `toml::from_str::<McpServerConfig>` and asserts the exact `McpServerTransportConfig` and option fields produced, or the exact class of error expected. The coverage is broad: stdio transport with command, args, env, env-var lists, sourced env-vars, cwd, enabled/required flags, tool filters, parallel tool-call support, and per-tool approval overrides; streamable HTTP transport with bearer-token env vars, static and env-backed headers, OAuth resource, and OAuth client ID; and round-trip serialization for approval mode and timeout-bearing configs.

Several tests focus on invariants enforced by `TryFrom<RawMcpServerConfig>` rather than serde shape alone. They verify that remote stdio requires an absolute `cwd`, that unsupported env-var sources are rejected, that command+url is invalid, that HTTP-only fields are rejected on stdio and vice versa, and that the deprecated inline `bearer_token` field is refused. One notable compatibility test confirms unknown server fields are ignored rather than causing failure, while still producing the canonical `McpServerConfig` defaults. Together these tests document both accepted syntax and the exact normalization/defaulting behavior expected from config loading.

#### Function details

##### `deserialize_stdio_command_server_config`  (lines 7–29)

```
fn deserialize_stdio_command_server_config()
```

**Purpose**: Verifies that the minimal stdio MCP config with only `command` deserializes into a `Stdio` transport with empty/default optional fields.

**Data flow**: Parses a TOML snippet containing `command = "echo"`; inspects the resulting `McpServerConfig`; asserts exact transport contents plus default `enabled`, `required`, and absent tool filters.

**Call relations**: This test directly exercises serde deserialization through `McpServerConfig::deserialize` and the stdio branch of `McpServerConfig::try_from`.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_args`  (lines 32–52)

```
fn deserialize_stdio_command_server_config_with_args()
```

**Purpose**: Checks that stdio `args` are preserved in order and that omitted optional fields still default correctly.

**Data flow**: Parses TOML with `command` and `args`; compares the resulting transport against a `Stdio` config containing the expected argument vector; asserts `enabled` remains true.

**Call relations**: It covers the stdio transport path where `args.unwrap_or_default()` is used during raw-to-validated conversion.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_remote_stdio_server_requires_absolute_cwd`  (lines 55–82)

```
fn deserialize_remote_stdio_server_requires_absolute_cwd()
```

**Purpose**: Confirms that remote stdio servers fail deserialization when `cwd` is missing or relative.

**Data flow**: Attempts to parse two invalid TOML snippets with `environment_id = "remote"`; captures the resulting errors; asserts their text mentions the absolute-cwd requirement and, for the relative case, includes the provided path.

**Call relations**: This test targets the `validate_remote_stdio_cwd` check reached from `McpServerConfig::try_from`.

*Call graph*: 1 external calls (assert!).


##### `deserialize_remote_stdio_server_accepts_absolute_cwd`  (lines 85–108)

```
fn deserialize_remote_stdio_server_accepts_absolute_cwd()
```

**Purpose**: Verifies that a remote stdio server with an absolute working directory is accepted.

**Data flow**: Builds TOML dynamically using `std::env::temp_dir()` as an absolute path; parses it into `McpServerConfig`; panics on unexpected failure; asserts the resulting `Stdio` transport stores that `cwd`.

**Call relations**: It exercises the success branch of `validate_remote_stdio_cwd` after transport selection in `McpServerConfig::try_from`.

*Call graph*: 5 external calls (assert_eq!, format!, panic!, temp_dir, from_str).


##### `deserialize_stdio_command_server_config_with_arg_with_args_and_env`  (lines 111–132)

```
fn deserialize_stdio_command_server_config_with_arg_with_args_and_env()
```

**Purpose**: Checks that stdio configs can include both argument lists and explicit environment-variable mappings.

**Data flow**: Parses TOML with `command`, `args`, and an inline `env` table; asserts the resulting transport contains the expected `HashMap` and argument vector; confirms `enabled` defaults to true.

**Call relations**: This covers the stdio conversion path where `env` is retained and no transport-specific validation rejects it.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_env_vars`  (lines 135–154)

```
fn deserialize_stdio_command_server_config_with_env_vars()
```

**Purpose**: Verifies legacy string-form `env_vars` entries deserialize into `McpServerEnvVar::Name` values.

**Data flow**: Parses TOML with `env_vars = ["FOO", "BAR"]`; asserts the resulting `Stdio` transport contains a vector of converted env-var enum values.

**Call relations**: It exercises serde's untagged enum handling for `McpServerEnvVar` and the stdio branch's defaulting of other fields.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_env_var_sources`  (lines 157–190)

```
fn deserialize_stdio_command_server_config_with_env_var_sources()
```

**Purpose**: Checks that mixed legacy and structured env-var declarations deserialize correctly, including explicit `local` and `remote` sources.

**Data flow**: Parses TOML containing both plain strings and `{ name, source }` objects in `env_vars`; asserts the exact enum variants and source strings stored in the resulting transport.

**Call relations**: This test covers both serde decoding of the untagged env-var enum and the acceptance path of `McpServerEnvVar::validate_source`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_rejects_unknown_env_var_source`  (lines 193–207)

```
fn deserialize_stdio_command_server_config_rejects_unknown_env_var_source()
```

**Purpose**: Ensures unsupported env-var source labels are rejected with a targeted error.

**Data flow**: Parses invalid TOML with `source = "elsewhere"`; expects an error; asserts the error text contains the unsupported-source message.

**Call relations**: It specifically validates the failure path of `McpServerEnvVar::validate_source` as invoked from `McpServerConfig::try_from`.

*Call graph*: 1 external calls (assert!).


##### `deserialize_stdio_command_server_config_with_cwd`  (lines 210–229)

```
fn deserialize_stdio_command_server_config_with_cwd()
```

**Purpose**: Verifies that local stdio configs may specify a working directory and that it is stored as a `PathBuf`.

**Data flow**: Parses TOML with `command` and `cwd = "/tmp"`; asserts the resulting `Stdio` transport contains `Some(PathBuf::from("/tmp"))`.

**Call relations**: This covers the stdio transport path without triggering remote-environment absolute-path enforcement.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_disabled_server_config`  (lines 232–243)

```
fn deserialize_disabled_server_config()
```

**Purpose**: Checks that `enabled = false` is preserved and does not implicitly mark the server as required.

**Data flow**: Parses TOML with `command` and `enabled = false`; asserts `cfg.enabled` is false and `cfg.required` remains false.

**Call relations**: It validates boolean defaulting and override behavior in `McpServerConfig::try_from`.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_required_server_config`  (lines 246–256)

```
fn deserialize_required_server_config()
```

**Purpose**: Checks that `required = true` is preserved during deserialization.

**Data flow**: Parses TOML with `command` and `required = true`; asserts the resulting config has `required` set.

**Call relations**: This covers another shared-field mapping in `McpServerConfig::try_from`.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_streamable_http_server_config`  (lines 259–277)

```
fn deserialize_streamable_http_server_config()
```

**Purpose**: Verifies that a minimal HTTP MCP config with only `url` becomes a `StreamableHttp` transport with no optional auth/header fields.

**Data flow**: Parses TOML containing `url`; asserts the exact transport variant and that `enabled` defaults to true.

**Call relations**: It exercises the HTTP branch of `McpServerConfig::try_from`.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_env_var`  (lines 280–299)

```
fn deserialize_streamable_http_server_config_with_env_var()
```

**Purpose**: Checks that HTTP bearer-token environment variable configuration is preserved.

**Data flow**: Parses TOML with `url` and `bearer_token_env_var`; asserts the resulting `StreamableHttp` transport stores that env-var name and leaves headers unset.

**Call relations**: This covers an HTTP-only field accepted by the streamable transport branch.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_headers`  (lines 302–324)

```
fn deserialize_streamable_http_server_config_with_headers()
```

**Purpose**: Verifies both static HTTP headers and env-backed HTTP headers deserialize into the transport config.

**Data flow**: Parses TOML with `http_headers` and `env_http_headers`; asserts the resulting transport contains the expected `HashMap`s.

**Call relations**: It exercises HTTP transport field retention and confirms these fields are not rejected on the HTTP branch.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_oauth_resource`  (lines 327–340)

```
fn deserialize_streamable_http_server_config_with_oauth_resource()
```

**Purpose**: Checks that the optional OAuth resource parameter is accepted for HTTP servers.

**Data flow**: Parses TOML with `url` and `oauth_resource`; asserts `cfg.oauth_resource` equals the expected string.

**Call relations**: This covers a shared field that is transport-restricted by `McpServerConfig::try_from` and valid only on the HTTP path.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_oauth_client_id`  (lines 343–360)

```
fn deserialize_streamable_http_server_config_with_oauth_client_id()
```

**Purpose**: Verifies nested OAuth client settings deserialize correctly for HTTP servers.

**Data flow**: Parses TOML with a nested `[oauth]` table containing `client_id`; asserts `cfg.oauth` equals the expected `McpServerOAuthConfig`.

**Call relations**: It exercises nested serde deserialization plus the HTTP branch's acceptance of the `oauth` field.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_server_config_with_tool_filters`  (lines 363–375)

```
fn deserialize_server_config_with_tool_filters()
```

**Purpose**: Checks that explicit enabled and disabled tool lists are preserved.

**Data flow**: Parses TOML with `enabled_tools` and `disabled_tools`; asserts both vectors are present with the expected contents.

**Call relations**: This covers shared server-level filtering fields populated by `McpServerConfig::try_from`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_server_config_with_parallel_tool_calls`  (lines 378–388)

```
fn deserialize_server_config_with_parallel_tool_calls()
```

**Purpose**: Verifies the server-level parallel-tool-call capability flag is parsed.

**Data flow**: Parses TOML with `supports_parallel_tool_calls = true`; asserts the resulting boolean field is true.

**Call relations**: It tests one of the shared booleans copied directly from raw config into `McpServerConfig`.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_server_config_with_default_tool_approval_mode`  (lines 391–420)

```
fn deserialize_server_config_with_default_tool_approval_mode()
```

**Purpose**: Checks both server-wide default tool approval mode and per-tool overrides, then verifies TOML serialization round-trips them.

**Data flow**: Parses TOML with `default_tools_approval_mode` and a `[tools.search]` table; asserts the enum values stored in `cfg`; serializes back to TOML; checks the serialized text contains the approval mode; reparses and asserts equality with the original config.

**Call relations**: This test spans both deserialization and serialization paths, including serde handling of nested `tools` maps and enum string forms.

*Call graph*: 4 external calls (assert!, assert_eq!, from_str, to_string).


##### `serialize_round_trips_server_config_with_parallel_tool_calls`  (lines 423–439)

```
fn serialize_round_trips_server_config_with_parallel_tool_calls()
```

**Purpose**: Verifies that a config containing `supports_parallel_tool_calls` and a floating-point tool timeout serializes and deserializes without loss.

**Data flow**: Parses TOML into `McpServerConfig`; serializes it back to TOML; asserts the serialized text contains the parallel-call flag; reparses and compares the round-tripped config to the original.

**Call relations**: It exercises the custom duration serde helper and confirms shared fields survive a full serde round trip.

*Call graph*: 4 external calls (assert!, assert_eq!, from_str, to_string).


##### `deserialize_ignores_unknown_server_fields`  (lines 442–477)

```
fn deserialize_ignores_unknown_server_fields()
```

**Purpose**: Documents that unknown MCP server fields are ignored rather than rejected, while all canonical defaults still apply.

**Data flow**: Parses TOML containing an extra `trust_level` field; asserts the resulting `McpServerConfig` equals a fully spelled-out expected value with default transport options, default environment ID, false booleans, and empty maps/options.

**Call relations**: This test captures compatibility behavior of the deserialization layer and the exact defaults produced after parsing.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_rejects_command_and_url`  (lines 480–488)

```
fn deserialize_rejects_command_and_url()
```

**Purpose**: Ensures configs specifying both stdio and HTTP transport selectors are rejected.

**Data flow**: Attempts to parse TOML containing both `command` and `url`; expects deserialization to fail.

**Call relations**: It targets the transport-selection logic in `McpServerConfig::try_from`, where stdio rejects `url` as unsupported.


##### `deserialize_rejects_env_for_http_transport`  (lines 491–499)

```
fn deserialize_rejects_env_for_http_transport()
```

**Purpose**: Ensures stdio-only environment mappings are rejected on HTTP transports.

**Data flow**: Attempts to parse TOML with `url` plus `env`; expects deserialization to fail.

**Call relations**: This covers one of the HTTP-branch `throw_if_set` validations in `McpServerConfig::try_from`.


##### `deserialize_rejects_headers_for_stdio`  (lines 502–545)

```
fn deserialize_rejects_headers_for_stdio()
```

**Purpose**: Checks that HTTP-only fields such as headers, OAuth config, and OAuth resource are rejected on stdio transports with clear messages.

**Data flow**: Attempts several invalid stdio parses using `http_headers`, `env_http_headers`, `oauth`, and `oauth_resource`; expects errors for each; for OAuth-related cases, asserts the error text names the unsupported field and transport.

**Call relations**: It exercises multiple stdio-branch validation failures in `McpServerConfig::try_from`.

*Call graph*: 1 external calls (assert!).


##### `deserialize_rejects_inline_bearer_token_field`  (lines 548–561)

```
fn deserialize_rejects_inline_bearer_token_field()
```

**Purpose**: Ensures the deprecated inline secret-bearing `bearer_token` field is rejected rather than accepted into config.

**Data flow**: Attempts to parse HTTP TOML containing `bearer_token = "secret"`; expects an error; asserts the message mentions that `bearer_token` is not supported.

**Call relations**: This targets the explicit rejection path for a field accepted only so deserialization can emit a focused validation error.

*Call graph*: 1 external calls (assert!).


### `config/src/mcp_edit_tests.rs`

`test` · `test`

This test module exercises the MCP config editing code against real temporary directories under the system temp folder. Each test creates a unique `codex_home` path using the current process ID plus a nanosecond timestamp to avoid collisions, constructs a `BTreeMap<String, McpServerConfig>`, writes it through `ConfigEditsBuilder`, inspects the exact serialized TOML text, reloads it with `load_global_mcp_servers`, and finally removes the temporary directory.

The first test covers a stdio MCP server with `supports_parallel_tool_calls`, a default tools approval mode, and two per-tool approval overrides. The expected TOML asserts that the writer emits a `[mcp_servers.<name>.tools]` table and nested tool subtables sorted by tool name (`read` before `search`), with approval modes rendered as strings. The second test covers an HTTP MCP server with OAuth metadata and verifies that the writer emits a nested `[mcp_servers.<name>.oauth]` table containing only `client_id`.

These tests are important because the writer is selective and order-sensitive: it omits empty/default fields, sorts nested maps for stable output, and must remain compatible with the typed loader. By asserting both exact text and successful round-trip parsing, the tests pin down formatting and semantics simultaneously.

#### Function details

##### `replace_mcp_servers_serializes_per_tool_approval_overrides`  (lines 10–86)

```
async fn replace_mcp_servers_serializes_per_tool_approval_overrides() -> anyhow::Result<()>
```

**Purpose**: Verifies that MCP server persistence writes per-tool approval overrides into nested TOML tables with stable ordering, and that the resulting file round-trips through the loader. It covers the stdio transport plus tool-level approval metadata.

**Data flow**: The test computes a unique temp directory path, constructs a `BTreeMap` containing one `McpServerConfig` with stdio transport, default approval mode, and two tool configs, then calls `ConfigEditsBuilder::new(&codex_home).replace_mcp_servers(&servers).apply().await`. It reads the written `config.toml`, asserts exact string equality against the expected TOML, reloads the config with `load_global_mcp_servers`, asserts equality with the original map, removes the temp directory, and returns `Ok(())`.

**Call relations**: This test exercises the full write/read round trip through `ConfigEditsBuilder`, `serialize_mcp_server`, and `load_global_mcp_servers`. It specifically validates the nested `tools` serialization branch.

*Call graph*: calls 1 internal fn (new); 9 external calls (from, from, now, new, assert_eq!, format!, temp_dir, read_to_string, remove_dir_all).


##### `replace_mcp_servers_serializes_oauth_client_id`  (lines 89–146)

```
async fn replace_mcp_servers_serializes_oauth_client_id() -> anyhow::Result<()>
```

**Purpose**: Verifies that an MCP server with OAuth metadata serializes a nested `[oauth]` table containing `client_id`, and that the file round-trips through the loader. It covers the HTTP transport plus optional OAuth output.

**Data flow**: The test creates a unique temp directory, builds a `BTreeMap` with one `McpServerConfig` using `StreamableHttp` transport and `oauth: Some(McpServerOAuthConfig { client_id: Some(...) })`, writes it via `ConfigEditsBuilder`, reads back `config.toml`, asserts exact TOML text, reloads with `load_global_mcp_servers`, asserts equality with the original map, removes the temp directory, and returns `Ok(())`.

**Call relations**: This test drives the `serialize_mcp_server` OAuth branch and confirms compatibility with `load_global_mcp_servers` after persistence.

*Call graph*: calls 1 internal fn (new); 8 external calls (from, new, now, assert_eq!, format!, temp_dir, read_to_string, remove_dir_all).


### `config/src/state_tests.rs`

`test` · `test`

This test module validates several subtle invariants from `state.rs`. The helper `test_user_config_path` builds absolute fixture paths inside a temporary directory so user-layer sources look like real config files. `origins_use_canonical_key_aliases` constructs a session-flags layer containing the legacy `memories.no_memories_if_mcp_or_web_search` key, then verifies that `ConfigLayerStack::origins()` records provenance under the canonical alias `memories.disable_on_external_context` and does not retain the legacy path. That test proves origin tracking runs after key normalization, not before.

The remaining tests focus on multiple user layers. `active_user_layer_is_highest_precedence_user_layer` creates a base user config and a profile-specific overlay, then checks that the active writable file is the profile file while the effective merged user config still inherits fields from the base layer. `with_user_config_updates_matching_user_layer_without_replacing_active_profile` then updates only the base file through `with_user_config`, confirming that the stack replaces the matching base layer by file path, preserves the profile layer as the active user layer, and still merges both layers correctly. Together these tests guard against regressions where profile overlays might be overwritten or where origin metadata might expose deprecated key names.

#### Function details

##### `test_user_config_path`  (lines 5–8)

```
fn test_user_config_path(temp_dir: &TempDir, file_name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute user-config fixture path inside a temporary directory. It keeps the tests concise while ensuring the path type matches production expectations.

**Data flow**: Takes a `TempDir` reference and a file name, joins the file name onto `temp_dir.path()`, converts the result with `AbsolutePathBuf::from_absolute_path`, and panics if the path is not absolute. It returns the resulting `AbsolutePathBuf`.

**Call relations**: Used by the user-layer precedence tests to create realistic `ConfigLayerSource::User` file paths without duplicating path-construction code.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (active_user_layer_is_highest_precedence_user_layer, with_user_config_updates_matching_user_layer_without_replacing_active_profile); 1 external calls (path).


##### `origins_use_canonical_key_aliases`  (lines 11–40)

```
fn origins_use_canonical_key_aliases()
```

**Purpose**: Verifies that origin tracking records canonical config keys rather than legacy aliases. It specifically checks the memories alias normalization path.

**Data flow**: Parses a TOML snippet containing the legacy memories key into a session-flags `ConfigLayerEntry`, builds a one-layer `ConfigLayerStack`, computes `origins()`, and asserts that the canonical key maps to the layer metadata while the legacy key is absent.

**Call relations**: This test drives `ConfigLayerEntry::new`, `ConfigLayerStack::new`, and `ConfigLayerStack::origins()` together to validate the normalization-before-origin-recording flow.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert!, assert_eq!, default, from_str, vec!).


##### `active_user_layer_is_highest_precedence_user_layer`  (lines 43–91)

```
fn active_user_layer_is_highest_precedence_user_layer()
```

**Purpose**: Checks that when both base and profile user layers exist, the profile layer is treated as the active writable user layer. It also confirms that effective user config merges base values underneath profile overrides.

**Data flow**: Creates temp-file paths for base and profile configs, builds corresponding `ConfigLayerEntry::new` user layers from TOML snippets, constructs a stack, then asserts that `get_user_config_file()` returns the profile file and that `effective_user_config()` yields `model` from the profile layer and `approval_policy` inherited from the base layer.

**Call relations**: This test exercises stack construction, active-user-layer selection, and user-only merge behavior in one scenario with multiple user layers.

*Call graph*: calls 3 internal fn (new, new, test_user_config_path); 6 external calls (new, default, assert_eq!, default, from_str, vec!).


##### `with_user_config_updates_matching_user_layer_without_replacing_active_profile`  (lines 94–141)

```
fn with_user_config_updates_matching_user_layer_without_replacing_active_profile()
```

**Purpose**: Verifies that updating the base user config by file path replaces only that matching layer and does not dislodge the active profile layer. It protects the profile-aware edit path.

**Data flow**: Builds a stack with separate base and profile user layers, calls `with_user_config(&base_file, updated_base_toml)`, and asserts that the resulting stack still reports the profile file as active while `effective_user_config()` contains the updated base `model` plus the profile `approval_policy`.

**Call relations**: This test specifically targets the `with_user_config`/`with_user_config_profile` update flow and its file-based replacement logic.

*Call graph*: calls 3 internal fn (new, new, test_user_config_path); 6 external calls (new, default, assert_eq!, default, from_str, vec!).


### `config/src/loader/tests.rs`

`test` · `test`

This test module lives beside the loader and exercises `load_config_layers_state` against real temporary files. To avoid depending on the production filesystem abstraction, it defines `TestFileSystem`, a deliberately minimal `ExecutorFileSystem` implementation. Only `canonicalize` and `read_file` are implemented using the host filesystem; streaming reads and all write/metadata/directory operations are left as `unimplemented!` because these tests only need to read user config files and do not traverse project directories.

The three async tests all create a temporary Codex home, write a base `config.toml`, write a selected `work.config.toml`, and configure `LoaderOverrides` so `user_config_path` points at the selected file and `user_config_profile` is `work`. Two tests assert that loading fails with `io::ErrorKind::InvalidData` when the base user config still contains either `[profiles.work]` or `profile = "work"`; they also inspect the error message for the exact migration guidance and documentation URL. The third test confirms that unrelated legacy profiles such as `[profiles.dev]` do not block profile-v2 loading. Together these tests pin down a subtle migration invariant in the loader: only matching legacy profile declarations are forbidden.

#### Function details

##### `TestFileSystem::canonicalize`  (lines 17–27)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Implements filesystem canonicalization for tests by converting a `PathUri` to an absolute path, canonicalizing it on disk, and converting it back. It supports any loader code path that needs canonical path resolution.

**Data flow**: Input is a `&PathUri`. The async body converts it with `to_abs_path()`, calls the standard library `canonicalize()` on the resulting path, wraps the canonicalized path back into `PathUri::from_abs_path`, and returns it in the boxed future.

**Call relations**: This method is part of the `ExecutorFileSystem` test double and may be used by loader code under test if canonicalization is needed. It does not delegate to other test helpers.

*Call graph*: calls 2 internal fn (from_abs_path, to_abs_path); 2 external calls (pin, canonicalize).


##### `TestFileSystem::read_file`  (lines 29–38)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Implements async file reads for tests using `tokio::fs::read`. It is the main capability needed by `load_config_layers_state` in these scenarios.

**Data flow**: Input is a `&PathUri`. The future converts it to an absolute path with `to_abs_path()`, then reads the file bytes from disk with `tokio::fs::read(path.as_path())`, returning the resulting `Vec<u8>` or I/O error.

**Call relations**: This method is used indirectly by loader code through the `ExecutorFileSystem` trait. The tests rely on it so the loader can read the temporary config files they create.

*Call graph*: calls 1 internal fn (to_abs_path); 3 external calls (pin, read, as_path).


##### `TestFileSystem::read_file_stream`  (lines 40–51)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Explicitly rejects streaming reads in the test filesystem. It documents that these tests only support whole-file reads.

**Data flow**: It ignores its inputs and returns a boxed future that immediately yields `Err(io::Error::new(io::ErrorKind::Unsupported, "test filesystem does not support streaming reads"))`.

**Call relations**: This trait method is present only to satisfy `ExecutorFileSystem`. None of the tests in this file expect it to be called.

*Call graph*: 2 external calls (pin, new).


##### `TestFileSystem::write_file`  (lines 53–60)

```
fn write_file(
        &'a self,
        _path: &'a PathUri,
        _contents: Vec<u8>,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Marks write support as unavailable in the test filesystem. Any accidental use would fail loudly.

**Data flow**: It ignores all inputs and returns a boxed future whose body calls `unimplemented!("test filesystem only supports reads")`.

**Call relations**: This is a defensive stub for the trait implementation; the tests write files directly with `std::fs::write` instead of through the abstraction.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::create_directory`  (lines 62–69)

```
fn create_directory(
        &'a self,
        _path: &'a PathUri,
        _create_directory_options: CreateDirectoryOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorF
```

**Purpose**: Marks directory creation as unsupported in the test filesystem. It prevents silent misuse of the test double.

**Data flow**: It ignores its arguments and returns a boxed future that panics via `unimplemented!("test filesystem only supports reads")`.

**Call relations**: This method exists only to complete the trait implementation and is not expected in the tested loader paths.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::get_metadata`  (lines 71–77)

```
fn get_metadata(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Leaves metadata lookup unimplemented because these profile-v2 tests do not load project layers or otherwise need metadata. It keeps the test double minimal.

**Data flow**: It ignores inputs and returns a boxed future that panics with `unimplemented!("test filesystem only supports reads")`.

**Call relations**: Because the tests pass `cwd: None`, `load_config_layers_state` avoids project-layer traversal and therefore should not invoke this method.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::read_directory`  (lines 79–85)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Leaves directory listing unsupported in the test filesystem. It is another intentional stub for unused trait surface area.

**Data flow**: It ignores inputs and returns a boxed future that panics via `unimplemented!`.

**Call relations**: This method is not part of the exercised code path in these tests.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::remove`  (lines 87–94)

```
fn remove(
        &'a self,
        _path: &'a PathUri,
        _remove_options: RemoveOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Marks file removal as unsupported in the test filesystem. The tests do not need mutation through the abstraction.

**Data flow**: It ignores inputs and returns a boxed future that panics with `unimplemented!`.

**Call relations**: This is unused in the profile-v2 loader tests and exists only for trait completeness.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::copy`  (lines 96–104)

```
fn copy(
        &'a self,
        _source_path: &'a PathUri,
        _destination_path: &'a PathUri,
        _copy_options: CopyOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    )
```

**Purpose**: Marks file copying as unsupported in the test filesystem. It prevents accidental reliance on unneeded behavior.

**Data flow**: It ignores all arguments and returns a boxed future that panics via `unimplemented!`.

**Call relations**: This trait method is not exercised by the tests in this file.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `profile_v2_rejects_matching_legacy_profile_in_base_user_config`  (lines 108–165)

```
async fn profile_v2_rejects_matching_legacy_profile_in_base_user_config()
```

**Purpose**: Verifies that selecting profile-v2 `work` fails when the base user config still contains a matching legacy `[profiles.work]` table. It checks both the error kind and the migration guidance text.

**Data flow**: The test creates a temp Codex home, writes a base `config.toml` containing `[profiles.work]`, writes `work.config.toml`, configures `LoaderOverrides` with that selected file and profile name, calls `load_config_layers_state(...).await`, expects an error, then asserts `InvalidData` and checks the message for the profile name, `config.toml`, `[profiles.work]`, and the docs URL.

**Call relations**: This test drives `load_config_layers_state` through the user/profile loading branch and specifically exercises the conflict check performed after loading the base user layer.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `profile_v2_rejects_matching_legacy_profile_selector_in_base_user_config`  (lines 168–219)

```
async fn profile_v2_rejects_matching_legacy_profile_selector_in_base_user_config()
```

**Purpose**: Verifies that selecting profile-v2 `work` also fails when the base user config contains the legacy top-level selector `profile = "work"`. It covers the alternate legacy conflict form.

**Data flow**: The test creates temp files, writes a base `config.toml` with `profile = "work"`, writes `work.config.toml`, sets matching overrides, calls `load_config_layers_state`, expects an `InvalidData` error, and asserts that the message mentions the profile selector text and the selected profile file.

**Call relations**: Like the previous test, this one exercises the profile-v2 conflict detection inside `load_config_layers_state`, but through the legacy selector branch instead of the legacy profiles table branch.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `profile_v2_allows_unrelated_legacy_profiles_in_base_user_config`  (lines 222–256)

```
async fn profile_v2_allows_unrelated_legacy_profiles_in_base_user_config()
```

**Purpose**: Confirms that profile-v2 selection is allowed when the base user config contains only unrelated legacy profiles. It ensures the loader rejects only matching conflicts, not all legacy profile usage.

**Data flow**: The test writes a base `config.toml` containing `[profiles.dev]`, writes `work.config.toml`, sets overrides selecting profile `work`, calls `load_config_layers_state(...).await`, and asserts success.

**Call relations**: This test complements the two rejection cases by proving that `load_config_layers_state` compares the selected profile name specifically rather than banning any legacy profile table.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 2 external calls (write, tempdir).


### `core/src/config/edit_tests.rs`

`test` · `test execution`

This file is a dense test suite for the config editing layer exposed by the parent module. Every test creates an isolated temporary Codex home directory, applies one or more edits through either `apply_blocking(...)` or `ConfigEditsBuilder`, then inspects the resulting `config.toml` as raw text or parsed `toml::Value`. The assertions are intentionally exact: many tests compare full file contents to ensure stable serialization, table placement, quoting, and preservation of comments.

The suite covers root-level scalar edits (`model`, `model_reasoning_effort`, `service_tier`), nested path writes and clears, TUI-specific settings such as session picker mode and keybindings, skill configuration array entries, notice/migration bookkeeping tables, realtime audio/voice settings, and full replacement of `mcp_servers`. Several tests seed existing TOML to prove edits are scoped to root settings and do not mutate legacy active-profile data under `profiles.*`. Others verify no-op behavior when clearing a missing path, and that batch updates preserve inline comments around unrelated tables.

A notable cluster exercises symlink handling on Unix: writes should follow a valid symlink chain to the real target, but if the chain is cyclic the implementation must replace the symlink with a regular file instead of looping. The MCP server tests are especially concrete, checking serialization of transport variants, durations, env/header maps, OAuth blocks, tool approval overrides, inline-table updates, and removal of the entire table when replacing with an empty map.

#### Function details

##### `blocking_set_model_top_level`  (lines 17–35)

```
fn blocking_set_model_top_level()
```

**Purpose**: Verifies that a blocking `SetModel` edit writes root-level `model` and `model_reasoning_effort` keys with the expected TOML spelling.

**Data flow**: Creates a temporary config directory, passes a single `ConfigEdit::SetModel { model: Some("gpt-5.4"), effort: Some(ReasoningEffort::High) }` into `apply_blocking`, then reads `CONFIG_TOML_FILE` back as a string and compares it to the exact expected text.

**Call relations**: This is a standalone test entry invoked by the test runner. It exercises the blocking edit application path and does not parse TOML; instead it validates the final serializer output byte-for-byte.

*Call graph*: 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_saves_default_as_default`  (lines 38–49)

```
fn set_service_tier_saves_default_as_default()
```

**Purpose**: Checks that the builder persists the protocol default request value as the literal TOML string `default`.

**Data flow**: Builds edits with `ConfigEditsBuilder::new(codex_home).set_service_tier(Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string()))`, applies them synchronously, reads the config file, and asserts the file contains only `service_tier = "default"`.

**Call relations**: Called by the test harness to cover the builder convenience API for service tier normalization. It specifically validates the mapping from request-layer default constant to persisted config text.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_saves_priority_as_fast`  (lines 52–63)

```
fn set_service_tier_saves_priority_as_fast()
```

**Purpose**: Confirms that a known `ServiceTier::Fast` request value is serialized as `fast` in config.

**Data flow**: Constructs a builder, feeds it `ServiceTier::Fast.request_value().to_string()`, applies the edit, reads the resulting file, and compares the exact one-line TOML output.

**Call relations**: This test complements the default-tier case by covering a recognized non-default enum value through the builder path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_preserves_unknown_service_tier`  (lines 66–77)

```
fn set_service_tier_preserves_unknown_service_tier()
```

**Purpose**: Ensures unknown service tier identifiers are not normalized away and are written back verbatim.

**Data flow**: Uses the builder to set `service_tier` to `experimental-tier-id`, persists it, reads the config file, and asserts the raw TOML contains that exact string value.

**Call relations**: Invoked independently by the test runner to prove the edit layer preserves forward-compatible or experimental tier strings instead of rejecting or remapping them.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `builder_with_edits_applies_custom_paths`  (lines 80–94)

```
fn builder_with_edits_applies_custom_paths()
```

**Purpose**: Tests that arbitrary `ConfigEdit::SetPath` edits supplied directly to the builder are applied correctly.

**Data flow**: Creates a builder, injects a vector containing `SetPath { segments: ["enabled"], value: true }`, applies it, then reads the config file and checks for `enabled = true`.

**Call relations**: This test covers the generic `with_edits` path rather than a typed builder helper, proving the builder can forward raw edit objects unchanged.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, vec!).


##### `session_picker_view_edit_writes_root_tui_setting`  (lines 97–111)

```
fn session_picker_view_edit_writes_root_tui_setting()
```

**Purpose**: Verifies that the helper producing a session picker view edit writes into the root `[tui]` table.

**Data flow**: Builds a single edit via `session_picker_view_edit(SessionPickerViewMode::Dense)`, applies it through the builder, reads the file, and asserts the TOML contains a `[tui]` table with `session_picker_view = "dense"`.

**Call relations**: Run by the test harness to validate a specialized edit-construction helper and its placement in the config hierarchy.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_binding_edit_writes_root_action_binding`  (lines 114–128)

```
fn keymap_binding_edit_writes_root_action_binding()
```

**Purpose**: Checks that a single keybinding helper writes the expected nested root keymap table and action binding.

**Data flow**: Creates one edit with `keymap_binding_edit("composer", "submit", "ctrl-enter")`, applies it, reads the config file, and compares the exact nested TOML table text.

**Call relations**: This test exercises the helper for one binding and confirms it targets root `tui.keymap.*` rather than any profile-specific subtree.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_bindings_edit_writes_single_binding_as_string`  (lines 131–149)

```
fn keymap_bindings_edit_writes_single_binding_as_string()
```

**Purpose**: Ensures the plural bindings helper collapses a one-element binding list to a TOML string instead of an array.

**Data flow**: Supplies `&["ctrl-enter".to_string()]` to `keymap_bindings_edit`, applies the edit, reads the file, and asserts the serialized value is `submit = "ctrl-enter"`.

**Call relations**: This test covers serialization shape selection for the helper when only one binding is present.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_bindings_edit_writes_multiple_bindings_as_array`  (lines 152–183)

```
fn keymap_bindings_edit_writes_multiple_bindings_as_array()
```

**Purpose**: Ensures multiple keybindings are serialized as a TOML array and remain parseable at the expected nested path.

**Data flow**: Builds an edit with two bindings, applies it, reads the raw file, parses it into `TomlValue`, walks through `tui -> keymap -> composer -> submit`, converts the array elements to strings, and asserts they equal `["enter", "ctrl-enter"]`.

**Call relations**: Unlike the single-binding tests, this one validates semantic structure by parsing TOML, covering the branch where the helper emits an array.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `keymap_binding_edit_replaces_existing_binding_without_touching_profile`  (lines 186–230)

```
fn keymap_binding_edit_replaces_existing_binding_without_touching_profile()
```

**Purpose**: Proves that updating a root keybinding replaces only the root binding and leaves profile-specific overrides intact.

**Data flow**: Seeds `config.toml` with both a root `tui.keymap.composer.submit` and a `profiles.team.tui.keymap.composer.submit`, applies a root-level binding edit, parses the resulting TOML, and separately asserts the root value changed to `ctrl-enter` while the profile value remains `shift-enter`.

**Call relations**: This regression test is invoked directly by the test runner to guard against accidental traversal into the active profile subtree during root edits.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `keymap_binding_clear_edit_removes_root_action_binding_without_touching_profile`  (lines 233–276)

```
fn keymap_binding_clear_edit_removes_root_action_binding_without_touching_profile()
```

**Purpose**: Checks that clearing a root keybinding deletes only the root action entry and preserves the profile override.

**Data flow**: Writes a config containing both root and profile `submit` bindings, applies `keymap_binding_clear_edit("composer", "submit")`, parses the file, and asserts the root `submit` key is absent while the profile `submit` string is still present.

**Call relations**: This test complements the replacement case by covering deletion semantics and ensuring clear operations are equally scoped to the root tree.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `set_model_availability_nux_count_writes_shown_count`  (lines 279–294)

```
fn set_model_availability_nux_count_writes_shown_count()
```

**Purpose**: Verifies that model-availability NUX counters are written under the expected nested TUI table.

**Data flow**: Creates a `HashMap` with one model/count pair, passes it to `ConfigEditsBuilder::set_model_availability_nux_count`, applies the edit, reads the file, and compares the exact `[tui.model_availability_nux]` TOML output.

**Call relations**: Run by the test harness to validate a builder helper that serializes map data into a nested table.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `set_skill_config_writes_disabled_entry`  (lines 297–315)

```
fn set_skill_config_writes_disabled_entry()
```

**Purpose**: Checks that disabling a skill by path creates a `[[skills.config]]` array-of-tables entry with `path` and `enabled = false`.

**Data flow**: Builds a `ConfigEdit::SetSkillConfig` using a concrete `PathBuf`, applies it through the builder, reads the config file, and asserts the exact array-table serialization.

**Call relations**: This test covers one branch of skill config persistence: explicit disabled entries are materialized in config.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `set_skill_config_removes_entry_when_enabled`  (lines 318–340)

```
fn set_skill_config_removes_entry_when_enabled()
```

**Purpose**: Ensures re-enabling a previously disabled skill removes its explicit config entry entirely.

**Data flow**: Seeds a config file containing one `[[skills.config]]` entry for a path with `enabled = false`, applies `SetSkillConfig { enabled: true }`, then reads the file and asserts it is empty.

**Call relations**: This regression test validates the inverse branch of skill config editing: default-enabled state is represented by absence, not `enabled = true`.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, read_to_string, write, tempdir).


##### `set_skill_config_writes_name_selector_entry`  (lines 343–361)

```
fn set_skill_config_writes_name_selector_entry()
```

**Purpose**: Verifies that disabling a skill by logical name, rather than path, writes a selector entry with `name` and `enabled = false`.

**Data flow**: Creates a `ConfigEdit::SetSkillConfigByName` for `github:yeet`, applies it, reads the file, and compares the exact `[[skills.config]]` TOML text.

**Call relations**: This test complements path-based skill config coverage by exercising the name-selector variant.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_set_model_ignores_inline_legacy_profile_contents`  (lines 364–412)

```
fn blocking_set_model_ignores_inline_legacy_profile_contents()
```

**Purpose**: Confirms that setting the root model does not rewrite or reinterpret legacy inline-table profile contents.

**Data flow**: Seeds a config with `profile = "fast"` and an inline `profiles = { fast = { model = ..., sandbox_mode = ... } }`, applies a root `SetModel`, reads and parses the file, then asserts the new root `model` exists while the inline `profiles.fast.model` and `sandbox_mode` values remain unchanged.

**Call relations**: This test is a targeted regression for legacy config compatibility, ensuring root edits do not follow the active profile pointer into inline profile tables.

*Call graph*: 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `blocking_set_model_writes_through_symlink_chain`  (lines 416–444)

```
fn blocking_set_model_writes_through_symlink_chain()
```

**Purpose**: On Unix, verifies that config writes follow a valid symlink chain and update the ultimate target file without replacing the top-level symlink.

**Data flow**: Creates a target file path in another temp directory, creates `config-link.toml` as a symlink to that target and `config.toml` as a symlink to `config-link.toml`, applies a `SetModel` edit, checks via `symlink_metadata` that `config.toml` is still a symlink, then reads the target file and asserts the expected TOML content.

**Call relations**: This Unix-only test exercises filesystem edge handling in the blocking writer, specifically the branch that resolves symlink chains safely.

*Call graph*: 6 external calls (assert!, assert_eq!, read_to_string, symlink_metadata, symlink, tempdir).


##### `blocking_set_model_replaces_symlink_on_cycle`  (lines 448–475)

```
fn blocking_set_model_replaces_symlink_on_cycle()
```

**Purpose**: On Unix, verifies that a cyclic symlink chain is broken by replacing the config symlink with a regular file containing the new config.

**Data flow**: Creates `a.toml -> b.toml`, `b.toml -> a.toml`, and `config.toml -> a.toml`, applies a root `SetModel`, checks that `config.toml` is no longer a symlink, then reads it as a regular file and asserts it contains only the new model line.

**Call relations**: This test covers the failure-handling branch of symlink resolution, ensuring the writer avoids infinite loops and still persists config.

*Call graph*: 6 external calls (assert!, assert_eq!, read_to_string, symlink_metadata, symlink, tempdir).


##### `batch_write_table_upsert_preserves_inline_comments`  (lines 478–535)

```
fn batch_write_table_upsert_preserves_inline_comments()
```

**Purpose**: Checks that applying multiple nested path updates rewrites only targeted values while preserving surrounding comments and unrelated table structure.

**Data flow**: Seeds a config containing comments in `[mcp_servers.linear]` and `[sandbox_workspace_write]`, applies two `SetPath` edits to change `url` and `network_access`, reads the updated file, and compares the entire TOML text including preserved comment lines and spacing.

**Call relations**: This test exercises batched blocking edits and validates the comment-preserving table-upsert logic rather than just semantic TOML equivalence.

*Call graph*: 5 external calls (assert_eq!, read_to_string, write, tempdir, vec!).


##### `blocking_clear_model_does_not_follow_legacy_active_profile`  (lines 538–567)

```
fn blocking_clear_model_does_not_follow_legacy_active_profile()
```

**Purpose**: Ensures clearing the root model while setting reasoning effort does not remove model data from a legacy active profile.

**Data flow**: Seeds a config with `profile = "fast"` and inline `profiles.fast.model`, applies `SetModel { model: None, effort: Some(High) }`, reads the file as text, and asserts the profile block is untouched while only `model_reasoning_effort = "high"` is added at root.

**Call relations**: This regression test covers the partial-update branch of `SetModel`, where one field is cleared and another is set, while guarding against profile-following behavior.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_model_does_not_follow_legacy_active_profile`  (lines 570–601)

```
fn blocking_set_model_does_not_follow_legacy_active_profile()
```

**Purpose**: Verifies that setting root model and effort does not overwrite similarly named fields inside the active profile table.

**Data flow**: Seeds a config with `profile = "team"` and `[profiles.team] model_reasoning_effort = "low"`, applies a root `SetModel` with `o5-preview` and `minimal`, reads the file, and asserts the new root keys are inserted before the profile table while the profile's `model_reasoning_effort` remains `low`.

**Call relations**: This test complements the previous legacy-profile cases by covering table-style profiles instead of inline tables.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_full_access_warning_preserves_table`  (lines 604–633)

```
fn blocking_set_hide_full_access_warning_preserves_table()
```

**Purpose**: Checks that adding `notice.hide_full_access_warning` appends to an existing `[notice]` table without disturbing comments or existing keys.

**Data flow**: Seeds a config with a global comment and a `[notice]` table containing a comment and `existing = "value"`, applies `ConfigEdit::SetNoticeHideFullAccessWarning(true)`, reads the file, and compares the exact expected TOML including preserved comments.

**Call relations**: This test validates one notice-setting edit and the general invariant that table augmentation preserves existing formatting context.

*Call graph*: 5 external calls (SetNoticeHideFullAccessWarning, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_rate_limit_model_nudge_preserves_table`  (lines 636–659)

```
fn blocking_set_hide_rate_limit_model_nudge_preserves_table()
```

**Purpose**: Verifies that `hide_rate_limit_model_nudge` is inserted into an existing `[notice]` table without rewriting unrelated entries.

**Data flow**: Writes a minimal `[notice]` table with `existing = "value"`, applies `SetNoticeHideRateLimitModelNudge(true)`, reads the file, and asserts the resulting TOML contains both keys in the same table.

**Call relations**: This is another focused notice-table regression test, covering a different edit variant but the same preservation behavior.

*Call graph*: 5 external calls (SetNoticeHideRateLimitModelNudge, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_gpt5_1_migration_prompt_preserves_table`  (lines 662–687)

```
fn blocking_set_hide_gpt5_1_migration_prompt_preserves_table()
```

**Purpose**: Checks that a model-migration prompt suppression flag with a simple identifier is added under `[notice]` as an unquoted TOML key.

**Data flow**: Seeds `[notice] existing = "value"`, applies `SetNoticeHideModelMigrationPrompt("hide_gpt5_1_migration_prompt", true)`, reads the file, and asserts the new boolean key appears alongside the existing entry.

**Call relations**: This test covers dynamic-key insertion for migration prompts where the key name is TOML-bare-key compatible.

*Call graph*: 5 external calls (SetNoticeHideModelMigrationPrompt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_gpt_5_1_codex_max_migration_prompt_preserves_table`  (lines 690–715)

```
fn blocking_set_hide_gpt_5_1_codex_max_migration_prompt_preserves_table()
```

**Purpose**: Verifies that a migration prompt suppression key containing punctuation is serialized as a quoted TOML key under `[notice]`.

**Data flow**: Seeds a `[notice]` table, applies `SetNoticeHideModelMigrationPrompt("hide_gpt-5.1-codex-max_migration_prompt", true)`, reads the file, and asserts the resulting key is quoted in TOML syntax.

**Call relations**: This test complements the previous one by covering the serializer branch for dynamic keys that cannot be emitted as bare identifiers.

*Call graph*: 5 external calls (SetNoticeHideModelMigrationPrompt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_record_model_migration_seen_preserves_table`  (lines 718–745)

```
fn blocking_record_model_migration_seen_preserves_table()
```

**Purpose**: Checks that recording a seen model migration creates or updates the nested `[notice.model_migrations]` table while preserving the parent notice table.

**Data flow**: Seeds `[notice] existing = "value"`, applies `RecordModelMigrationSeen { from: "gpt-5.2", to: "gpt-5.4" }`, reads the file, and asserts the original notice key remains and a new nested table maps the source model string to the destination model string.

**Call relations**: This test exercises nested-table creation beneath an existing table and verifies exact placement and quoting of model IDs.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_external_config_migration_prompt_home_preserves_table`  (lines 748–774)

```
fn blocking_set_hide_external_config_migration_prompt_home_preserves_table()
```

**Purpose**: Ensures the home-level external-config migration prompt flag is written under `[notice.external_config_migration_prompts]` without disturbing `[notice]`.

**Data flow**: Seeds a `[notice]` table, applies `SetNoticeHideExternalConfigMigrationPromptHome(true)`, reads the file, and compares the exact TOML showing the new nested table with `home = true`.

**Call relations**: This test covers creation of a second-level nested notice table for migration prompt state.

*Call graph*: 5 external calls (SetNoticeHideExternalConfigMigrationPromptHome, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_external_config_migration_prompt_project_preserves_table`  (lines 777–806)

```
fn blocking_set_hide_external_config_migration_prompt_project_preserves_table()
```

**Purpose**: Verifies that project-specific external-config migration prompt suppression is stored in a nested projects map keyed by the project path.

**Data flow**: Seeds `[notice] existing = "value"`, applies `SetNoticeHideExternalConfigMigrationPromptProject("/Users/alexsong/code/skills", true)`, reads the file, and asserts a `[notice.external_config_migration_prompts.projects]` table contains the quoted path key mapped to `true`.

**Call relations**: This test extends the external-config migration coverage to per-project state keyed by arbitrary filesystem paths.

*Call graph*: 5 external calls (SetNoticeHideExternalConfigMigrationPromptProject, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_external_config_migration_prompt_home_last_prompted_at_preserves_table`  (lines 809–833)

```
fn blocking_set_external_config_migration_prompt_home_last_prompted_at_preserves_table()
```

**Purpose**: Checks that the home-level last-prompted timestamp is written as an integer in the external-config migration prompts table.

**Data flow**: Seeds a `[notice]` table, applies `SetNoticeExternalConfigMigrationPromptHomeLastPromptedAt(1_760_000_000)`, reads the file, and asserts the nested table contains `home_last_prompted_at = 1760000000`.

**Call relations**: This test covers timestamp persistence for the home-scoped migration prompt bookkeeping path.

*Call graph*: 5 external calls (SetNoticeExternalConfigMigrationPromptHomeLastPromptedAt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_external_config_migration_prompt_project_last_prompted_at_preserves_table`  (lines 836–865)

```
fn blocking_set_external_config_migration_prompt_project_last_prompted_at_preserves_table()
```

**Purpose**: Verifies that project-specific last-prompted timestamps are stored in a dedicated nested map keyed by project path.

**Data flow**: Seeds `[notice] existing = "value"`, applies `SetNoticeExternalConfigMigrationPromptProjectLastPromptedAt(path, timestamp)`, reads the file, and asserts a `[notice.external_config_migration_prompts.project_last_prompted_at]` table contains the quoted path key with the integer timestamp.

**Call relations**: This test complements the home timestamp case by covering the per-project nested-table branch.

*Call graph*: 5 external calls (SetNoticeExternalConfigMigrationPromptProjectLastPromptedAt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_round_trips`  (lines 868–973)

```
fn blocking_replace_mcp_servers_round_trips()
```

**Purpose**: Exercises full replacement of the `mcp_servers` section with multiple server definitions spanning different transport types and optional fields.

**Data flow**: Builds a `BTreeMap<String, McpServerConfig>` containing one `Stdio` server and one `StreamableHttp` server with env/header maps, durations, enabled/disabled tool lists, OAuth config, and resource URL; applies `ConfigEdit::ReplaceMcpServers`, reads the raw file, and compares it to the exact expected TOML including nested `[http_headers]`, `[oauth]`, and `[env]` tables.

**Call relations**: This is the broadest MCP serialization test, invoked directly by the test runner to validate deterministic ordering and omission/inclusion rules across many fields.

*Call graph*: 8 external calls (new, new, ReplaceMcpServers, assert_eq!, read_to_string, from_secs, tempdir, vec!).


##### `blocking_replace_mcp_servers_serializes_tool_approval_overrides`  (lines 976–1025)

```
fn blocking_replace_mcp_servers_serializes_tool_approval_overrides()
```

**Purpose**: Checks that MCP server default tool approval mode and per-tool approval overrides are serialized into the correct nested tables.

**Data flow**: Constructs a single `docs` server with `default_tools_approval_mode = Prompt` and a `tools` map containing `search -> approval_mode = Approve`, applies `ReplaceMcpServers`, reads the file, and asserts the exact TOML with `[mcp_servers.docs]` and `[mcp_servers.docs.tools.search]` sections.

**Call relations**: This test focuses on approval-related fields that are absent from the broader round-trip case, ensuring nested tool config serialization works.

*Call graph*: 7 external calls (new, from, new, ReplaceMcpServers, assert_eq!, read_to_string, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comments`  (lines 1028–1076)

```
fn blocking_replace_mcp_servers_preserves_inline_comments()
```

**Purpose**: Verifies that replacing MCP servers leaves an unchanged inline-table entry and its preceding comment untouched when the semantic content is equivalent.

**Data flow**: Seeds `[mcp_servers]` with a comment and `foo = { command = "cmd" }`, constructs an equivalent `foo` stdio server, applies `ReplaceMcpServers`, reads the file, and asserts the original text including the comment is preserved exactly.

**Call relations**: This regression test targets comment-preserving updates for inline-table MCP server definitions when no effective field changes are needed.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_suffix`  (lines 1079–1125)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_suffix()
```

**Purpose**: Checks that updating an inline-table MCP server preserves a trailing end-of-line comment suffix.

**Data flow**: Seeds `[mcp_servers] foo = { command = "cmd" } # keep me`, constructs a replacement server differing only by `enabled = false`, applies `ReplaceMcpServers`, reads the file, and asserts the updated inline table now includes `enabled = false` while retaining `# keep me`.

**Call relations**: This test covers the formatter branch that rewrites inline tables in place while preserving suffix comments.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_after_removing_keys`  (lines 1128–1174)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_after_removing_keys()
```

**Purpose**: Ensures that when replacement removes obsolete inline-table keys, the trailing comment is still preserved.

**Data flow**: Seeds an inline MCP server table containing `command` and `args`, replaces it with a config that only needs `command`, applies the edit, reads the file, and asserts the resulting inline table has dropped `args` but still ends with `# keep me`.

**Call relations**: This test complements the previous suffix-comment case by covering key removal rather than key addition.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_prefix_on_update`  (lines 1177–1225)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_prefix_on_update()
```

**Purpose**: Verifies that a comment line immediately preceding an inline MCP server entry remains attached after the entry is updated.

**Data flow**: Seeds `[mcp_servers]` with a standalone `# keep me` line before `foo = { command = "cmd" }`, replaces `foo` with a version including `enabled = false`, reads the file, and asserts both the prefix comment and updated inline table remain.

**Call relations**: This test covers preservation of comment prefixes rather than suffixes during inline-table mutation.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_clear_path_noop_when_missing`  (lines 1228–1244)

```
fn blocking_clear_path_noop_when_missing()
```

**Purpose**: Checks that clearing a nonexistent path is a true no-op and does not create `config.toml`.

**Data flow**: Creates a temporary config home, applies `ConfigEdit::ClearPath { segments: ["missing"] }`, then asserts the config file path does not exist.

**Call relations**: This test validates an important invariant of the edit engine: no-op clears should not materialize an empty config file.

*Call graph*: 3 external calls (assert!, tempdir, vec!).


##### `blocking_set_path_updates_notifications`  (lines 1247–1269)

```
fn blocking_set_path_updates_notifications()
```

**Purpose**: Verifies that a generic nested `SetPath` can create and populate `tui.notifications` with a boolean value.

**Data flow**: Applies `SetPath { segments: ["tui", "notifications"], value: false }`, reads the resulting file, parses it as `TomlValue`, navigates to `tui.notifications`, and asserts the boolean is `Some(false)`.

**Call relations**: This test exercises generic nested-path creation and semantic TOML parsing rather than exact text matching.

*Call graph*: 5 external calls (assert_eq!, read_to_string, tempdir, from_str, vec!).


##### `async_builder_set_model_persists`  (lines 1272–1287)

```
async fn async_builder_set_model_persists()
```

**Purpose**: Checks the asynchronous builder API for setting model and reasoning effort.

**Data flow**: Creates a temp config home, calls `ConfigEditsBuilder::new(&codex_home).set_model(Some("gpt-5.4"), Some(High)).apply().await`, then reads the file and compares the exact TOML output.

**Call relations**: This async test mirrors the blocking model tests but specifically validates the async `apply` path exposed by the builder.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_builder_set_model_round_trips_back_and_forth`  (lines 1290–1321)

```
fn blocking_builder_set_model_round_trips_back_and_forth()
```

**Purpose**: Ensures repeated builder-based model updates overwrite prior values cleanly and can be reverted without accumulating stale state.

**Data flow**: Applies `set_model` three times in sequence on the same temp config home—first `o4-mini/low`, then `gpt-5.4/high`, then back to `o4-mini/low`—reading the file after each step and asserting the exact expected contents each time.

**Call relations**: This test is a stateful regression check for idempotent overwrite behavior across multiple successive writes.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_set_asynchronous_helpers_available`  (lines 1324–1342)

```
async fn blocking_set_asynchronous_helpers_available()
```

**Purpose**: Verifies that async builder helper methods for notice settings are available and persist the expected nested boolean.

**Data flow**: Uses the async builder path to call `set_hide_full_access_warning(true).apply().await`, reads the file, parses it as `TomlValue`, navigates to `notice.hide_full_access_warning`, and asserts it is `Some(true)`.

**Call relations**: This async test complements the blocking notice-table tests by proving the convenience helper is wired through the asynchronous builder API.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_builder_set_realtime_audio_persists_and_clears`  (lines 1345–1386)

```
fn blocking_builder_set_realtime_audio_persists_and_clears()
```

**Purpose**: Checks that realtime audio device settings can be written independently and later partially cleared without removing unrelated sibling keys.

**Data flow**: First uses the builder to set `audio.microphone = "USB Mic"` and `audio.speaker = "Desk Speakers"`, reads and parses the file to assert both values exist, then applies a second builder call with `set_realtime_microphone(None)`, reparses the file, and asserts `microphone` is absent while `speaker` remains unchanged.

**Call relations**: This test covers both creation and selective deletion within the same nested `audio` table using builder helpers.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `blocking_builder_set_realtime_voice_persists_and_clears`  (lines 1389–1421)

```
fn blocking_builder_set_realtime_voice_persists_and_clears()
```

**Purpose**: Verifies that the realtime voice setting is persisted under `[realtime]` and removed cleanly when set to `None`.

**Data flow**: Applies `set_realtime_voice(Some("cedar"))`, parses the file to confirm `realtime.voice == "cedar"`, then applies `set_realtime_voice(None)`, reparses, and asserts the `voice` key is absent.

**Call relations**: This test is the voice-specific counterpart to the realtime audio test, covering nested-table key insertion and removal.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `replace_mcp_servers_blocking_clears_table_when_empty`  (lines 1424–1441)

```
fn replace_mcp_servers_blocking_clears_table_when_empty()
```

**Purpose**: Ensures replacing MCP servers with an empty map removes the `mcp_servers` table entirely from an existing config.

**Data flow**: Seeds a config containing `[mcp_servers] foo = { command = "cmd" }`, applies `ConfigEdit::ReplaceMcpServers(BTreeMap::new())`, reads the file, and asserts the resulting text no longer contains the string `mcp_servers`.

**Call relations**: This test covers the deletion branch of full MCP server replacement, proving that an empty replacement clears the section instead of leaving an empty table.

*Call graph*: 6 external calls (new, ReplaceMcpServers, assert!, read_to_string, write, tempdir).


### `core/src/config/schema_tests.rs`

`test` · `test-only`

This small test module validates the generated configuration schema rather than runtime config behavior. The main test, `config_schema_matches_fixture`, compares the generated schema against the repository fixture in two ways. First, it parses both as JSON, canonicalizes them, and compares the semantic structure; if they differ, it renders a unified diff with `similar::TextDiff` and panics with instructions to run `just write-config-schema`. Second, it writes a fresh schema file into a temporary directory and compares the exact serialized text (after normalizing Windows newlines and trimming a single trailing newline) to ensure the checked-in fixture matches byte-for-byte formatting expectations.

The helper `trim_single_trailing_newline` exists solely to make that exact-text comparison robust to one trailing newline difference. The second test, `config_schema_hides_unsupported_inline_mcp_bearer_token`, parses the generated schema JSON and navigates to `/definitions/RawMcpServerConfig/properties`, asserting that `bearer_token` is absent while `bearer_token_env_var` remains present. This encodes the policy that insecure inline bearer tokens are unsupported and should not appear in the public schema.

Together these tests make schema generation reproducible and ensure that removed config fields stay hidden from users and tooling.

#### Function details

##### `trim_single_trailing_newline`  (lines 9–11)

```
fn trim_single_trailing_newline(contents: &str) -> &str
```

**Purpose**: Removes exactly one trailing newline from a string if present.

**Data flow**: It takes `&str`, calls `strip_suffix('\n')`, and returns either the stripped slice or the original slice unchanged.

**Call relations**: The fixture/schema exact-text comparison uses this helper to ignore a single trailing newline difference.


##### `config_schema_matches_fixture`  (lines 14–55)

```
fn config_schema_matches_fixture()
```

**Purpose**: Checks that the generated config schema matches the checked-in fixture semantically and exactly on disk.

**Data flow**: It locates and reads the fixture file, parses fixture and generated schema JSON, canonicalizes both values, and if they differ renders a unified diff and panics. It then writes a fresh schema to a temp file, reads it back, normalizes Windows newlines when needed, trims one trailing newline from both strings, and asserts exact equality.

**Call relations**: This is the primary schema-regression test guarding both semantic and serialized stability of the generated schema.

*Call graph*: 12 external calls (new, from_lines, assert_eq!, find_resource!, panic!, from_slice, from_str, to_string_pretty, read_to_string, canonicalize (+2 more)).


##### `config_schema_hides_unsupported_inline_mcp_bearer_token`  (lines 58–75)

```
fn config_schema_hides_unsupported_inline_mcp_bearer_token()
```

**Purpose**: Verifies that the generated schema exposes `bearer_token_env_var` but not the removed inline `bearer_token` field for MCP server config.

**Data flow**: It generates schema JSON, parses it into `serde_json::Value`, navigates to the `RawMcpServerConfig` properties object, and asserts that `contains_key("bearer_token")` is false while `contains_key("bearer_token_env_var")` is true.

**Call relations**: This targeted regression test protects the schema-level enforcement of the removed insecure bearer-token field.

*Call graph*: 3 external calls (assert_eq!, from_slice, config_schema_json).


### `core/src/config/config_tests.rs`

`test` · `cross-cutting; exercised during test runs for config load, merge, and runtime policy derivation`

This file is the main behavioral specification for the configuration subsystem. It mixes small constructor helpers (`stdio_mcp`, `http_mcp`) with hundreds of focused tests that validate how TOML input, CLI overrides, managed requirements, and runtime defaults combine into a final `Config`. The tests cover simple scalar defaults (TUI flags, auth store modes, service tier, feedback, realtime settings), structural TOML decoding (permissions profiles, MITM hooks/actions, MCP server tool approvals, desktop opaque JSON-like blobs), and complex policy derivation such as translating permission profiles into `FileSystemSandboxPolicy`, `NetworkSandboxPolicy`, and legacy `SandboxPolicy` projections.

A recurring pattern is creating temporary `codex_home` and workspace directories, writing `config.toml` or project-local `.codex/config.toml`, then loading via `Config::load_from_base_config_with_overrides` or `ConfigBuilder`. That lets the tests verify precedence between user config, project config, session flags, managed config, and enterprise requirements. The suite is especially detailed around edge cases: unknown special filesystem paths become warnings instead of hard failures, empty/blank values are normalized away, Windows sandbox downgrades are preserved, managed requirements can force fallback values and clear active profile metadata, and plugin-derived MCP servers are filtered or shadowed correctly. `PrecedenceTestFixture` packages a reusable baseline config for precedence-oriented tests involving profiles, OTEL, and service-tier behavior.

#### Function details

##### `stdio_mcp`  (lines 114–138)

```
fn stdio_mcp(command: &str) -> McpServerConfig
```

**Purpose**: Builds a canonical `McpServerConfig` for a stdio-backed MCP server with a supplied command and otherwise default-like test values. It gives tests a compact way to compare full server structs without repeating boilerplate.

**Data flow**: Takes a `&str` command, converts it into `McpServerTransportConfig::Stdio { command, args: Vec::new(), env: None, env_vars: Vec::new(), cwd: None }`, then fills the remaining `McpServerConfig` fields with the default environment id, enabled=true, required=false, no timeouts, no approvals overrides, no scopes/oauth, and an empty `tools` map. Returns the assembled `McpServerConfig` without mutating external state.

**Call relations**: Used by MCP allowlist/filtering tests as the expected baseline server shape. Those tests construct server maps with this helper before passing them into requirement-filtering logic, then compare enabled flags and disabled reasons after filtering.

*Call graph*: called by 5 (filter_mcp_servers_by_allowlist_allows_all_when_unset, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin, filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules); 2 external calls (new, new).


##### `http_mcp`  (lines 140–163)

```
fn http_mcp(url: &str) -> McpServerConfig
```

**Purpose**: Builds a canonical `McpServerConfig` for a streamable HTTP MCP server with a supplied URL and otherwise empty optional settings. It mirrors `stdio_mcp` for HTTP transport cases.

**Data flow**: Takes a `&str` URL, wraps it in `McpServerTransportConfig::StreamableHttp { url, bearer_token_env_var: None, http_headers: None, env_http_headers: None }`, then populates the rest of `McpServerConfig` with the standard test defaults: default environment id, enabled=true, required=false, no timeouts, no tool filters, no oauth, and empty `tools`. Returns the config value only.

**Call relations**: Called by MCP filtering and plugin-selection tests to create expected HTTP server entries. In those flows it serves as the comparison target after requirement filtering or plugin/user shadowing logic has run.

*Call graph*: called by 5 (filter_mcp_servers_by_allowlist_allows_all_when_unset, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules, selected_plugin_wins_after_discovered_plugin_requirements); 1 external calls (new).


##### `derive_legacy_sandbox_policy_for_test`  (lines 165–189)

```
async fn derive_legacy_sandbox_policy_for_test(
    cfg: &ConfigToml,
    sandbox_mode_override: Option<SandboxMode>,
    windows_sandbox_level: WindowsSandboxLevel,
    active_project: Option<&Projec
```

**Purpose**: Convenience async wrapper that derives a permission profile from `ConfigToml` and then projects it into the legacy `SandboxPolicy`, falling back to read-only if the projection is impossible. It lets tests assert legacy sandbox semantics without duplicating the conversion logic.

**Data flow**: Consumes references to `ConfigToml`, optional sandbox override, Windows sandbox level, optional active project, and optional constrained permission profile. It awaits `cfg.derive_permission_profile(...)`, then calls `to_legacy_sandbox_policy(Path::new("/"))`. On success it returns that `SandboxPolicy`; on conversion failure it logs a warning and returns `SandboxPolicy::new_read_only_policy()`.

**Call relations**: Invoked by sandbox-derivation tests that want to validate compatibility behavior, implicit defaults, trust-based fallback, and Windows downgrade semantics. It delegates the real derivation to production config code and only adds the lossy fallback behavior for test assertions.

*Call graph*: calls 1 internal fn (derive_permission_profile); called by 4 (derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults, derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback, test_sandbox_config_parsing, test_untrusted_project_gets_workspace_write_sandbox); 1 external calls (new).


##### `load_config_normalizes_relative_cwd_override`  (lines 192–207)

```
async fn load_config_normalizes_relative_cwd_override() -> std::io::Result<()>
```

**Purpose**: Verifies that a relative `cwd` override is resolved against the current process directory before being stored in runtime config.

**Data flow**: Creates an expected absolute path via `AbsolutePathBuf::relative_to_current_dir("nested")`, loads a default `ConfigToml` with `ConfigOverrides { cwd: Some(PathBuf::from("nested")), .. }`, then asserts that `config.cwd` equals the normalized absolute path. It returns `Ok(())` on success.

**Call relations**: This is a direct load-path test of `Config::load_from_base_config_with_overrides`, exercising override normalization rather than TOML parsing.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 6 external calls (default, from, load_from_base_config_with_overrides, assert_eq!, default, tempdir).


##### `test_toml_parsing`  (lines 210–311)

```
async fn test_toml_parsing()
```

**Purpose**: Checks several TOML decoding and runtime-resolution paths for history and memories settings, including a legacy memories alias.

**Data flow**: Parses inline TOML snippets into `ConfigToml`, inspects decoded `history` and `memories` fields, then loads runtime `Config` from the memories TOML and asserts the resolved `MemoriesConfig` booleans, numeric limits, and model names. It also parses a legacy `no_memories_if_mcp_or_web_search` field and confirms it maps to `disable_on_external_context`.

**Call relations**: Acts as a broad deserialization-and-resolution regression test. It first validates raw TOML structs, then delegates to the runtime loader to confirm the same settings survive normalization into `Config`.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir).


##### `parses_bundled_skills_config`  (lines 314–334)

```
fn parses_bundled_skills_config()
```

**Purpose**: Confirms that `[skills]` and nested `[skills.bundled]` TOML decode into `SkillsConfig` with the expected optional fields.

**Data flow**: Parses a TOML snippet with `include_instructions = false` and `bundled.enabled = false`, then compares `cfg.skills` against a fully constructed `SkillsConfig { bundled: Some(BundledSkillsConfig { enabled: false }), include_instructions: Some(false), config: Vec::new() }`.

**Call relations**: Pure deserialization test; it does not invoke runtime config loading.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_web_search_true_deserializes_to_none`  (lines 337–353)

```
fn tools_web_search_true_deserializes_to_none()
```

**Purpose**: Verifies that legacy boolean `tools.web_search = true` is accepted but normalized away in `ToolsToml`.

**Data flow**: Parses TOML containing `[tools] web_search = true` and asserts that the resulting `ToolsToml` has `web_search: None` and `experimental_request_user_input: None`.

**Call relations**: One of a pair of compatibility tests ensuring old boolean forms do not survive as meaningful structured config.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_web_search_false_deserializes_to_none`  (lines 356–372)

```
fn tools_web_search_false_deserializes_to_none()
```

**Purpose**: Verifies that legacy boolean `tools.web_search = false` is also accepted and normalized to no structured `web_search` config.

**Data flow**: Parses TOML with `[tools] web_search = false` and asserts the decoded `ToolsToml` contains `web_search: None` and no experimental request-user-input config.

**Call relations**: Companion to the previous test, covering the false branch of the same compatibility behavior.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_experimental_request_user_input_defaults_to_enabled`  (lines 375–390)

```
fn tools_experimental_request_user_input_defaults_to_enabled()
```

**Purpose**: Checks that an empty `[tools.experimental_request_user_input]` table defaults its `enabled` flag to true.

**Data flow**: Parses a TOML snippet containing only the nested table and asserts that `cfg.tools` equals `Some(ToolsToml { web_search: None, experimental_request_user_input: Some(ExperimentalRequestUserInput { enabled: true }) })`.

**Call relations**: Pure TOML defaulting test for a nested tool config block.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_experimental_request_user_input_can_be_disabled`  (lines 393–409)

```
fn tools_experimental_request_user_input_can_be_disabled()
```

**Purpose**: Checks that the nested experimental request-user-input tool can explicitly set `enabled = false`.

**Data flow**: Parses TOML with `[tools.experimental_request_user_input] enabled = false` and asserts the decoded nested struct preserves `enabled: false`.

**Call relations**: Pairs with the previous test to cover explicit override of the nested default.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `load_config_resolves_experimental_request_user_input_enabled`  (lines 412–431)

```
async fn load_config_resolves_experimental_request_user_input_enabled() -> std::io::Result<()>
```

**Purpose**: Verifies that the runtime `Config` exposes the resolved boolean for experimental request-user-input support.

**Data flow**: Constructs a `ConfigToml` with `tools.experimental_request_user_input.enabled = false`, loads runtime config, and asserts `config.experimental_request_user_input_enabled` is false.

**Call relations**: Moves beyond deserialization to confirm the loader copies the nested TOML setting into the flattened runtime field.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, default, tempdir).


##### `load_config_resolves_code_mode_config`  (lines 434–457)

```
async fn load_config_resolves_code_mode_config() -> std::io::Result<()>
```

**Purpose**: Ensures feature-table code mode settings both enable the `Feature::CodeMode` flag and preserve excluded tool namespaces.

**Data flow**: Parses TOML under `[features.code_mode]`, loads runtime config, then asserts `config.code_mode.excluded_tool_namespaces` contains the two configured namespaces and `config.features.enabled(Feature::CodeMode)` is true.

**Call relations**: Exercises feature-table parsing plus runtime feature activation for a structured feature block.

*Call graph*: 6 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir, from_str).


##### `rejects_provider_auth_with_env_key`  (lines 460–477)

```
fn rejects_provider_auth_with_env_key()
```

**Purpose**: Confirms provider config validation rejects combining `env_key` with an explicit `[auth]` block on the same custom model provider.

**Data flow**: Attempts to parse invalid provider TOML and captures the deserialization error, then checks the error string mentions that provider auth cannot be combined with `env_key`.

**Call relations**: Pure validation test at TOML parse time; it never reaches runtime config loading.

*Call graph*: 1 external calls (assert!).


##### `rejects_provider_aws_for_custom_provider`  (lines 480–497)

```
fn rejects_provider_aws_for_custom_provider()
```

**Purpose**: Confirms AWS-specific provider settings are rejected for non-`amazon-bedrock` providers.

**Data flow**: Parses invalid TOML defining `[model_providers.custom.aws]`, expects an error, and asserts the message says AWS config is only supported for `amazon-bedrock`.

**Call relations**: Another parse-time validation test for provider schema constraints.

*Call graph*: 1 external calls (assert!).


##### `accepts_amazon_bedrock_aws_profile_override`  (lines 500–524)

```
fn accepts_amazon_bedrock_aws_profile_override()
```

**Purpose**: Checks that the special-case AWS override fields for `amazon-bedrock` deserialize correctly.

**Data flow**: Parses TOML with `[model_providers.amazon-bedrock.aws] profile` and `region`, then drills into `cfg.model_providers` to assert both optional strings are present.

**Call relations**: Covers the allowed branch of the Bedrock-specific provider validation rules.

*Call graph*: 1 external calls (assert_eq!).


##### `load_config_applies_amazon_bedrock_aws_profile_override`  (lines 527–564)

```
async fn load_config_applies_amazon_bedrock_aws_profile_override()
```

**Purpose**: Verifies that Bedrock AWS overrides survive into the runtime-selected provider when `model_provider = "amazon-bedrock"`.

**Data flow**: Parses TOML selecting the Bedrock provider and setting AWS profile/region, loads runtime config, then asserts `config.model_provider_id` and the nested `config.model_provider.aws` fields match the TOML.

**Call relations**: Builds on the deserialization test by checking the runtime provider selection path.

*Call graph*: 4 external calls (load_from_base_config_with_overrides, assert_eq!, default, tempdir).


##### `load_config_rejects_unsupported_amazon_bedrock_overrides`  (lines 567–597)

```
async fn load_config_rejects_unsupported_amazon_bedrock_overrides()
```

**Purpose**: Ensures runtime loading rejects non-default Bedrock provider fields other than `aws.profile` and `aws.region`.

**Data flow**: Parses TOML that customizes Bedrock name/base URL/auth/websocket support in addition to AWS fields, attempts runtime load, and asserts an `InvalidData` error with the specific unsupported-overrides message.

**Call relations**: This validation happens during runtime config loading rather than TOML parsing, so the test exercises the loader’s provider normalization checks.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir).


##### `config_toml_deserializes_model_availability_nux`  (lines 600–635)

```
fn config_toml_deserializes_model_availability_nux()
```

**Purpose**: Checks that `[tui.model_availability_nux]` deserializes into the nested `ModelAvailabilityNuxConfig` map while preserving other TUI defaults.

**Data flow**: Parses TOML with two model counters, then compares the entire decoded `Tui` struct against an expected value containing default notification/keymap/animation fields and a `shown_count` `HashMap` with both entries.

**Call relations**: Pure TOML decoding test for a nested TUI map structure.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_status_line_use_colors_defaults_to_enabled`  (lines 638–650)

```
fn config_toml_status_line_use_colors_defaults_to_enabled()
```

**Purpose**: Verifies that an empty `[tui]` table defaults `status_line_use_colors` to true.

**Data flow**: Parses minimal TUI TOML and asserts the decoded `Tui.status_line_use_colors` boolean is true.

**Call relations**: Simple default-value deserialization test.

*Call graph*: 2 external calls (assert!, from_str).


##### `config_toml_deserializes_status_line_use_colors_disabled`  (lines 653–666)

```
fn config_toml_deserializes_status_line_use_colors_disabled()
```

**Purpose**: Verifies that `status_line_use_colors = false` is preserved during TUI TOML parsing.

**Data flow**: Parses `[tui] status_line_use_colors = false` and asserts the decoded boolean is false.

**Call relations**: Companion explicit-override test for the previous default case.

*Call graph*: 2 external calls (assert!, from_str).


##### `config_toml_deserializes_terminal_resize_reflow_config`  (lines 669–683)

```
fn config_toml_deserializes_terminal_resize_reflow_config()
```

**Purpose**: Checks that the TUI resize reflow row limit parses as an optional integer.

**Data flow**: Parses `[tui] terminal_resize_reflow_max_rows = 9000` and asserts the decoded field is `Some(9000)`.

**Call relations**: Pure TOML parsing test for a numeric TUI setting.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `runtime_config_defaults_model_availability_nux`  (lines 686–699)

```
async fn runtime_config_defaults_model_availability_nux()
```

**Purpose**: Ensures runtime config uses the default `ModelAvailabilityNuxConfig` when no TUI NUX settings are provided.

**Data flow**: Loads runtime config from `ConfigToml::default()` and asserts `cfg.model_availability_nux == ModelAvailabilityNuxConfig::default()`.

**Call relations**: Runtime counterpart to the TOML deserialization test for model-availability NUX.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `test_tui_vim_mode_default_defaults_to_false`  (lines 702–713)

```
fn test_tui_vim_mode_default_defaults_to_false()
```

**Purpose**: Checks that `vim_mode_default` defaults to false in an otherwise empty TUI table.

**Data flow**: Parses `[tui]` and asserts the decoded `vim_mode_default` field is false.

**Call relations**: Simple deserialization default test.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_vim_mode_default_true`  (lines 716–728)

```
fn test_tui_vim_mode_default_true()
```

**Purpose**: Checks that `vim_mode_default = true` is preserved during parsing.

**Data flow**: Parses TOML with the flag set and asserts the decoded field is true.

**Call relations**: Explicit override companion to the previous test.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_raw_output_mode_defaults_to_false`  (lines 731–742)

```
fn test_tui_raw_output_mode_defaults_to_false()
```

**Purpose**: Checks that `raw_output_mode` defaults to false in TUI config.

**Data flow**: Parses an empty `[tui]` table and asserts `raw_output_mode` is false.

**Call relations**: Default-value deserialization test.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_raw_output_mode_true`  (lines 745–757)

```
fn test_tui_raw_output_mode_true()
```

**Purpose**: Checks that `raw_output_mode = true` parses correctly.

**Data flow**: Parses TOML with the flag enabled and asserts the decoded field is true.

**Call relations**: Explicit-value companion to the previous default test.

*Call graph*: 2 external calls (assert!, from_str).


##### `runtime_config_uses_tui_raw_output_mode`  (lines 760–775)

```
async fn runtime_config_uses_tui_raw_output_mode()
```

**Purpose**: Verifies that parsed TUI raw-output mode is propagated into the flattened runtime config field.

**Data flow**: Parses TOML enabling `raw_output_mode`, loads runtime config, and asserts `cfg.tui_raw_output_mode` is true.

**Call relations**: Bridges TOML parsing and runtime field resolution for this TUI option.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, tempdir, from_str).


##### `config_toml_deserializes_permission_profiles`  (lines 778–898)

```
fn config_toml_deserializes_permission_profiles()
```

**Purpose**: Validates the full TOML shape for named permission profiles, including workspace roots, filesystem entries, network settings, domains, and MITM hooks/actions.

**Data flow**: Parses a large TOML snippet with `default_permissions = "dev"` and a `[permissions.dev]` subtree, then compares the resulting `PermissionsToml` and nested `PermissionProfileToml`, `WorkspaceRootsToml`, `FilesystemPermissionsToml`, `NetworkToml`, `NetworkMitmToml`, hook/action maps, and enum values against a fully constructed expected value.

**Call relations**: This is the canonical schema test for permission-profile TOML. Later runtime permission tests rely on the same structures but validate policy derivation instead of raw decoding.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_rejects_empty_mitm_action_reference_list`  (lines 901–923)

```
fn config_toml_rejects_empty_mitm_action_reference_list()
```

**Purpose**: Ensures a MITM hook cannot declare an empty `action = []` list.

**Data flow**: Attempts to parse TOML with an empty action reference list under a MITM hook, expects failure, and asserts the error mentions the specific hook path and non-empty requirement.

**Call relations**: Parse-time validation test for fail-closed MITM configuration.

*Call graph*: 1 external calls (assert!).


##### `config_toml_rejects_empty_mitm_action_definition`  (lines 926–947)

```
fn config_toml_rejects_empty_mitm_action_definition()
```

**Purpose**: Ensures a MITM action definition must contain at least one operation such as stripping or injecting headers.

**Data flow**: Parses TOML with a hook referencing `strip_auth` but an empty `[actions.strip_auth]` table, expects an error, and checks the message says the action must define at least one operation.

**Call relations**: Companion validation test for MITM action bodies.

*Call graph*: 1 external calls (assert!).


##### `permissions_profile_network_to_proxy_config_preserves_mitm_hooks`  (lines 950–989)

```
fn permissions_profile_network_to_proxy_config_preserves_mitm_hooks()
```

**Purpose**: Checks that converting `NetworkToml` into proxy config preserves MITM enablement, hook matchers, and action payloads.

**Data flow**: Constructs a `NetworkToml` in memory with mode `Full`, one MITM hook, and one action, calls `to_network_proxy_config()`, then asserts the resulting proxy config has `network.mode = Full`, `mitm = true`, one hook, the expected host/methods, and the expected stripped request header list.

**Call relations**: Exercises the production conversion from permission-profile network config into managed proxy runtime config.

*Call graph*: 7 external calls (from, new, assert!, assert_eq!, default, default, vec!).


##### `permissions_profile_network_to_proxy_config_preserves_mitm_hook_declaration_order`  (lines 992–1032)

```
fn permissions_profile_network_to_proxy_config_preserves_mitm_hook_declaration_order()
```

**Purpose**: Verifies that MITM hooks retain TOML declaration order rather than being reordered alphabetically.

**Data flow**: Parses TOML with actions and two hooks declared as `z_first` then `a_second`, extracts the workspace profile’s `NetworkToml`, converts it to proxy config, and asserts the resulting hook list preserves the original path-prefix order.

**Call relations**: Targets ordering semantics in the TOML-to-runtime conversion, relying on `IndexMap` preservation.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `permissions_profiles_proxy_policy_does_not_start_managed_network_proxy_without_feature`  (lines 1035–1083)

```
async fn permissions_profiles_proxy_policy_does_not_start_managed_network_proxy_without_feature() -> std::io::Result<()>
```

**Purpose**: Ensures a permission profile with `network.enabled = true` affects sandbox policy but does not instantiate managed proxy config unless the feature is enabled.

**Data flow**: Creates temp home/cwd, writes a `.git` marker, loads config with a named permission profile whose network section only enables network access, then asserts `network_sandbox_policy()` is `Enabled` while `config.permissions.network` remains `None`.

**Call relations**: Part of the network-proxy feature matrix; it checks that sandbox semantics and managed-proxy startup are intentionally decoupled.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, write).


##### `permissions_profiles_proxy_policy_starts_managed_network_proxy`  (lines 1086–1135)

```
async fn permissions_profiles_proxy_policy_starts_managed_network_proxy() -> std::io::Result<()>
```

**Purpose**: Despite its name, verifies that even a profile containing proxy URL settings still does not start the managed proxy when the feature gate is absent.

**Data flow**: Loads a permission profile with `network.enabled = true`, `proxy_url`, and `enable_socks5 = false`, then asserts network sandbox is enabled but `config.permissions.network` is still `None`.

**Call relations**: Companion to the previous test, covering the case where proxy-specific settings exist but the feature remains disabled.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, write).


##### `network_proxy_feature_is_no_op_without_sandbox_network`  (lines 1138–1163)

```
async fn network_proxy_feature_is_no_op_without_sandbox_network() -> std::io::Result<()>
```

**Purpose**: Checks that enabling the `network_proxy` feature alone does nothing when sandbox/network access itself is not enabled.

**Data flow**: Loads config with `features.network_proxy = true` and no network-enabled sandbox/profile, then asserts the network sandbox policy stays `Restricted` and no managed proxy config is created.

**Call relations**: Part of the feature matrix proving the proxy feature cannot widen network access by itself.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, from_str).


##### `network_proxy_feature_matrix_preserves_sandbox_network_semantics`  (lines 1166–1313)

```
async fn network_proxy_feature_matrix_preserves_sandbox_network_semantics() -> std::io::Result<()>
```

**Purpose**: Exhaustively tests combinations of permission-profile vs legacy workspace-write surfaces, network enabled/disabled, and proxy feature enabled/disabled.

**Data flow**: Defines local `Surface` and `Case` types, iterates eight cases, builds a `ConfigToml` per case, loads runtime config, and asserts both the resulting `NetworkSandboxPolicy` and whether `config.permissions.network` is present. It also creates temp repos for workspace-root discovery where needed.

**Call relations**: This is the central matrix test for network proxy semantics. It repeatedly drives `Config::load_from_base_config_with_overrides` with different inputs to verify invariant separation between sandbox policy and managed proxy startup.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `network_proxy_cli_overrides_merge_toggle_with_proxy_config`  (lines 1316–1362)

```
async fn network_proxy_cli_overrides_merge_toggle_with_proxy_config() -> std::io::Result<()>
```

**Purpose**: Verifies CLI override keys under `features.network_proxy.*` merge with file-based sandbox settings to start a managed proxy with the expected defaults and socks toggle.

**Data flow**: Writes a base `config.toml` enabling workspace-write network access, builds config through `ConfigBuilder` with CLI overrides enabling `features.network_proxy.enabled` and disabling socks5, then asserts network sandbox is enabled and the resulting managed proxy uses host `127.0.0.1:3128` with socks disabled.

**Call relations**: Exercises the layered builder path rather than direct load, specifically testing CLI TOML-path overrides merged into file config.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert!, assert_eq!, write, vec!).


##### `experimental_network_requirements_enable_proxy_without_feature`  (lines 1365–1392)

```
async fn experimental_network_requirements_enable_proxy_without_feature() -> std::io::Result<()>
```

**Purpose**: Checks that managed enterprise requirements can enable the managed network proxy even when the user-facing `Feature::NetworkProxy` is off.

**Data flow**: Builds config with a cloud-config bundle containing `[experimental_network] enabled = true`, then asserts the feature flag is false, `managed_network_requirements_enabled()` is true, and `config.permissions.network` exists and is enabled.

**Call relations**: Covers the managed-requirements path that bypasses the normal feature gate for enterprise-controlled proxy behavior.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `network_proxy_feature_uses_profile_network_proxy_settings`  (lines 1395–1447)

```
async fn network_proxy_feature_uses_profile_network_proxy_settings() -> std::io::Result<()>
```

**Purpose**: Ensures that when the proxy feature is enabled and the permission profile enables network access, profile-specified proxy settings become the managed proxy runtime config.

**Data flow**: Loads config with `features.network_proxy = true` and a permission profile containing `network.enabled = true`, `proxy_url`, and `enable_socks5 = false`, then asserts enabled network sandbox plus a present managed proxy whose host/port and socks setting match the profile.

**Call relations**: Positive-path counterpart to earlier no-op tests in the network proxy matrix.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, from_str).


##### `disabled_network_proxy_feature_does_not_start_profile_proxy_policy`  (lines 1450–1505)

```
async fn disabled_network_proxy_feature_does_not_start_profile_proxy_policy() -> std::io::Result<()>
```

**Purpose**: Verifies that an explicit `features.network_proxy.enabled = false` suppresses managed proxy startup even if the profile contains proxy settings.

**Data flow**: Loads config with a disabled feature table and a profile that enables network plus proxy URL, then asserts the feature is disabled and `config.permissions.network` is `None`.

**Call relations**: Tests explicit feature disablement overriding otherwise proxy-capable profile config.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, from_str).


##### `permissions_profiles_network_disabled_by_default_does_not_start_proxy`  (lines 1508–1555)

```
async fn permissions_profiles_network_disabled_by_default_does_not_start_proxy() -> std::io::Result<()>
```

**Purpose**: Checks that merely specifying network domain rules without `network.enabled = true` does not start a managed proxy.

**Data flow**: Loads a permission profile whose network section contains allowed domains but no explicit enablement, then asserts `config.permissions.network` is `None`.

**Call relations**: Covers the default-disabled interpretation of profile network config.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, write).


##### `default_permissions_profile_populates_runtime_sandbox_policy`  (lines 1558–1658)

```
async fn default_permissions_profile_populates_runtime_sandbox_policy() -> std::io::Result<()>
```

**Purpose**: Verifies that a named default permission profile is compiled into the expected runtime filesystem sandbox entries, legacy sandbox projection, active profile metadata, and network restriction.

**Data flow**: Creates a repo-like cwd with `docs/` and `.git`, loads config with `default_permissions = "dev"` and a profile granting `:minimal` read plus scoped `:workspace_roots` write/read entries, then asserts the exact `FileSystemSandboxPolicy::restricted(...)` entries, the legacy `SandboxPolicy::WorkspaceWrite` projection, inability to write `.git`, restricted network policy, and active profile id `dev`.

**Call relations**: One of the core permission-profile runtime tests, validating the full translation from TOML profile to runtime permissions and legacy compatibility view.

*Call graph*: 10 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, Scoped, create_dir_all, write).


##### `default_permissions_extended_profile_preserves_parent_metadata`  (lines 1661–1717)

```
async fn default_permissions_extended_profile_preserves_parent_metadata() -> std::io::Result<()>
```

**Purpose**: Ensures that when a selected profile extends another profile, the runtime active-profile metadata retains the parent `extends` relationship.

**Data flow**: Loads config with profiles `base` and `dev extends = "base"`, then asserts `config.permissions.active_permission_profile()` equals `ActivePermissionProfile { id: "dev", extends: Some("base") }`.

**Call relations**: Focuses on metadata preservation rather than filesystem/network semantics.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `permission_profile_override_populates_runtime_permissions`  (lines 1720–1746)

```
async fn permission_profile_override_populates_runtime_permissions() -> std::io::Result<()>
```

**Purpose**: Checks that a direct `ConfigOverrides.permission_profile` bypasses named profile selection and sets runtime permissions to the supplied profile.

**Data flow**: Loads default config with an override of `PermissionProfile::Disabled`, then asserts the effective permission profile equals that override, active profile metadata is `None`, and the legacy projection becomes `SandboxPolicy::DangerFullAccess`.

**Call relations**: Exercises the override path where runtime permissions are injected directly rather than selected from TOML.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `permission_snapshot_setter_preserves_permission_constraints`  (lines 1749–1770)

```
fn permission_snapshot_setter_preserves_permission_constraints()
```

**Purpose**: Verifies that restoring a permission snapshot cannot violate existing permission constraints on a `Permissions` object.

**Data flow**: Creates constrained permissions allowing only a read-only profile, attempts to set a session snapshot containing a workspace-write profile, expects `ConstraintError::InvalidValue`, and confirms the original permission profile and active profile remain unchanged.

**Call relations**: Tests mutation-time constraint enforcement on the `Permissions` domain object rather than config loading.

*Call graph*: calls 7 internal fn (new, allow_any, allow_only, from_approval_and_profile, active, read_only, workspace_write); 2 external calls (assert!, assert_eq!).


##### `permission_profile_override_preserves_managed_unrestricted_filesystem`  (lines 1773–1804)

```
async fn permission_profile_override_preserves_managed_unrestricted_filesystem() -> std::io::Result<()>
```

**Purpose**: Checks that a managed permission profile with unrestricted filesystem and restricted network survives config loading and projects to the external-sandbox legacy form.

**Data flow**: Loads config with an override `PermissionProfile::Managed { file_system: Unrestricted, network: Restricted }`, then asserts the effective profile matches and the legacy projection is `SandboxPolicy::ExternalSandbox { network_access: Restricted }`.

**Call relations**: Covers a managed-permissions branch distinct from built-in read-only/workspace/full-access profiles.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `managed_unrestricted_permission_profile_still_enables_network_requirements`  (lines 1807–1859)

```
async fn managed_unrestricted_permission_profile_still_enables_network_requirements() -> std::io::Result<()>
```

**Purpose**: Ensures managed unrestricted filesystem profiles still honor managed network requirements even though their legacy projection is lossy.

**Data flow**: Loads config with a managed unrestricted/enabled-network profile, confirms the legacy projection is `DangerFullAccess`, then manually rebuilds `config.config_layer_stack` with injected network requirements and asserts `managed_network_requirements_enabled()` becomes true.

**Call relations**: This test mutates the loaded config’s layer stack to simulate managed requirements after load, proving that requirement detection is independent of the lossy legacy sandbox projection.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `permission_profile_override_keeps_memories_root_out_of_legacy_projection`  (lines 1862–1912)

```
async fn permission_profile_override_keeps_memories_root_out_of_legacy_projection() -> std::io::Result<()>
```

**Purpose**: Checks that a runtime permission profile granting project-root writes does not accidentally widen the legacy projection to include the Codex memories directory.

**Data flow**: Builds a permission profile from runtime filesystem entries (`:root` read and `:project_roots` write), loads config with that override, then asserts the memories root is not writable under the runtime policy and the legacy projection remains plain workspace-write without extra writable roots.

**Call relations**: Targets a subtle invariant: internal memories storage must not leak into legacy writable-root projections.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 7 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `permission_profile_override_preserves_configured_network_policy_without_starting_proxy`  (lines 1915–1973)

```
async fn permission_profile_override_preserves_configured_network_policy_without_starting_proxy() -> std::io::Result<()>
```

**Purpose**: Verifies that overriding the permission profile suppresses profile-derived managed proxy startup even if the base config’s selected profile had network/proxy settings.

**Data flow**: Loads config whose TOML defines a network-enabled profile with proxy settings but whose overrides force `PermissionProfile::Disabled`, then asserts `config.permissions.network` is `None` and the effective profile is the override.

**Call relations**: Shows that direct permission-profile overrides replace profile-derived runtime network config rather than merging with it.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access).


##### `workspace_root_glob_none_compiles_to_filesystem_pattern_entry`  (lines 1976–2057)

```
async fn workspace_root_glob_none_compiles_to_filesystem_pattern_entry() -> std::io::Result<()>
```

**Purpose**: Ensures scoped `:workspace_roots` glob entries compile into concrete `GlobPattern` sandbox entries for each effective workspace root, not literal special-path entries.

**Data flow**: Creates cwd and extra writable root repos, loads a profile with `glob_scan_max_depth = 2` and scoped entries `.` write plus `**/*.env` deny, then asserts the runtime policy carries the depth limit, contains one deny `GlobPattern` per root with resolved absolute patterns, and contains no `FileSystemSpecialPath::ProjectRoots { subpath: Some("**/*.env") }` entries.

**Call relations**: Exercises the filesystem compiler path for scoped workspace-root globs and additional writable roots.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Scoped, write, vec!).


##### `permissions_profiles_require_default_permissions`  (lines 2060–2102)

```
async fn permissions_profiles_require_default_permissions() -> std::io::Result<()>
```

**Purpose**: Checks that defining `[permissions]` profiles without selecting `default_permissions` is rejected.

**Data flow**: Loads config containing a `permissions` table but no `default_permissions`, expects an `InvalidInput` error, and asserts the exact message explains the missing selector.

**Call relations**: Validation test for profile-table completeness during runtime load.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `default_permissions_can_select_builtin_profile_without_permissions_table`  (lines 2105–2143)

```
async fn default_permissions_can_select_builtin_profile_without_permissions_table() -> std::io::Result<()>
```

**Purpose**: Verifies that `default_permissions` may directly select a built-in profile such as `:workspace` without any custom `[permissions]` table.

**Data flow**: Loads config with `default_permissions` set to the built-in workspace profile id, then asserts explicit profile mode is on, custom profile summaries are empty, active profile metadata names the built-in profile, and the resulting filesystem policy allows writing the cwd but not `.git`.

**Call relations**: Covers built-in profile selection independent of custom profile definitions.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `default_permissions_read_only_keeps_add_dir_read_only`  (lines 2146–2178)

```
async fn default_permissions_read_only_keeps_add_dir_read_only() -> std::io::Result<()>
```

**Purpose**: Ensures selecting built-in read-only does not let runtime `additional_writable_roots` widen permissions.

**Data flow**: Loads config with built-in read-only selected and an extra runtime writable root override, then asserts the filesystem policy still cannot write that extra root and active profile metadata remains the built-in read-only profile.

**Call relations**: Tests that runtime workspace-root expansion only matters for writable profiles, not read-only ones.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, vec!).


##### `workspace_profile_applies_rules_to_runtime_and_profile_workspace_roots`  (lines 2181–2278)

```
async fn workspace_profile_applies_rules_to_runtime_and_profile_workspace_roots() -> std::io::Result<()>
```

**Purpose**: Checks that `:workspace_roots` scoped rules apply to both runtime workspace roots and profile-declared workspace roots, while metadata carveouts remain enforced.

**Data flow**: Creates cwd, runtime root, and profile root with `.git` and `.codex` directories, loads a profile that adds the profile root and grants `.` write but `.git`/`.codex` read under `:workspace_roots`, then asserts `config.workspace_roots`, `permissions.workspace_roots()`, `effective_workspace_roots()`, write access to each root, denied writes to metadata subdirs, profile workspace roots list, and active profile metadata.

**Call relations**: This is a key integration test for merging runtime and profile workspace roots into one effective permission surface.

*Call graph*: 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Scoped, create_dir_all, vec!).


##### `explicit_builtin_workspace_profile_ignores_legacy_workspace_write_settings`  (lines 2281–2320)

```
async fn explicit_builtin_workspace_profile_ignores_legacy_workspace_write_settings() -> std::io::Result<()>
```

**Purpose**: Verifies that explicitly selecting built-in `:workspace` does not inherit legacy `sandbox_workspace_write` writable roots or network settings as extra grants.

**Data flow**: Loads config with `default_permissions = :workspace` plus `sandbox_workspace_write` containing an extra writable root and network access, then asserts network policy stays restricted and the filesystem policy contains no concrete entry for the extra root.

**Call relations**: Contrasts explicit built-in profile selection with implicit workspace-write fallback behavior tested elsewhere.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, vec!).


##### `default_permissions_profile_can_extend_builtin_workspace`  (lines 2323–2418)

```
async fn default_permissions_profile_can_extend_builtin_workspace() -> std::io::Result<()>
```

**Purpose**: Checks that a custom profile can extend built-in `:workspace`, inherit its write/carveout behavior, override inherited entries, and add network access.

**Data flow**: Loads a profile extending built-in workspace and adding `:tmpdir = read` plus `network.enabled = true`, then asserts cwd remains writable, `.git` remains protected, inherited `:slash_tmp` write survives, inherited `:tmpdir` write is replaced by read, network policy is enabled, and active profile metadata records the built-in parent.

**Call relations**: Exercises profile inheritance and entry replacement semantics against a built-in parent profile.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access).


##### `default_permissions_profile_can_extend_builtin_read_only`  (lines 2421–2474)

```
async fn default_permissions_profile_can_extend_builtin_read_only() -> std::io::Result<()>
```

**Purpose**: Checks that a custom profile can extend built-in read-only and add network access without gaining write permissions.

**Data flow**: Loads a profile extending built-in read-only with `network.enabled = true`, then asserts cwd remains readable but not writable, network policy is enabled, and active profile metadata records the built-in parent.

**Call relations**: Companion inheritance test for the read-only built-in profile.

*Call graph*: 6 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `empty_config_defaults_to_builtin_profile_for_trusted_project`  (lines 2477–2529)

```
async fn empty_config_defaults_to_builtin_profile_for_trusted_project() -> std::io::Result<()>
```

**Purpose**: Verifies the implicit default permission profile chosen for a trusted project when no explicit permissions config exists.

**Data flow**: Loads config with a `projects` entry marking the cwd trusted, then asserts the active profile id is built-in workspace on non-Windows or read-only on Windows, and checks write/read behavior accordingly, including `.codex` carveouts on non-Windows.

**Call relations**: Tests trust-based implicit defaults and platform-specific Windows downgrade behavior.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `empty_config_defaults_to_builtin_profile_for_untrusted_project`  (lines 2532–2588)

```
async fn empty_config_defaults_to_builtin_profile_for_untrusted_project() -> std::io::Result<()>
```

**Purpose**: Verifies the implicit default permission profile for an untrusted project and confirms it still maps to the same built-in profile choice as trusted projects in current behavior.

**Data flow**: Loads config with the cwd marked untrusted, asserts the active profile id is workspace on non-Windows or read-only on Windows, and checks read/write behavior plus metadata carveouts.

**Call relations**: Pairs with the trusted-project test to document current fallback behavior independent of trust level.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `implicit_builtin_workspace_profile_preserves_sandbox_workspace_write_settings`  (lines 2591–2657)

```
async fn implicit_builtin_workspace_profile_preserves_sandbox_workspace_write_settings() -> std::io::Result<()>
```

**Purpose**: Checks that when workspace-write is chosen implicitly rather than explicitly, legacy `sandbox_workspace_write` settings are preserved in runtime and legacy projections.

**Data flow**: Loads config for a trusted project with `sandbox_workspace_write` writable roots, network access, and tmp exclusions, then asserts the filesystem policy can write the extra root, network policy is enabled, active profile metadata is `None`, and the legacy `SandboxPolicy::WorkspaceWrite` contains the configured roots and flags.

**Call relations**: Contrasts with the explicit built-in workspace test: implicit fallback preserves legacy settings because it cannot be faithfully represented as a named built-in profile.

*Call graph*: 8 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, panic!, vec!).


##### `implicit_builtin_workspace_profile_preserves_add_dir_metadata_carveouts`  (lines 2660–2707)

```
async fn implicit_builtin_workspace_profile_preserves_add_dir_metadata_carveouts() -> std::io::Result<()>
```

**Purpose**: Ensures implicit workspace-write fallback applies metadata carveouts (`.git`, `.agents`, `.codex`) to additional writable roots supplied at runtime.

**Data flow**: Creates an extra writable root containing those metadata directories, loads config for a trusted project with that root in `additional_writable_roots`, then asserts the root itself is writable but each metadata subpath is not.

**Call relations**: Extends the implicit workspace-write behavior to runtime-added roots.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, create_dir_all, vec!).


##### `empty_config_defaults_to_builtin_read_only_without_trust_decision`  (lines 2710–2735)

```
async fn empty_config_defaults_to_builtin_read_only_without_trust_decision() -> std::io::Result<()>
```

**Purpose**: Checks the no-project-metadata fallback: absent any trust decision, config defaults to read-only behavior.

**Data flow**: Loads completely default config with a cwd override and asserts the resulting filesystem policy allows reads but denies writes to the cwd.

**Call relations**: Documents the baseline fallback when no project trust entry exists.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `default_permissions_can_select_builtin_full_access_profile`  (lines 2738–2768)

```
async fn default_permissions_can_select_builtin_full_access_profile() -> std::io::Result<()>
```

**Purpose**: Verifies that selecting the built-in danger/full-access profile maps to `PermissionProfile::Disabled` while retaining active-profile metadata naming the built-in profile.

**Data flow**: Loads config with `default_permissions` set to the built-in full-access id, then asserts the effective permission profile is `Disabled` and the active profile id matches the built-in full-access name.

**Call relations**: Covers the built-in full-access alias path in runtime loading.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `legacy_danger_no_sandbox_is_rejected`  (lines 2771–2794)

```
async fn legacy_danger_no_sandbox_is_rejected() -> std::io::Result<()>
```

**Purpose**: Ensures the removed legacy built-in alias `:danger-no-sandbox` is rejected with a clear error.

**Data flow**: Loads config with `default_permissions = ":danger-no-sandbox"`, expects failure, and asserts the error string says the built-in profile is unknown.

**Call relations**: Compatibility-break test for a removed legacy alias.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `user_defined_permission_profile_names_cannot_use_builtin_prefix`  (lines 2797–2827)

```
async fn user_defined_permission_profile_names_cannot_use_builtin_prefix() -> std::io::Result<()>
```

**Purpose**: Checks that custom permission profile ids cannot start with the reserved built-in `:` prefix.

**Data flow**: Loads config defining a custom profile named `:custom`, expects `InvalidInput`, and asserts the message says the reserved built-in prefix cannot be used.

**Call relations**: Validation test for profile naming rules.

*Call graph*: 6 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `unknown_builtin_permission_profile_name_is_rejected`  (lines 2830–2854)

```
async fn unknown_builtin_permission_profile_name_is_rejected() -> std::io::Result<()>
```

**Purpose**: Ensures unknown built-in-style profile names are rejected when selected via `default_permissions`.

**Data flow**: Loads config with `default_permissions = ":unknown"`, expects `InvalidInput`, and asserts the exact unknown-built-in message.

**Call relations**: Companion to the reserved-prefix and removed-alias tests.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `permissions_profiles_allow_direct_write_roots_outside_workspace_root`  (lines 2857–2920)

```
async fn permissions_profiles_allow_direct_write_roots_outside_workspace_root() -> std::io::Result<()>
```

**Purpose**: Verifies custom permission profiles may grant direct write access to absolute paths outside the workspace roots and that this is reflected in custom profile summaries and legacy projection.

**Data flow**: Creates an external temp dir, canonicalizes it into `AbsolutePathBuf`, loads a profile granting that path `write`, then asserts `config.custom_permission_profiles` contains the profile summary, the runtime filesystem policy can write the external path, and the legacy projection is workspace-write with that path in `writable_roots`.

**Call relations**: Tests non-workspace absolute path grants and their compatibility projection.

*Call graph*: calls 1 internal fn (from_absolute_path); 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, canonicalize, write).


##### `permissions_profiles_reject_nested_entries_for_non_workspace_roots`  (lines 2923–2970)

```
async fn permissions_profiles_reject_nested_entries_for_non_workspace_roots() -> std::io::Result<()>
```

**Purpose**: Ensures nested/scoped filesystem entries are only allowed for `:workspace_roots`, not for other special paths like `:minimal`.

**Data flow**: Loads a profile with `:minimal = { docs = "read" }`, expects `InvalidInput`, and asserts the message says that filesystem path does not support nested entries.

**Call relations**: Validation test for scoped filesystem entry syntax.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Scoped, write).


##### `load_workspace_permission_profile`  (lines 2972–2994)

```
async fn load_workspace_permission_profile(
    profile: PermissionProfileToml,
) -> std::io::Result<Config>
```

**Purpose**: Shared async helper that loads a single custom permission profile named `dev` in a temporary repo-like workspace.

**Data flow**: Creates temp codex home and cwd, writes a `.git` marker into cwd, wraps the supplied `PermissionProfileToml` into `ConfigToml { default_permissions: Some("dev"), permissions: Some(...) }`, and returns the result of `Config::load_from_base_config_with_overrides(...)`.

**Call relations**: Called by tests for unknown special paths and missing/empty filesystem sections to avoid repeating the same temporary setup and profile wrapper.

*Call graph*: called by 4 (permissions_profiles_allow_empty_filesystem_with_warning, permissions_profiles_allow_missing_filesystem_with_warning, permissions_profiles_allow_unknown_special_paths, permissions_profiles_allow_unknown_special_paths_with_nested_entries); 5 external calls (from, default, new, load_from_base_config_with_overrides, write).


##### `permissions_profiles_allow_unknown_special_paths`  (lines 2997–3039)

```
async fn permissions_profiles_allow_unknown_special_paths() -> std::io::Result<()>
```

**Purpose**: Checks that unknown special filesystem paths are accepted as forward-compatible entries, downgraded to warnings, and ignored by legacy projection.

**Data flow**: Uses `load_workspace_permission_profile` with a profile granting `:future_special_path = read`, then asserts the runtime filesystem policy contains a `FileSystemSpecialPath::unknown(...)` entry, the legacy projection is read-only, and startup warnings mention the unrecognized path will be ignored.

**Call relations**: Exercises forward-compatibility behavior for future special-path names.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 4 external calls (from, assert!, assert_eq!, Access).


##### `permissions_profiles_allow_unknown_special_paths_with_nested_entries`  (lines 3042–3079)

```
async fn permissions_profiles_allow_unknown_special_paths_with_nested_entries() -> std::io::Result<()>
```

**Purpose**: Extends the previous test to unknown special paths with nested subpaths.

**Data flow**: Loads a profile with `:future_special_path.docs = read`, then asserts the runtime policy contains `FileSystemSpecialPath::unknown(..., Some("docs"))` and startup warnings mention the nested entry is unrecognized and ignored.

**Call relations**: Companion forward-compatibility test for scoped unknown special paths.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 4 external calls (from, assert!, assert_eq!, Scoped).


##### `permissions_profiles_allow_missing_filesystem_with_warning`  (lines 3082–3110)

```
async fn permissions_profiles_allow_missing_filesystem_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that a permission profile with no filesystem section is accepted but yields an empty restricted policy and a startup warning.

**Data flow**: Loads a profile with `filesystem: None`, then asserts the runtime filesystem policy is `restricted(Vec::new())`, the legacy projection is read-only, and warnings mention no recognized filesystem entries were defined.

**Call relations**: Covers a permissive-but-warning path for incomplete profiles.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 2 external calls (assert!, assert_eq!).


##### `permissions_profiles_allow_empty_filesystem_with_warning`  (lines 3113–3138)

```
async fn permissions_profiles_allow_empty_filesystem_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that an explicitly empty filesystem table behaves like a missing one: empty restricted policy plus warning.

**Data flow**: Loads a profile with `filesystem.entries = BTreeMap::new()`, then asserts an empty restricted policy and a warning about no recognized filesystem entries.

**Call relations**: Companion to the missing-filesystem test for the explicit-empty case.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 3 external calls (new, assert!, assert_eq!).


##### `permissions_profiles_reject_workspace_root_parent_traversal`  (lines 3141–3187)

```
async fn permissions_profiles_reject_workspace_root_parent_traversal() -> std::io::Result<()>
```

**Purpose**: Ensures scoped `:workspace_roots` subpaths cannot contain `.` or `..` traversal components.

**Data flow**: Loads a profile with `:workspace_roots."../sibling" = read`, expects `InvalidInput`, and asserts the message says the subpath must be a descendant path without `.` or `..`.

**Call relations**: Validation test for safe workspace-root subpath compilation.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Scoped, write).


##### `permissions_profiles_allow_network_enablement`  (lines 3190–3235)

```
async fn permissions_profiles_allow_network_enablement() -> std::io::Result<()>
```

**Purpose**: Verifies that a permission profile can enable network access and that both runtime and legacy sandbox views reflect it.

**Data flow**: Loads a profile with `network.enabled = true`, then asserts `config.permissions.network_sandbox_policy().is_enabled()` and `config.legacy_sandbox_policy().has_full_network_access()`.

**Call relations**: Positive-path network enablement test for permission profiles.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, write).


##### `tui_theme_deserializes_from_toml`  (lines 3238–3248)

```
fn tui_theme_deserializes_from_toml()
```

**Purpose**: Checks that `tui.theme` parses as an optional string.

**Data flow**: Parses TOML with `theme = "dracula"` and asserts the decoded `theme` is `Some("dracula")`.

**Call relations**: Simple TUI deserialization test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_theme_defaults_to_none`  (lines 3251–3257)

```
fn tui_theme_defaults_to_none()
```

**Purpose**: Checks that `tui.theme` is absent by default.

**Data flow**: Parses an empty `[tui]` table and asserts `theme` is `None`.

**Call relations**: Default-value companion to the previous theme test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_session_picker_view_deserializes_from_toml`  (lines 3260–3270)

```
fn tui_session_picker_view_deserializes_from_toml()
```

**Purpose**: Checks that `tui.session_picker_view` parses into `SessionPickerViewMode`.

**Data flow**: Parses `session_picker_view = "dense"` and asserts the decoded enum is `Some(SessionPickerViewMode::Dense)`.

**Call relations**: Pure enum deserialization test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_deserializes_from_toml`  (lines 3273–3283)

```
fn tui_pet_deserializes_from_toml()
```

**Purpose**: Checks that `tui.pet` parses as an optional string.

**Data flow**: Parses `pet = "chefito"` and asserts the decoded field is `Some("chefito")`.

**Call relations**: Simple TUI field parsing test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_session_picker_view_defaults_to_none`  (lines 3286–3295)

```
fn tui_session_picker_view_defaults_to_none()
```

**Purpose**: Checks that `session_picker_view` is absent by default.

**Data flow**: Parses an empty `[tui]` table and asserts the decoded field is `None`.

**Call relations**: Default-value companion to the explicit session-picker test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_defaults_to_none`  (lines 3298–3304)

```
fn tui_pet_defaults_to_none()
```

**Purpose**: Checks that `tui.pet` defaults to `None`.

**Data flow**: Parses an empty `[tui]` table and asserts the decoded pet field is absent.

**Call relations**: Default-value companion to the explicit pet test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_deserializes_from_toml`  (lines 3307–3317)

```
fn tui_pet_anchor_deserializes_from_toml()
```

**Purpose**: Checks that `tui.pet_anchor` parses into the `TuiPetAnchor` enum.

**Data flow**: Parses `pet_anchor = "screen-bottom"` and asserts the decoded anchor is `ScreenBottom`.

**Call relations**: Enum deserialization test for pet placement.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_defaults_to_composer`  (lines 3320–3329)

```
fn tui_pet_anchor_defaults_to_composer()
```

**Purpose**: Checks that `pet_anchor` defaults to `Composer`.

**Data flow**: Parses an empty `[tui]` table and asserts the decoded anchor is `Composer`.

**Call relations**: Default-value companion to the explicit pet-anchor test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_rejects_unknown_value`  (lines 3332–3345)

```
fn tui_pet_anchor_rejects_unknown_value()
```

**Purpose**: Ensures invalid `pet_anchor` strings are rejected with an enum-variant error listing valid values.

**Data flow**: Attempts to parse `pet_anchor = "bottom"`, captures the error string, and asserts it mentions the unknown variant plus `composer` and `screen-bottom`.

**Call relations**: Negative parse test for pet-anchor enum validation.

*Call graph*: 1 external calls (assert!).


##### `tui_config_missing_notifications_field_defaults_to_enabled`  (lines 3348–3378)

```
fn tui_config_missing_notifications_field_defaults_to_enabled()
```

**Purpose**: Verifies that omitting notification-related TUI fields yields the full default `Tui` struct, including enabled notifications.

**Data flow**: Parses an empty `[tui]` table and compares the decoded `Tui` against a fully constructed expected default value with `TuiNotificationSettings::default()`, animations/tooltips enabled, default alternate screen, default keymap, default NUX config, and no optional theme/pet/session-picker values.

**Call relations**: Broad default-struct deserialization test for TUI config.

*Call graph*: 1 external calls (assert_eq!).


##### `runtime_config_resolves_terminal_resize_reflow_defaults_and_overrides`  (lines 3381–3436)

```
async fn runtime_config_resolves_terminal_resize_reflow_defaults_and_overrides()
```

**Purpose**: Checks runtime translation of TUI resize-reflow settings into `TerminalResizeReflowConfig`, including the special zero-means-disabled case.

**Data flow**: Loads default config and asserts `max_rows = Auto`, then loads config with `terminal_resize_reflow_max_rows = 9000` and asserts `Limit(9000)`, then loads config with `0` and asserts `Disabled`.

**Call relations**: Runtime counterpart to the raw TOML parsing test for resize reflow.

*Call graph*: 6 external calls (default, load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `forced_chatgpt_workspace_id_empty_values_disable_runtime_restriction`  (lines 3439–3485)

```
async fn forced_chatgpt_workspace_id_empty_values_disable_runtime_restriction() -> std::io::Result<()>
```

**Purpose**: Verifies normalization of `forced_chatgpt_workspace_id` across empty strings, whitespace, empty arrays, and mixed arrays.

**Data flow**: Iterates several TOML cases, parses each into `ConfigToml`, loads runtime config, normalizes expected values into `Option<Vec<String>>`, and asserts `config.forced_chatgpt_workspace_id` matches—dropping blank entries and treating all-empty inputs as `None`.

**Call relations**: Table-driven normalization test for a field that accepts multiple TOML shapes.

*Call graph*: 6 external calls (load_from_base_config_with_overrides, assert_eq!, default, tempdir, from_str, vec!).


##### `legacy_remote_thread_store_endpoint_is_rejected`  (lines 3488–3506)

```
async fn legacy_remote_thread_store_endpoint_is_rejected()
```

**Purpose**: Ensures the deprecated `experimental_thread_store_endpoint` still parses but is rejected during runtime load with a helpful message.

**Data flow**: Parses TOML containing the legacy field, attempts runtime load, expects failure, and asserts the error mentions the field name and that it is no longer supported.

**Call relations**: Compatibility-break test where parse-time acceptance is followed by load-time rejection.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, tempdir, from_str).


##### `profile_tui_rejects_unsupported_settings`  (lines 3509–3521)

```
fn profile_tui_rejects_unsupported_settings()
```

**Purpose**: Checks that profile-scoped TUI config only accepts supported fields and rejects unsupported ones like `theme`.

**Data flow**: Attempts to parse TOML with `[profiles.work.tui] theme = "dark"`, expects an error, and asserts the message mentions an unknown field and `theme`.

**Call relations**: Schema validation test for profile-local config subsets.

*Call graph*: 1 external calls (assert!).


##### `runtime_config_resolves_session_picker_view_default_and_override`  (lines 3524–3553)

```
async fn runtime_config_resolves_session_picker_view_default_and_override()
```

**Purpose**: Verifies runtime defaulting and override behavior for the TUI session picker view mode.

**Data flow**: Loads default config and asserts `tui_session_picker_view = Dense`, then loads config with `tui.session_picker_view = Comfortable` and asserts the runtime field changes accordingly.

**Call relations**: Runtime resolution test for a TUI enum with a non-`None` default.

*Call graph*: 6 external calls (default, load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `test_sandbox_config_parsing`  (lines 3556–3677)

```
async fn test_sandbox_config_parsing()
```

**Purpose**: Checks legacy sandbox-mode TOML parsing and derivation into `SandboxPolicy` for danger-full-access, read-only, and workspace-write modes.

**Data flow**: Parses several TOML snippets, calls `derive_legacy_sandbox_policy_for_test` for each, and asserts the resulting policy matches expected danger-full-access, read-only, or workspace-write values, with Windows-specific downgrade expectations for workspace-write.

**Call relations**: Uses the helper wrapper to validate legacy sandbox semantics independently of the newer permission-profile runtime representation.

*Call graph*: calls 1 internal fn (derive_legacy_sandbox_policy_for_test); 4 external calls (assert_eq!, cfg!, test_absolute_path, format!).


##### `legacy_sandbox_mode_builds_profiles_with_compatible_projection`  (lines 3680–3816)

```
async fn legacy_sandbox_mode_builds_profiles_with_compatible_projection() -> std::io::Result<()>
```

**Purpose**: Ensures legacy `sandbox_mode` inputs are converted into runtime permission profiles whose filesystem/network policies round-trip back to the same legacy sandbox semantics.

**Data flow**: Iterates danger-full-access, read-only, and workspace-write TOML cases, loads runtime config, extracts `legacy_sandbox_policy`, filesystem policy, and network policy, then asserts network semantics match `NetworkSandboxPolicy::from(&sandbox_policy)` and that converting the filesystem policy back to legacy reproduces the original policy. For workspace-write it also checks workspace roots and metadata carveouts, with Windows downgrade handling.

**Call relations**: This is the main compatibility-roundtrip test between legacy sandbox config and the newer runtime permission model.

*Call graph*: 9 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!, test_absolute_path, unreachable!, vec!).


##### `filter_mcp_servers_by_allowlist_enforces_identity_rules`  (lines 3819–3899)

```
fn filter_mcp_servers_by_allowlist_enforces_identity_rules()
```

**Purpose**: Verifies global MCP server requirement filtering disables servers whose names are unlisted or whose command/URL identity does not match the requirement entry.

**Data flow**: Builds a `HashMap<String, McpServerConfig>` with stdio and HTTP servers, constructs a sourced requirements map keyed by server name with expected `McpServerIdentity`, calls `filter_mcp_servers_by_requirements`, then compares the resulting `(enabled, disabled_reason)` pairs for every server against the expected map.

**Call relations**: Uses `stdio_mcp` and `http_mcp` to create baseline servers, then exercises the production requirement-filtering function on global MCP servers.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `filter_mcp_servers_by_allowlist_allows_all_when_unset`  (lines 3902–3923)

```
fn filter_mcp_servers_by_allowlist_allows_all_when_unset()
```

**Purpose**: Checks that absent MCP requirements leave all configured global MCP servers enabled.

**Data flow**: Creates two servers, calls `filter_mcp_servers_by_requirements` with `None`, and asserts both remain `(enabled=true, disabled_reason=None)`.

**Call relations**: Covers the no-requirements branch of the same filtering logic.

*Call graph*: calls 2 internal fn (http_mcp, stdio_mcp); 2 external calls (from, assert_eq!).


##### `filter_mcp_servers_by_allowlist_blocks_all_when_empty`  (lines 3926–3950)

```
fn filter_mcp_servers_by_allowlist_blocks_all_when_empty()
```

**Purpose**: Checks that an explicitly empty MCP requirements map disables every configured global MCP server.

**Data flow**: Creates two servers, constructs `Sourced(BTreeMap::new(), source)`, filters the servers, and asserts both become disabled with `McpServerDisabledReason::Requirements { source }`.

**Call relations**: Covers the empty-allowlist branch of global MCP filtering.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (new, from, assert_eq!).


##### `filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules`  (lines 3953–4012)

```
fn filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules()
```

**Purpose**: Verifies plugin-scoped MCP requirements filter only the listed plugin’s servers and still enforce command identity matching.

**Data flow**: Builds a plugin server map, constructs sourced plugin requirements for `sample@test` with two allowed servers and expected command identities, calls `filter_plugin_mcp_servers_by_requirements("sample@test", ...)`, and asserts matched server stays enabled while mismatched and unlisted servers are disabled with requirement reasons.

**Call relations**: Exercises the plugin-specific variant of MCP requirement filtering.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin`  (lines 4015–4053)

```
fn filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin()
```

**Purpose**: Checks that if requirements mention a different plugin id, all MCP servers for the current plugin are disabled.

**Data flow**: Creates one stdio server, constructs requirements for `other@test` only, filters for `sample@test`, and asserts the server is disabled with a requirements-based reason.

**Call relations**: Covers the plugin-not-listed branch of plugin MCP filtering.

*Call graph*: calls 2 internal fn (new, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `rebuild_preserving_session_layers_refreshes_requirements`  (lines 4056–4262)

```
async fn rebuild_preserving_session_layers_refreshes_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies that rebuilding config while preserving session layers refreshes lower-precedence config and managed requirements, then reapplies session overrides subject to the refreshed requirements.

**Data flow**: Constructs a refreshed `ConfigLayerStack` with user/project/managed layers plus MCP requirements, loads a refreshed config, constructs a thread-local stack with stale user/project/managed layers plus a session-flags layer, loads that config, calls `rebuild_preserving_session_layers(&refreshed_config)`, and asserts the final `mcp_servers` map reflects session overrides where allowed, refreshed managed/user/project values where higher precedence changed, and disables a session-only server blocked by refreshed requirements.

**Call relations**: This is a high-level layering test for config refresh behavior. It drives `Config::load_config_with_layer_stack` twice and then exercises the rebuild path that merges preserved session layers with refreshed base layers and requirements.

*Call graph*: calls 3 internal fn (new, new, resolve_path_against_base); 6 external calls (from, default, new, load_config_with_layer_stack, assert_eq!, vec!).


##### `rebuild_preserving_session_layers_refreshes_plugin_derived_mcp_config`  (lines 4265–4370)

```
async fn rebuild_preserving_session_layers_refreshes_plugin_derived_mcp_config() -> anyhow::Result<()>
```

**Purpose**: Ensures the same rebuild path refreshes plugin-derived MCP server discovery when feature flags change across refreshed config.

**Data flow**: Creates a fake cached plugin with `.codex-plugin/plugin.json` and `.mcp.json`, loads a refreshed config with plugins enabled and a thread config with plugins disabled, rebuilds preserving session layers, converts the result to MCP config via `PluginsManager`, and asserts the plugin-derived HTTP server appears with correct plugin attribution.

**Call relations**: Extends rebuild testing from raw MCP server tables to plugin-discovered MCP registrations.

*Call graph*: calls 3 internal fn (new, new, resolve_path_against_base); 7 external calls (default, new, load_config_with_layer_stack, assert_eq!, create_dir_all, write, vec!).


##### `to_mcp_config_omits_plugin_id_when_user_server_shadows_plugin_mcp`  (lines 4373–4429)

```
async fn to_mcp_config_omits_plugin_id_when_user_server_shadows_plugin_mcp() -> anyhow::Result<()>
```

**Purpose**: Checks that if a user-defined MCP server has the same name as a plugin-provided one, the user server wins and plugin attribution is omitted.

**Data flow**: Creates a fake plugin exposing server `sample`, writes user config enabling plugins and defining `[mcp_servers.sample]` with a different URL, builds config, converts to MCP config, and asserts the configured server uses the user URL while `plugin_attributions_by_server_name()` is empty.

**Call relations**: Exercises precedence between user-configured and plugin-derived MCP servers during `to_mcp_config` assembly.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert!, assert_eq!, default, create_dir_all, write).


##### `selected_plugin_wins_after_discovered_plugin_requirements`  (lines 4432–4536)

```
async fn selected_plugin_wins_after_discovered_plugin_requirements() -> anyhow::Result<()>
```

**Purpose**: Verifies that enterprise requirements can disable discovered plugin MCP servers, but an explicitly selected plugin registration can still override that discovered result afterward.

**Data flow**: Creates a plugin exposing `sample` and `unlisted`, builds config with enterprise requirements allowing only `sample`, converts to MCP config and asserts `sample` stays enabled while `unlisted` is disabled with a requirements reason, then calls `to_mcp_config_with_plugin_registrations` with a selected-plugin registration for `unlisted` and asserts the catalog now serves the selected-plugin source and config.

**Call relations**: Tests the ordering between discovered plugin MCP filtering and later explicit selected-plugin registrations.

*Call graph*: calls 5 internal fn (new, from_selected_plugin, loader_with_enterprise_requirement, new, http_mcp); 5 external calls (new, assert_eq!, default, create_dir_all, write).


##### `to_mcp_config_empty_mcp_requirements_disable_plugin_mcps`  (lines 4539–4602)

```
async fn to_mcp_config_empty_mcp_requirements_disable_plugin_mcps() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicitly empty global MCP requirements table disables plugin-derived MCP servers too.

**Data flow**: Creates a fake plugin with one MCP server, builds config with enterprise requirements containing an empty `[mcp_servers]` table, converts to MCP config, and asserts the plugin server is present but disabled with a requirements-based reason.

**Call relations**: Covers the interaction between global MCP requirements and plugin-discovered servers.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, new); 5 external calls (new, assert_eq!, default, create_dir_all, write).


##### `add_dir_override_extends_workspace_writable_roots`  (lines 4605–4650)

```
async fn add_dir_override_extends_workspace_writable_roots() -> std::io::Result<()>
```

**Purpose**: Verifies `additional_writable_roots` CLI overrides are normalized, deduplicated, and merged into workspace-write legacy sandbox roots.

**Data flow**: Creates frontend/backend directories, loads config with `sandbox_mode = WorkspaceWrite` and `additional_writable_roots` containing both a relative and absolute path to backend, then on non-Windows asserts the legacy workspace-write policy contains exactly one backend root entry; on Windows it asserts the expected read-only downgrade.

**Call relations**: Tests runtime override normalization for additional writable roots in legacy workspace-write mode.

*Call graph*: 9 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, cfg!, default, panic!, create_dir_all, vec!).


##### `default_zsh_path_sets_runtime_zsh_path`  (lines 4653–4669)

```
async fn default_zsh_path_sets_runtime_zsh_path() -> std::io::Result<()>
```

**Purpose**: Checks that a harness override for `default_zsh_path` becomes the runtime `config.zsh_path`.

**Data flow**: Creates a temp packaged-zsh path, loads default config with `ConfigOverrides { default_zsh_path: Some(...) }`, and asserts `config.zsh_path` equals that path.

**Call relations**: Simple override propagation test.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `sqlite_home_defaults_to_codex_home_for_workspace_write`  (lines 4672–4687)

```
async fn sqlite_home_defaults_to_codex_home_for_workspace_write() -> std::io::Result<()>
```

**Purpose**: Verifies that in workspace-write mode the runtime SQLite home defaults to the Codex home directory.

**Data flow**: Loads default config with a sandbox-mode override of workspace-write and asserts `config.sqlite_home == codex_home.path()`.

**Call relations**: Tests one runtime path default that depends on sandbox mode.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `workspace_write_includes_configured_writable_root_once_without_memories_root`  (lines 4690–4741)

```
async fn workspace_write_includes_configured_writable_root_once_without_memories_root() -> std::io::Result<()>
```

**Purpose**: Ensures configured workspace-write roots are deduplicated and that config loading does not create or inject the memories root into writable roots.

**Data flow**: Loads config with duplicate `sandbox_workspace_write.writable_roots`, then on non-Windows asserts the memories directory does not exist and the legacy workspace-write policy contains the configured writable root exactly once and not the memories root; on Windows it asserts read-only downgrade.

**Call relations**: Regression test for writable-root deduplication and memories-root exclusion.

*Call graph*: 8 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!, panic!, vec!).


##### `memory_tool_makes_memories_root_readable_without_creating_or_widening_writes`  (lines 4744–4797)

```
async fn memory_tool_makes_memories_root_readable_without_creating_or_widening_writes() -> std::io::Result<()>
```

**Purpose**: Checks that enabling the memories feature grants read access to the memories root without creating the directory or making it writable.

**Data flow**: Loads workspace-write config with `features.memories = true`, then asserts the memories directory does not exist, the runtime filesystem policy can read but not write the memories root, and the legacy workspace-write projection does not include that root in writable roots.

**Call relations**: Targets the interaction between the memories feature and sandbox permissions.

*Call graph*: calls 1 internal fn (from); 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, cfg!, panic!).


##### `config_defaults_to_file_cli_auth_store_mode`  (lines 4800–4817)

```
async fn config_defaults_to_file_cli_auth_store_mode() -> std::io::Result<()>
```

**Purpose**: Verifies the default runtime CLI auth credential store mode is `AuthCredentialsStoreMode::File`.

**Data flow**: Loads default config and asserts `config.cli_auth_credentials_store_mode == File`.

**Call relations**: Simple runtime default test for auth storage.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `config_resolves_explicit_keyring_auth_store_mode`  (lines 4820–4843)

```
async fn config_resolves_explicit_keyring_auth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit CLI auth store mode of `Keyring` is resolved through the production helper, which may rewrite it depending on build version.

**Data flow**: Loads config with `cli_auth_credentials_store = Keyring`, then asserts the runtime mode equals `resolve_cli_auth_credentials_store_mode(Keyring, env!("CARGO_PKG_VERSION"))`.

**Call relations**: Delegates expected behavior to the same resolver used in production, validating loader wiring rather than duplicating version logic.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `config_resolves_default_oauth_store_mode`  (lines 4846–4866)

```
async fn config_resolves_default_oauth_store_mode() -> std::io::Result<()>
```

**Purpose**: Verifies the default MCP OAuth credential store mode is resolved from `Auto` using the production resolver.

**Data flow**: Loads default config and asserts `config.mcp_oauth_credentials_store_mode` equals `resolve_mcp_oauth_credentials_store_mode(Auto, env!("CARGO_PKG_VERSION"))`.

**Call relations**: Runtime default test for OAuth credential storage.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `local_dev_builds_force_file_cli_auth_store_modes`  (lines 4869–4895)

```
fn local_dev_builds_force_file_cli_auth_store_modes()
```

**Purpose**: Checks the standalone resolver logic that local-dev builds force file-based CLI auth storage except for ephemeral mode.

**Data flow**: Calls `resolve_cli_auth_credentials_store_mode` with `Keyring`, `Auto`, and `Ephemeral` under `LOCAL_DEV_BUILD_VERSION`, plus `Keyring` under a normal version string, and asserts the returned modes are `File`, `File`, `Ephemeral`, and `Keyring` respectively.

**Call relations**: Pure unit test of the resolver helper, independent of config loading.

*Call graph*: 1 external calls (assert_eq!).


##### `local_dev_builds_force_file_mcp_oauth_store_modes`  (lines 4898–4917)

```
fn local_dev_builds_force_file_mcp_oauth_store_modes()
```

**Purpose**: Checks the analogous resolver behavior for MCP OAuth credential storage in local-dev builds.

**Data flow**: Calls `resolve_mcp_oauth_credentials_store_mode` with `Keyring` and `Auto` under `LOCAL_DEV_BUILD_VERSION` and with `Keyring` under a normal version, asserting file fallback for local-dev and keyring preservation otherwise.

**Call relations**: Pure unit test for the OAuth store-mode resolver.

*Call graph*: 1 external calls (assert_eq!).


##### `feedback_enabled_defaults_to_true`  (lines 4920–4937)

```
async fn feedback_enabled_defaults_to_true() -> std::io::Result<()>
```

**Purpose**: Verifies that feedback remains enabled when the feedback table is present but empty.

**Data flow**: Loads config with `feedback: Some(FeedbackConfigToml::default())` and asserts `config.feedback_enabled == true`.

**Call relations**: Runtime defaulting test for feedback config.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `web_search_mode_defaults_to_none_if_unset`  (lines 4940–4945)

```
fn web_search_mode_defaults_to_none_if_unset()
```

**Purpose**: Checks that absent explicit config and legacy feature flags, web search mode resolves to `None`.

**Data flow**: Creates `ConfigToml::default()` and `Features::with_defaults()`, calls `resolve_web_search_mode`, and asserts it returns `None`.

**Call relations**: Pure resolver test for web-search mode selection.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (assert_eq!, default).


##### `web_search_mode_prefers_config_over_legacy_flags`  (lines 4948–4960)

```
fn web_search_mode_prefers_config_over_legacy_flags()
```

**Purpose**: Verifies explicit `web_search` config wins over legacy feature toggles.

**Data flow**: Builds `ConfigToml { web_search: Some(Live) }`, enables `Feature::WebSearchCached` in a `Features` set, calls `resolve_web_search_mode`, and asserts the result is `Some(Live)`.

**Call relations**: Resolver precedence test between new config and legacy feature aliases.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (default, assert_eq!).


##### `web_search_mode_disabled_overrides_legacy_request`  (lines 4963–4975)

```
fn web_search_mode_disabled_overrides_legacy_request()
```

**Purpose**: Checks that explicit `web_search = disabled` overrides a legacy feature requesting web search.

**Data flow**: Builds config with `web_search = Disabled`, enables `Feature::WebSearchRequest`, resolves the mode, and asserts `Some(Disabled)`.

**Call relations**: Companion precedence test for the disabled case.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (default, assert_eq!).


##### `web_search_mode_for_turn_uses_preference_for_read_only`  (lines 4978–4984)

```
fn web_search_mode_for_turn_uses_preference_for_read_only()
```

**Purpose**: Verifies per-turn web-search resolution keeps the configured preference when the permission profile is read-only.

**Data flow**: Wraps `WebSearchMode::Cached` in `Constrained::allow_any`, passes it with `PermissionProfile::read_only()` to `resolve_web_search_mode_for_turn`, and asserts the result is `Cached`.

**Call relations**: Pure resolver test for turn-level mode selection under read-only permissions.

*Call graph*: calls 2 internal fn (allow_any, read_only); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_prefers_live_for_disabled_permissions`  (lines 4987–4992)

```
fn web_search_mode_for_turn_prefers_live_for_disabled_permissions()
```

**Purpose**: Checks that when permissions are fully disabled/full-access, per-turn web search prefers live mode over a cached preference.

**Data flow**: Creates unconstrained cached mode, resolves it for `PermissionProfile::Disabled`, and asserts the result is `Live`.

**Call relations**: Covers the full-access branch of turn-level web-search resolution.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_respects_disabled_for_disabled_permissions`  (lines 4995–5000)

```
fn web_search_mode_for_turn_respects_disabled_for_disabled_permissions()
```

**Purpose**: Ensures that if the configured mode is explicitly disabled, full-access permissions do not force it to live.

**Data flow**: Creates unconstrained disabled mode, resolves it for `PermissionProfile::Disabled`, and asserts the result remains `Disabled`.

**Call relations**: Companion to the previous test for the explicit-disabled branch.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_falls_back_when_live_is_disallowed`  (lines 5003–5021)

```
fn web_search_mode_for_turn_falls_back_when_live_is_disallowed() -> anyhow::Result<()>
```

**Purpose**: Checks that turn-level resolution falls back to the constrained configured mode when live mode would violate requirements.

**Data flow**: Builds a `Constrained<WebSearchMode>` that only allows `Disabled` or `Cached`, resolves it for `PermissionProfile::Disabled`, and asserts the result is `Cached` rather than `Live`.

**Call relations**: Tests interaction between permission-based preference and requirement constraints.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `project_profiles_are_ignored`  (lines 5024–5072)

```
async fn project_profiles_are_ignored() -> std::io::Result<()>
```

**Purpose**: Verifies that project-local `.codex/config.toml` profile selection and profile definitions are ignored, with a startup warning instead of affecting runtime config.

**Data flow**: Writes a trusted-project entry in user config, creates a project-local config selecting `profile = "project"` and defining `[profiles.project] model = ...`, builds config for that workspace, then asserts `config.model` remains `None` and startup warnings mention ignored `profile`/`profiles` keys and instruct the user to move settings to user-level config.

**Call relations**: Exercises project-config loading and the intentional exclusion of profile selection/definitions from project-local scope.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, write).


##### `feature_table_overrides_legacy_flags`  (lines 5075–5094)

```
async fn feature_table_overrides_legacy_flags() -> std::io::Result<()>
```

**Purpose**: Checks that explicit `[features]` entries override legacy top-level experimental toggles.

**Data flow**: Builds `ConfigToml` with `features.apply_patch_freeform = false`, loads runtime config, and asserts `Feature::ApplyPatchFreeform` is disabled.

**Call relations**: Runtime feature-resolution precedence test.

*Call graph*: calls 1 internal fn (from); 6 external calls (new, default, new, load_from_base_config_with_overrides, assert!, default).


##### `legacy_toggles_map_to_features`  (lines 5097–5116)

```
async fn legacy_toggles_map_to_features() -> std::io::Result<()>
```

**Purpose**: Verifies a legacy experimental toggle still maps into the canonical feature set and legacy runtime boolean.

**Data flow**: Loads config with `experimental_use_unified_exec_tool = true`, then asserts `Feature::UnifiedExec` is enabled and `config.use_experimental_unified_exec_tool` is true.

**Call relations**: Compatibility test for legacy feature aliases.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `responses_websocket_features_do_not_change_wire_api`  (lines 5119–5140)

```
async fn responses_websocket_features_do_not_change_wire_api() -> std::io::Result<()>
```

**Purpose**: Ensures enabling websocket-related response features does not alter the selected model provider wire API away from `WireApi::Responses`.

**Data flow**: Loops over two feature keys, loads config with each enabled, and asserts `config.model_provider.wire_api == WireApi::Responses`.

**Call relations**: Regression test guarding against unintended provider API switching from feature flags.

*Call graph*: calls 1 internal fn (from); 6 external calls (new, default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `config_honors_explicit_file_oauth_store_mode`  (lines 5143–5163)

```
async fn config_honors_explicit_file_oauth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that explicitly setting MCP OAuth credential storage to `File` is preserved at runtime.

**Data flow**: Loads config with `mcp_oauth_credentials_store = File` and asserts `config.mcp_oauth_credentials_store_mode == File`.

**Call relations**: Simple runtime propagation test for explicit OAuth store mode.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `managed_config_overrides_oauth_store_mode`  (lines 5166–5212)

```
async fn managed_config_overrides_oauth_store_mode() -> anyhow::Result<()>
```

**Purpose**: Verifies managed config layers override user config for OAuth credential store mode before runtime resolution.

**Data flow**: Writes user config with `file` and managed config with `keyring`, loads layered config state via `load_config_layers_state`, deserializes the effective TOML, asserts the merged `ConfigToml` contains `Keyring`, then loads runtime config and asserts the resolved runtime mode matches the production resolver for `Keyring`.

**Call relations**: Exercises the lower-level layer loader plus final runtime load to prove managed precedence over user config.

*Call graph*: calls 1 internal fn (with_managed_config_path_for_tests); 6 external calls (new, new, load_from_base_config_with_overrides, assert_eq!, default, write).


##### `load_global_mcp_servers_returns_empty_if_missing`  (lines 5215–5222)

```
async fn load_global_mcp_servers_returns_empty_if_missing() -> anyhow::Result<()>
```

**Purpose**: Checks that loading global MCP servers from a home directory with no config file returns an empty map rather than failing.

**Data flow**: Creates an empty temp home, calls `load_global_mcp_servers`, and asserts the returned map is empty.

**Call relations**: Simple I/O-path test for MCP server loading defaults.

*Call graph*: 2 external calls (new, assert!).


##### `replace_mcp_servers_round_trips_entries`  (lines 5225–5294)

```
async fn replace_mcp_servers_round_trips_entries() -> anyhow::Result<()>
```

**Purpose**: Verifies `ConfigEdit::ReplaceMcpServers` writes MCP server config to disk and `load_global_mcp_servers` reads it back faithfully, including durations and cwd.

**Data flow**: Builds a `BTreeMap` with one stdio server containing args, cwd, startup/tool timeouts, and non-default environment id, applies the edit with `apply_blocking`, reloads servers from disk, pattern-matches the transport and asserts all fields, then repeats with an empty map and asserts loading returns empty.

**Call relations**: Exercises the edit/write path and the read path together as a round-trip persistence test.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (new, from_secs, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, vec!).


##### `managed_config_wins_over_cli_overrides`  (lines 5297–5329)

```
async fn managed_config_wins_over_cli_overrides() -> anyhow::Result<()>
```

**Purpose**: Checks that managed config has higher precedence than CLI TOML-path overrides during layer merging.

**Data flow**: Writes user config `model = "base"` and managed config `model = "managed_config"`, loads config layers with a CLI override setting `model = "cli"`, deserializes the effective config, and asserts `cfg.model == Some("managed_config")`.

**Call relations**: Layer-precedence test at the merged-TOML stage rather than final runtime config.

*Call graph*: calls 1 internal fn (with_managed_config_path_for_tests); 4 external calls (new, String, assert_eq!, write).


##### `load_global_mcp_servers_accepts_legacy_ms_field`  (lines 5332–5351)

```
async fn load_global_mcp_servers_accepts_legacy_ms_field() -> anyhow::Result<()>
```

**Purpose**: Ensures MCP server loading still accepts the legacy `startup_timeout_ms` field and converts it to seconds-based runtime storage.

**Data flow**: Writes a config file with `[mcp_servers.docs] command = "echo" startup_timeout_ms = 2500`, loads global MCP servers, and asserts `startup_timeout_sec == Some(Duration::from_millis(2500))`.

**Call relations**: Backward-compatibility test for MCP server timeout field migration.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `mcp_servers_toml_parses_per_tool_approval_overrides`  (lines 5354–5383)

```
fn mcp_servers_toml_parses_per_tool_approval_overrides()
```

**Purpose**: Checks TOML parsing for MCP server default tool approval mode and per-tool approval overrides.

**Data flow**: Parses a config with `[mcp_servers.docs] default_tools_approval_mode = "prompt"` and `[mcp_servers.docs.tools.search] approval_mode = "approve"`, then asserts the decoded server has `default_tools_approval_mode = Some(Prompt)` and a `tools["search"]` entry with `approval_mode = Some(Approve)`.

**Call relations**: Pure deserialization test for nested MCP server tool config.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_servers_toml_ignores_unknown_server_fields`  (lines 5386–5400)

```
fn mcp_servers_toml_ignores_unknown_server_fields()
```

**Purpose**: Verifies unknown fields under an MCP server table are ignored rather than causing parse failure.

**Data flow**: Parses TOML with `[mcp_servers.docs] command = "docs-server" trust_level = "trusted"` and asserts the decoded server equals the baseline `stdio_mcp("docs-server")`.

**Call relations**: Schema leniency test for MCP server tables.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_servers_toml_parses_tool_approval_override_for_reserved_name`  (lines 5403–5426)

```
fn mcp_servers_toml_parses_tool_approval_override_for_reserved_name()
```

**Purpose**: Checks that per-tool approval overrides work even when the tool name is `command`, a potentially reserved-looking identifier.

**Data flow**: Parses TOML defining `[mcp_servers.docs.tools.command] approval_mode = "approve"`, extracts the tool config, and asserts it equals `McpServerToolConfig { approval_mode: Some(Approve) }`.

**Call relations**: Regression test for nested tool-table parsing with a reserved-ish key.

*Call graph*: 1 external calls (assert_eq!).


##### `desktop_toml_round_trips_opaque_nested_values`  (lines 5429–5477)

```
fn desktop_toml_round_trips_opaque_nested_values() -> anyhow::Result<()>
```

**Purpose**: Verifies the `desktop` config section preserves arbitrary nested values as opaque JSON-like data and round-trips through TOML serialization.

**Data flow**: Parses TOML with scalar, array, and nested-table desktop settings, asserts the resulting `desktop` map contains the expected `serde_json::Value` entries, serializes the whole `ConfigToml` back to TOML, reparses it, and asserts the `desktop` field is unchanged.

**Call relations**: Pure serialization/deserialization round-trip test for an intentionally opaque config subtree.

*Call graph*: 2 external calls (assert_eq!, to_string).


##### `to_mcp_config_preserves_apps_feature_from_config`  (lines 5480–5504)

```
async fn to_mcp_config_preserves_apps_feature_from_config() -> std::io::Result<()>
```

**Purpose**: Checks that `Config::to_mcp_config` derives `apps_enabled` from the feature set and carries through `apps_mcp_product_sku`.

**Data flow**: Loads default config, sets `config.apps_mcp_product_sku = Some("tpp")`, converts to MCP config and asserts apps are enabled with that SKU, then disables and re-enables `Feature::Apps` on the mutable feature set and asserts `apps_enabled` toggles accordingly.

**Call relations**: Exercises runtime MCP-config assembly from mutable in-memory config state.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, load_from_base_config_with_overrides, assert!, assert_eq!, default, default).


##### `to_mcp_config_flows_mcp_tool_prefix_from_feature`  (lines 5507–5525)

```
async fn to_mcp_config_flows_mcp_tool_prefix_from_feature() -> std::io::Result<()>
```

**Purpose**: Verifies MCP tool-name prefixing in generated MCP config is controlled by the `NonPrefixedMcpToolNames` feature.

**Data flow**: Loads default config, converts to MCP config and asserts `prefix_mcp_tool_names` is true, then enables `Feature::NonPrefixedMcpToolNames`, converts again, and asserts the flag becomes false.

**Call relations**: Tests feature-to-MCP-config translation for tool naming.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, load_from_base_config_with_overrides, assert!, default, default).


##### `to_mcp_config_preserves_auth_elicitation_feature_from_config`  (lines 5528–5555)

```
async fn to_mcp_config_preserves_auth_elicitation_feature_from_config() -> std::io::Result<()>
```

**Purpose**: Checks that enabling `Feature::AuthElicitation` adds form and URL elicitation capabilities to generated MCP config.

**Data flow**: Loads default config, converts to MCP config and asserts default `ElicitationCapability`, then enables `Feature::AuthElicitation`, converts again, and asserts the capability contains default `FormElicitationCapability` and `UrlElicitationCapability`.

**Call relations**: Feature-to-MCP-client-capability translation test.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `load_global_mcp_servers_rejects_inline_bearer_token`  (lines 5558–5580)

```
async fn load_global_mcp_servers_rejects_inline_bearer_token() -> anyhow::Result<()>
```

**Purpose**: Ensures MCP server loading rejects insecure inline `bearer_token` fields and points users to `bearer_token_env_var`.

**Data flow**: Writes a config file with an HTTP MCP server containing `bearer_token = "secret"`, calls `load_global_mcp_servers`, expects `InvalidData`, and asserts the error mentions both `bearer_token` and `bearer_token_env_var`.

**Call relations**: I/O validation test for secure MCP server credential configuration.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `replace_mcp_servers_serializes_env_sorted`  (lines 5583–5659)

```
async fn replace_mcp_servers_serializes_env_sorted() -> anyhow::Result<()>
```

**Purpose**: Checks that writing stdio MCP servers serializes inline environment variables in sorted key order and round-trips them correctly.

**Data flow**: Builds a server with `env = { ZIG_VAR: 3, ALPHA_VAR: 1 }`, applies `ReplaceMcpServers`, reads the raw config file and asserts exact TOML ordering under `[mcp_servers.docs.env]`, then reloads servers and asserts the env map contents and transport fields.

**Call relations**: Persistence-format regression test for deterministic MCP server serialization.

*Call graph*: calls 1 internal fn (apply_blocking); 11 external calls (from, from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string (+1 more)).


##### `replace_mcp_servers_serializes_env_vars`  (lines 5662–5714)

```
async fn replace_mcp_servers_serializes_env_vars() -> anyhow::Result<()>
```

**Purpose**: Verifies stdio MCP `env_vars` lists are serialized and loaded back intact.

**Data flow**: Writes a server with `env_vars = ["ALPHA", "BETA"]`, asserts the serialized TOML contains that array, reloads servers, and asserts the transport’s `env_vars` vector matches.

**Call relations**: Companion persistence test for environment-variable passthrough references.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string, vec!).


##### `replace_mcp_servers_serializes_sourced_env_vars`  (lines 5717–5770)

```
async fn replace_mcp_servers_serializes_sourced_env_vars() -> anyhow::Result<()>
```

**Purpose**: Checks serialization and round-trip loading for mixed legacy string env vars and structured `McpServerEnvVar::Config` entries.

**Data flow**: Writes a server whose `env_vars` contains both a plain string and `{ name, source }`, asserts the serialized TOML contains the mixed array form, reloads servers, and asserts the loaded map equals the original `servers` map exactly.

**Call relations**: Persistence test for the richer env-var schema.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string, vec!).


##### `replace_mcp_servers_serializes_cwd`  (lines 5773–5826)

```
async fn replace_mcp_servers_serializes_cwd() -> anyhow::Result<()>
```

**Purpose**: Verifies stdio MCP server `cwd` is serialized to TOML and restored on load.

**Data flow**: Writes a server with `cwd = Some(PathBuf::from("/tmp/codex-mcp"))`, asserts the raw TOML contains that field, reloads servers, and pattern-matches the transport to confirm the same cwd path.

**Call relations**: Persistence test for stdio transport working-directory support.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, new, from, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_serializes_bearer_token`  (lines 5829–5893)

```
async fn replace_mcp_servers_streamable_http_serializes_bearer_token() -> anyhow::Result<()>
```

**Purpose**: Checks HTTP MCP server serialization for `bearer_token_env_var` and startup timeout.

**Data flow**: Writes a streamable HTTP server with URL, bearer-token env var, and startup timeout, asserts the exact serialized TOML, reloads servers, and confirms transport fields plus `startup_timeout_sec`.

**Call relations**: Persistence test for HTTP transport optional auth and timeout fields.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, from_secs, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_serializes_custom_headers`  (lines 5896–5973)

```
async fn replace_mcp_servers_streamable_http_serializes_custom_headers() -> anyhow::Result<()>
```

**Purpose**: Verifies HTTP MCP custom headers and env-backed headers serialize into separate nested TOML tables and round-trip correctly.

**Data flow**: Writes a server with `http_headers` and `env_http_headers`, asserts the exact serialized TOML sections, reloads servers, and confirms both header maps are preserved.

**Call relations**: Companion persistence test for HTTP header configuration.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, from_secs, from, new, new, ReplaceMcpServers, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_removes_optional_sections`  (lines 5976–6077)

```
async fn replace_mcp_servers_streamable_http_removes_optional_sections() -> anyhow::Result<()>
```

**Purpose**: Ensures rewriting an HTTP MCP server with optional auth/header fields removed deletes those TOML sections instead of leaving stale data behind.

**Data flow**: First writes a server with bearer token and header sections and confirms they appear in the file, then rewrites the same server with all optional fields `None`, asserts the resulting file contains only the URL table, reloads servers, and confirms all optional transport fields and startup timeout are absent.

**Call relations**: Regression test for idempotent overwrite behavior in MCP server serialization.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, from_secs, from, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_isolates_headers_between_servers`  (lines 6080–6196)

```
async fn replace_mcp_servers_streamable_http_isolates_headers_between_servers() -> anyhow::Result<()>
```

**Purpose**: Checks that HTTP header sections are emitted only for the HTTP server that needs them and do not bleed into unrelated stdio server entries.

**Data flow**: Writes one HTTP server with headers and one stdio server, reads the serialized config and asserts only the HTTP server has header sections or bearer-token fields, then reloads and confirms the HTTP headers are preserved while the stdio server still has no env map.

**Call relations**: Multi-server serialization isolation test.

*Call graph*: calls 1 internal fn (apply_blocking); 12 external calls (from, from_secs, from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic! (+2 more)).


##### `replace_mcp_servers_serializes_disabled_flag`  (lines 6199–6246)

```
async fn replace_mcp_servers_serializes_disabled_flag() -> anyhow::Result<()>
```

**Purpose**: Verifies the MCP server `enabled = false` flag is serialized and loaded back.

**Data flow**: Writes a disabled stdio server, asserts the raw TOML contains `enabled = false`, reloads servers, and asserts the loaded server’s `enabled` field is false.

**Call relations**: Persistence test for the enabled/disabled state.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, new, ReplaceMcpServers, assert!, read_to_string).


##### `replace_mcp_servers_serializes_required_flag`  (lines 6249–6296)

```
async fn replace_mcp_servers_serializes_required_flag() -> anyhow::Result<()>
```

**Purpose**: Verifies the MCP server `required = true` flag is serialized and loaded back.

**Data flow**: Writes a required stdio server, asserts the raw TOML contains `required = true`, reloads servers, and asserts the loaded server’s `required` field is true.

**Call relations**: Persistence test for the required-server flag.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, new, ReplaceMcpServers, assert!, read_to_string).


##### `replace_mcp_servers_serializes_tool_filters`  (lines 6299–6351)

```
async fn replace_mcp_servers_serializes_tool_filters() -> anyhow::Result<()>
```

**Purpose**: Checks serialization and round-trip loading of MCP server `enabled_tools` and `disabled_tools` filters.

**Data flow**: Writes a stdio server with one enabled tool and one disabled tool, asserts the raw TOML contains both arrays, reloads servers, and asserts the loaded vectors match.

**Call relations**: Persistence test for MCP tool filtering config.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string, vec!).


##### `replace_mcp_servers_streamable_http_serializes_oauth_resource`  (lines 6354–6405)

```
async fn replace_mcp_servers_streamable_http_serializes_oauth_resource() -> anyhow::Result<()>
```

**Purpose**: Verifies HTTP MCP OAuth client metadata and `oauth_resource` serialize and load correctly.

**Data flow**: Writes an HTTP server with `oauth.client_id` and `oauth_resource`, asserts the raw TOML contains the nested `[oauth]` table and resource field, reloads servers, and asserts `oauth_resource` and `oauth_client_id()` match.

**Call relations**: Persistence test for MCP OAuth metadata.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string).


##### `set_model_updates_defaults`  (lines 6408–6423)

```
async fn set_model_updates_defaults() -> anyhow::Result<()>
```

**Purpose**: Checks that `ConfigEditsBuilder::set_model` writes top-level model defaults and reasoning effort into the selected config file.

**Data flow**: Creates a temp home, applies `ConfigEditsBuilder::new(...).set_model(Some("gpt-5.4"), Some(High)).apply()`, reads the resulting `config.toml`, parses it as `ConfigToml`, and asserts `model` and `model_reasoning_effort` were written.

**Call relations**: Exercises the config-edit builder’s write path for model defaults.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, read_to_string, from_str).


##### `for_config_writes_selected_user_config_file`  (lines 6426–6458)

```
async fn for_config_writes_selected_user_config_file() -> anyhow::Result<()>
```

**Purpose**: Verifies `ConfigEditsBuilder::for_config` writes to the currently selected profile-v2 user config file rather than the base `config.toml`.

**Data flow**: Creates base and selected config files, builds a `Config` whose loader overrides point at the selected file/profile, applies `ConfigEditsBuilder::for_config(&config).set_model(...)`, then reads both files and asserts only the selected config changed.

**Call relations**: Tests edit-target selection based on loaded config metadata.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, without_managed_config_for_tests); 6 external calls (new, assert_eq!, for_config, read_to_string, write, from_str).


##### `profile_v2_config_path_resolves_validated_names`  (lines 6461–6469)

```
fn profile_v2_config_path_resolves_validated_names() -> anyhow::Result<()>
```

**Purpose**: Checks that a validated `ProfileV2Name` maps to the expected `<name>.config.toml` path under Codex home.

**Data flow**: Parses `"work"` into `ProfileV2Name`, calls `resolve_profile_v2_config_path`, and asserts the returned absolute path is `codex_home/work.config.toml`.

**Call relations**: Pure path-resolution helper test.

*Call graph*: 2 external calls (new, assert_eq!).


##### `set_model_overwrites_existing_model`  (lines 6472–6507)

```
async fn set_model_overwrites_existing_model() -> anyhow::Result<()>
```

**Purpose**: Ensures `set_model` updates top-level model settings without disturbing profile-specific model settings already present in the file.

**Data flow**: Seeds `config.toml` with top-level model fields and `[profiles.dev].model`, applies `set_model(Some("o4-mini"), Some(High))`, reparses the file, and asserts the top-level model fields changed while `profiles.dev.model` stayed `gpt-4.1`.

**Call relations**: Regression test for targeted TOML editing that preserves unrelated sections.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, read_to_string, write, from_str).


##### `PrecedenceTestFixture::cwd_path`  (lines 6516–6518)

```
fn cwd_path(&self) -> PathBuf
```

**Purpose**: Returns the temporary cwd path stored in the precedence test fixture.

**Data flow**: Reads `self.cwd.path()` from the `TempDir` and clones it into a `PathBuf` return value. It does not mutate fixture state.

**Call relations**: Used by precedence-oriented tests to pass a stable cwd override into config loading.

*Call graph*: 1 external calls (path).


##### `PrecedenceTestFixture::codex_home`  (lines 6520–6522)

```
fn codex_home(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the fixture’s temporary Codex home as an `AbsolutePathBuf`.

**Data flow**: Calls the `abs()` test-support helper on `self.codex_home` and returns the resulting absolute path wrapper.

**Call relations**: Used alongside `cwd_path` by tests that repeatedly load config from the same baseline fixture.

*Call graph*: 1 external calls (abs).


##### `cli_override_sets_compact_prompt`  (lines 6526–6546)

```
async fn cli_override_sets_compact_prompt() -> std::io::Result<()>
```

**Purpose**: Verifies a CLI/harness override can directly set the runtime compact prompt string.

**Data flow**: Loads default config with `ConfigOverrides { compact_prompt: Some("Use the compact override".to_string()), .. }` and asserts `config.compact_prompt.as_deref()` matches that string.

**Call relations**: Simple override precedence test for compact prompt text.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `loads_compact_prompt_from_file`  (lines 6549–6576)

```
async fn loads_compact_prompt_from_file() -> std::io::Result<()>
```

**Purpose**: Checks that `experimental_compact_prompt_file` loads prompt text from disk and trims surrounding whitespace.

**Data flow**: Creates a workspace and prompt file containing padded text, loads config with `experimental_compact_prompt_file` pointing at that file and cwd set to the workspace, then asserts `config.compact_prompt` equals the trimmed string `"summarize differently"`.

**Call relations**: Exercises file-backed prompt loading during runtime config resolution.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, create_dir_all, write).


##### `load_config_uses_requirements_guardian_policy_config`  (lines 6579–6611)

```
async fn load_config_uses_requirements_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Verifies managed requirements can supply `guardian_policy_config` and that runtime loading trims and uses it.

**Data flow**: Constructs a `ConfigLayerStack` whose requirements TOML contains padded `guardian_policy_config`, loads config with that stack, and asserts `config.guardian_policy_config` equals the trimmed managed string.

**Call relations**: Tests requirements-to-runtime propagation for guardian policy text.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, new, load_config_with_layer_stack, assert_eq!, default).


##### `config_toml_deserializes_auto_review_policy`  (lines 6614–6629)

```
fn config_toml_deserializes_auto_review_policy()
```

**Purpose**: Checks that `[auto_review].policy` parses as an optional string in `ConfigToml`.

**Data flow**: Parses TOML with `[auto_review] policy = ...` and asserts the nested optional string is present.

**Call relations**: Pure deserialization test for auto-review guardian policy text.

*Call graph*: 1 external calls (assert_eq!).


##### `load_config_uses_auto_review_guardian_policy_config`  (lines 6632–6657)

```
async fn load_config_uses_auto_review_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Verifies user-configured auto-review policy text becomes the runtime guardian policy config after trimming.

**Data flow**: Loads config with `auto_review.policy` containing padded text and asserts `config.guardian_policy_config` equals the trimmed string.

**Call relations**: Runtime counterpart to the previous TOML parsing test.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `requirements_guardian_policy_beats_auto_review`  (lines 6660–6696)

```
async fn requirements_guardian_policy_beats_auto_review() -> std::io::Result<()>
```

**Purpose**: Checks that managed requirements override user `auto_review.policy` when both specify guardian policy text.

**Data flow**: Builds a layer stack with requirements guardian policy text, loads config from a `ConfigToml` that also contains `auto_review.policy`, and asserts the runtime guardian policy uses the managed value.

**Call relations**: Precedence test between requirements and user config for guardian policy.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, new, load_config_with_layer_stack, assert_eq!).


##### `load_config_ignores_empty_auto_review_guardian_policy_config`  (lines 6699–6721)

```
async fn load_config_ignores_empty_auto_review_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Ensures blank or whitespace-only `auto_review.policy` is normalized away to `None`.

**Data flow**: Loads config with `auto_review.policy = "   "` and asserts `config.guardian_policy_config == None`.

**Call relations**: Normalization test for empty user guardian policy text.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `load_config_ignores_empty_requirements_guardian_policy_config`  (lines 6724–6751)

```
async fn load_config_ignores_empty_requirements_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Ensures blank managed `guardian_policy_config` is also normalized away to `None`.

**Data flow**: Builds a layer stack with whitespace-only requirements guardian policy text, loads config, and asserts `config.guardian_policy_config == None`.

**Call relations**: Managed-requirements counterpart to the previous normalization test.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, new, load_config_with_layer_stack, assert_eq!, default).


##### `load_config_rejects_missing_agent_role_config_file`  (lines 6754–6788)

```
async fn load_config_rejects_missing_agent_role_config_file() -> std::io::Result<()>
```

**Purpose**: Checks that legacy split agent-role entries referencing a nonexistent `config_file` are rejected during config load.

**Data flow**: Builds `ConfigToml` with `agents.roles.researcher.config_file` pointing at a missing path, attempts runtime load, expects `InvalidInput`, and asserts the message mentions `agents.researcher.config_file` and that it must point to an existing file.

**Call relations**: Validation test for legacy split agent-role file references.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `agent_role_relative_config_file_resolves_against_config_toml`  (lines 6791–6837)

```
async fn agent_role_relative_config_file_resolves_against_config_toml() -> std::io::Result<()>
```

**Purpose**: Verifies relative `agents.<role>.config_file` paths are resolved relative to the user `config.toml` location.

**Data flow**: Creates `codex_home/agents/researcher.toml`, writes user config with `config_file = "./agents/researcher.toml"`, builds config, and asserts the loaded role stores the absolute file path and normalized nickname candidates.

**Call relations**: Exercises path resolution for legacy split agent-role config loaded from the user config file.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_relative_config_file_resolves_from_config_layer`  (lines 6840–6895)

```
async fn agent_role_relative_config_file_resolves_from_config_layer() -> std::io::Result<()>
```

**Purpose**: Checks the same relative-path resolution works when the agent role comes from an explicit `ConfigLayerEntry` rather than a file read by the builder.

**Data flow**: Creates the role file, constructs a `ConfigLayerStack` with a user layer whose source file is `codex_home/config.toml` and whose TOML contains the relative `config_file`, loads config with that stack, and asserts the resolved role path is absolute to the layer source.

**Call relations**: Covers layer-source-relative resolution rather than builder-discovered file resolution.

*Call graph*: calls 1 internal fn (new); 10 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, default, create_dir_all, write, from_str, vec!).


##### `agent_role_file_metadata_overrides_config_toml_metadata`  (lines 6898–6946)

```
async fn agent_role_file_metadata_overrides_config_toml_metadata() -> std::io::Result<()>
```

**Purpose**: Verifies metadata inside an agent role file overrides metadata supplied in the referencing `config.toml` entry.

**Data flow**: Writes a role file containing `description` and `nickname_candidates`, writes user config with different values plus `config_file`, builds config, and asserts the loaded role uses the file-provided description and nickname candidates while retaining the resolved `config_file` path.

**Call relations**: Tests merge precedence between legacy split role metadata sources.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_file_without_developer_instructions_is_dropped_with_warning`  (lines 6949–7014)

```
async fn agent_role_file_without_developer_instructions_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that discovered standalone agent role files lacking `developer_instructions` are ignored with a startup warning, while valid sibling roles still load.

**Data flow**: Creates a trusted repo with `.codex/agents/researcher.toml` missing `developer_instructions` and `reviewer.toml` containing it, builds config from a nested cwd, then asserts `researcher` is absent, `reviewer` is present, and startup warnings mention the missing `developer_instructions` requirement.

**Call relations**: Exercises standalone agent-role discovery and validation in project-local `.codex/agents` directories.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 8 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `legacy_agent_role_config_file_allows_missing_developer_instructions`  (lines 7017–7065)

```
async fn legacy_agent_role_config_file_allows_missing_developer_instructions() -> std::io::Result<()>
```

**Purpose**: Verifies the stricter standalone-file requirement does not apply to legacy split agent-role `config_file` references.

**Data flow**: Writes a legacy role config file containing only model settings, references it from `[agents.researcher]` in user config, builds config, and asserts the role still loads with description from config and the resolved file path.

**Call relations**: Contrasts legacy split-role behavior with standalone discovered-role validation.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_without_description_after_merge_is_dropped_with_warning`  (lines 7068–7118)

```
async fn agent_role_without_description_after_merge_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that an agent role missing a description after merging all sources is dropped with a warning.

**Data flow**: Writes a role file with `developer_instructions` but no description, references it from config without a description, also defines a valid reviewer role, builds config, then asserts `researcher` is absent, `reviewer` remains, and warnings mention the missing description requirement.

**Call relations**: Validation test for required merged metadata on agent roles.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (new, assert!, assert_eq!, create_dir_all, write).


##### `discovered_agent_role_file_without_name_is_dropped_with_warning`  (lines 7121–7183)

```
async fn discovered_agent_role_file_without_name_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Ensures standalone discovered agent role files must define a non-empty `name`; otherwise they are ignored with a warning.

**Data flow**: Creates a trusted repo with one standalone role file missing `name` and another valid one, builds config from nested cwd, then asserts only the valid role loads and warnings mention the missing non-empty `name` requirement.

**Call relations**: Standalone agent-role discovery validation test for required naming.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 8 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `agent_role_file_name_takes_precedence_over_config_key`  (lines 7186–7228)

```
async fn agent_role_file_name_takes_precedence_over_config_key() -> std::io::Result<()>
```

**Purpose**: Verifies that when a legacy split role file declares its own `name`, that file-provided name replaces the key used in `[agents.<key>]`.

**Data flow**: Writes `agents/researcher.toml` containing `name = "archivist"`, references it from `[agents.researcher]`, builds config, and asserts there is no `researcher` role but there is an `archivist` role with the file description and path.

**Call relations**: Tests merge precedence for role identity itself, not just metadata.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `loads_legacy_split_agent_roles_from_config_toml`  (lines 7231–7318)

```
async fn loads_legacy_split_agent_roles_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that multiple legacy split agent roles referenced from user config load correctly with descriptions, config-file paths, and nickname candidates.

**Data flow**: Creates two role files, writes `[agents.researcher]` and `[agents.reviewer]` entries pointing at them, builds config, and asserts both roles’ descriptions, resolved paths, and nickname candidate lists.

**Call relations**: Positive-path integration test for the legacy split-role loading mechanism.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `discovers_multiple_standalone_agent_role_files`  (lines 7321–7448)

```
async fn discovers_multiple_standalone_agent_role_files() -> std::io::Result<()>
```

**Purpose**: Verifies recursive discovery of multiple standalone agent role files across root and nested `.codex/agents` directories in a trusted workspace tree.

**Data flow**: Creates a trusted repo with one root-level standalone role and two nested/sibling standalone roles under `packages/.codex/agents`, builds config from a nested cwd, and asserts all three roles load with the expected descriptions and nickname candidates.

**Call relations**: Exercises standalone role discovery across multiple `.codex/agents` directories in the workspace ancestry.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert_eq!, format!, create_dir_all, write).


##### `mixed_legacy_and_standalone_agent_role_sources_merge_with_precedence`  (lines 7451–7594)

```
async fn mixed_legacy_and_standalone_agent_role_sources_merge_with_precedence() -> std::io::Result<()>
```

**Purpose**: Checks precedence when both legacy split roles from user config and standalone discovered role files define overlapping or distinct roles.

**Data flow**: Creates trusted workspace metadata, user-config legacy roles `researcher` and `critic`, corresponding home role files, plus standalone workspace roles `researcher` and `writer`, builds config, and asserts standalone `researcher` overrides legacy `researcher`, legacy `critic` remains, and standalone `writer` is added.

**Call relations**: Integration test for merging agent-role sources from different origins with precedence.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `higher_precedence_agent_role_can_inherit_description_from_lower_layer`  (lines 7597–7677)

```
async fn higher_precedence_agent_role_can_inherit_description_from_lower_layer() -> std::io::Result<()>
```

**Purpose**: Verifies a higher-precedence standalone agent role file can override some fields while inheriting missing description metadata from a lower-precedence legacy source.

**Data flow**: Creates a legacy `researcher` role with description and config file plus a standalone `researcher` file lacking description but containing nickname candidates and instructions, builds config, and asserts the final role uses the standalone file path and nickname candidates while inheriting the lower-layer description.

**Call relations**: Tests field-wise merge behavior across agent-role precedence layers.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `load_config_resolves_agent_interrupt_message`  (lines 7680–7700)

```
async fn load_config_resolves_agent_interrupt_message() -> std::io::Result<()>
```

**Purpose**: Checks that `agents.interrupt_message = false` becomes the flattened runtime boolean `agent_interrupt_message_enabled = false`.

**Data flow**: Loads config with `AgentsToml { interrupt_message: Some(false), .. }` and asserts the runtime boolean is false.

**Call relations**: Simple runtime propagation test for an agents-level flag.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `load_config_normalizes_agent_role_nickname_candidates`  (lines 7703–7743)

```
async fn load_config_normalizes_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Verifies nickname candidates are trimmed and normalized during runtime load.

**Data flow**: Loads config with a role whose `nickname_candidates` contain padded and unpadded strings, then asserts the loaded role stores `"Hypatia"` and `"Noether"` without surrounding whitespace.

**Call relations**: Normalization test for agent-role nickname metadata.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, default, vec!).


##### `load_config_rejects_empty_agent_role_nickname_candidates`  (lines 7746–7780)

```
async fn load_config_rejects_empty_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Ensures an explicitly empty nickname-candidate list is rejected.

**Data flow**: Loads config with `nickname_candidates: Some(Vec::new())`, expects `InvalidInput`, and asserts the error mentions the `agents.researcher.nickname_candidates` field.

**Call relations**: Validation test for non-empty nickname candidate lists.

*Call graph*: 8 external calls (from, default, new, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `load_config_rejects_duplicate_agent_role_nickname_candidates`  (lines 7783–7817)

```
async fn load_config_rejects_duplicate_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Checks that duplicate nickname candidates are rejected after normalization.

**Data flow**: Loads config with `"Hypatia"` and `" Hypatia "`, expects `InvalidInput`, and asserts the message says duplicates are not allowed.

**Call relations**: Validation test for deduplicated nickname candidate normalization.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `load_config_rejects_unsafe_agent_role_nickname_candidates`  (lines 7820–7853)

```
async fn load_config_rejects_unsafe_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Ensures nickname candidates are restricted to a safe ASCII character set.

**Data flow**: Loads config with `nickname_candidates = ["Agent <One>"]`, expects `InvalidInput`, and asserts the message says only ASCII letters, digits, spaces, hyphens, and underscores are allowed.

**Call relations**: Validation test for nickname candidate sanitization.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `model_catalog_json_loads_from_path`  (lines 7856–7881)

```
async fn model_catalog_json_loads_from_path() -> std::io::Result<()>
```

**Purpose**: Verifies a custom model catalog can be loaded from a JSON file path into runtime config.

**Data flow**: Builds a one-model catalog from `bundled_models_response()`, writes it to `catalog.json`, loads config with `model_catalog_json` pointing at that file, and asserts `config.model_catalog == Some(catalog)`.

**Call relations**: Exercises file-backed model catalog loading.

*Call graph*: 8 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, bundled_models_response, default, to_string, write).


##### `model_catalog_json_rejects_empty_catalog`  (lines 7884–7908)

```
async fn model_catalog_json_rejects_empty_catalog() -> std::io::Result<()>
```

**Purpose**: Ensures a custom model catalog file containing zero models is rejected during config load.

**Data flow**: Writes `{"models":[]}` to a catalog file, loads config pointing at it, expects `InvalidData`, and asserts the error mentions that at least one model is required.

**Call relations**: Validation test for custom model catalog contents.

*Call graph*: 7 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, write).


##### `create_test_fixture`  (lines 7910–7973)

```
fn create_test_fixture() -> std::io::Result<PrecedenceTestFixture>
```

**Purpose**: Builds a reusable precedence-test fixture containing a baseline `ConfigToml`, a temp cwd marked as a git repo, and a temp Codex home.

**Data flow**: Parses a large inline TOML string defining model defaults, analytics, a custom provider, and several legacy profiles into `ConfigToml`; creates a temp cwd and writes a `.git` marker to suppress AGENTS.md lookup; creates a temp Codex home; and returns `PrecedenceTestFixture { cwd, codex_home, cfg }`.

**Call relations**: Shared setup helper for many later tests involving service tier, OTEL, legacy profile rejection, and requirements behavior. Those tests call it to avoid repeating the same baseline config and temp-directory setup.

*Call graph*: called by 13 (config_toml_legacy_fast_service_tier_uses_priority_request_value, config_toml_priority_service_tier_uses_priority_request_value, config_toml_service_tier_accepts_arbitrary_string, default_service_tier_override_uses_default_request_value, explicit_null_service_tier_override_maps_to_default_service_tier, fast_default_opt_out_notice_config_is_respected, legacy_fast_service_tier_override_uses_priority_request_value, legacy_profile_selection_is_rejected, load_config_applies_otel_trace_metadata, load_config_drops_invalid_otel_trace_metadata_entries (+3 more)); 3 external calls (new, write, from_str).


##### `legacy_profile_selection_is_rejected`  (lines 7976–7998)

```
async fn legacy_profile_selection_is_rejected() -> std::io::Result<()>
```

**Purpose**: Ensures the removed top-level legacy `profile = "..."` selection mechanism is rejected at runtime load.

**Data flow**: Creates the baseline fixture, sets `fixture.cfg.profile = Some("gpt3")`, loads config with fixture cwd/home, expects `InvalidData`, and asserts the error mentions legacy profile selection is no longer supported.

**Call relations**: Uses `create_test_fixture` to test a compatibility break in profile selection.

*Call graph*: calls 1 internal fn (create_test_fixture); 4 external calls (default, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `metrics_exporter_defaults_to_statsig_when_missing`  (lines 8001–8016)

```
async fn metrics_exporter_defaults_to_statsig_when_missing() -> std::io::Result<()>
```

**Purpose**: Checks that OTEL metrics exporter defaults to `Statsig` when not explicitly configured.

**Data flow**: Loads the fixture config and asserts `config.otel.metrics_exporter == OtelExporterKind::Statsig`.

**Call relations**: Runtime default test using the shared precedence fixture.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `trace_exporter_defaults_to_none_when_log_exporter_is_set`  (lines 8019–8049)

```
async fn trace_exporter_defaults_to_none_when_log_exporter_is_set() -> std::io::Result<()>
```

**Purpose**: Verifies that when a generic OTEL exporter is configured for logs and metrics exporter is `None`, the trace exporter defaults to `None` rather than inheriting the log exporter.

**Data flow**: Starts from the fixture config, injects `cfg.otel` with an `OtlpHttp` exporter and `metrics_exporter = None`, loads runtime config, and asserts `config.otel.exporter` is the OTLP HTTP exporter while `config.otel.trace_exporter == None`.

**Call relations**: Tests OTEL exporter defaulting logic in the runtime loader.

*Call graph*: calls 1 internal fn (create_test_fixture); 5 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `load_config_applies_otel_trace_metadata`  (lines 8052–8091)

```
async fn load_config_applies_otel_trace_metadata() -> std::io::Result<()>
```

**Purpose**: Checks that valid OTEL span attributes and tracestate entries are loaded into runtime config.

**Data flow**: Replaces the fixture config with TOML containing `[otel.span_attributes]` and `[otel.tracestate.example]`, loads runtime config, and asserts the resulting `BTreeMap`s for `span_attributes` and nested `tracestate` exactly match the configured values.

**Call relations**: Positive-path OTEL metadata parsing and runtime propagation test.

*Call graph*: calls 1 internal fn (create_test_fixture); 4 external calls (default, load_from_base_config_with_overrides, assert_eq!, from_str).


##### `load_config_drops_invalid_otel_trace_metadata_entries`  (lines 8094–8162)

```
async fn load_config_drops_invalid_otel_trace_metadata_entries() -> std::io::Result<()>
```

**Purpose**: Ensures invalid OTEL span-attribute keys and tracestate values are dropped while valid entries survive and warnings are emitted.

**Data flow**: Loads fixture config containing one empty span-attribute key and tracestate values with embedded newlines, then asserts runtime OTEL environment survives, only valid metadata entries remain, and startup warnings mention the invalid span-attribute and tracestate entries.

**Call relations**: Negative-path counterpart to the previous OTEL metadata test.

*Call graph*: calls 1 internal fn (create_test_fixture); 5 external calls (default, load_from_base_config_with_overrides, assert!, assert_eq!, from_str).


##### `explicit_null_service_tier_override_maps_to_default_service_tier`  (lines 8165–8185)

```
async fn explicit_null_service_tier_override_maps_to_default_service_tier() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit CLI override of `service_tier = null` maps to the protocol default request value rather than clearing the field.

**Data flow**: Loads fixture config with `ConfigOverrides { service_tier: Some(None), .. }`, then asserts `config.service_tier == Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string())` and `config.notices.fast_default_opt_out == None`.

**Call relations**: Service-tier override normalization test using the shared fixture.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `default_service_tier_override_uses_default_request_value`  (lines 8188–8207)

```
async fn default_service_tier_override_uses_default_request_value() -> std::io::Result<()>
```

**Purpose**: Verifies that the legacy string override `service_tier = "default"` also maps to the protocol default request value.

**Data flow**: Loads fixture config with `ConfigOverrides { service_tier: Some(Some("default".to_string())), .. }` and asserts the runtime service tier equals the default request value string.

**Call relations**: Companion normalization test for the explicit-string default alias.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `legacy_fast_service_tier_override_uses_priority_request_value`  (lines 8210–8229)

```
async fn legacy_fast_service_tier_override_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Checks that the legacy override string `fast` maps to `ServiceTier::Fast.request_value()`.

**Data flow**: Loads fixture config with `ConfigOverrides { service_tier: Some(Some("fast".to_string())), .. }` and asserts the runtime service tier equals the fast request value string.

**Call relations**: Legacy alias normalization test for CLI/service-tier overrides.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_priority_service_tier_uses_priority_request_value`  (lines 8232–8253)

```
async fn config_toml_priority_service_tier_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Verifies that a TOML `service_tier` already set to the canonical fast request value is preserved.

**Data flow**: Mutates the fixture config to set `cfg.service_tier` to `ServiceTier::Fast.request_value()`, loads runtime config, and asserts the same string is present in `config.service_tier`.

**Call relations**: TOML-path counterpart to the override-based service-tier tests.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_service_tier_accepts_arbitrary_string`  (lines 8256–8277)

```
async fn config_toml_service_tier_accepts_arbitrary_string() -> std::io::Result<()>
```

**Purpose**: Checks that arbitrary non-special service-tier strings are accepted and preserved.

**Data flow**: Sets `fixture.cfg.service_tier = Some("experimental-tier-id".to_string())`, loads config, and asserts the runtime field contains that exact string.

**Call relations**: Documents permissive handling for unknown/custom service-tier identifiers.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_legacy_fast_service_tier_uses_priority_request_value`  (lines 8280–8301)

```
async fn config_toml_legacy_fast_service_tier_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Verifies that TOML `service_tier = "fast"` is normalized to the canonical fast request value.

**Data flow**: Sets the fixture config’s `service_tier` to `"fast"`, loads runtime config, and asserts the runtime field equals `ServiceTier::Fast.request_value()`.

**Call relations**: TOML normalization counterpart to the override-based fast-tier test.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `fast_default_opt_out_notice_config_is_respected`  (lines 8304–8325)

```
async fn fast_default_opt_out_notice_config_is_respected() -> std::io::Result<()>
```

**Purpose**: Checks that notice config for `fast_default_opt_out` is preserved when no service tier is forced.

**Data flow**: Starts from the fixture config, sets `cfg.notice.fast_default_opt_out = Some(true)`, loads runtime config, and asserts `config.service_tier == None` while `config.notices.fast_default_opt_out == Some(true)`.

**Call relations**: Tests interaction between notice config and service-tier defaults.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `test_requirements_web_search_mode_allowlist_does_not_warn_when_unset`  (lines 8328–8404)

```
async fn test_requirements_web_search_mode_allowlist_does_not_warn_when_unset() -> anyhow::Result<()>
```

**Purpose**: Ensures managed requirements constraining allowed web-search modes do not emit warnings when the effective configured mode is already unset/default-compatible.

**Data flow**: Builds requirements TOML allowing only cached mode and a constrained runtime requirement object, wraps them in a `ConfigLayerStack`, loads fixture config with that stack, and asserts no startup warning mentions `web_search_mode`.

**Call relations**: Exercises requirements plumbing for web-search mode without forcing a visible fallback warning.

*Call graph*: calls 4 internal fn (new, new, new, create_test_fixture); 5 external calls (default, new, load_config_with_layer_stack, assert!, vec!).


##### `test_set_project_trusted_writes_explicit_tables`  (lines 8407–8429)

```
fn test_set_project_trusted_writes_explicit_tables() -> anyhow::Result<()>
```

**Purpose**: Checks that setting a project trust level on an empty TOML document writes an explicit `[projects.<path>]` table.

**Data flow**: Creates an empty `DocumentMut`, calls `set_project_trust_level_inner(&mut doc, project_dir, TrustLevel::Trusted)`, converts the document to string, and asserts the exact expected TOML with a quoted project path key and `trust_level = "trusted"`.

**Call relations**: Pure TOML-editing unit test for project trust persistence.

*Call graph*: 4 external calls (new, new, assert_eq!, format!).


##### `test_set_project_trusted_converts_inline_to_explicit`  (lines 8432–8466)

```
fn test_set_project_trusted_converts_inline_to_explicit() -> anyhow::Result<()>
```

**Purpose**: Verifies that if `[projects]` contains an inline table entry, setting trust converts it into explicit nested tables.

**Data flow**: Seeds a `DocumentMut` from TOML where `[projects]` contains an inline entry for the target path, calls `set_project_trust_level_inner`, serializes the document, and asserts the output now uses an explicit `[projects.<path>]` table with updated trust level.

**Call relations**: Covers migration behavior from inline to explicit project tables during edits.

*Call graph*: 3 external calls (new, assert_eq!, format!).


##### `test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries`  (lines 8469–8503)

```
fn test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries() -> anyhow::Result<()>
```

**Purpose**: Checks migration of a top-level inline `projects = { ... }` table into explicit per-project tables while preserving unrelated top-level keys and existing project fields.

**Data flow**: Parses a TOML document with top-level `projects = { ... }`, calls `set_project_trust_level_inner` for a new project, serializes the document, and asserts the output preserves `toplevel` and `model`, expands existing project entries into explicit tables with their fields, and appends the new trusted project table.

**Call relations**: More comprehensive migration test for project trust editing.

*Call graph*: calls 1 internal fn (project_trust_key); 3 external calls (new, assert_eq!, format!).


##### `active_project_does_not_match_configured_alias_for_canonical_cwd`  (lines 8507–8530)

```
async fn active_project_does_not_match_configured_alias_for_canonical_cwd() -> anyhow::Result<()>
```

**Purpose**: Ensures active-project lookup does not match a configured symlink alias when the actual cwd is the canonical target path.

**Data flow**: On Unix, creates a real project directory and a symlink alias, builds `ConfigToml` with a project entry keyed by the alias path, then asserts `config.get_active_project(&project_root, None)` returns `None`.

**Call relations**: Tests exact-path matching semantics for project config lookup in the presence of symlinks.

*Call graph*: 6 external calls (default, from, assert_eq!, create_dir_all, symlink, tempdir).


##### `test_set_default_oss_provider`  (lines 8533–8565)

```
fn test_set_default_oss_provider() -> std::io::Result<()>
```

**Purpose**: Verifies writing the default OSS provider into config, updating existing config, overwriting prior values, and rejecting invalid provider ids.

**Data flow**: Creates a temp config path, calls `set_default_oss_provider` on empty config and checks the file contains `oss_provider = "ollama"`, rewrites config with an existing `model` and sets provider to `lmstudio`, checks both lines coexist, sets provider back to `ollama` and checks overwrite behavior, then calls the function with an invalid provider and asserts `InvalidInput` with a helpful message.

**Call relations**: Exercises the config-edit helper for OSS provider selection across success and failure cases.

*Call graph*: 5 external calls (new, assert!, assert_eq!, read_to_string, write).


##### `test_set_default_oss_provider_rejects_legacy_ollama_chat_provider`  (lines 8568–8583)

```
fn test_set_default_oss_provider_rejects_legacy_ollama_chat_provider() -> std::io::Result<()>
```

**Purpose**: Ensures the removed legacy Ollama chat provider id is rejected by the OSS-provider setter with the dedicated removal error.

**Data flow**: Calls `set_default_oss_provider` with `LEGACY_OLLAMA_CHAT_PROVIDER_ID`, expects `InvalidInput`, and asserts the error contains `OLLAMA_CHAT_PROVIDER_REMOVED_ERROR`.

**Call relations**: Compatibility-break test for the setter helper.

*Call graph*: 3 external calls (new, assert!, assert_eq!).


##### `test_load_config_rejects_legacy_ollama_chat_provider_with_helpful_error`  (lines 8586–8610)

```
async fn test_load_config_rejects_legacy_ollama_chat_provider_with_helpful_error() -> std::io::Result<()>
```

**Purpose**: Checks runtime config loading rejects the removed legacy Ollama chat provider id with a not-found style error and helpful message.

**Data flow**: Loads config with `model_provider = LEGACY_OLLAMA_CHAT_PROVIDER_ID`, expects failure, and asserts the error kind is `NotFound` and the message contains the removal error text.

**Call relations**: Runtime-load counterpart to the setter rejection test.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `test_untrusted_project_gets_workspace_write_sandbox`  (lines 8613–8648)

```
async fn test_untrusted_project_gets_workspace_write_sandbox() -> anyhow::Result<()>
```

**Purpose**: Verifies that an untrusted active project still derives workspace-write sandbox semantics (or Windows read-only downgrade) under legacy sandbox derivation.

**Data flow**: Parses config marking `/tmp/test` untrusted, constructs an `active_project` with `TrustLevel::Untrusted`, calls `derive_legacy_sandbox_policy_for_test`, and asserts the result is workspace-write on non-Windows or read-only on Windows.

**Call relations**: Uses the helper wrapper to test trust-based implicit sandbox derivation.

*Call graph*: calls 1 internal fn (derive_legacy_sandbox_policy_for_test); 2 external calls (assert!, cfg!).


##### `derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults`  (lines 8651–8692)

```
async fn derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults() -> anyhow::Result<()>
```

**Purpose**: Checks that when implicit default sandbox selection would violate a permission-profile constraint, legacy derivation falls back to read-only.

**Data flow**: Creates a trusted-project config and an active project, builds a `Constrained<PermissionProfile>` allowing only read-only, calls `derive_legacy_sandbox_policy_for_test`, and asserts the result is `SandboxPolicy::new_read_only_policy()`.

**Call relations**: Exercises the helper’s fallback path when constrained permission derivation cannot preserve the implicit default.

*Call graph*: calls 3 internal fn (new, derive_legacy_sandbox_policy_for_test, read_only); 4 external calls (default, from, new, assert_eq!).


##### `derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback`  (lines 8695–8748)

```
async fn derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback() -> anyhow::Result<()>
```

**Purpose**: Ensures constrained fallback to workspace-write still preserves the existing Windows downgrade behavior when legacy projection is unsupported.

**Data flow**: Creates a trusted-project config and a constraint that only accepts managed profiles with some writable filesystem entry, derives the legacy sandbox policy, and asserts workspace-write on non-Windows or read-only on Windows.

**Call relations**: Companion constrained-fallback test focused on Windows compatibility behavior.

*Call graph*: calls 3 internal fn (new, derive_legacy_sandbox_policy_for_test, workspace_write); 5 external calls (default, from, new, assert_eq!, cfg!).


##### `test_resolve_oss_provider_explicit_override`  (lines 8751–8755)

```
fn test_resolve_oss_provider_explicit_override()
```

**Purpose**: Checks that an explicit OSS provider override argument wins over config contents.

**Data flow**: Calls `resolve_oss_provider(Some("custom-provider"), &ConfigToml::default())` and asserts it returns `Some("custom-provider".to_string())`.

**Call relations**: Pure resolver unit test.

*Call graph*: 2 external calls (assert_eq!, default).


##### `test_resolve_oss_provider_from_global_config`  (lines 8758–8766)

```
fn test_resolve_oss_provider_from_global_config()
```

**Purpose**: Checks that when no explicit override is supplied, the global config `oss_provider` value is used.

**Data flow**: Builds `ConfigToml { oss_provider: Some("global-provider"), .. }`, calls `resolve_oss_provider(None, &config_toml)`, and asserts the same string is returned.

**Call relations**: Resolver test for config-based OSS provider selection.

*Call graph*: 2 external calls (default, assert_eq!).


##### `test_resolve_oss_provider_none_when_not_configured`  (lines 8769–8773)

```
fn test_resolve_oss_provider_none_when_not_configured()
```

**Purpose**: Checks that OSS provider resolution returns `None` when neither override nor config specifies a provider.

**Data flow**: Calls `resolve_oss_provider(None, &ConfigToml::default())` and asserts `None`.

**Call relations**: Baseline resolver test.

*Call graph*: 2 external calls (assert_eq!, default).


##### `test_resolve_oss_provider_explicit_overrides_global`  (lines 8776–8784)

```
fn test_resolve_oss_provider_explicit_overrides_global()
```

**Purpose**: Verifies explicit OSS provider override takes precedence over a configured global provider.

**Data flow**: Builds config with `oss_provider = "global-provider"`, calls `resolve_oss_provider(Some("explicit-provider"), &config_toml)`, and asserts the explicit value is returned.

**Call relations**: Precedence test for the OSS provider resolver.

*Call graph*: 2 external calls (default, assert_eq!).


##### `config_toml_deserializes_mcp_oauth_callback_port`  (lines 8787–8792)

```
fn config_toml_deserializes_mcp_oauth_callback_port()
```

**Purpose**: Checks that `mcp_oauth_callback_port` parses as an optional integer in `ConfigToml`.

**Data flow**: Parses `mcp_oauth_callback_port = 4321` and asserts the decoded field is `Some(4321)`.

**Call relations**: Simple TOML parsing test.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_deserializes_mcp_oauth_callback_url`  (lines 8795–8803)

```
fn config_toml_deserializes_mcp_oauth_callback_url()
```

**Purpose**: Checks that `mcp_oauth_callback_url` parses as an optional string.

**Data flow**: Parses `mcp_oauth_callback_url = "https://example.com/callback"` and asserts the decoded field matches.

**Call relations**: Simple TOML parsing test.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_loads_mcp_oauth_callback_port_from_toml`  (lines 8806–8824)

```
async fn config_loads_mcp_oauth_callback_port_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies the parsed MCP OAuth callback port is propagated into runtime config.

**Data flow**: Parses TOML containing `mcp_oauth_callback_port = 5678`, loads runtime config, and asserts `config.mcp_oauth_callback_port == Some(5678)`.

**Call relations**: Runtime counterpart to the raw callback-port parsing test.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `config_loads_allow_login_shell_from_toml`  (lines 8827–8846)

```
async fn config_loads_allow_login_shell_from_toml() -> std::io::Result<()>
```

**Purpose**: Checks that `allow_login_shell = false` is loaded into runtime permissions.

**Data flow**: Parses TOML with `allow_login_shell = false`, loads runtime config, and asserts `config.permissions.allow_login_shell` is false.

**Call relations**: Runtime propagation test for a permissions-related scalar.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert!, default, from_str).


##### `config_loads_apps_mcp_product_sku_from_toml`  (lines 8849–8867)

```
async fn config_loads_apps_mcp_product_sku_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies `apps_mcp_product_sku` parses and becomes the runtime field.

**Data flow**: Parses TOML with `apps_mcp_product_sku = "tpp"`, loads runtime config, and asserts `config.apps_mcp_product_sku.as_deref() == Some("tpp")`.

**Call relations**: Simple runtime propagation test.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `config_loads_mcp_oauth_callback_url_from_toml`  (lines 8870–8891)

```
async fn config_loads_mcp_oauth_callback_url_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies the parsed MCP OAuth callback URL is propagated into runtime config.

**Data flow**: Parses TOML with `mcp_oauth_callback_url = "https://example.com/callback"`, loads runtime config, and asserts the runtime field matches.

**Call relations**: Runtime counterpart to the raw callback-URL parsing test.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `test_untrusted_project_gets_unless_trusted_approval_policy`  (lines 8894–8944)

```
async fn test_untrusted_project_gets_unless_trusted_approval_policy() -> anyhow::Result<()>
```

**Purpose**: Checks that untrusted projects default to `AskForApproval::UnlessTrusted` while still using workspace-write sandbox semantics (or Windows downgrade).

**Data flow**: Loads config marking the cwd untrusted, then asserts `config.permissions.approval_policy.value() == AskForApproval::UnlessTrusted` and checks the legacy sandbox policy is workspace-write on non-Windows or read-only on Windows.

**Call relations**: Trust-based defaulting test for approval policy plus sandbox behavior.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `requirements_disallowing_default_sandbox_falls_back_to_required_default`  (lines 8947–8965)

```
async fn requirements_disallowing_default_sandbox_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Verifies enterprise requirements restricting allowed sandbox modes force the default sandbox to read-only.

**Data flow**: Builds config with enterprise requirements `allowed_sandbox_modes = ["read-only"]`, then asserts `config.legacy_sandbox_policy() == SandboxPolicy::new_read_only_policy()`.

**Call relations**: Managed-requirements fallback test for implicit sandbox defaults.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `explicit_sandbox_mode_falls_back_when_disallowed_by_requirements`  (lines 8968–8991)

```
async fn explicit_sandbox_mode_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that an explicitly configured disallowed sandbox mode is normalized to the required allowed mode.

**Data flow**: Writes `sandbox_mode = "danger-full-access"`, builds config with requirements allowing only read-only, and asserts the resulting legacy sandbox policy is read-only.

**Call relations**: Managed-requirements fallback test for explicit sandbox config.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `windows_sandbox_mode_falls_back_when_disallowed_by_requirements`  (lines 8994–9027)

```
async fn windows_sandbox_mode_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies Windows sandbox implementation settings are normalized to requirement-allowed values and emit a warning.

**Data flow**: Writes `[windows] sandbox = "unelevated"`, builds config with requirements allowing only `elevated`, then asserts `config.permissions.windows_sandbox_mode == Some(Elevated)` and startup warnings mention the configured value was disallowed by requirements.

**Call relations**: Managed-requirements normalization test for Windows-specific sandbox implementation.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `danger_full_access_with_never_is_rejected_when_requirements_force_read_only`  (lines 9030–9058)

```
async fn danger_full_access_with_never_is_rejected_when_requirements_force_read_only() -> std::io::Result<()>
```

**Purpose**: Ensures `approval_policy = "never"` is rejected when requirements would force a full-access sandbox choice down to read-only, because that would disable approvals under reduced permissions.

**Data flow**: Writes config with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`, builds with requirements allowing only read-only, expects `InvalidInput`, and asserts the exact explanatory error message.

**Call relations**: Safety validation test for the interaction between approval policy and requirement-forced sandbox fallback.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `named_full_access_profile_with_never_is_rejected_when_requirements_force_read_only`  (lines 9061–9092)

```
async fn named_full_access_profile_with_never_is_rejected_when_requirements_force_read_only() -> std::io::Result<()>
```

**Purpose**: Checks the same safety rule when full access comes from a named permission profile rather than legacy sandbox mode.

**Data flow**: Writes config with `approval_policy = "never"`, `default_permissions = "dev"`, and a profile granting `:root = write`, builds with read-only-only requirements, expects `InvalidInput`, and asserts the same explanatory message.

**Call relations**: Companion safety test for named permission profiles.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `permission_profile_override_falls_back_when_disallowed_by_requirements`  (lines 9095–9120)

```
async fn permission_profile_override_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies a direct permission-profile override is normalized down to read-only when requirements disallow the requested sandbox mode.

**Data flow**: Builds config with a harness override `permission_profile = PermissionProfile::Disabled` and enterprise requirements allowing only read-only, then asserts the legacy sandbox policy is read-only and the effective permission profile is `PermissionProfile::read_only()`.

**Call relations**: Managed-requirements fallback test for direct runtime permission-profile overrides.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (default, new, new_read_only_policy, assert_eq!).


##### `active_profile_is_cleared_when_requirements_force_fallback`  (lines 9123–9152)

```
async fn active_profile_is_cleared_when_requirements_force_fallback() -> std::io::Result<()>
```

**Purpose**: Checks that when requirements force a selected built-in full-access profile to fall back, active-profile metadata is cleared and a warning is emitted.

**Data flow**: Builds config with a harness override selecting built-in full-access and requirements allowing only read-only, then asserts the effective profile is read-only, `active_permission_profile()` is `None`, and startup warnings mention `permission_profile` was disallowed by requirements.

**Call relations**: Tests metadata cleanup and warning emission during requirement-forced fallback.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (default, new, assert!, assert_eq!).


##### `bypass_hook_trust_adds_startup_warning`  (lines 9155–9175)

```
async fn bypass_hook_trust_adds_startup_warning() -> std::io::Result<()>
```

**Purpose**: Verifies enabling the dangerous hook-trust bypass override adds a prominent startup warning.

**Data flow**: Builds config with `ConfigOverrides { bypass_hook_trust: Some(true), .. }` and asserts startup warnings contain the exact bypass warning string.

**Call relations**: Simple warning-emission test for a dangerous runtime override.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (default, new, assert!).


##### `permission_profile_override_preserves_split_write_roots`  (lines 9178–9231)

```
async fn permission_profile_override_preserves_split_write_roots() -> std::io::Result<()>
```

**Purpose**: Checks that a managed runtime permission profile with root read plus an external concrete write path preserves that split-write structure and still projects to workspace-write legacy semantics.

**Data flow**: Creates cwd and outside-write directories, builds a `FileSystemSandboxPolicy` with `:root` read and the outside path write, converts it into a managed `PermissionProfile`, builds config with that override, then asserts the runtime policy can write the outside root, the legacy projection is workspace-write, and network policy remains restricted.

**Call relations**: Regression test for legacy projection of managed profiles with concrete write roots outside cwd.

*Call graph*: calls 4 internal fn (without_managed_config_for_tests, from_runtime_permissions_with_enforcement, restricted, from_absolute_path); 6 external calls (default, new, assert!, assert_eq!, create_dir_all, vec!).


##### `requirements_web_search_mode_overrides_danger_full_access_default`  (lines 9234–9263)

```
async fn requirements_web_search_mode_overrides_danger_full_access_default() -> std::io::Result<()>
```

**Purpose**: Verifies managed requirements can override the default web-search mode even when the sandbox is danger-full-access.

**Data flow**: Writes `sandbox_mode = "danger-full-access"`, builds config with requirements allowing only cached web search, then asserts `config.web_search_mode.value() == Cached` and turn-level resolution also yields `Cached` for the effective permission profile.

**Call relations**: Managed-requirements test for web-search mode normalization under full-access defaults.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `requirements_disallowing_default_approval_falls_back_to_required_default`  (lines 9266–9297)

```
async fn requirements_disallowing_default_approval_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Checks that if the implicit default approval policy is disallowed by requirements, config falls back to the required allowed default.

**Data flow**: Creates an untrusted workspace so the implicit approval policy would be `UnlessTrusted`, builds config with requirements allowing only `on-request`, and asserts the runtime approval policy becomes `OnRequest`.

**Call relations**: Managed-requirements fallback test for implicit approval-policy defaults.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert_eq!, format!, write).


##### `explicit_approval_policy_falls_back_when_disallowed_by_requirements`  (lines 9300–9324)

```
async fn explicit_approval_policy_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies an explicitly configured disallowed approval policy is normalized to the requirement-allowed one.

**Data flow**: Writes `approval_policy = "untrusted"`, builds config with requirements allowing only `on-request`, and asserts the runtime approval policy is `OnRequest`.

**Call relations**: Managed-requirements fallback test for explicit approval-policy config.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `feature_requirements_normalize_effective_feature_values`  (lines 9327–9356)

```
async fn feature_requirements_normalize_effective_feature_values() -> std::io::Result<()>
```

**Purpose**: Checks that enterprise feature requirements directly normalize the effective feature set without producing warnings.

**Data flow**: Builds config with requirements `[features] personality = true shell_tool = false`, then asserts `Feature::Personality` is enabled, `Feature::ShellTool` is disabled, and no startup warning mentions configured `features` values.

**Call relations**: Managed-requirements normalization test for canonical feature flags.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `feature_requirements_auto_review_disables_guardian_approval`  (lines 9359–9378)

```
async fn feature_requirements_auto_review_disables_guardian_approval() -> std::io::Result<()>
```

**Purpose**: Verifies that disabling `auto_review` via feature requirements also disables the derived `GuardianApproval` feature.

**Data flow**: Builds config with requirements `[features] auto_review = false` and asserts `Feature::GuardianApproval` is disabled.

**Call relations**: Tests derived-feature normalization under managed requirements.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `browser_feature_requirements_are_valid`  (lines 9381–9402)

```
async fn browser_feature_requirements_are_valid() -> std::io::Result<()>
```

**Purpose**: Checks that browser-related feature requirements parse and apply cleanly.

**Data flow**: Builds config with requirements disabling `in_app_browser` and `browser_use`, then asserts both corresponding features are disabled.

**Call relations**: Simple managed-feature normalization test for browser features.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `debug_config_lockfile_export_settings_load_from_nested_table`  (lines 9405–9433)

```
async fn debug_config_lockfile_export_settings_load_from_nested_table() -> std::io::Result<()>
```

**Purpose**: Verifies nested `[debug.config_lockfile]` export settings load into the corresponding runtime debug fields.

**Data flow**: Writes config with `export_dir`, `allow_codex_version_mismatch`, and `save_fields_resolved_from_model_catalog`, builds config, and asserts the resolved absolute export dir plus the two booleans.

**Call relations**: Runtime propagation test for nested debug config-lockfile settings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `debug_config_lockfile_load_path_loads_lock_from_nested_table`  (lines 9436–9473)

```
async fn debug_config_lockfile_load_path_loads_lock_from_nested_table() -> std::io::Result<()>
```

**Purpose**: Checks that nested debug config-lockfile `load_path` causes a config lock file to be loaded into runtime config.

**Data flow**: Writes a minimal lock file with the current lock version and an older codex version, writes config pointing `[debug.config_lockfile].load_path` at it with version mismatch allowed, builds config, and asserts `config.config_lock_toml.is_some()` plus the two booleans.

**Call relations**: Exercises debug lockfile loading through nested config.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, format!, write).


##### `explicit_feature_config_is_normalized_by_requirements`  (lines 9476–9514)

```
async fn explicit_feature_config_is_normalized_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies explicit user feature settings are overridden by enterprise feature requirements without warning spam.

**Data flow**: Writes user config disabling `personality` and enabling `shell_tool`, builds with requirements forcing the opposite, then asserts the effective features match requirements and no startup warning mentions configured `features` values.

**Call relations**: Precedence test between user feature config and managed feature requirements.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert!, write).


##### `approvals_reviewer_defaults_to_manual_only_without_guardian_feature`  (lines 9517–9529)

```
async fn approvals_reviewer_defaults_to_manual_only_without_guardian_feature() -> std::io::Result<()>
```

**Purpose**: Checks that the default approvals reviewer is the user/manual reviewer when guardian approval is not enabled.

**Data flow**: Builds default config and asserts `config.approvals_reviewer == ApprovalsReviewer::User`.

**Call relations**: Baseline runtime default test for approvals reviewer.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `prompt_instruction_blocks_can_be_disabled_from_config`  (lines 9532–9558)

```
async fn prompt_instruction_blocks_can_be_disabled_from_config() -> std::io::Result<()>
```

**Purpose**: Verifies several prompt-instruction inclusion flags can be disabled from config, including skill instructions under `[skills]`.

**Data flow**: Writes config disabling permissions/apps/collaboration/environment instruction blocks and `skills.include_instructions`, builds config, and asserts all corresponding runtime booleans are false.

**Call relations**: Runtime propagation test for prompt-construction toggles.

*Call graph*: 4 external calls (new, assert!, default, write).


##### `approvals_reviewer_stays_manual_only_when_guardian_feature_is_enabled`  (lines 9561–9579)

```
async fn approvals_reviewer_stays_manual_only_when_guardian_feature_is_enabled() -> std::io::Result<()>
```

**Purpose**: Checks that merely enabling the guardian-approval feature does not automatically switch the approvals reviewer away from the user.

**Data flow**: Writes `[features] guardian_approval = true`, builds config, and asserts `config.approvals_reviewer == ApprovalsReviewer::User`.

**Call relations**: Clarifies that feature enablement and reviewer selection are separate concerns.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `approvals_reviewer_can_be_set_in_config_without_guardian_approval`  (lines 9582–9599)

```
async fn approvals_reviewer_can_be_set_in_config_without_guardian_approval() -> std::io::Result<()>
```

**Purpose**: Verifies the approvals reviewer can be explicitly set in config even when guardian approval is not enabled.

**Data flow**: Writes `approvals_reviewer = "user"`, builds config, and asserts the runtime reviewer is `User`.

**Call relations**: Simple explicit-setting test for approvals reviewer.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `requirements_disallowing_default_approvals_reviewer_falls_back_to_required_default`  (lines 9602–9618)

```
async fn requirements_disallowing_default_approvals_reviewer_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Checks that managed requirements can force the default approvals reviewer to `guardian_subagent`/auto-review.

**Data flow**: Builds config with requirements `allowed_approvals_reviewers = ["guardian_subagent"]` and asserts `config.approvals_reviewer == ApprovalsReviewer::AutoReview`.

**Call relations**: Managed-requirements fallback test for reviewer defaults.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `root_approvals_reviewer_falls_back_when_disallowed_by_requirements`  (lines 9621–9651)

```
async fn root_approvals_reviewer_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies an explicitly configured root approvals reviewer is normalized to the requirement-allowed reviewer and emits a warning.

**Data flow**: Writes `approvals_reviewer = "user"`, builds with requirements allowing only `guardian_subagent`, then asserts the runtime reviewer is `AutoReview` and startup warnings mention `approvals_reviewer` was disallowed.

**Call relations**: Managed-requirements fallback test for root-level reviewer config.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `profile_approvals_reviewer_falls_back_when_disallowed_by_requirements`  (lines 9654–9682)

```
async fn profile_approvals_reviewer_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks the same reviewer fallback behavior when the setting comes from a selected profile-v2 config file.

**Data flow**: Writes a selected profile config containing `approvals_reviewer = "user"`, builds config with loader overrides selecting that file/profile and requirements allowing only `guardian_subagent`, then asserts the runtime reviewer is `AutoReview`.

**Call relations**: Profile-v2 counterpart to the root-level reviewer fallback test.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements`  (lines 9685–9715)

```
async fn approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies that if requirements allow the configured reviewer, the user’s choice is preserved and no warning is emitted.

**Data flow**: Writes `approvals_reviewer = "guardian_subagent"`, builds with requirements allowing both `user` and `guardian_subagent`, then asserts the runtime reviewer is `AutoReview` and no startup warning mentions `approvals_reviewer`.

**Call relations**: Positive-path managed-requirements test for reviewer selection.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `smart_approvals_alias_is_ignored`  (lines 9718–9742)

```
async fn smart_approvals_alias_is_ignored() -> std::io::Result<()>
```

**Purpose**: Checks that the legacy `smart_approvals` feature alias still enables guardian approval behavior but is preserved as-is in the config file without rewriting canonical keys.

**Data flow**: Writes `[features] smart_approvals = true`, builds config, asserts `Feature::GuardianApproval` is enabled and reviewer remains `User`, then reads the raw config file and asserts it still contains `smart_approvals = true` and not rewritten `guardian_approval` or `approvals_reviewer` entries.

**Call relations**: Compatibility test for a legacy feature alias plus non-destructive config persistence.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (new, assert!, assert_eq!, write, read_to_string).


##### `multi_agent_v2_config_from_feature_table`  (lines 9745–9804)

```
async fn multi_agent_v2_config_from_feature_table() -> std::io::Result<()>
```

**Purpose**: Verifies the structured `[features.multi_agent_v2]` table loads into runtime multi-agent-v2 config and affects derived thread-cap calculations.

**Data flow**: Writes a full multi-agent-v2 feature table with concurrency, timeout, usage-hint, namespace, metadata, and mode flags, builds config, and asserts the feature is enabled, all runtime fields match, `agent_max_threads` remains `None`, and `effective_agent_max_threads(MultiAgentVersion::V2)` equals one less than the session cap.

**Call relations**: Primary positive-path test for multi-agent-v2 feature-table parsing and runtime derivation.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `multi_agent_v2_default_session_thread_cap_counts_root`  (lines 9807–9832)

```
async fn multi_agent_v2_default_session_thread_cap_counts_root() -> std::io::Result<()>
```

**Purpose**: Checks the default multi-agent-v2 session thread cap and derived subagent capacity when the feature is enabled with no overrides.

**Data flow**: Writes `[features.multi_agent_v2] enabled = true`, builds config, and asserts `config.multi_agent_v2 == MultiAgentV2Config::default()` and `effective_agent_max_threads(V2) == Some(3)` while `agent_max_threads` remains `None`.

**Call relations**: Default-value companion to the explicit multi-agent-v2 config test.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_default_usage_hints_use_configured_thread_cap`  (lines 9835–9857)

```
fn multi_agent_v2_default_usage_hints_use_configured_thread_cap()
```

**Purpose**: Verifies default generated usage-hint text incorporates the configured session concurrency cap.

**Data flow**: Parses a multi-agent-v2 TOML snippet with `max_concurrent_threads_per_session = 17`, resolves the config via `resolve_multi_agent_v2_config`, builds the expected suffix string containing the concurrency guidance, and asserts both root and subagent usage hints end with that suffix.

**Call relations**: Pure resolver test for generated multi-agent-v2 hint text.

*Call graph*: 3 external calls (assert!, format!, from_str).


##### `multi_agent_v2_empty_usage_hint_overrides_clear_default_hints`  (lines 9860–9881)

```
async fn multi_agent_v2_empty_usage_hint_overrides_clear_default_hints() -> std::io::Result<()>
```

**Purpose**: Checks that explicitly empty usage-hint override strings clear the default generated hints.

**Data flow**: Writes a multi-agent-v2 feature table with empty `root_agent_usage_hint_text` and `subagent_usage_hint_text`, builds config, and asserts both runtime hint fields are `None`.

**Call relations**: Normalization test for empty-string overrides in multi-agent-v2 config.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_feature_rejects_agents_max_threads`  (lines 9884–9916)

```
async fn multi_agent_v2_feature_rejects_agents_max_threads() -> std::io::Result<()>
```

**Purpose**: Ensures legacy `agents.max_threads` cannot be set when multi-agent-v2 is enabled, even though the derived effective thread count is still computed.

**Data flow**: Writes config enabling multi-agent-v2 and setting `[agents] max_threads = 3`, builds config, calls `validate_multi_agent_v2_config()`, expects `InvalidInput`, and asserts the exact conflict message plus `effective_agent_max_threads(V2) == Some(3)`.

**Call relations**: Validation test for conflicting legacy and new multi-agent concurrency settings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `catalog_v2_allows_agents_max_threads_when_feature_disabled`  (lines 9919–9944)

```
async fn catalog_v2_allows_agents_max_threads_when_feature_disabled() -> std::io::Result<()>
```

**Purpose**: Checks that `agents.max_threads` remains valid when multi-agent-v2 is explicitly disabled.

**Data flow**: Writes config with `[features.multi_agent_v2] enabled = false` and `[agents] max_threads = 3`, builds config, validates successfully, and asserts `effective_agent_max_threads(V2) == Some(3)`.

**Call relations**: Companion non-conflict case for the previous validation test.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_rejects_invalid_wait_timeouts`  (lines 9947–10143)

```
async fn multi_agent_v2_rejects_invalid_wait_timeouts() -> std::io::Result<()>
```

**Purpose**: Exhaustively validates numeric bounds and ordering constraints for multi-agent-v2 wait timeout settings.

**Data flow**: Writes several successive configs covering zero values, negative values, values above the max bound, `min > max`, `default < min`, and `default > max`; for each invalid case it builds config and asserts the exact `InvalidInput` message, while also confirming the all-zero case loads as-is.

**Call relations**: Comprehensive validation suite for multi-agent-v2 timeout fields.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_rejects_invalid_tool_namespace`  (lines 10146–10179)

```
async fn multi_agent_v2_rejects_invalid_tool_namespace() -> std::io::Result<()>
```

**Purpose**: Ensures multi-agent-v2 tool namespaces must match the allowed regex and avoid reserved names.

**Data flow**: Loops over two invalid namespaces (`"bad namespace"` and `"functions"`), writes each into config, builds config expecting failure, and asserts the exact validation message for regex mismatch or reserved namespace.

**Call relations**: Validation test for multi-agent-v2 tool namespace rules.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, format!, write).


##### `multi_agent_v2_session_thread_cap_one_disallows_subagents`  (lines 10182–10208)

```
async fn multi_agent_v2_session_thread_cap_one_disallows_subagents() -> std::io::Result<()>
```

**Purpose**: Checks that a session thread cap of one leaves zero available subagent slots because the root agent counts toward the cap.

**Data flow**: Writes multi-agent-v2 config with `max_concurrent_threads_per_session = 1`, builds config, and asserts the runtime cap is 1 while `effective_agent_max_threads(V2) == Some(0)`.

**Call relations**: Derived-capacity edge-case test for multi-agent-v2.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `feature_requirements_normalize_runtime_feature_mutations`  (lines 10211–10242)

```
async fn feature_requirements_normalize_runtime_feature_mutations() -> std::io::Result<()>
```

**Purpose**: Verifies that even runtime mutations to the `Features` set are normalized by managed feature requirements when applied through the constrained feature wrapper.

**Data flow**: Builds config with requirements forcing `personality = true` and `shell_tool = false`, clones the current feature set, mutates it to request the opposite, confirms `can_set` succeeds, applies `config.features.set(requested)`, and asserts the effective features remain normalized to the requirement-enforced values.

**Call relations**: Tests post-load mutation behavior of the constrained feature set, not just initial load normalization.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 3 external calls (new, assert!, default).


##### `feature_requirements_warn_on_collab_legacy_alias`  (lines 10245–10272)

```
async fn feature_requirements_warn_on_collab_legacy_alias() -> std::io::Result<()>
```

**Purpose**: Checks that using the legacy managed feature requirement key `collab` still enables the canonical `Collab` feature but emits a warning recommending `multi_agent`.

**Data flow**: Builds config with enterprise requirements `[features] collab = true`, then asserts `Feature::Collab` is enabled and startup warnings mention the legacy requirement key and preferred canonical key.

**Call relations**: Managed-requirements compatibility test for a legacy feature alias.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `feature_requirements_warn_and_ignore_unknown_feature`  (lines 10275–10302)

```
async fn feature_requirements_warn_and_ignore_unknown_feature() -> std::io::Result<()>
```

**Purpose**: Ensures unknown managed feature requirement keys are ignored with a startup warning rather than causing failure.

**Data flow**: Builds config with enterprise requirements `[features] made_up_feature = true` and asserts startup warnings mention the unknown feature requirement was ignored.

**Call relations**: Validation/compatibility test for forward-unknown managed feature keys.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `tool_suggest_discoverables_load_from_config_toml`  (lines 10305–10364)

```
async fn tool_suggest_discoverables_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks TOML parsing and runtime normalization for `tool_suggest.discoverables`, including dropping blank ids.

**Data flow**: Parses TOML with connector and plugin discoverables plus one blank connector id, asserts raw `ConfigToml` preserves all three entries, then loads runtime config and asserts `config.tool_suggest.discoverables` contains only the two non-blank normalized entries.

**Call relations**: Covers both raw TOML decoding and runtime cleanup for tool-suggestion discoverables.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `tool_suggest_disabled_tools_load_from_config_toml`  (lines 10367–10413)

```
async fn tool_suggest_disabled_tools_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks TOML parsing and runtime normalization for `tool_suggest.disabled_tools`, including trimming, deduplication, and dropping blanks.

**Data flow**: Parses TOML with duplicate/blank connector ids and one plugin id, asserts raw `ConfigToml` preserves all entries, then loads runtime config and asserts the disabled-tools list contains only normalized unique entries for `connector_calendar` and `slack@openai-curated`.

**Call relations**: Runtime normalization test for tool-suggestion disabled-tool lists.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `tool_suggest_disabled_tools_merge_across_config_layers`  (lines 10416–10470)

```
async fn tool_suggest_disabled_tools_merge_across_config_layers() -> std::io::Result<()>
```

**Purpose**: Verifies `tool_suggest.disabled_tools` entries merge across user and project config layers with normalization and deduplication.

**Data flow**: Writes user config and project-local config each containing overlapping disabled-tool lists, builds config for the trusted workspace, and asserts the final runtime list preserves merged order while deduplicating normalized duplicates.

**Call relations**: Layer-merging test for tool-suggestion disabled tools.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert_eq!, format!, create_dir_all, write).


##### `experimental_realtime_start_instructions_load_from_config_toml`  (lines 10473–10499)

```
async fn experimental_realtime_start_instructions_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `experimental_realtime_start_instructions`.

**Data flow**: Parses TOML with the field set, asserts raw `ConfigToml` contains it, loads runtime config, and asserts the runtime field matches.

**Call relations**: Simple parse-and-propagate test for an experimental realtime scalar.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_thread_config_endpoint_loads_from_config_toml`  (lines 10502–10528)

```
async fn experimental_thread_config_endpoint_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `experimental_thread_config_endpoint`.

**Data flow**: Parses TOML with the endpoint URL, asserts raw `ConfigToml` contains it, loads runtime config, and asserts the runtime field matches.

**Call relations**: Simple parse-and-propagate test for an experimental endpoint.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_base_url_loads_from_config_toml`  (lines 10531–10564)

```
async fn experimental_realtime_ws_base_url_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of experimental realtime websocket and WebRTC base URLs.

**Data flow**: Parses TOML with both URL fields, asserts raw `ConfigToml` contains them, loads runtime config, and asserts both runtime fields match.

**Call relations**: Simple parse-and-propagate test for experimental realtime URLs.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_backend_prompt_loads_from_config_toml`  (lines 10567–10593)

```
async fn experimental_realtime_ws_backend_prompt_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `experimental_realtime_ws_backend_prompt`.

**Data flow**: Parses TOML with the prompt string, asserts raw `ConfigToml` contains it, loads runtime config, and asserts the runtime field matches.

**Call relations**: Simple parse-and-propagate test for an experimental realtime prompt.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_startup_context_loads_from_config_toml`  (lines 10596–10622)

```
async fn experimental_realtime_ws_startup_context_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `experimental_realtime_ws_startup_context`.

**Data flow**: Parses TOML with the startup-context string, asserts raw `ConfigToml` contains it, loads runtime config, and asserts the runtime field matches.

**Call relations**: Simple parse-and-propagate test for an experimental realtime context field.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_model_loads_from_config_toml`  (lines 10625–10651)

```
async fn experimental_realtime_ws_model_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `experimental_realtime_ws_model`.

**Data flow**: Parses TOML with the model name, asserts raw `ConfigToml` contains it, loads runtime config, and asserts the runtime field matches.

**Call relations**: Simple parse-and-propagate test for an experimental realtime model selector.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_config_partial_table_uses_realtime_defaults`  (lines 10654–10679)

```
async fn realtime_config_partial_table_uses_realtime_defaults() -> std::io::Result<()>
```

**Purpose**: Verifies that a partial `[realtime]` table overlays onto `RealtimeConfig::default()` rather than requiring all fields.

**Data flow**: Parses TOML with only `voice = "marin"`, loads runtime config, and asserts `config.realtime` equals `RealtimeConfig { voice: Some(Marin), ..RealtimeConfig::default() }`.

**Call relations**: Runtime default-overlay test for structured realtime config.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_loads_from_config_toml`  (lines 10682–10725)

```
async fn realtime_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks full `[realtime]` TOML parsing and runtime propagation for architecture, version, session type, transport, and voice.

**Data flow**: Parses a complete realtime table, asserts raw `ConfigToml.realtime` equals the expected `RealtimeToml`, loads runtime config, and asserts the resulting `RealtimeConfig` contains the corresponding concrete enum values.

**Call relations**: Comprehensive parse-and-propagate test for structured realtime config.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_audio_loads_from_config_toml`  (lines 10728–10759)

```
async fn realtime_audio_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks parsing and runtime propagation of `[audio]` microphone and speaker settings used by realtime features.

**Data flow**: Parses TOML with `[audio] microphone` and `speaker`, asserts raw `ConfigToml.audio` contains both strings, loads runtime config, and asserts `config.realtime_audio` matches.

**Call relations**: Simple parse-and-propagate test for realtime audio device settings.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `test_tui_notifications_true`  (lines 10773–10783)

```
fn test_tui_notifications_true()
```

**Purpose**: Verifies that `tui.notifications = true` deserializes into `Notifications::Enabled(true)` through the flattened notification settings structure.

**Data flow**: Parses a small wrapper TOML into `RootTomlTest`, then pattern-matches `parsed.tui.notifications.notifications` with `assert_matches!` to confirm the enabled boolean variant.

**Call relations**: Uses the local `TuiTomlTest`/`RootTomlTest` helper structs to isolate notification-field deserialization behavior.

*Call graph*: 2 external calls (assert_matches!, from_str).


##### `test_tui_notifications_custom_array`  (lines 10786–10796)

```
fn test_tui_notifications_custom_array()
```

**Purpose**: Checks that `tui.notifications = ["foo"]` deserializes into the custom-notification list variant.

**Data flow**: Parses wrapper TOML into `RootTomlTest` and pattern-matches the flattened notifications field to confirm `Notifications::Custom(vec!["foo"])`.

**Call relations**: Companion notification-shape test for the array form.

*Call graph*: 2 external calls (assert_matches!, from_str).


##### `test_tui_notification_method`  (lines 10799–10807)

```
fn test_tui_notification_method()
```

**Purpose**: Verifies `tui.notification_method` parses into the `NotificationMethod` enum.

**Data flow**: Parses wrapper TOML with `notification_method = "bel"` and asserts the flattened notification settings contain `NotificationMethod::Bel`.

**Call relations**: Enum deserialization test for TUI notification settings.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_defaults_to_unfocused`  (lines 10810–10820)

```
fn test_tui_notification_condition_defaults_to_unfocused()
```

**Purpose**: Checks that the default notification condition is `Unfocused` when omitted.

**Data flow**: Parses an empty `[tui]` wrapper TOML and asserts the flattened notification settings contain `NotificationCondition::Unfocused`.

**Call relations**: Default-value test for notification condition.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_always`  (lines 10823–10834)

```
fn test_tui_notification_condition_always()
```

**Purpose**: Checks that `notification_condition = "always"` parses into the corresponding enum variant.

**Data flow**: Parses wrapper TOML with the field set and asserts the flattened notification settings contain `NotificationCondition::Always`.

**Call relations**: Explicit-value companion to the previous default test.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_rejects_unknown_value`  (lines 10837–10850)

```
fn test_tui_notification_condition_rejects_unknown_value()
```

**Purpose**: Ensures invalid notification-condition strings are rejected with an enum-variant error listing valid values.

**Data flow**: Attempts to parse `notification_condition = "background"`, captures the error string, and asserts it mentions the unknown variant plus `unfocused` and `always`.

**Call relations**: Negative parse test for TUI notification condition validation.

*Call graph*: 1 external calls (assert!).


### Configuration loading and managed policy resolution
These tests move from end-to-end config loading into the higher-level policy and feature decisions derived from layered config, managed requirements, and startup migrations or warnings.

### `core/src/config/config_loader_tests.rs`

`test` · `cross-cutting; exercised during test runs for config load, request setup, and policy evaluation paths`

This file is the regression suite for the config subsystem’s most subtle behaviors. It exercises `ConfigBuilder` and the lower-level `load_config_layers_state` / `load_requirements_toml` APIs against real temporary directories, synthetic `config.toml` and `requirements.toml` files, CLI override tuples, managed-config overrides, cloud bundle fixtures, and thread/session config loaders. The tests verify precedence across system, enterprise-managed, user, selected-profile, project, session-thread, and CLI layers; they also check that missing files still produce placeholder layers with preserved metadata. A major theme is trust-sensitive project loading: `.codex` layers are included, disabled, sanitized, or ignored depending on configured `TrustLevel`, canonical path matching, project-root markers, and linked-worktree detection. Another theme is requirements composition: system requirements, cloud bundle requirements, and macOS managed preferences are merged with source tracking and precedence rules, then converted into runtime constraints over approval policy, sandbox mode, permission profiles, hooks, residency, and filesystem deny-read patterns. The file also validates strict-config diagnostics, including unknown-field detection and source ranges, plus path resolution rules for relative CLI and project-local files. The nested `requirements_exec_policy_tests` module separately checks TOML parsing and runtime evaluation of requirements-based exec-policy prefix rules, including merge behavior with on-disk `.rules` files.

#### Function details

##### `config_error_from_io`  (lines 46–51)

```
fn config_error_from_io(err: &std::io::Error) -> &ConfigError
```

**Purpose**: Extracts the underlying `ConfigError` from an `std::io::Error` that is expected to wrap a `ConfigLoadError`. It is a test helper for comparing structured loader failures rather than stringifying them.

**Data flow**: Takes a borrowed `std::io::Error`, reads its inner error via `get_ref()`, downcasts that payload to `ConfigLoadError`, maps it to the embedded `ConfigError`, and returns a borrowed reference. It panics if the `io::Error` does not contain the expected wrapped type.

**Call relations**: Used by tests that intentionally provoke parse/schema/strictness failures from config loading so they can compare exact `ConfigError` values and source ranges instead of generic I/O errors.

*Call graph*: called by 5 (returns_config_error_for_invalid_managed_config_toml, returns_config_error_for_invalid_user_config_toml, returns_config_error_for_schema_error_in_user_config, strict_config_rejects_unknown_feature_user_config_key, strict_config_rejects_unknown_user_config_key); 1 external calls (get_ref).


##### `cloud_config_bundle_requirement_source`  (lines 53–58)

```
fn cloud_config_bundle_requirement_source() -> RequirementSource
```

**Purpose**: Builds the canonical `RequirementSource::EnterpriseManaged` value used by cloud-bundle requirement assertions in this file. The helper keeps source IDs and names consistent across tests.

**Data flow**: Creates and returns a fresh `RequirementSource::EnterpriseManaged` with fixed `id` `req_1` and `name` `Base requirements`. It reads no external state and writes nothing.

**Call relations**: Called by tests that compose requirements manually and need to assert that cloud-provided constraints retain their original source attribution after merging.

*Call graph*: called by 1 (system_remote_sandbox_config_keeps_cloud_sandbox_modes).


##### `load_single_requirements_toml`  (lines 60–67)

```
async fn load_single_requirements_toml(
    requirements_file: &AbsolutePathBuf,
) -> anyhow::Result<ConfigRequirementsWithSources>
```

**Purpose**: Loads one `requirements.toml` file through the production loader and immediately composes it into a single `ConfigRequirementsWithSources` value. It hides the optional-layer wrapper returned by the loader.

**Data flow**: Accepts an `AbsolutePathBuf` to a requirements file, calls `load_requirements_toml` against `LOCAL_FS`, unwraps the expected `Some(layer)`, then passes a one-element vector into `compose_requirements`. It returns the composed requirements-with-sources or propagates loader/composition errors via `anyhow::Result`.

**Call relations**: Used by requirement-focused tests that care about normalized paths and converted constraints, letting those tests exercise the real loader path before asserting on the merged result.

*Call graph*: calls 1 internal fn (load_requirements_toml); called by 3 (load_requirements_toml_produces_expected_constraints, load_requirements_toml_resolves_deny_read_against_parent, load_requirements_toml_resolves_deny_read_glob_against_parent); 2 external calls (compose_requirements, vec!).


##### `make_config_for_test`  (lines 69–90)

```
async fn make_config_for_test(
    codex_home: &Path,
    project_path: &Path,
    trust_level: TrustLevel,
    project_root_markers: Option<Vec<String>>,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal user `config.toml` for a test home directory, primarily to register a project trust level and optional project-root markers. It centralizes the exact TOML shape expected by project-layer tests.

**Data flow**: Takes `codex_home`, `project_path`, a `TrustLevel`, and optional marker strings; constructs a `ConfigToml` with a `projects` map keyed by the project path string and a `ProjectConfig { trust_level }`, serializes it with `toml::to_string`, and writes it to `codex_home/config.toml` asynchronously. It returns the `tokio::fs::write` result.

**Call relations**: Invoked by many project-trust and project-layer tests to seed the user config before calling `ConfigBuilder` or `load_config_layers_state`.

*Call graph*: called by 15 (cli_override_can_update_project_local_mcp_server_when_project_is_trusted, cli_overrides_with_relative_paths_do_not_break_trust_check, codex_home_within_project_tree_is_not_double_loaded, invalid_project_config_ignored_when_untrusted_or_unknown, linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml, nested_project_root_markers_do_not_redirect_regular_repo_hooks, project_layer_ignores_unsupported_config_keys, project_layer_is_added_when_dot_codex_exists_without_config_toml, project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown (+5 more)); 6 external calls (default, from, join, to_string_lossy, write, to_string).


##### `write_linked_worktree_pointer`  (lines 92–103)

```
async fn write_linked_worktree_pointer(
    repo_root: &Path,
    worktree_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Creates the minimal `.git` indirection needed to simulate a Git linked worktree. This lets tests verify that config content comes from the worktree while hook lookup can be redirected to the main repository.

**Data flow**: Given a repository root and worktree root, it creates `.git/worktrees/feature-x` under the repo root, then writes a `.git` file in the worktree root containing `gitdir: <repo-root>/.git/worktrees/feature-x`. It returns any filesystem error from directory creation or file writing.

**Call relations**: Used only by linked-worktree tests before loading config layers, so those tests can exercise the loader’s repository-root and hooks-folder resolution logic.

*Call graph*: called by 2 (linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml); 4 external calls (join, format!, create_dir_all, write).


##### `write_project_hook_config`  (lines 105–129)

```
async fn write_project_hook_config(
    dot_codex_folder: &Path,
    foo: Option<&str>,
    command: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a project-local `.codex/config.toml` containing a simple `hooks.PreToolUse` command hook and an optional sentinel `foo` field. It provides compact fixtures for hook-folder precedence tests.

**Data flow**: Accepts a `.codex` directory path, optional `foo` string, and command string; ensures the directory exists, formats TOML with optional `foo` plus a `[[hooks.PreToolUse]]` matcher and nested command hook, and writes it to `config.toml`. It returns the async write result.

**Call relations**: Called by worktree and nested-root-marker tests to create distinguishable hook configs at repo-root, repo-child, worktree-root, and worktree-child locations.

*Call graph*: called by 3 (linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml, nested_project_root_markers_do_not_redirect_regular_repo_hooks); 4 external calls (join, format!, create_dir_all, write).


##### `cli_overrides_resolve_relative_paths_against_cwd`  (lines 132–153)

```
async fn cli_overrides_resolve_relative_paths_against_cwd() -> std::io::Result<()>
```

**Purpose**: Verifies that relative path values supplied through CLI overrides are resolved against the current working directory rather than `CODEX_HOME`. The test specifically checks `log_dir` normalization.

**Data flow**: Creates temp home and cwd directories, builds a config with CLI override `log_dir = "run-logs"` and harness override `cwd`, then computes the expected absolute path with `AbsolutePathBuf::resolve_path_against_base`. It asserts that `config.log_dir` equals that resolved path.

**Call relations**: Exercises the `ConfigBuilder` path-resolution path directly, without lower-level layer inspection, to confirm final runtime config fields are normalized correctly.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 5 external calls (default, assert_eq!, default, tempdir, vec!).


##### `returns_config_error_for_invalid_user_config_toml`  (lines 156–179)

```
async fn returns_config_error_for_invalid_user_config_toml()
```

**Purpose**: Checks that malformed user `config.toml` syntax is surfaced as a structured `ConfigError` matching the TOML parser’s location information. It ensures loader failures preserve source-path context.

**Data flow**: Writes invalid TOML to `CODEX_HOME/config.toml`, calls `load_config_layers_state` expecting an error, extracts the embedded `ConfigError` with `config_error_from_io`, independently parses the same contents to obtain the TOML parse error, converts that into an expected `ConfigError` with `config_error_from_toml`, and compares them.

**Call relations**: Calls the low-level layer loader directly because the test is about raw load failure behavior before higher-level config building proceeds.

*Call graph*: calls 3 internal fn (load_config_layers_state, config_error_from_io, try_from); 5 external calls (assert_eq!, config_error_from_toml, default, write, tempdir).


##### `ignore_user_config_keeps_empty_user_layer`  (lines 182–215)

```
async fn ignore_user_config_keeps_empty_user_layer() -> std::io::Result<()>
```

**Purpose**: Verifies that `ignore_user_config` suppresses user settings but still leaves a user layer object in the stack with metadata intact. This preserves stack shape while removing user values from the effective config.

**Data flow**: Writes invalid user config, loads layers with `LoaderOverrides { ignore_user_config: true, .. }`, fetches the active user layer, and asserts its `config` is an empty TOML table and that the merged config has no `model` key. It returns `Ok(())` on success.

**Call relations**: Exercises a special loader override path where the file is intentionally ignored rather than parsed, confirming downstream layer inspection still sees a user layer.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 4 external calls (default, assert_eq!, write, tempdir).


##### `ignore_rules_marks_config_stack_for_exec_policy_rule_skip`  (lines 218–237)

```
async fn ignore_rules_marks_config_stack_for_exec_policy_rule_skip() -> std::io::Result<()>
```

**Purpose**: Checks that the loader records the flag to ignore user and project exec-policy rules when requested. The test is about stack metadata, not merged config values.

**Data flow**: Loads layers with `ignore_user_and_project_exec_policy_rules: true` and asserts `layers.ignore_user_and_project_exec_policy_rules()` is true. No files are written because only the flag propagation matters.

**Call relations**: Targets the loader-state object directly, validating a control bit later consumed by exec-policy loading logic.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 3 external calls (default, assert!, tempdir).


##### `returns_config_error_for_invalid_managed_config_toml`  (lines 240–266)

```
async fn returns_config_error_for_invalid_managed_config_toml()
```

**Purpose**: Ensures malformed managed config files produce the same structured parse diagnostics as malformed user config files. It confirms managed-config path overrides participate in normal TOML error reporting.

**Data flow**: Writes invalid TOML to a synthetic managed-config path, passes that path through `LoaderOverrides::with_managed_config_path_for_tests`, loads layers expecting failure, extracts the `ConfigError`, computes the expected parse-derived `ConfigError` for the managed path, and asserts equality.

**Call relations**: Uses the same helper flow as the invalid-user-config test, but through the managed-config branch of the loader.

*Call graph*: calls 4 internal fn (load_config_layers_state, with_managed_config_path_for_tests, config_error_from_io, try_from); 4 external calls (assert_eq!, config_error_from_toml, write, tempdir).


##### `returns_config_error_for_schema_error_in_user_config`  (lines 269–288)

```
async fn returns_config_error_for_schema_error_in_user_config()
```

**Purpose**: Checks that syntactically valid but type-invalid user config produces a typed-schema `ConfigError` with the expected location. This covers deserialization failures after TOML parsing succeeds.

**Data flow**: Writes `model_context_window = "not_a_number"`, builds config expecting failure, extracts the embedded `ConfigError`, constructs an `AbsolutePathBufGuard` so path handling matches production expectations, computes the expected typed-TOML error via `config_error_from_typed_toml::<ConfigToml>`, and compares them.

**Call relations**: Uses `ConfigBuilder` rather than the raw layer loader because the schema validation occurs in the typed config-building path.

*Call graph*: calls 2 internal fn (config_error_from_io, new); 4 external calls (assert_eq!, default, write, tempdir).


##### `top_level_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy`  (lines 291–315)

```
async fn top_level_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy() -> std::io::Result<()>
```

**Purpose**: Verifies that a top-level `allow_managed_hooks_only` key in user config does not leak into requirements policy state. The setting should not be interpreted as a managed requirement when sourced from user config.

**Data flow**: Writes `allow_managed_hooks_only = true` to user config, loads layers, then asserts both `layers.requirements_toml().allow_managed_hooks_only` and the converted runtime requirement field are `None`.

**Call relations**: Directly inspects the loaded layer stack to ensure user config parsing and requirements extraction remain separated.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 5 external calls (assert!, assert_eq!, default, write, tempdir).


##### `hooks_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy`  (lines 318–356)

```
async fn hooks_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy() -> std::io::Result<()>
```

**Purpose**: Checks the same separation as the previous test, but for `hooks.allow_managed_hooks_only` nested under a valid hooks table. It confirms hooks config still deserializes while requirements remain unset.

**Data flow**: Writes a hooks table containing `allow_managed_hooks_only = true` plus a valid `PreToolUse` command hook, loads layers, asserts the user layer still contains a `hooks` table, and separately asserts requirements TOML and runtime requirements do not gain `allow_managed_hooks_only`.

**Call relations**: Exercises a realistic mixed config where valid hook definitions coexist with a similarly named field that must not be promoted into requirements.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 5 external calls (assert!, assert_eq!, default, write, tempdir).


##### `strict_config_rejects_unknown_user_config_key`  (lines 359–380)

```
async fn strict_config_rejects_unknown_user_config_key()
```

**Purpose**: Ensures strict-config mode rejects unknown top-level keys in user config and reports them through structured config errors. This guards against silently ignored typos.

**Data flow**: Writes a config containing `unknown_key = true`, builds with `strict_config(true)` and no managed config, expects failure, extracts the `ConfigError`, computes the expected unknown-field error via `config_error_from_ignored_toml_fields::<ConfigToml>`, and asserts equality.

**Call relations**: Uses `ConfigBuilder` because strictness is a build option that affects validation of loaded layers.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, config_error_from_io); 4 external calls (assert_eq!, default, write, tempdir).


##### `strict_config_rejects_unknown_cli_override_key`  (lines 383–403)

```
async fn strict_config_rejects_unknown_cli_override_key()
```

**Purpose**: Checks that strict-config mode also validates CLI override keys, not just file-based config. The test asserts the exact human-readable error string.

**Data flow**: Builds config with CLI override `foo = "bar"`, strict mode enabled, and no managed config; expects an error and compares `err.to_string()` to the expected unknown-field message for `-c/--config` overrides.

**Call relations**: Covers the CLI override validation branch in `ConfigBuilder`, where there is no source file/range to compare structurally.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `strict_config_rejects_unknown_cli_override_key_with_relative_path_override`  (lines 406–431)

```
async fn strict_config_rejects_unknown_cli_override_key_with_relative_path_override()
```

**Purpose**: Verifies that strict CLI validation still rejects unknown keys even when another override is a valid relative-path field that requires path resolution. This prevents path normalization from masking later validation errors.

**Data flow**: Creates an instructions file, builds with two CLI overrides—valid `model_instructions_file = "instructions.md"` and invalid `foo = "bar"`—under strict mode, expects failure, and asserts the error string names `foo` as the unknown field.

**Call relations**: Exercises ordering between CLI path preprocessing and strict unknown-key detection in the builder.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, default, write, tempdir, vec!).


##### `strict_config_rejects_unknown_feature_cli_override_key`  (lines 434–451)

```
async fn strict_config_rejects_unknown_feature_cli_override_key()
```

**Purpose**: Checks that strict validation applies to nested feature override paths such as `features.foo`. Unknown feature flags must be rejected rather than accepted as arbitrary map entries.

**Data flow**: Builds config with CLI override `features.foo = true`, strict mode enabled, expects failure, and compares the resulting error string to the expected nested-field message.

**Call relations**: Targets the nested-key validation path for CLI overrides specifically.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `strict_config_rejects_unknown_feature_user_config_key`  (lines 454–477)

```
async fn strict_config_rejects_unknown_feature_user_config_key()
```

**Purpose**: Ensures unknown nested feature keys in user config produce a structured error with the correct dotted field name and source location. It validates strict-mode diagnostics for nested tables.

**Data flow**: Writes `[features]
foo = true`, builds in strict mode expecting failure, extracts the `ConfigError`, and asserts its message is `unknown configuration field \`features.foo\`` with line 2, column 1.

**Call relations**: Complements the CLI nested-key test by checking file-based strict validation and range reporting.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, config_error_from_io); 4 external calls (assert_eq!, default, write, tempdir).


##### `strict_config_points_to_unknown_nested_key`  (lines 480–497)

```
fn strict_config_points_to_unknown_nested_key()
```

**Purpose**: Checks that unknown nested keys inside deeper tables are reported with the full dotted path and the exact line/column of the offending entry. This is a pure parser/diagnostic unit test.

**Data flow**: Writes a config containing `[mcp_servers.local]` with `unknown_key = true`, calls `config_error_from_ignored_toml_fields::<ConfigToml>`, and asserts the resulting message and source range point to `mcp_servers.local.unknown_key` on line 3 column 1.

**Call relations**: Bypasses config loading entirely and tests the ignored-field diagnostic helper in isolation.

*Call graph*: 3 external calls (assert_eq!, write, tempdir).


##### `schema_error_points_to_feature_value`  (lines 499–514)

```
fn schema_error_points_to_feature_value()
```

**Purpose**: Verifies that typed-schema errors point at the invalid value token rather than only the containing key. The test uses a feature flag with the wrong scalar type.

**Data flow**: Writes `[features]
collaboration_modes = "true"`, computes a typed TOML error via `config_error_from_typed_toml::<ConfigToml>`, derives the expected column by locating the quoted value in the source line, and asserts the error starts at that line/column.

**Call relations**: Another isolated diagnostic test, focused on value-position accuracy for schema mismatches.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, write, tempdir).


##### `merges_managed_config_layer_on_top`  (lines 517–567)

```
async fn merges_managed_config_layer_on_top()
```

**Purpose**: Confirms that managed config overrides user config at both top-level and nested-table keys. It checks deep merge semantics and precedence ordering.

**Data flow**: Writes base user config and managed config with overlapping `foo` and `nested.value` plus managed-only `nested.extra`, loads layers with a managed-config override path, obtains `effective_config()`, and asserts `foo = 2`, `nested.value = "managed_config"`, and `nested.extra = true`.

**Call relations**: Exercises the merged-config output of the layer loader, specifically the precedence of managed config over user config.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 3 external calls (assert_eq!, write, tempdir).


##### `returns_empty_when_all_layers_missing`  (lines 570–629)

```
async fn returns_empty_when_all_layers_missing()
```

**Purpose**: Verifies the loader’s baseline behavior when no user or managed config files exist. The stack should still contain a placeholder user layer and a system layer, while the effective config remains empty.

**Data flow**: Creates temp paths without writing config files, loads layers with a managed-config path override, fetches the active user layer, compares it to an expected empty `ConfigLayerEntry::new(ConfigLayerSource::User { ... }, empty table)`, checks the merged table is empty, counts system layers, and on non-macOS reasserts the effective table is empty.

**Call relations**: Covers the no-files-present branch of the loader, ensuring downstream code can rely on stable layer metadata even in empty environments.

*Call graph*: calls 5 internal fn (load_config_layers_state, new, with_managed_config_path_for_tests, resolve_path_against_base, try_from); 5 external calls (Table, assert!, assert_eq!, tempdir, new).


##### `selected_user_config_file_layers_over_base_user_config`  (lines 632–700)

```
async fn selected_user_config_file_layers_over_base_user_config()
```

**Purpose**: Checks that an explicitly selected user config file/profile is layered above the default `CODEX_HOME/config.toml` rather than replacing it entirely. Shared keys should inherit from the base file while overridden keys come from the selected file.

**Data flow**: Writes a default user config and a separate selected config, sets `LoaderOverrides.user_config_path` and `user_config_profile`, loads layers, inspects user layers in low-to-high order, asserts both base and selected user layers are present with correct `ConfigLayerSource::User` metadata, and verifies the merged config uses `model` from the selected file and `approval_policy` from the base file.

**Call relations**: Exercises the multi-user-layer branch of the loader where profile selection adds another layer instead of mutating the base one.

*Call graph*: calls 4 internal fn (load_config_layers_state, with_managed_config_path_for_tests, from_absolute_path, try_from); 3 external calls (assert_eq!, write, tempdir).


##### `includes_thread_config_layers_in_stack`  (lines 703–757)

```
async fn includes_thread_config_layers_in_stack() -> anyhow::Result<()>
```

**Purpose**: Verifies that session/thread config sources are inserted into the config stack as `SessionFlags` layers and can override CLI/session values. It also checks the exact layer ordering relative to user and system layers.

**Data flow**: Creates a project cwd, loads layers with a CLI override `features.plugins = true` and a `StaticThreadConfigLoader` returning `SessionThreadConfig { features.plugins = false }`, then collects layer sources from `layers_high_to_low()` and asserts the order is session flags, session flags, user, system. It also asserts the effective `features.plugins` value is `false`.

**Call relations**: Combines CLI/session inputs with the loader’s thread-config integration path to validate both stack shape and precedence.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, new, from_absolute_path); 5 external calls (Boolean, assert_eq!, tempdir, create_dir_all, vec!).


##### `managed_preferences_take_highest_precedence`  (lines 761–827)

```
async fn managed_preferences_take_highest_precedence()
```

**Purpose**: On macOS, confirms that base64-encoded managed preferences from MDM override both user config and managed config files. It also checks that the raw TOML payload is preserved on the corresponding layer.

**Data flow**: Writes user and managed config files, encodes a managed-preferences TOML blob into `managed_preferences_base64`, loads layers, asserts the merged `nested.value` and `nested.flag` come from the MDM payload, then finds the `LegacyManagedConfigTomlFromMdm` layer and checks its preserved raw TOML contains expected text.

**Call relations**: Exercises the macOS-specific managed-preferences branch and its precedence above file-based managed config.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `managed_preferences_expand_home_directory_in_workspace_write_roots`  (lines 831–876)

```
async fn managed_preferences_expand_home_directory_in_workspace_write_roots() -> anyhow::Result<()>
```

**Purpose**: Checks that `~` in macOS managed-preferences writable roots is expanded to the actual home directory before becoming runtime sandbox policy. This ensures managed path settings are normalized like user-facing ones.

**Data flow**: Obtains the current home directory, encodes a managed-preferences TOML blob selecting `workspace-write` with `writable_roots = ["~/code"]`, builds config, computes the expected absolute root, and matches on `config.legacy_sandbox_policy()` to assert that root appears exactly once in the writable roots list.

**Call relations**: Uses `ConfigBuilder` because the assertion is against the final runtime sandbox policy, not just raw layer TOML.

*Call graph*: calls 2 internal fn (with_managed_config_path_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, home_dir, panic!, tempdir).


##### `managed_preferences_requirements_are_applied`  (lines 880–931)

```
async fn managed_preferences_requirements_are_applied() -> anyhow::Result<()>
```

**Purpose**: On macOS, verifies that managed-preferences requirements are converted into active runtime constraints over approval policy and permission profile. It checks both chosen defaults and rejection of disallowed alternatives.

**Data flow**: Encodes requirements TOML with `allowed_approval_policies = ["never"]` and `allowed_sandbox_modes = ["read-only"]`, loads layers, asserts runtime requirements choose `AskForApproval::Never` and `PermissionProfile::read_only()`, and asserts `can_set` rejects `OnRequest` and `workspace_write()`.

**Call relations**: Exercises the macOS managed-requirements ingestion path and the conversion from TOML requirements into constraint objects.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `managed_preferences_requirements_take_precedence`  (lines 935–981)

```
async fn managed_preferences_requirements_take_precedence() -> anyhow::Result<()>
```

**Purpose**: Checks that macOS managed requirements override conflicting values from managed config files. Requirements should constrain the effective runtime choice even if config requests something else.

**Data flow**: Writes managed config with `approval_policy = "on-request"`, supplies managed requirements allowing only `never`, loads layers, and asserts the runtime requirement value is `Never` and rejects setting `OnRequest`.

**Call relations**: Tests precedence between two managed sources: config values versus requirements constraints.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 4 external calls (assert!, assert_eq!, tempdir, write).


##### `load_requirements_toml_produces_expected_constraints`  (lines 984–1073)

```
async fn load_requirements_toml_produces_expected_constraints() -> anyhow::Result<()>
```

**Purpose**: Validates end-to-end parsing of `requirements.toml` into both sourced TOML representation and runtime `ConfigRequirements`. It covers approval policy, web search mode, residency, and feature requirements.

**Data flow**: Writes a requirements file with allowed approval policies, allowed web search modes, residency, and `[features] personality = true`, loads it through `load_single_requirements_toml`, asserts the sourced TOML fields contain expected enums and maps, converts to `ConfigRequirements`, then checks chosen default values and `can_set` behavior for allowed and disallowed alternatives.

**Call relations**: Uses the helper loader to exercise the real requirements parser before asserting on the runtime constraint objects it feeds.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert!, assert_eq!, tempdir, write).


##### `mdm_requirements_take_precedence_over_cloud_config_bundle`  (lines 1077–1127)

```
async fn mdm_requirements_take_precedence_over_cloud_config_bundle() -> anyhow::Result<()>
```

**Purpose**: On macOS, verifies that MDM-managed requirements outrank cloud-bundle requirements when both constrain the same field. Source attribution in the resulting constraint error must point to MDM.

**Data flow**: Builds loader options with MDM requirements allowing only `on-request` and a cloud bundle requiring `never`, loads layers, asserts the runtime approval policy value is `OnRequest`, and checks that attempting `Never` yields `ConstraintError::InvalidValue` whose `requirement_source` is `RequirementSource::MdmManagedPreferences`.

**Call relations**: Exercises precedence across two managed requirement channels and confirms the winning source is preserved in validation errors.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_requirement, try_from); 3 external calls (default, assert_eq!, tempdir).


##### `cloud_config_bundle_are_not_overwritten_by_system_requirements`  (lines 1130–1172)

```
async fn cloud_config_bundle_are_not_overwritten_by_system_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that cloud-bundle requirements override system requirements for overlapping fields during composition. The test also verifies the surviving source metadata remains the cloud source.

**Data flow**: Writes a system `requirements.toml` allowing `on-request`, loads it as a requirements layer, manually composes it with a cloud `RequirementsLayerEntry` allowing `never`, and asserts the resulting `allowed_approval_policies` value and source are both from the cloud layer.

**Call relations**: By composing layers manually, the test isolates requirements precedence logic from the broader config loader.

*Call graph*: calls 2 internal fn (load_requirements_toml, try_from); 5 external calls (assert_eq!, compose_requirements, tempdir, write, vec!).


##### `system_remote_sandbox_config_keeps_cloud_sandbox_modes`  (lines 1175–1218)

```
async fn system_remote_sandbox_config_keeps_cloud_sandbox_modes() -> anyhow::Result<()>
```

**Purpose**: Verifies that cloud-level sandbox-mode restrictions still govern runtime permission checks even when system requirements define `remote_sandbox_config`. It ensures remote sandbox config does not accidentally widen cloud constraints.

**Data flow**: Writes system requirements containing a `remote_sandbox_config` entry that allows `read-only` and `workspace-write`, composes that with a cloud requirement allowing only `read-only`, converts to `ConfigRequirements`, and asserts `permission_profile.can_set(workspace_write())` returns a `ConstraintError::InvalidValue` sourced from the cloud requirement.

**Call relations**: Another manual-composition test focused on the interaction between remote sandbox config and top-level allowed sandbox modes.

*Call graph*: calls 3 internal fn (load_requirements_toml, cloud_config_bundle_requirement_source, try_from); 5 external calls (assert_eq!, compose_requirements, tempdir, write, vec!).


##### `load_requirements_toml_resolves_deny_read_against_parent`  (lines 1221–1266)

```
async fn load_requirements_toml_resolves_deny_read_against_parent() -> anyhow::Result<()>
```

**Purpose**: Checks that relative filesystem `deny_read` paths in `requirements.toml` are resolved against the parent directory of the requirements file. This applies to both `./` and `../` forms.

**Data flow**: Creates a nested `managed/requirements.toml` with `deny_read = ["./sensitive", "../shared/secret.txt"]`, loads it through `load_single_requirements_toml`, extracts `permissions.filesystem.deny_read`, and asserts it equals two `FilesystemDenyReadPattern` values built from absolute paths under the requirements file’s parent and sibling directories. It also asserts the requirement source is `SystemRequirementsToml { file }`.

**Call relations**: Exercises path normalization inside requirements loading, not just TOML parsing.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `load_requirements_toml_resolves_deny_read_glob_against_parent`  (lines 1269–1315)

```
async fn load_requirements_toml_resolves_deny_read_glob_against_parent() -> anyhow::Result<()>
```

**Purpose**: Verifies the same parent-relative resolution for glob-style `deny_read` patterns. The loader should normalize the glob into an absolute pattern rooted at the requirements file directory.

**Data flow**: Writes `deny_read = ["./sensitive/**/*.txt"]`, loads the requirements, extracts the deny-read list, and asserts it contains a single `FilesystemDenyReadPattern::from_input` built from the absolute glob string rooted at the requirements directory. It also checks the source metadata.

**Call relations**: Complements the previous test by covering glob normalization rather than plain path normalization.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `load_config_layers_includes_cloud_config_bundle`  (lines 1318–1360)

```
async fn load_config_layers_includes_cloud_config_bundle() -> anyhow::Result<()>
```

**Purpose**: Checks that cloud-bundle requirements are loaded into the config layer state and enforced as runtime constraints. It validates both raw requirements TOML and converted `ConstraintError` behavior.

**Data flow**: Creates an empty home directory, builds a cloud bundle fixture with `allowed_approval_policies = ["never"]`, loads layers, compares `layers.requirements_toml().allowed_approval_policies` to the TOML-parsed expected value, and asserts `approval_policy.can_set(OnRequest)` fails with a `ConstraintError::InvalidValue` sourced from the enterprise-managed requirement.

**Call relations**: Exercises the cloud-bundle integration path of `load_config_layers_state` without involving local requirements files.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (default, assert_eq!, tempdir, create_dir_all, from_str).


##### `system_requirements_define_managed_permission_profiles`  (lines 1363–1414)

```
async fn system_requirements_define_managed_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Verifies that system requirements can define managed permission profiles and select one as the default, and that the built config activates that profile. It checks both raw requirements storage and runtime permission selection.

**Data flow**: Writes user config selecting `default_permissions = "managed-standard"`, writes system requirements defining `default_permissions`, `allowed_permission_profiles`, and `[permissions.managed-standard] extends = ":workspace"`, builds config with `system_requirements_path`, then asserts the requirements TOML contains the allowed profile map and the active permission profile ID is `managed-standard`.

**Call relations**: Uses `ConfigBuilder` because the test is about final permission-profile activation after requirements and config are reconciled.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_select_managed_default_without_local_default`  (lines 1417–1477)

```
async fn system_allowed_permission_profiles_select_managed_default_without_local_default() -> anyhow::Result<()>
```

**Purpose**: Checks that when system requirements define allowed managed profiles and a managed default, that default is selected even if local config does not specify one. The behavior is tested across trusted, untrusted, and unknown project trust states.

**Data flow**: For each trust-level case, optionally writes user trust config, writes system requirements with `default_permissions = "managed-standard"` and two allowed managed profiles, builds config, asserts the active permission profile is `managed-standard`, and confirms no startup warning claims the chosen profile is disallowed.

**Call relations**: Exercises the fallback/default-selection logic in `ConfigBuilder` under multiple trust contexts while keeping requirements constant.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, make_config_for_test, from_absolute_path); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_require_managed_default`  (lines 1480–1514)

```
async fn system_allowed_permission_profiles_require_managed_default() -> anyhow::Result<()>
```

**Purpose**: Ensures that if system requirements restrict allowed permission profiles to managed ones, they must also specify `default_permissions` unless the allowed set is the standard built-in pair. This prevents ambiguous startup defaults.

**Data flow**: Writes system requirements with a managed profile and `allowed_permission_profiles` but no `default_permissions`, builds config expecting failure, and asserts the error string mentions the requirement that `default_permissions` must be set unless both standard built-ins are allowed.

**Call relations**: Targets validation logic in config building for incomplete managed-permission requirements.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_standard_pair_defaults_to_workspace`  (lines 1517–1550)

```
async fn system_allowed_permission_profiles_standard_pair_defaults_to_workspace() -> anyhow::Result<()>
```

**Purpose**: Checks the special-case rule that if `allowed_permission_profiles` contains exactly the built-in `:read-only` and `:workspace` pair, the default falls back to workspace. No explicit managed default is required.

**Data flow**: Writes system requirements allowing only `:read-only` and `:workspace`, builds config, and asserts the active permission profile ID is the built-in workspace profile constant.

**Call relations**: Covers the permissive built-in-pair branch of permission-profile default selection.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_managed_default_must_be_allowed`  (lines 1553–1592)

```
async fn system_managed_default_must_be_allowed() -> anyhow::Result<()>
```

**Purpose**: Verifies that a `default_permissions` value in system requirements must itself appear in `allowed_permission_profiles`. A managed default outside the allowed set is rejected.

**Data flow**: Writes system requirements where `default_permissions = "managed-build"` but `allowed_permission_profiles` only allows `managed-standard`, builds expecting failure, and asserts the error string states that `managed-build` must be allowed.

**Call relations**: Exercises consistency validation between two related requirements fields.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_managed_default_requires_allowed_permission_profiles`  (lines 1595–1624)

```
async fn system_managed_default_requires_allowed_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Checks the inverse consistency rule: specifying `default_permissions` in system requirements requires an accompanying `allowed_permission_profiles` set. A default without an allowlist is invalid.

**Data flow**: Writes system requirements containing only `default_permissions = ":read-only"`, builds expecting failure, and asserts the error string mentions that `default_permissions` requires `allowed_permission_profiles`.

**Call relations**: Complements the previous validation test by covering the missing-allowlist case.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_fall_back_from_disallowed_danger_full_access`  (lines 1627–1680)

```
async fn system_allowed_permission_profiles_fall_back_from_disallowed_danger_full_access() -> anyhow::Result<()>
```

**Purpose**: Verifies that if local config selects the dangerous built-in full-access profile but requirements disallow it, config building falls back to the managed default and emits a warning. This protects startup from invalid local defaults.

**Data flow**: Writes user config selecting `BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS`, writes system requirements allowing only `managed-standard` and setting it as default, builds config, asserts the active profile becomes `managed-standard`, and checks `startup_warnings` contains a message that the configured permission profile is disallowed by requirements.

**Call relations**: Exercises reconciliation between user-selected defaults and requirement-enforced allowlists.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 7 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_fall_back_from_disallowed_workspace`  (lines 1683–1734)

```
async fn system_allowed_permission_profiles_fall_back_from_disallowed_workspace() -> anyhow::Result<()>
```

**Purpose**: Checks the same fallback-and-warning behavior when local config selects built-in `:workspace` but requirements allow only a managed profile. The runtime profile should switch to the managed default.

**Data flow**: Writes user config selecting `:workspace`, writes system requirements allowing only `managed-standard`, builds config, asserts the active profile is `managed-standard`, and checks for the disallowed-profile startup warning.

**Call relations**: Pairs with the previous test to cover another disallowed built-in profile.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `system_requirements_preserve_allowed_configured_permission_default`  (lines 1737–1786)

```
async fn system_requirements_preserve_allowed_configured_permission_default() -> anyhow::Result<()>
```

**Purpose**: Verifies that if local config selects a permission profile that is allowed by system requirements, the configured choice is preserved instead of being replaced by the system default. Requirements constrain but do not unnecessarily override valid local choices.

**Data flow**: Writes user config selecting `managed-build`, writes system requirements whose default is `managed-standard` but whose allowlist includes both `managed-build` and `managed-standard`, builds config, and asserts the active profile remains `managed-build`.

**Call relations**: Exercises the non-warning, preserve-user-choice branch of permission-profile reconciliation.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_requirements_warn_for_disallowed_explicit_permission_override`  (lines 1789–1837)

```
async fn system_requirements_warn_for_disallowed_explicit_permission_override() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicit harness override for default permissions is also subject to requirements validation and fallback. Disallowed overrides should not win silently.

**Data flow**: Writes system requirements allowing only `managed-standard`, builds config with a harness override `default_permissions = "managed-build"`, asserts the active profile falls back to `managed-standard`, and checks for the same disallowed-profile startup warning.

**Call relations**: Extends permission-profile validation coverage from file-based config to harness/runtime overrides.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 7 external calls (assert!, assert_eq!, default, default, tempdir, create_dir_all, write).


##### `load_config_layers_inserts_cloud_config_between_system_and_user`  (lines 1840–1919)

```
async fn load_config_layers_inserts_cloud_config_between_system_and_user() -> anyhow::Result<()>
```

**Purpose**: Verifies that enterprise-managed cloud config is inserted between system and user config layers in precedence order. User config should still override cloud values, while cloud should override system values.

**Data flow**: Writes user config with `model = "user"`, system config with `model`, `model_provider`, and `review_model`, loads layers with a cloud config bundle setting `model = "cloud"` and `model_provider = "cloud-provider"`, then asserts the merged config has `model` from user, `model_provider` from cloud, and `review_model` from system. It also asserts the low-to-high layer source order is system, enterprise-managed, user.

**Call relations**: Exercises cloud config insertion into the ordinary config layer stack, distinct from cloud requirements.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_config, from_absolute_path); 5 external calls (default, assert_eq!, tempdir, create_dir_all, write).


##### `load_config_layers_can_ignore_managed_requirements`  (lines 1922–1974)

```
async fn load_config_layers_can_ignore_managed_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that `ignore_managed_requirements` disables enforcement from managed requirements sources while still allowing config loading to proceed. This leaves otherwise constrained settings mutable.

**Data flow**: Writes a managed config file and a system requirements file, sets loader overrides including `ignore_managed_requirements = true`, supplies a cloud requirement that would normally force `approval_policy = never`, builds config, and asserts `approval_policy.can_set(OnRequest)` succeeds and `set(OnRequest)` works.

**Call relations**: Exercises a loader override that suppresses requirement enforcement across managed sources during config building.

*Call graph*: calls 3 internal fn (with_managed_config_path_for_tests, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `load_config_layers_includes_cloud_hook_requirements`  (lines 1977–2030)

```
async fn load_config_layers_includes_cloud_hook_requirements() -> anyhow::Result<()>
```

**Purpose**: Verifies that hook-related requirements from a cloud bundle are loaded into both raw requirements TOML and runtime managed-hooks state. It checks source attribution for managed hooks.

**Data flow**: Creates a managed hooks directory, formats a cloud requirements TOML containing `[hooks] managed_dir` and a `PreToolUse` command hook, loads layers with that cloud bundle, asserts `layers.requirements_toml().hooks` equals the TOML-parsed expected hooks section, and asserts `layers.requirements().managed_hooks` carries the cloud requirement source.

**Call relations**: Covers the cloud-bundle path for hook requirements specifically, separate from approval/sandbox constraints.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 6 external calls (default, assert_eq!, format!, tempdir, create_dir_all, from_str).


##### `load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home`  (lines 2033–2079)

```
async fn load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home() -> anyhow::Result<()>
```

**Purpose**: Checks that relative paths inside cloud-bundle requirements are resolved against `codex_home`, not the current working directory. This matters for enterprise-managed filesystem restrictions.

**Data flow**: Creates `codex_home`, loads layers with a cloud requirement containing `[permissions.filesystem] deny_read = ["secrets/**"]`, extracts the resulting filesystem requirements, and asserts the deny-read pattern equals an absolute glob rooted at `codex_home/secrets/**`.

**Call relations**: Exercises path normalization for cloud-provided requirements, complementing the local requirements path-resolution tests.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_requirement, from_absolute_path); 4 external calls (default, assert_eq!, tempdir, create_dir_all).


##### `strict_config_rejects_unknown_cloud_config_key`  (lines 2082–2112)

```
async fn strict_config_rejects_unknown_cloud_config_key()
```

**Purpose**: Ensures strict-config mode validates enterprise-managed cloud config keys too. Unknown keys in cloud config should fail closed rather than being ignored.

**Data flow**: Loads layers in strict mode with a cloud config bundle containing `unknown_key = true`, expects an error, and asserts the error string contains `unknown configuration field \`unknown_key\``.

**Call relations**: Extends strict-config coverage from user files and CLI overrides to cloud-managed config sources.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_config, from_absolute_path); 3 external calls (assert!, tempdir, create_dir_all).


##### `load_config_layers_applies_matching_remote_sandbox_config`  (lines 2115–2159)

```
async fn load_config_layers_applies_matching_remote_sandbox_config() -> anyhow::Result<()>
```

**Purpose**: Verifies that matching `remote_sandbox_config` entries can widen the effective allowed sandbox modes for the current environment. A wildcard hostname rule should permit workspace-write even when the top-level default is read-only.

**Data flow**: Loads layers with a cloud requirement specifying top-level `allowed_sandbox_modes = ["read-only"]` plus a `remote_sandbox_config` entry matching `*` and allowing `read-only` and `workspace-write`, then asserts the merged requirements TOML exposes both modes and runtime `permission_profile.can_set(workspace_write())` succeeds.

**Call relations**: Exercises the remote-sandbox matching logic inside requirements processing after cloud bundle ingestion.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (default, assert!, assert_eq!, tempdir, create_dir_all).


##### `load_config_layers_fails_when_cloud_config_bundle_loader_fails`  (lines 2162–2192)

```
async fn load_config_layers_fails_when_cloud_config_bundle_loader_fails() -> anyhow::Result<()>
```

**Purpose**: Checks that cloud bundle loading is fail-closed: if the bundle loader returns an error, config loading fails instead of silently continuing. The test also verifies the resulting `io::Error` shape.

**Data flow**: Constructs a `CloudConfigBundleLoader` whose async body returns `CloudConfigBundleLoadError::new(RequestFailed, None, "cloud config bundle failed")`, calls `load_config_layers_state` expecting failure, and asserts the resulting error has kind `Other` and contains the loader message.

**Call relations**: Targets the error-propagation path from the asynchronous cloud bundle loader into the config layer loader.

*Call graph*: calls 4 internal fn (new, new, load_config_layers_state, from_absolute_path); 5 external calls (default, assert!, assert_eq!, tempdir, create_dir_all).


##### `project_layers_prefer_closest_cwd`  (lines 2195–2258)

```
async fn project_layers_prefer_closest_cwd() -> std::io::Result<()>
```

**Purpose**: Verifies that when multiple `.codex` directories exist along the path to the project root, the closest one to the current working directory has higher precedence. The merged config should therefore prefer the nested project-local value.

**Data flow**: Creates a Git-rooted project with `.codex/config.toml` at both root and child directories, marks the project trusted in user config, loads layers from the child cwd, collects project layer folders from high to low precedence, and asserts the child `.codex` comes before the root `.codex`. It then checks merged `foo` equals `child`.

**Call relations**: Exercises project-layer discovery and ordering based on cwd proximity within a trusted project.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks`  (lines 2261–2360)

```
async fn linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks() -> std::io::Result<()>
```

**Purpose**: Checks linked-worktree behavior where project config values come from worktree `.codex` files but hook lookup is redirected to the corresponding main-repo `.codex` folders. This preserves worktree-local config while sharing repository hooks.

**Data flow**: Builds repo-root/repo-child and worktree-root/worktree-child `.codex` trees with distinct `foo` values and hook commands, writes a linked-worktree `.git` pointer, marks the repo trusted, loads layers from the worktree child, and asserts there are two project layers whose `hooks_config_folder()` points to repo-child and repo-root while their `config.foo` values come from worktree-child and worktree-root. It uses `project_hook_command` to assert the hook commands come from the repo-side configs.

**Call relations**: Exercises the loader’s special-case mapping between worktree config locations and canonical hook folders for linked Git worktrees.

*Call graph*: calls 5 internal fn (load_config_layers_state, make_config_for_test, write_linked_worktree_pointer, write_project_hook_config, from_absolute_path); 4 external calls (assert_eq!, default, tempdir, create_dir_all).


##### `linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml`  (lines 2363–2417)

```
async fn linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml() -> std::io::Result<()>
```

**Purpose**: Verifies the linked-worktree fallback when the worktree has a `.codex` directory but no `config.toml`: the loader should still create a project layer whose hooks folder points at the main repo’s `.codex`. This ensures hooks remain discoverable without worktree-local config content.

**Data flow**: Creates a repo root with hook config, a worktree root with only `.codex/`, writes the linked-worktree pointer, marks the repo trusted, loads layers from the worktree root, and asserts there is one project layer whose `hooks_config_folder()` is the repo-root `.codex` and whose extracted hook command is `echo repo root hook`.

**Call relations**: Covers the no-worktree-config branch of linked-worktree project-layer construction.

*Call graph*: calls 5 internal fn (load_config_layers_state, make_config_for_test, write_linked_worktree_pointer, write_project_hook_config, from_absolute_path); 4 external calls (assert_eq!, default, tempdir, create_dir_all).


##### `nested_project_root_markers_do_not_redirect_regular_repo_hooks`  (lines 2420–2495)

```
async fn nested_project_root_markers_do_not_redirect_regular_repo_hooks() -> std::io::Result<()>
```

**Purpose**: Checks that alternate project-root markers such as `.hg` affect project-root discovery but do not trigger linked-worktree-style hook redirection in a normal repository tree. Nested project layers should keep their own hook folders.

**Data flow**: Creates a repo root with `.git`, a project root with `.hg`, and a nested child, writes distinct hook configs at repo, project, and nested `.codex` folders, marks the project root trusted with `project_root_markers = [".hg"]`, loads layers from the nested cwd, and asserts the two project layers use nested and project hook folders directly and expose the corresponding hook commands.

**Call relations**: Contrasts ordinary nested project-root-marker behavior with the special linked-worktree hook redirection tested above.

*Call graph*: calls 4 internal fn (load_config_layers_state, make_config_for_test, write_project_hook_config, from_absolute_path); 6 external calls (assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `project_hook_command`  (lines 2497–2509)

```
fn project_hook_command(layer: &ConfigLayerEntry) -> Option<&str>
```

**Purpose**: Extracts the first command string from the first `hooks.PreToolUse` hook in a `ConfigLayerEntry`. It is a narrow helper for asserting which hook config file supplied a project layer’s hooks.

**Data flow**: Traverses `layer.config` through `hooks` → `PreToolUse` array → first element → nested `hooks` array → first element → `command`, returning `Option<&str>` if every lookup and type conversion succeeds. It reads only the provided layer and writes nothing.

**Call relations**: Used by project-hook precedence tests to compare the effective hook command embedded in each project layer without re-parsing the whole TOML structure in each test.


##### `project_paths_resolve_relative_to_dot_codex_and_override_in_order`  (lines 2512–2565)

```
async fn project_paths_resolve_relative_to_dot_codex_and_override_in_order() -> std::io::Result<()>
```

**Purpose**: Verifies that path-valued settings inside project-local `.codex/config.toml` are resolved relative to that `.codex` directory, and that nearer project layers override farther ones. The test uses `model_instructions_file` to confirm both behaviors.

**Data flow**: Creates root and nested `.codex/config.toml` files pointing to `root.txt` and `child.txt`, writes those files beside each config, marks the project trusted, builds config with cwd at the nested directory, and asserts `config.base_instructions` contains the contents of `child.txt`.

**Call relations**: Uses `ConfigBuilder` because the assertion is against the final loaded instruction text after path resolution and layer precedence are applied.

*Call graph*: calls 1 internal fn (make_config_for_test); 6 external calls (assert_eq!, default, default, tempdir, create_dir_all, write).


##### `cli_override_model_instructions_file_sets_base_instructions`  (lines 2568–2601)

```
async fn cli_override_model_instructions_file_sets_base_instructions() -> std::io::Result<()>
```

**Purpose**: Checks that a CLI override for `model_instructions_file` is read and loaded into `base_instructions`. This covers the path-valued CLI override path all the way to final instruction content.

**Data flow**: Creates an empty user config, a cwd directory, and an instructions file, builds config with CLI override `model_instructions_file = <absolute path>`, and asserts `config.base_instructions` equals the file contents.

**Call relations**: Exercises `ConfigBuilder`’s post-merge instruction-file loading for CLI-sourced settings.

*Call graph*: 7 external calls (assert_eq!, default, default, tempdir, create_dir_all, write, vec!).


##### `inline_instructions_set_base_instructions`  (lines 2604–2625)

```
async fn inline_instructions_set_base_instructions() -> std::io::Result<()>
```

**Purpose**: Verifies that inline `instructions = "..."` in config directly populate `base_instructions` without needing an external file. This is the simplest instruction-loading path.

**Data flow**: Writes user config containing `instructions = "snapshot instructions"`, builds config without managed config, and asserts `config.base_instructions` is that exact string.

**Call relations**: Complements file-based instruction tests by covering the inline-text branch.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `project_layer_is_added_when_dot_codex_exists_without_config_toml`  (lines 2628–2670)

```
async fn project_layer_is_added_when_dot_codex_exists_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that the loader still creates a project layer when a `.codex` directory exists but contains no `config.toml`. The layer should be present with an empty table so metadata and hooks-folder semantics remain available.

**Data flow**: Creates a trusted Git project with a `.codex` directory but no config file, loads layers from a nested cwd, filters project layers, constructs an expected empty `ConfigLayerEntry` for the project `.codex` folder, and asserts the actual project layers equal that single expected layer.

**Call relations**: Exercises the project-layer discovery path where directory presence alone is enough to create a layer.

*Call graph*: calls 4 internal fn (load_config_layers_state, new, make_config_for_test, from_absolute_path); 7 external calls (Table, assert_eq!, default, tempdir, create_dir_all, write, new).


##### `codex_home_is_not_loaded_as_project_layer_from_home_dir`  (lines 2673–2712)

```
async fn codex_home_is_not_loaded_as_project_layer_from_home_dir() -> std::io::Result<()>
```

**Purpose**: Verifies that `codex_home` itself is treated only as the user config location, not also as a project-local `.codex` layer when the cwd is the home directory. This prevents double-loading the same config.

**Data flow**: Creates `home/.codex/config.toml` with `foo = "user"`, loads layers with `codex_home = home/.codex` and cwd at `home`, filters project layers from the full stack including disabled ones, asserts there are none, and confirms the effective config still contains `foo = "user"` from the user layer.

**Call relations**: Targets a deduplication edge case where the user config directory could otherwise be mistaken for a project `.codex` folder.

*Call graph*: calls 2 internal fn (load_config_layers_state, from_absolute_path); 6 external calls (new, assert_eq!, default, tempdir, create_dir_all, write).


##### `codex_home_within_project_tree_is_not_double_loaded`  (lines 2715–2788)

```
async fn codex_home_within_project_tree_is_not_double_loaded() -> std::io::Result<()>
```

**Purpose**: Checks another deduplication edge case: when `codex_home` itself lives inside a project tree, it should not also appear as a project layer. Only distinct nested `.codex` directories should be loaded as project-local layers.

**Data flow**: Creates a project with nested child `.codex/config.toml`, uses the project root `.codex` as `codex_home`, writes user config there plus `foo = "user"`, loads layers from the nested cwd, filters project layers, constructs the expected single child project layer, and asserts the effective config uses `foo = "child"` from that project layer.

**Call relations**: Exercises loader logic that excludes the user config directory from project-layer discovery even when it sits under the project root.

*Call graph*: calls 4 internal fn (load_config_layers_state, new, make_config_for_test, from_absolute_path); 8 external calls (assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write, from_str).


##### `project_layers_disabled_when_untrusted_or_unknown`  (lines 2791–2909)

```
async fn project_layers_disabled_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Verifies that project-local layers are discovered but disabled when project trust is `Untrusted` or absent, and that unsupported project keys are stripped even in disabled layers. Effective config should then come only from user config.

**Data flow**: Creates a nested project `.codex/config.toml` with `foo` and unsupported `profile`, then runs two cases: one with user config marking the project untrusted and one with no trust entry. For each, it loads layers, filters project layers including disabled ones, asserts exactly one layer exists with `disabled_reason.is_some()`, checks `foo` remains in the layer but `profile` was removed, confirms effective config uses user `foo`, and asserts startup warnings are empty.

**Call relations**: Exercises trust gating plus project-config sanitization on disabled layers, ensuring discovery and parsing still happen but do not affect merged config.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 8 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write).


##### `project_layer_ignores_unsupported_config_keys`  (lines 2912–3026)

```
async fn project_layer_ignores_unsupported_config_keys() -> std::io::Result<()>
```

**Purpose**: Checks that trusted project-local config is sanitized to a supported subset, with unsupported keys removed and surfaced in a startup warning. Supported path-valued keys must survive sanitization and still resolve relative to the project `.codex` folder.

**Data flow**: Writes a project `.codex/config.toml` containing allowed keys (`model`, `model_instructions_file`) plus many unsupported or dangerous keys (`openai_base_url`, `model_provider`, `profiles`, `otel`, etc.), marks the project trusted, loads layers, finds the project layer, constructs the expected warning listing ignored keys, asserts `layers.startup_warnings()` matches it, checks effective `model` and resolved absolute `model_instructions_file`, and verifies each ignored key is absent from the project layer config.

**Call relations**: Exercises the project-config sanitization pass that strips unsupported settings before typed path resolution and merge.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 7 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `project_trust_does_not_match_configured_alias_for_canonical_cwd`  (lines 3030–3087)

```
async fn project_trust_does_not_match_configured_alias_for_canonical_cwd() -> std::io::Result<()>
```

**Purpose**: Verifies that trust lookup uses the configured project path key exactly and does not collapse symlink aliases to the canonical cwd path. A trust entry for an alias must not implicitly trust the canonical target.

**Data flow**: Creates a project and a symlink alias to it, writes trusted-project config keyed by the alias path, loads layers with cwd at the canonical project path, filters project layers including disabled ones, and asserts the single project layer is disabled and contributes no `foo` to the effective config.

**Call relations**: Targets a security-sensitive trust-resolution edge case involving symlinks and canonicalization.

*Call graph*: calls 2 internal fn (load_config_layers_state, from_absolute_path); 10 external calls (default, from, assert!, assert_eq!, default, symlink, tempdir, create_dir_all, write, to_string).


##### `cli_override_can_update_project_local_mcp_server_when_project_is_trusted`  (lines 3090–3136)

```
async fn cli_override_can_update_project_local_mcp_server_when_project_is_trusted() -> std::io::Result<()>
```

**Purpose**: Checks that CLI overrides can modify a project-local MCP server definition when the project layer is trusted and therefore active. The override should flip the server’s `enabled` flag in the final config.

**Data flow**: Creates a trusted project `.codex/config.toml` defining `[mcp_servers.sentry]` with `enabled = false`, builds config with CLI override `mcp_servers.sentry.enabled = true`, then reads `config.mcp_servers.get().get("sentry")` and asserts `enabled` is true.

**Call relations**: Exercises interaction between trusted project-local MCP server definitions and CLI override application in `ConfigBuilder`.

*Call graph*: calls 1 internal fn (make_config_for_test); 6 external calls (assert!, default, tempdir, create_dir_all, write, vec!).


##### `cli_override_for_disabled_project_local_mcp_server_returns_invalid_transport`  (lines 3139–3178)

```
async fn cli_override_for_disabled_project_local_mcp_server_returns_invalid_transport() -> std::io::Result<()>
```

**Purpose**: Verifies that the same CLI override fails when the project-local MCP server definition comes from an untrusted/disabled project layer. Without an active base transport definition, enabling the server should produce an invalid transport error.

**Data flow**: Creates a project-local MCP server config but does not mark the project trusted, builds config with CLI override `mcp_servers.sentry.enabled = true`, expects failure, and asserts the error string mentions both `invalid transport` and `mcp_servers.sentry`.

**Call relations**: Complements the trusted-project MCP test by covering the disabled-layer branch where CLI overrides cannot resurrect hidden project-local transports.

*Call graph*: 6 external calls (assert!, default, tempdir, create_dir_all, write, vec!).


##### `invalid_project_config_ignored_when_untrusted_or_unknown`  (lines 3181–3263)

```
async fn invalid_project_config_ignored_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Checks that malformed project-local `config.toml` does not fail overall config loading when the project is untrusted or has unknown trust. Disabled project layers should degrade to empty config instead.

**Data flow**: Creates a nested project `.codex/config.toml` containing invalid TOML `foo =`, then runs untrusted and unknown-trust cases with user config `foo = "user"`. For each case it loads layers, asserts there is one disabled project layer whose `config` is an empty table, and confirms the effective config still contains the user `foo` value.

**Call relations**: Exercises the loader’s fail-open behavior for invalid project config when trust gating means the layer would be disabled anyway.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 8 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write).


##### `project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown`  (lines 3266–3328)

```
async fn project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Verifies disabled-state handling for project layers that exist only as `.codex` directories without `config.toml`. Trust determines whether the empty layer is active or disabled.

**Data flow**: Creates a project with nested `.codex/` but no config file, then runs untrusted, unknown, and trusted cases. For each it loads layers, filters project layers including disabled ones, asserts exactly one layer exists, checks whether `disabled_reason.is_some()` matches the expected trust-dependent state, and confirms the layer config is an empty table.

**Call relations**: Covers the intersection of trust gating and directory-only project layers.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 6 external calls (assert_eq!, default, format!, tempdir, create_dir_all, write).


##### `cli_overrides_with_relative_paths_do_not_break_trust_check`  (lines 3331–3365)

```
async fn cli_overrides_with_relative_paths_do_not_break_trust_check() -> std::io::Result<()>
```

**Purpose**: Checks that preprocessing relative-path CLI overrides does not interfere with project trust evaluation. The loader should still complete successfully for a trusted project.

**Data flow**: Creates a trusted project and nested cwd, prepares CLI override `model_instructions_file = "relative.md"`, calls `load_config_layers_state`, and simply asserts success by returning `Ok(())` if no error occurs.

**Call relations**: Targets a regression where relative-path normalization could have altered cwd/trust handling before project-layer discovery.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 5 external calls (default, tempdir, create_dir_all, write, vec!).


##### `project_root_markers_supports_alternate_markers`  (lines 3368–3432)

```
async fn project_root_markers_supports_alternate_markers() -> std::io::Result<()>
```

**Purpose**: Verifies that configured alternate project-root markers such as `.hg` are honored during project-layer discovery and ordering. Nested `.codex` layers should still be found and merged from child to root.

**Data flow**: Creates a project rooted by `.hg` instead of `.git`, writes root and child `.codex/config.toml` files with different `foo` values, marks the project trusted with `project_root_markers = [".hg"]`, loads layers from the child cwd, asserts the project layer folders are child then root, and checks merged `foo` equals `child`.

**Call relations**: Exercises project-root discovery customization via user-configured markers.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 6 external calls (assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `requirements_exec_policy_tests::tokens`  (lines 3458–3460)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of command-token string slices into owned `Vec<String>` values for exec-policy assertions. It keeps the policy tests concise and readable.

**Data flow**: Takes `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns it. It has no side effects.

**Call relations**: Used throughout the nested exec-policy tests to build expected matched prefixes and command inputs for policy evaluation.


##### `requirements_exec_policy_tests::panic_if_called`  (lines 3462–3464)

```
fn panic_if_called(_: &[String]) -> Decision
```

**Purpose**: A heuristic callback that intentionally panics if invoked, proving that a matching explicit exec-policy rule short-circuited heuristic evaluation. It is a sentinel for rule-match tests.

**Data flow**: Accepts a token slice and immediately panics with a fixed message; it never returns normally. It reads no state and writes nothing.

**Call relations**: Passed into policy `check`/`check_multiple` calls in tests where an explicit prefix rule is expected to decide the outcome without consulting heuristics.

*Call graph*: 1 external calls (panic!).


##### `requirements_exec_policy_tests::config_stack_for_dot_codex_folder_with_requirements`  (lines 3466–3478)

```
fn config_stack_for_dot_codex_folder_with_requirements(
        dot_codex_folder: &Path,
        requirements: ConfigRequirements,
    ) -> ConfigLayerStack
```

**Purpose**: Builds a minimal `ConfigLayerStack` containing a single project layer and supplied requirements for exec-policy loading tests. It avoids needing the full config loader in that submodule.

**Data flow**: Takes a `.codex` folder path and a `ConfigRequirements`, converts the path to `AbsolutePathBuf`, creates a `ConfigLayerEntry::new(ConfigLayerSource::Project { dot_codex_folder }, empty table)`, then constructs `ConfigLayerStack::new(vec![layer], requirements, ConfigRequirementsToml::default())`. It returns the stack or panics if construction fails.

**Call relations**: Used by the async exec-policy loading tests to provide `load_exec_policy` with just enough stack context to locate project rule files and requirements.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); 4 external calls (default, Table, default, vec!).


##### `requirements_exec_policy_tests::requirements_from_toml`  (lines 3480–3485)

```
fn requirements_from_toml(toml_str: &str) -> ConfigRequirements
```

**Purpose**: Parses a TOML string into runtime `ConfigRequirements` with a placeholder source. It is a compact helper for exec-policy tests that only care about the resulting constraints.

**Data flow**: Parses the input string into `ConfigRequirementsToml`, creates a default `ConfigRequirementsWithSources`, merges the parsed TOML into it with `RequirementSource::Unknown`, converts the result with `ConfigRequirements::try_from`, and returns the runtime requirements.

**Call relations**: Feeds `config_stack_for_dot_codex_folder_with_requirements` in the nested exec-policy tests.

*Call graph*: 3 external calls (try_from, default, from_str).


##### `requirements_exec_policy_tests::parses_single_prefix_rule_from_raw_toml`  (lines 3488–3512)

```
fn parses_single_prefix_rule_from_raw_toml() -> anyhow::Result<()>
```

**Purpose**: Checks TOML deserialization of a single exec-policy prefix rule into `RequirementsExecPolicyToml`. It verifies the exact nested token/decision structure.

**Data flow**: Parses a TOML string containing one `prefix_rules` entry, then compares the parsed value to an explicitly constructed `RequirementsExecPolicyToml` with one `RequirementsExecPolicyPrefixRuleToml` and one `RequirementsExecPolicyPatternTokenToml`.

**Call relations**: A pure parsing test in the nested module, validating the raw TOML schema before conversion to runtime policy.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::parses_multiple_prefix_rules_from_raw_toml`  (lines 3515–3556)

```
fn parses_multiple_prefix_rules_from_raw_toml() -> anyhow::Result<()>
```

**Purpose**: Verifies deserialization of multiple prefix rules, including `any_of` token alternatives and optional justifications. It ensures the TOML schema supports richer rule forms.

**Data flow**: Parses a TOML string with two rules, then asserts equality with a manually built `RequirementsExecPolicyToml` containing both rule structs and their nested token representations.

**Call relations**: Extends the raw parsing coverage from the single-rule case to multi-rule and `any_of` forms.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::converts_rules_toml_into_internal_policy_representation`  (lines 3559–3583)

```
fn converts_rules_toml_into_internal_policy_representation() -> anyhow::Result<()>
```

**Purpose**: Checks conversion from TOML exec-policy rules into the internal runtime policy object and verifies actual command evaluation. A matching prefix should yield the configured decision and matched-rule metadata.

**Data flow**: Parses a TOML rule set, calls `to_policy()`, evaluates the resulting policy against tokens `rm -rf /tmp` using `panic_if_called` as the heuristic callback, and asserts the returned `Evaluation` contains `Decision::Forbidden` and a single `RuleMatch::PrefixRuleMatch` for the `rm` prefix.

**Call relations**: Bridges the gap between raw TOML parsing tests and runtime policy evaluation tests.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::head_any_of_expands_into_multiple_program_rules`  (lines 3586–3621)

```
fn head_any_of_expands_into_multiple_program_rules() -> anyhow::Result<()>
```

**Purpose**: Verifies that an `any_of` token in the head position expands into multiple equivalent program-prefix rules. Both alternatives should match and produce the same decision.

**Data flow**: Parses a rule with head `any_of = ["git", "hg"]` followed by `status`, converts it to policy, evaluates the policy against `git status` and `hg status`, and asserts both evaluations return `Decision::Prompt` with the corresponding matched prefix.

**Call relations**: Exercises a specific rule-expansion behavior in `RequirementsExecPolicyToml::to_policy()`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::missing_decision_is_rejected`  (lines 3624–3639)

```
fn missing_decision_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Checks that converting exec-policy TOML to runtime policy fails when a rule omits its `decision`. This enforces completeness of each prefix rule.

**Data flow**: Parses a TOML rule lacking `decision`, calls `to_policy()` expecting failure, and asserts the error matches `RequirementsExecPolicyParseError::MissingDecision { rule_index: 0 }`.

**Call relations**: A negative conversion test for validation logic inside exec-policy TOML processing.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::allow_decision_is_rejected`  (lines 3642–3657)

```
fn allow_decision_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Verifies that `decision = "allow"` is not permitted in requirements exec-policy rules. Requirements may only tighten behavior, not explicitly allow commands.

**Data flow**: Parses a TOML rule with `decision = "allow"`, calls `to_policy()` expecting failure, and asserts the error matches `RequirementsExecPolicyParseError::AllowDecisionNotAllowed { rule_index: 0 }`.

**Call relations**: Covers another validation rule in exec-policy conversion, focused on disallowed decision kinds.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::empty_prefix_rules_is_rejected`  (lines 3660–3673)

```
fn empty_prefix_rules_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Checks that an empty `prefix_rules` array is invalid when converting requirements exec-policy TOML. The parser accepts the shape, but conversion rejects the empty policy.

**Data flow**: Parses TOML with `prefix_rules = []`, calls `to_policy()` expecting failure, and asserts the error matches `RequirementsExecPolicyParseError::EmptyPrefixRules`.

**Call relations**: Completes the negative validation coverage for malformed or vacuous exec-policy TOML.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::loads_requirements_exec_policy_without_rules_files`  (lines 3676–3705)

```
async fn loads_requirements_exec_policy_without_rules_files() -> anyhow::Result<()>
```

**Purpose**: Verifies that `load_exec_policy` can build a policy solely from requirements-embedded rules when no external `.rules` files exist. The resulting policy should still evaluate commands correctly.

**Data flow**: Creates a temp directory, builds `ConfigRequirements` from TOML containing `[rules] prefix_rules = [...]`, wraps it in a minimal `ConfigLayerStack` for that directory, calls `load_exec_policy`, evaluates the policy against `rm`, and asserts the returned `Evaluation` is `Forbidden` with the expected matched prefix rule.

**Call relations**: Exercises the async exec-policy loader path using only requirements data, without filesystem rule files.

*Call graph*: calls 1 internal fn (load_exec_policy); 4 external calls (assert_eq!, config_stack_for_dot_codex_folder_with_requirements, requirements_from_toml, tempdir).


##### `requirements_exec_policy_tests::merges_requirements_exec_policy_with_file_rules`  (lines 3708–3759)

```
async fn merges_requirements_exec_policy_with_file_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that `load_exec_policy` merges requirements-embedded prefix rules with external rule files found under the project rules directory. Both sources should contribute matches to the final policy.

**Data flow**: Creates a temp rules directory containing `deny.rules` with a file-based `prefix_rule(pattern=["rm"], decision="forbidden")`, builds requirements TOML containing a `git push` prompt rule, constructs a minimal config stack, loads the merged policy, and separately evaluates `rm` and `git push`, asserting each returns the expected `Evaluation` and matched prefix.

**Call relations**: Covers the combined-source branch of exec-policy loading where on-disk rule files augment requirements-defined rules.

*Call graph*: calls 1 internal fn (load_exec_policy); 6 external calls (assert_eq!, config_stack_for_dot_codex_folder_with_requirements, requirements_from_toml, create_dir_all, write, tempdir).


### `core/src/config/auth_keyring_tests.rs`

`test` · `test execution`

This file is a focused unit test module for auth keyring backend resolution logic in the surrounding config module. Its central concern is the `secret_auth_storage` feature flag: the test proves that an explicit enabled feature in `ConfigToml` selects `AuthKeyringBackendKind::Secrets`, an explicit disabled feature selects `AuthKeyringBackendKind::Direct`, and a feature requirement can force `Secrets` even when the config itself says `false`.

To do that, the file constructs small `ConfigToml` values with only the `features` field populated, using `FeaturesToml` backed by a `BTreeMap<String, bool>`. It then wraps those configs in a synthetic `ConfigTomlLoadResult` via the local helper `config_toml_load_result`. That helper creates a `ConfigRequirements` value, injects optional `Sourced<FeatureRequirementsToml>` requirements, and builds a `ConfigLayerStack` with no layers, default TOML requirements, and the supplied requirement set. The test therefore exercises the same resolution path as production code without needing filesystem-backed config loading.

A notable design point is that the test checks precedence behavior, not just raw parsing: requirements supplied through `RequirementSource`-tagged `Sourced` metadata can override a disabled feature in the config. The helper returns `std::io::Result` because `ConfigLayerStack::new` is fallible, allowing the test to use `?` and fail naturally if setup itself becomes invalid.

#### Function details

##### `resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature`  (lines 14–61)

```
fn resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature() -> std::io::Result<()>
```

**Purpose**: Verifies the backend-kind resolver against three concrete scenarios around the `secret_auth_storage` feature: enabled in config, disabled in config, and disabled in config but required externally. Each assertion checks the exact `AuthKeyringBackendKind` chosen by the bootstrap resolver.

**Data flow**: The test creates `ConfigToml` inputs with `features` set to a `FeaturesToml` converted from a `BTreeMap` containing `secret_auth_storage -> true` or `false`. It passes each config, plus either no feature requirements or a `Sourced<FeatureRequirementsToml>` requiring the feature, through `config_toml_load_result`, then into `resolve_bootstrap_auth_keyring_backend_kind`. The returned backend kind is compared with `AuthKeyringBackendKind::Secrets` or `AuthKeyringBackendKind::Direct` using `assert_eq!`; any setup or resolution error is propagated as the test's `std::io::Result<()>`.

**Call relations**: This is a top-level `#[test]` entry invoked by the Rust test harness. Within the test flow it repeatedly delegates setup to `config_toml_load_result` so it can focus on the resolver behavior, and it relies on constructors and defaults for `FeaturesToml`, `FeatureRequirementsToml`, and related config types to build the exact precedence cases under test.

*Call graph*: calls 2 internal fn (new, from); 3 external calls (from, default, assert_eq!).


##### `config_toml_load_result`  (lines 63–79)

```
fn config_toml_load_result(
    config_toml: ConfigToml,
    feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<ConfigTomlLoadResult>
```

**Purpose**: Builds a minimal `ConfigTomlLoadResult` suitable for unit tests from an in-memory `ConfigToml` and optional feature requirements. It isolates the boilerplate needed to create a valid `ConfigLayerStack` without reading any config layers from disk.

**Data flow**: The function takes a concrete `ConfigToml` plus an `Option<Sourced<FeatureRequirementsToml>>`. It embeds the optional requirements into a `ConfigRequirements` value while leaving all other requirement fields at their defaults, then constructs a `ConfigLayerStack` from an empty layer vector, those requirements, and a default `ConfigRequirementsToml`. On success it returns a `ConfigTomlLoadResult` containing the original `config_toml` and the newly created stack; any I/O-style error from `ConfigLayerStack::new` is returned to the caller.

**Call relations**: This helper is called by the test function whenever it needs a resolver input shaped like production config-loading output. It exists purely to support that test flow, delegating the actual stack construction to `ConfigLayerStack::new` so the test exercises real requirement-merging behavior rather than a hand-built stub.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, new, default).


### `features/src/tests.rs`

`test` · `test execution`

This test file is the executable specification for the feature system in `features/src/lib.rs`. Most tests assert registry invariants directly against `FEATURES` or `Feature` accessors: under-development flags must default off, default-enabled flags must be stable or removed, and specific compatibility flags retain their intended stage and default values. A second cluster verifies key resolution and backward compatibility, checking that removed keys still parse through `feature_for_key`, that some removed config entries are ignored entirely during `Features::from_sources`, and that deprecated aliases such as `use_legacy_landlock` produce the expected `LegacyFeatureUsage` notice text.

The file also covers behavior that emerges only after resolution. `from_sources_applies_base_profile_and_overrides` confirms precedence across base config, profile config, and explicit overrides. Dependency normalization is tested in both directions: `CodeModeOnly` forces `CodeMode`, and `SpawnCsv` forces `Collab`, but not vice versa. Structured TOML support is validated for `multi_agent_v2`, including both boolean and table forms and the subtle case where extra config fields do not implicitly enable the feature unless `enabled` is set.

Finally, the tests around `materialize_resolved_enabled` and `unstable_features_warning_event` verify serialization and user messaging. They ensure resolved config writes every canonical feature key, preserves nested config payloads, strips compatibility-only entries, and warns only about under-development features that are explicitly enabled and actually active.

#### Function details

##### `under_development_features_are_disabled_by_default`  (lines 18–28)

```
fn under_development_features_are_disabled_by_default()
```

**Purpose**: Verifies the global policy that every `Stage::UnderDevelopment` feature in the registry defaults to `false`.

**Data flow**: Iterates over `crate::FEATURES`, filters by `matches!(spec.stage, Stage::UnderDevelopment)`, and asserts `spec.default_enabled == false` with the feature key in the failure message.

**Call relations**: This is a registry-wide invariant test; it does not call production logic beyond reading the static registry.

*Call graph*: 2 external calls (assert_eq!, matches!).


##### `default_enabled_features_are_stable`  (lines 31–42)

```
fn default_enabled_features_are_stable()
```

**Purpose**: Checks that any feature enabled by default is either stable or removed, never experimental or under development.

**Data flow**: Scans `crate::FEATURES`, and for each `spec.default_enabled` asserts that `spec.stage` matches `Stage::Stable | Stage::Removed`.

**Call relations**: Acts as a rollout-policy guardrail over the registry contents.

*Call graph*: 1 external calls (assert!).


##### `use_legacy_landlock_is_deprecated_and_disabled_by_default`  (lines 45–48)

```
fn use_legacy_landlock_is_deprecated_and_disabled_by_default()
```

**Purpose**: Confirms the deprecated status and default-off behavior of `Feature::UseLegacyLandlock`.

**Data flow**: Calls `Feature::UseLegacyLandlock.stage()` and `.default_enabled()` and asserts they equal `Stage::Deprecated` and `false` respectively.

**Call relations**: Targets one specific compatibility feature whose semantics are important to preserve during deprecation.

*Call graph*: 1 external calls (assert_eq!).


##### `use_linux_sandbox_bwrap_is_removed_and_disabled_by_default`  (lines 51–54)

```
fn use_linux_sandbox_bwrap_is_removed_and_disabled_by_default()
```

**Purpose**: Asserts that the legacy bubblewrap opt-in remains a removed, disabled compatibility key.

**Data flow**: Reads `Feature::UseLinuxSandboxBwrap.stage()` and `.default_enabled()` and compares them to `Stage::Removed` and `false`.

**Call relations**: Protects backward-compatibility parsing without allowing the flag to regain runtime effect.

*Call graph*: 1 external calls (assert_eq!).


##### `undo_is_removed_and_disabled_by_default`  (lines 57–60)

```
fn undo_is_removed_and_disabled_by_default()
```

**Purpose**: Checks the removed compatibility status of the old `undo`/`GhostCommit` feature.

**Data flow**: Asserts `Feature::GhostCommit.stage() == Stage::Removed` and `default_enabled() == false`.

**Call relations**: Ensures old configs can still parse the key while the feature remains inert.

*Call graph*: 1 external calls (assert_eq!).


##### `image_detail_original_is_removed_and_disabled_by_default`  (lines 63–66)

```
fn image_detail_original_is_removed_and_disabled_by_default()
```

**Purpose**: Verifies that the legacy image-detail flag is retained only as a removed, disabled no-op.

**Data flow**: Reads the feature’s stage and default-enabled state and asserts removed/false.

**Call relations**: Covers another compatibility-only key expected to remain parseable but inactive.

*Call graph*: 1 external calls (assert_eq!).


##### `apply_patch_freeform_is_removed_and_disabled_by_default`  (lines 69–76)

```
fn apply_patch_freeform_is_removed_and_disabled_by_default()
```

**Purpose**: Checks both registry metadata and key lookup for the removed `apply_patch_freeform` flag.

**Data flow**: Asserts the feature’s stage is `Removed`, default is `false`, and `feature_for_key("apply_patch_freeform")` resolves to that feature.

**Call relations**: Combines registry and lookup-path validation for a removed key.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_hooks_is_removed_and_disabled_by_default`  (lines 79–83)

```
fn plugin_hooks_is_removed_and_disabled_by_default()
```

**Purpose**: Confirms the removed status and key resolution of the old plugin hooks flag.

**Data flow**: Asserts removed/false metadata and that `feature_for_key("plugin_hooks")` returns `Some(Feature::PluginHooks)`.

**Call relations**: Protects compatibility parsing for a deleted feature.

*Call graph*: 1 external calls (assert_eq!).


##### `external_migration_is_removed_and_disabled_by_default`  (lines 86–93)

```
fn external_migration_is_removed_and_disabled_by_default()
```

**Purpose**: Verifies that `external_migration` remains a removed, disabled compatibility key and still resolves by name.

**Data flow**: Checks stage, default-enabled, and `feature_for_key` resolution for `Feature::ExternalMigration`.

**Call relations**: Another targeted compatibility regression test.

*Call graph*: 1 external calls (assert_eq!).


##### `removed_apps_mcp_path_override_shapes_are_ignored`  (lines 96–114)

```
fn removed_apps_mcp_path_override_shapes_are_ignored()
```

**Purpose**: Ensures both boolean and structured TOML forms of the removed `apps_mcp_path_override` input deserialize but contribute no effective entries.

**Data flow**: Deserializes two `FeaturesToml` values from TOML strings, calls `entries()` on each, and asserts both produce empty `BTreeMap`s.

**Call relations**: Validates the compatibility field’s deserialization shape while confirming it is ignored by resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `code_mode_only_requires_code_mode`  (lines 117–124)

```
fn code_mode_only_requires_code_mode()
```

**Purpose**: Checks dependency normalization from `CodeModeOnly` to `CodeMode`.

**Data flow**: Starts from `Features::with_defaults()`, enables `Feature::CodeModeOnly`, calls `normalize_dependencies()`, and asserts both `CodeModeOnly` and `CodeMode` are enabled.

**Call relations**: Exercises the one-way dependency logic implemented in `Features::normalize_dependencies`.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `guardian_approval_is_stable_and_enabled_by_default`  (lines 127–132)

```
fn guardian_approval_is_stable_and_enabled_by_default()
```

**Purpose**: Verifies rollout metadata for `GuardianApproval`.

**Data flow**: Reads `Feature::GuardianApproval.info()` and `default_enabled()`, asserting stable stage and default `true`.

**Call relations**: A targeted registry sanity check for a stable default-on feature.

*Call graph*: 1 external calls (assert_eq!).


##### `request_permissions_is_under_development`  (lines 135–141)

```
fn request_permissions_is_under_development()
```

**Purpose**: Checks that `ExecPermissionApprovals` remains under development and disabled by default.

**Data flow**: Asserts `stage()` is `UnderDevelopment` and `default_enabled()` is `false`.

**Call relations**: Protects rollout policy for an unfinished permission-related feature.

*Call graph*: 1 external calls (assert_eq!).


##### `request_permissions_tool_is_under_development`  (lines 144–150)

```
fn request_permissions_tool_is_under_development()
```

**Purpose**: Verifies the same rollout policy for `RequestPermissionsTool`.

**Data flow**: Reads stage/default-enabled and asserts under-development/false.

**Call relations**: Pairs with the previous test to cover both related permission features.

*Call graph*: 1 external calls (assert_eq!).


##### `terminal_resize_reflow_is_removed_and_enabled_by_default`  (lines 153–160)

```
fn terminal_resize_reflow_is_removed_and_enabled_by_default()
```

**Purpose**: Confirms that the removed compatibility flag for terminal reflow still resolves and remains default-on as a no-op.

**Data flow**: Checks `feature_for_key`, `stage()`, and `default_enabled()` for `Feature::TerminalResizeReflow`.

**Call relations**: Covers a removed feature whose default remains true for backward compatibility.

*Call graph*: 1 external calls (assert_eq!).


##### `from_sources_ignores_removed_terminal_resize_reflow_feature_key`  (lines 163–180)

```
fn from_sources_ignores_removed_terminal_resize_reflow_feature_key()
```

**Purpose**: Ensures explicitly setting the removed `terminal_resize_reflow` key in config does not alter the resolved feature set.

**Data flow**: Builds a `FeaturesToml` from a map containing `terminal_resize_reflow = false`, resolves features via `Features::from_sources`, and asserts the result equals `Features::with_defaults()` while the feature remains enabled.

**Call relations**: Tests the `apply_map` branch that ignores this removed key entirely.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `tool_suggest_is_stable_and_enabled_by_default`  (lines 183–186)

```
fn tool_suggest_is_stable_and_enabled_by_default()
```

**Purpose**: Checks stable default-on metadata for `ToolSuggest`.

**Data flow**: Asserts `Feature::ToolSuggest.stage() == Stage::Stable` and `default_enabled() == true`.

**Call relations**: A straightforward registry invariant test.

*Call graph*: 1 external calls (assert_eq!).


##### `network_proxy_is_experimental_and_disabled_by_default`  (lines 189–199)

```
fn network_proxy_is_experimental_and_disabled_by_default()
```

**Purpose**: Verifies that `network_proxy` is registered as experimental and defaults off.

**Data flow**: Checks `feature_for_key("network_proxy")`, asserts `stage()` matches `Stage::Experimental { .. }`, and `default_enabled()` is `false`.

**Call relations**: Protects the rollout classification of a user-visible experimental feature.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tool_search_is_removed_and_disabled_by_default`  (lines 202–206)

```
fn tool_search_is_removed_and_disabled_by_default()
```

**Purpose**: Confirms the removed status and key resolution of the legacy `tool_search` flag.

**Data flow**: Asserts removed/false metadata and successful `feature_for_key("tool_search")` lookup.

**Call relations**: Ensures compatibility parsing remains intact for a deleted feature.

*Call graph*: 1 external calls (assert_eq!).


##### `secret_auth_storage_defaults_to_windows_only`  (lines 209–216)

```
fn secret_auth_storage_defaults_to_windows_only()
```

**Purpose**: Checks that `SecretAuthStorage` is stable and platform-defaulted only on Windows.

**Data flow**: Asserts stable stage, compares `default_enabled()` to `cfg!(windows)`, and verifies key lookup.

**Call relations**: Guards a platform-conditional default encoded in the registry.

*Call graph*: 1 external calls (assert_eq!).


##### `browser_controls_are_stable_and_enabled_by_default`  (lines 219–241)

```
fn browser_controls_are_stable_and_enabled_by_default()
```

**Purpose**: Verifies stable default-on metadata and key lookup for the browser-related requirement gates.

**Data flow**: Checks `InAppBrowser`, `BrowserUse`, `BrowserUseExternal`, and `ComputerUse` for stable stage, default `true`, and successful `feature_for_key` resolution.

**Call relations**: Covers a cluster of related features expected to remain enabled by default.

*Call graph*: 1 external calls (assert_eq!).


##### `use_linux_sandbox_bwrap_is_a_removed_feature_key`  (lines 244–253)

```
fn use_linux_sandbox_bwrap_is_a_removed_feature_key()
```

**Purpose**: Confirms both legacy Linux sandbox keys still resolve through feature lookup.

**Data flow**: Asserts `feature_for_key("use_legacy_landlock")` and `feature_for_key("use_linux_sandbox_bwrap")` return the expected features.

**Call relations**: Focuses on alias/key compatibility rather than runtime behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `image_generation_is_stable_and_enabled_by_default`  (lines 256–259)

```
fn image_generation_is_stable_and_enabled_by_default()
```

**Purpose**: Checks stable default-on metadata for image generation.

**Data flow**: Asserts `Feature::ImageGeneration.stage() == Stage::Stable` and `default_enabled() == true`.

**Call relations**: A targeted registry check.

*Call graph*: 1 external calls (assert_eq!).


##### `image_generation_extension_is_under_development_and_disabled_by_default`  (lines 262–266)

```
fn image_generation_extension_is_under_development_and_disabled_by_default()
```

**Purpose**: Verifies rollout metadata and key lookup for the experimental image-generation extension replacement.

**Data flow**: Asserts `ImageGenExt` is under development, default-off, and resolved by `feature_for_key("imagegenext")`.

**Call relations**: Protects the intended rollout state of this extension-backed feature.

*Call graph*: 1 external calls (assert_eq!).


##### `use_legacy_landlock_config_records_deprecation_notice`  (lines 269–288)

```
fn use_legacy_landlock_config_records_deprecation_notice()
```

**Purpose**: Checks that enabling `use_legacy_landlock` through config records the exact expected deprecation notice.

**Data flow**: Builds a one-entry `BTreeMap`, applies it to `Features::with_defaults()` via `apply_map`, collects `legacy_feature_usages()`, and asserts alias, feature, summary, and details text.

**Call relations**: Exercises the special-case notice path in `apply_map` and `legacy_usage_notice`.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (new, assert_eq!).


##### `image_detail_original_is_a_removed_feature_key`  (lines 291–296)

```
fn image_detail_original_is_a_removed_feature_key()
```

**Purpose**: Confirms lookup support for the removed `image_detail_original` key.

**Data flow**: Asserts `feature_for_key("image_detail_original") == Some(Feature::ImageDetailOriginal)`.

**Call relations**: A narrow compatibility lookup test.

*Call graph*: 1 external calls (assert_eq!).


##### `js_repl_features_are_removed_feature_keys`  (lines 299–310)

```
fn js_repl_features_are_removed_feature_keys()
```

**Purpose**: Verifies both deleted JS REPL flags remain removed, disabled, and resolvable by key.

**Data flow**: Checks stage/default-enabled for `JsRepl` and `JsReplToolsOnly`, and asserts `feature_for_key` resolves both names.

**Call relations**: Covers compatibility behavior for two related removed flags.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_call_mcp_elicitation_is_stable_and_enabled_by_default`  (lines 313–316)

```
fn tool_call_mcp_elicitation_is_stable_and_enabled_by_default()
```

**Purpose**: Checks stable default-on metadata for MCP elicitation routing.

**Data flow**: Asserts `Feature::ToolCallMcpElicitation.stage()` is stable and `default_enabled()` is true.

**Call relations**: A targeted registry assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `auth_elicitation_is_under_development`  (lines 319–326)

```
fn auth_elicitation_is_under_development()
```

**Purpose**: Verifies rollout metadata and key lookup for `AuthElicitation`.

**Data flow**: Asserts under-development stage, default-off state, and successful `feature_for_key("auth_elicitation")` resolution.

**Call relations**: Protects the intended rollout state of this unfinished feature.

*Call graph*: 1 external calls (assert_eq!).


##### `mentions_v2_is_stable_and_enabled_by_default`  (lines 329–333)

```
fn mentions_v2_is_stable_and_enabled_by_default()
```

**Purpose**: Checks stable default-on metadata and key lookup for `MentionsV2`.

**Data flow**: Asserts stage/default-enabled and `feature_for_key("mentions_v2")` resolution.

**Call relations**: A straightforward registry test.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_is_removed_and_disabled_by_default`  (lines 336–343)

```
fn remote_control_is_removed_and_disabled_by_default()
```

**Purpose**: Confirms the deleted remote-control feature remains removed, disabled, and parseable.

**Data flow**: Checks stage/default-enabled and `feature_for_key("remote_control")`.

**Call relations**: Compatibility regression coverage for a removed feature.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_config_is_ignored`  (lines 346–354)

```
fn remote_control_config_is_ignored()
```

**Purpose**: Ensures setting the removed `remote_control` config key has no effect on resolved features.

**Data flow**: Creates a map with `remote_control = true`, applies it to `Features::with_defaults()` via `apply_map`, and asserts `Feature::RemoteControl` remains disabled.

**Call relations**: Exercises the explicit ignore branch in `apply_map`.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (new, assert_eq!).


##### `workspace_dependencies_is_stable_and_enabled_by_default`  (lines 357–364)

```
fn workspace_dependencies_is_stable_and_enabled_by_default()
```

**Purpose**: Checks stable default-on metadata and key lookup for workspace dependency support.

**Data flow**: Asserts stage/default-enabled and `feature_for_key("workspace_dependencies")` resolution.

**Call relations**: A targeted registry assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `telepathy_is_legacy_alias_for_chronicle`  (lines 367–372)

```
fn telepathy_is_legacy_alias_for_chronicle()
```

**Purpose**: Verifies that `telepathy` remains a legacy alias for `Chronicle`.

**Data flow**: Checks `Chronicle` stage/default-enabled and asserts both `feature_for_key("chronicle")` and `feature_for_key("telepathy")` resolve to `Feature::Chronicle`.

**Call relations**: Covers alias compatibility in the legacy lookup table.

*Call graph*: 1 external calls (assert_eq!).


##### `collab_is_legacy_alias_for_multi_agent`  (lines 375–378)

```
fn collab_is_legacy_alias_for_multi_agent()
```

**Purpose**: Confirms both `multi_agent` and legacy `collab` map to `Feature::Collab`.

**Data flow**: Asserts `feature_for_key` returns `Some(Feature::Collab)` for both strings.

**Call relations**: Tests alias handling for a renamed stable feature.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_hooks_is_legacy_alias_for_hooks`  (lines 381–384)

```
fn codex_hooks_is_legacy_alias_for_hooks()
```

**Purpose**: Checks that both `hooks` and legacy `codex_hooks` resolve to `Feature::CodexHooks`.

**Data flow**: Calls `feature_for_key` on both names and asserts the same feature result.

**Call relations**: Another alias-compatibility regression test.

*Call graph*: 1 external calls (assert_eq!).


##### `multi_agent_is_stable_and_enabled_by_default`  (lines 387–390)

```
fn multi_agent_is_stable_and_enabled_by_default()
```

**Purpose**: Verifies stable default-on metadata for `Collab`/`multi_agent`.

**Data flow**: Asserts `Feature::Collab.stage() == Stage::Stable` and `default_enabled() == true`.

**Call relations**: A direct registry check.

*Call graph*: 1 external calls (assert_eq!).


##### `enable_fanout_is_under_development`  (lines 393–396)

```
fn enable_fanout_is_under_development()
```

**Purpose**: Checks rollout metadata for `SpawnCsv`/`enable_fanout`.

**Data flow**: Asserts `Feature::SpawnCsv.stage()` is under development and `default_enabled()` is false.

**Call relations**: Protects rollout policy for this unfinished feature.

*Call graph*: 1 external calls (assert_eq!).


##### `enable_fanout_normalization_enables_multi_agent_one_way`  (lines 399–411)

```
fn enable_fanout_normalization_enables_multi_agent_one_way()
```

**Purpose**: Verifies the one-way dependency from `SpawnCsv` to `Collab` and confirms the reverse implication does not exist.

**Data flow**: Creates two `Features` values from defaults. In the first, enables `SpawnCsv`, normalizes, and asserts both `SpawnCsv` and `Collab` are true. In the second, enables only `Collab`, normalizes, and asserts `SpawnCsv` stays false.

**Call relations**: Directly exercises `normalize_dependencies` semantics.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `apps_require_feature_flag_and_chatgpt_auth`  (lines 414–421)

```
fn apps_require_feature_flag_and_chatgpt_auth()
```

**Purpose**: Checks that app availability for auth flows requires both the feature flag and ChatGPT auth.

**Data flow**: Starts from defaults, calls `apps_enabled_for_auth(false)` and expects false, then enables `Apps` and asserts false without auth and true with auth.

**Call relations**: Tests the convenience predicate `Features::apps_enabled_for_auth`.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert!).


##### `from_sources_applies_base_profile_and_overrides`  (lines 424–458)

```
fn from_sources_applies_base_profile_and_overrides()
```

**Purpose**: Validates source precedence and dependency normalization across base config, profile config, and explicit overrides.

**Data flow**: Builds base and profile `FeaturesToml` values with different entries, resolves them through `Features::from_sources` with `web_search_request: Some(false)`, and asserts resulting feature states for `Plugins`, `CodeModeOnly`, implied `CodeMode`, removed `ApplyPatchFreeform`, and overridden `WebSearchRequest`.

**Call relations**: This is the main integration-style test for `from_sources` orchestration.

*Call graph*: calls 1 internal fn (from_sources); 3 external calls (new, default, assert_eq!).


##### `from_sources_ignores_removed_image_detail_original_feature_key`  (lines 461–477)

```
fn from_sources_ignores_removed_image_detail_original_feature_key()
```

**Purpose**: Ensures the removed `image_detail_original` key is ignored during source resolution.

**Data flow**: Creates a `FeaturesToml` from a one-entry map, resolves via `Features::from_sources`, and asserts the result equals `Features::with_defaults()`.

**Call relations**: Covers one explicit ignore path in `apply_map` through the higher-level source API.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_undo_feature_key`  (lines 480–493)

```
fn from_sources_ignores_removed_undo_feature_key()
```

**Purpose**: Checks that the removed `undo` key does not affect resolved features.

**Data flow**: Builds a `FeaturesToml` containing `undo = true`, resolves it, and compares the result to defaults.

**Call relations**: Another regression test for ignored removed keys.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_js_repl_feature_keys`  (lines 496–512)

```
fn from_sources_ignores_removed_js_repl_feature_keys()
```

**Purpose**: Ensures both removed JS REPL keys are ignored during feature resolution.

**Data flow**: Creates a `FeaturesToml` with `js_repl` and `js_repl_tools_only` set true, resolves it, and asserts the result equals defaults.

**Call relations**: Exercises multiple ignore branches together through `from_sources`.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_apply_patch_freeform_feature_key`  (lines 515–529)

```
fn from_sources_ignores_removed_apply_patch_freeform_feature_key()
```

**Purpose**: Checks that the removed `apply_patch_freeform` key is ignored by source resolution.

**Data flow**: Builds a one-entry `FeaturesToml`, resolves it, and asserts no change from defaults.

**Call relations**: Regression coverage for another removed compatibility key.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_plugin_hooks_feature_key`  (lines 532–545)

```
fn from_sources_ignores_removed_plugin_hooks_feature_key()
```

**Purpose**: Ensures the removed `plugin_hooks` key is ignored during resolution.

**Data flow**: Creates a `FeaturesToml` with `plugin_hooks = true`, resolves it, and asserts equality with defaults.

**Call relations**: Tests the corresponding ignore branch in `apply_map` via the public API.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `multi_agent_v2_feature_config_deserializes_boolean_toggle`  (lines 548–561)

```
fn multi_agent_v2_feature_config_deserializes_boolean_toggle()
```

**Purpose**: Verifies that `multi_agent_v2 = true` deserializes into the boolean `FeatureToml::Enabled` form and contributes the expected flat entry.

**Data flow**: Parses TOML into `FeaturesToml`, calls `entries()`, and asserts both the flattened map and the `multi_agent_v2` field value.

**Call relations**: Covers the simple structured-feature TOML shape.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `multi_agent_v2_feature_config_deserializes_table`  (lines 564–605)

```
fn multi_agent_v2_feature_config_deserializes_table()
```

**Purpose**: Checks deserialization of the full structured table form for `multi_agent_v2`.

**Data flow**: Parses a TOML table with many fields, asserts `entries()` contains only `multi_agent_v2 = true`, and compares the nested `FeatureToml::Config(MultiAgentV2ConfigToml { ... })` value field-by-field.

**Call relations**: Validates that richer config survives deserialization while still exposing an enabled bit for feature resolution.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `multi_agent_v2_feature_config_usage_hint_enabled_does_not_enable_feature`  (lines 608–644)

```
fn multi_agent_v2_feature_config_usage_hint_enabled_does_not_enable_feature()
```

**Purpose**: Ensures auxiliary config fields inside `multi_agent_v2` do not implicitly enable the feature when `enabled` is absent.

**Data flow**: Parses TOML with only `usage_hint_enabled = false`, resolves features via `from_sources`, and asserts the feature remains disabled, `entries()` is empty, and the nested config preserves only the provided field with `enabled: None`.

**Call relations**: Tests a subtle distinction in `FeatureToml::enabled` and `FeaturesToml::entries` behavior.

*Call graph*: calls 1 internal fn (from_sources); 5 external calls (default, assert_eq!, default, default, from_str).


##### `materialize_resolved_enabled_writes_all_features_and_preserves_custom_config`  (lines 647–704)

```
fn materialize_resolved_enabled_writes_all_features_and_preserves_custom_config()
```

**Purpose**: Verifies that resolved feature state can be written back into `FeaturesToml` canonically without losing structured config payloads.

**Data flow**: Starts from defaults, enables `CodeMode`, `MultiAgentV2`, and `NetworkProxy`, constructs a `FeaturesToml` with nested config objects containing extra fields, calls `materialize_resolved_enabled`, then asserts every registry key appears in `entries()` with the resolved boolean, nested configs have their `enabled` field updated to `Some(true)` while preserving other fields, and replaying the materialized TOML through `from_sources` still leaves removed features like `ApplyPatchFreeform` disabled.

**Call relations**: This is the main round-trip serialization test for resolved feature state.

*Call graph*: calls 2 internal fn (from_sources, with_defaults); 6 external calls (new, default, assert_eq!, default, default, Config).


##### `unstable_warning_event_only_mentions_enabled_under_development_features`  (lines 707–730)

```
fn unstable_warning_event_only_mentions_enabled_under_development_features()
```

**Purpose**: Checks that the unstable-feature warning mentions only under-development features that are both configured and actually enabled.

**Data flow**: Builds a TOML `Table` with `child_agents_md`, `personality`, and an unknown key set true; enables only `ChildAgentsMd` in a `Features` value; calls `unstable_features_warning_event`; destructures the returned warning event and asserts the message contains `child_agents_md`, excludes `personality`, and includes the config path.

**Call relations**: Exercises the filtering logic in `unstable_features_warning_event` against mixed configured keys.

*Call graph*: calls 1 internal fn (with_defaults); 5 external calls (new, Boolean, assert!, unstable_features_warning_event, panic!).


##### `unstable_warning_event_mentions_enabled_structured_under_development_feature`  (lines 733–761)

```
fn unstable_warning_event_mentions_enabled_structured_under_development_feature()
```

**Purpose**: Verifies warning generation for a mix of structured and boolean under-development feature entries.

**Data flow**: Parses a TOML table containing `multi_agent_v2 = { enabled = true, ... }` and `code_mode = true`, enables both features in `Features`, calls `unstable_features_warning_event`, extracts the warning message, and asserts exact string equality including sorted feature names and suppression guidance.

**Call relations**: Confirms the warning path correctly recognizes structured `enabled = true` entries and produces deterministic sorted output.

*Call graph*: calls 1 internal fn (with_defaults); 4 external calls (assert_eq!, unstable_features_warning_event, panic!, from_str).


### `tools/src/tool_config_tests.rs`

`test` · `test execution`

This file is the executable specification for shell and mode-selection policy. Two helpers keep the tests readable: `model_with_shell_type` constructs a fully populated `ModelInfo` with a caller-selected `ConfigShellToolType`, and `shell_features` creates a default `Features` set with `ShellTool` enabled but zsh-fork and unified-exec features disabled. The tests then mutate those fixtures to walk through policy transitions. `shell_type_is_derived_from_model_and_feature_gates` verifies the full decision pipeline, including fallback from model-requested `UnifiedExec` to `ShellCommand` when unified exec is disabled, conditional promotion back to unified exec when the feature is enabled and `conpty_supported()` allows it, forced shell-command behavior when shell zsh-fork is enabled without unified-exec zsh-fork composition, and complete disablement when `ShellTool` is turned off. Separate tests isolate `shell_command_backend_for_features` and `unified_exec_feature_mode_for_features`, confirming their dependency rules. `request_user_input_modes_follow_default_mode_feature` checks that `ModeKind::Plan` is always available while `ModeKind::Default` appears only when `DefaultModeRequestUserInput` is enabled. Finally, `unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match` validates the runtime resolver with real executable paths from `current_exe()`, asserting Unix-only zsh-fork activation and fallback to `Direct` when feature mode is merely `Direct`.

#### Function details

##### `model_with_shell_type`  (lines 12–53)

```
fn model_with_shell_type(shell_type: ConfigShellToolType) -> ModelInfo
```

**Purpose**: Builds a complete `ModelInfo` fixture with a caller-specified shell type and otherwise stable default values. It avoids repetitive boilerplate across shell-policy tests.

**Data flow**: Accepts `shell_type: ConfigShellToolType` and returns a populated `ModelInfo` with fixed strings, empty vectors, defaulted optional fields, `TruncationPolicyConfig::tokens(1024)`, default input modalities, and the provided shell type inserted into the `shell_type` field.

**Call relations**: This helper is called by `shell_type_is_derived_from_model_and_feature_gates` to create the model fixture under test. It is test-only scaffolding and does not participate in production configuration flow.

*Call graph*: calls 2 internal fn (tokens, default_input_modalities); called by 1 (shell_type_is_derived_from_model_and_feature_gates); 3 external calls (default, new, new).


##### `shell_features`  (lines 55–62)

```
fn shell_features() -> Features
```

**Purpose**: Creates a baseline feature set for shell-policy tests with shell tools enabled and all zsh-fork/unified-exec features disabled. Tests then mutate this baseline to probe specific transitions.

**Data flow**: Starts from `Features::with_defaults()`, enables `Feature::ShellTool`, disables `Feature::ShellZshFork`, `Feature::UnifiedExec`, and `Feature::UnifiedExecZshFork`, and returns the resulting `Features` value.

**Call relations**: This helper is reused by the shell backend, shell type, and unified-exec feature-mode tests. It centralizes the common starting state so each test only expresses the feature toggles relevant to its scenario.

*Call graph*: calls 1 internal fn (with_defaults); called by 3 (shell_command_backend_requires_both_shell_tool_and_zsh_fork, shell_type_is_derived_from_model_and_feature_gates, unified_exec_feature_mode_follows_composition_dependencies).


##### `shell_type_is_derived_from_model_and_feature_gates`  (lines 65–101)

```
fn shell_type_is_derived_from_model_and_feature_gates()
```

**Purpose**: Exercises the full shell-type decision function across a sequence of feature toggles. It verifies fallback, promotion, zsh-fork interaction, and complete disablement.

**Data flow**: Builds a `ModelInfo` requesting `ConfigShellToolType::UnifiedExec` via `model_with_shell_type`, creates baseline features with `shell_features`, and repeatedly calls `shell_type_for_model_and_features` after mutating features. It computes `expected_unified_exec` using `codex_utils_pty::conpty_supported()` and asserts the returned shell type at each step.

**Call relations**: The test harness runs this as the broad integration-style test for `shell_type_for_model_and_features`. It depends on the two local fixture helpers and indirectly covers the lower-level feature-policy helpers used by the production function.

*Call graph*: calls 2 internal fn (model_with_shell_type, shell_features); 2 external calls (assert_eq!, conpty_supported).


##### `shell_command_backend_requires_both_shell_tool_and_zsh_fork`  (lines 104–122)

```
fn shell_command_backend_requires_both_shell_tool_and_zsh_fork()
```

**Purpose**: Verifies the narrow rule for selecting the shell-command backend: zsh-fork requires both shell-tool and shell-zsh-fork features. It guards against accidental activation when only one prerequisite is enabled.

**Data flow**: Starts from `shell_features()`, calls `shell_command_backend_for_features` in three states—baseline, after enabling `ShellZshFork`, and after then disabling `ShellTool`—and asserts the returned `ShellCommandBackendConfig` each time.

**Call relations**: This test isolates `shell_command_backend_for_features` from the broader shell-type logic. It is invoked by the test harness as a direct unit test of that helper’s feature dependency rule.

*Call graph*: calls 1 internal fn (shell_features); 1 external calls (assert_eq!).


##### `unified_exec_feature_mode_follows_composition_dependencies`  (lines 125–162)

```
fn unified_exec_feature_mode_follows_composition_dependencies()
```

**Purpose**: Checks the feature-only unified-exec mode state machine, especially the composition dependency between shell zsh-fork and unified-exec zsh-fork. It ensures unsupported combinations resolve to `Disabled` rather than silently enabling behavior.

**Data flow**: Creates baseline features with `shell_features()`, then toggles `UnifiedExec`, `UnifiedExecZshFork`, `ShellZshFork`, and `ShellTool` in sequence. After each mutation it calls `unified_exec_feature_mode_for_features` and asserts the expected enum variant (`Disabled`, `Direct`, or `ZshFork`).

**Call relations**: The test harness invokes this as the direct specification for `unified_exec_feature_mode_for_features`. It complements the broader shell-type test by validating the intermediate feature-mode abstraction on its own.

*Call graph*: calls 1 internal fn (shell_features); 1 external calls (assert_eq!).


##### `request_user_input_modes_follow_default_mode_feature`  (lines 165–178)

```
fn request_user_input_modes_follow_default_mode_feature()
```

**Purpose**: Verifies that request-user-input mode visibility depends on the `DefaultModeRequestUserInput` feature for `ModeKind::Default` while `ModeKind::Plan` remains available. It pins the UI-facing mode list produced by the policy helper.

**Data flow**: Creates `Features::with_defaults()`, disables `Feature::DefaultModeRequestUserInput`, calls `request_user_input_available_modes`, and asserts the result is only `vec![ModeKind::Plan]`. It then enables the feature, calls the helper again, and asserts the result is `vec![ModeKind::Default, ModeKind::Plan]`.

**Call relations**: This test is run by the harness to validate `request_user_input_available_modes`. It focuses on the one feature gate that alters the visible mode list.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match`  (lines 181–206)

```
fn unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match()
```

**Purpose**: Checks the runtime session resolver for unified exec, confirming that zsh-fork is selected only when feature mode, shell type, platform, and both path inputs all line up. It also verifies the direct-mode fallback path explicitly.

**Data flow**: Obtains the current executable path with `std::env::current_exe()`, reuses it as both shell and wrapper path, and calls `UnifiedExecShellMode::for_session` first with `UnifiedExecFeatureMode::ZshFork` and `ToolUserShellType::Zsh`. On Unix it asserts the result matches `UnifiedExecShellMode::ZshFork(_)`; otherwise it asserts `Direct`. It then calls `for_session` again with `UnifiedExecFeatureMode::Direct` and asserts `Direct` regardless of paths.

**Call relations**: This test directly exercises `UnifiedExecShellMode::for_session` and is the runtime counterpart to the feature-only unified-exec tests. It demonstrates that even with valid paths, the resolver refuses zsh-fork unless every prerequisite condition is satisfied.

*Call graph*: calls 1 internal fn (for_session); 4 external calls (assert!, assert_eq!, cfg!, current_exe).


### `connectors/src/app_tool_policy_tests.rs`

`test` · `test`

This test file exercises the policy engine in `app_tool_policy.rs` across a wide matrix of precedence cases. The tests verify snapshot reuse (`AppToolPolicyEvaluator::from_parts` serving multiple tools consistently), global defaults for destructive/open-world hints, conservative treatment of missing hints as `true`, app enablement inheritance from `_default`, managed disable overriding user enable but not vice versa, managed approval overriding user approval, exact matching of managed approvals by raw tool name only, and fallback matching of user tool config by `tool_title` when the raw tool name differs.

Several tests focus on enablement precedence: explicit per-tool `enabled` beats app-level hint gating, `default_tools_enabled` beats hint gating for unspecified tools, and app-level disabled state short-circuits tool evaluation. Approval precedence is similarly pinned: managed requirement first, then per-tool user config, then app default tool approval, then `Auto`.

The helper functions are important infrastructure for these tests. `policy_from_config_parts` constructs a realistic `ConfigLayerStack`, optionally injects a serialized user `[apps]` table into a synthetic config TOML path, and then runs the real `AppToolPolicyEvaluator::new(...).policy(...)`. `policy_from_apps_config` optionally synthesizes managed requirements from a requested approval. Additional builders create `AppsRequirementsToml` fragments and default app settings. The result is a suite that validates the actual layered-config path rather than only isolated pure functions.

#### Function details

##### `evaluator_reuses_one_snapshot_across_tools`  (lines 25–85)

```
fn evaluator_reuses_one_snapshot_across_tools()
```

**Purpose**: Verifies that one evaluator built from fixed config parts can evaluate multiple tools consistently without re-reading config and that raw tool-name matching differs from title fallback matching.

**Data flow**: Builds `AppsConfigToml` with one app and one per-tool override plus `AppsRequirementsToml` with a managed approval for `events/create` → constructs `AppToolPolicyEvaluator::from_parts` → evaluates three inputs (`events/create`, `events/list`, and raw name `calendar_events/create` with title `events/create`) → asserts the resulting policy array matches expected enabled/approval combinations.

**Call relations**: Directly exercises the evaluator constructor and `policy` method over multiple inputs in one snapshot.

*Call graph*: calls 1 internal fn (from_parts); 4 external calls (from, default, from, assert_eq!).


##### `evaluator_uses_global_defaults_for_destructive_hints`  (lines 88–112)

```
fn evaluator_uses_global_defaults_for_destructive_hints()
```

**Purpose**: Checks that global app defaults can disable tools marked destructive when no per-app or per-tool override exists.

**Data flow**: Builds `AppsConfigToml` whose defaults set `destructive_enabled: false` → calls `policy_from_apps_config` with a destructive hint of `Some(true)` → asserts the resulting policy is disabled with `Auto` approval.

**Call relations**: Targets the hint-based fallback branch in policy evaluation.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_defaults_missing_destructive_hint_to_true`  (lines 115–139)

```
fn evaluator_defaults_missing_destructive_hint_to_true()
```

**Purpose**: Ensures a missing destructive hint is treated conservatively as `true`, so destructive-disabled defaults still block the tool.

**Data flow**: Builds defaults with `destructive_enabled: false` → calls `policy_from_apps_config` with `destructive_hint: None` and `open_world_hint: Some(false)` → asserts the tool is disabled.

**Call relations**: Regression test for the evaluator’s conservative defaulting of absent hints.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_defaults_missing_open_world_hint_to_true`  (lines 142–166)

```
fn evaluator_defaults_missing_open_world_hint_to_true()
```

**Purpose**: Ensures a missing open-world hint is treated conservatively as `true`, so open-world-disabled defaults still block the tool.

**Data flow**: Builds defaults with `open_world_enabled: false` → calls `policy_from_apps_config` with `open_world_hint: None` and `destructive_hint: Some(false)` → asserts the tool is disabled.

**Call relations**: Companion to the missing-destructive-hint test, covering the other hint dimension.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `app_enablement_uses_defaults_and_per_app_overrides`  (lines 169–192)

```
fn app_enablement_uses_defaults_and_per_app_overrides()
```

**Purpose**: Verifies that app enablement falls back to `_default.enabled` and can be overridden per app.

**Data flow**: Builds `AppsConfigToml` with `_default.enabled = false` and one app `calendar` explicitly enabled → calls `app_is_enabled` for `calendar`, `drive`, and `None` connector id → asserts results `[true, false, false]`.

**Call relations**: Direct unit test of the `app_is_enabled` helper.

*Call graph*: calls 1 internal fn (defaults); 3 external calls (default, from, assert_eq!).


##### `managed_disable_overrides_enabled_app`  (lines 195–223)

```
fn managed_disable_overrides_enabled_app()
```

**Purpose**: Checks that a managed requirement disabling an app wins even when user config explicitly enables that app.

**Data flow**: Builds user `AppsConfigToml` with app enabled and requirements via `app_enabled_requirement(..., false)` → evaluates policy through `policy_from_config_parts` → asserts the resulting policy is disabled with `Auto` approval.

**Call relations**: Exercises the managed app-disable overlay applied by `effective_apps_config`.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 3 external calls (default, from, assert_eq!).


##### `managed_enable_does_not_override_disabled_app`  (lines 226–254)

```
fn managed_enable_does_not_override_disabled_app()
```

**Purpose**: Verifies that managed requirements do not force-enable an app that user config has disabled.

**Data flow**: Builds user `AppsConfigToml` with app disabled and requirements via `app_enabled_requirement(..., true)` → evaluates policy through `policy_from_config_parts` → asserts the policy remains disabled.

**Call relations**: Pins the one-way nature of managed enablement constraints in the current implementation.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 3 external calls (default, from, assert_eq!).


##### `managed_disable_applies_without_apps_config`  (lines 257–275)

```
fn managed_disable_applies_without_apps_config()
```

**Purpose**: Checks that managed app disablement still takes effect even when there is no user `[apps]` config at all.

**Data flow**: Builds requirements disabling one app → calls `policy_from_config_parts` with `apps_config: None` → asserts the resulting policy is disabled with `Auto` approval.

**Call relations**: Covers the path where `effective_apps_config` starts from a default empty config and requirements create the disabling entry.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 1 external calls (assert_eq!).


##### `evaluator_honors_default_app_enabled_false`  (lines 278–302)

```
fn evaluator_honors_default_app_enabled_false()
```

**Purpose**: Verifies that `_default.enabled = false` disables tools for apps without explicit per-app overrides.

**Data flow**: Builds `AppsConfigToml` with defaults disabled and no app entries → evaluates a tool policy for `calendar` → asserts the result is disabled with `Auto` approval.

**Call relations**: Another test of app-level enablement fallback, but through the full policy path.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_allows_per_app_enable_when_default_is_disabled`  (lines 305–332)

```
fn evaluator_allows_per_app_enable_when_default_is_disabled()
```

**Purpose**: Checks that a per-app `enabled = true` override re-enables an app even when `_default.enabled` is false.

**Data flow**: Builds defaults disabled plus an explicit enabled `calendar` app → evaluates a tool policy for that app → asserts the result equals `AppToolPolicy::default()`.

**Call relations**: Complements the previous test by covering the per-app override branch.

*Call graph*: calls 1 internal fn (defaults); 3 external calls (default, from, assert_eq!).


##### `evaluator_uses_managed_approval_without_apps_config`  (lines 335–351)

```
fn evaluator_uses_managed_approval_without_apps_config()
```

**Purpose**: Verifies that managed approval alone can affect policy even when there is no user apps config.

**Data flow**: Calls `policy_from_apps_config` with `apps_config: None` and `managed_approval: Some(AppToolApproval::Approve)` → asserts the result is enabled with approval `Approve`.

**Call relations**: Covers the no-apps-config early-return branch in `app_tool_policy_from_apps_config`.

*Call graph*: 1 external calls (assert_eq!).


##### `managed_approval_uses_raw_tool_name`  (lines 354–390)

```
fn managed_approval_uses_raw_tool_name()
```

**Purpose**: Ensures managed approval matching uses the raw tool name only and does not fall back to `tool_title` aliases.

**Data flow**: Builds requirements granting approval to raw tool name `calendar/list_events` → evaluates one policy with that exact raw name and another with a different raw name but matching title → asserts only the exact raw-name case receives managed approval.

**Call relations**: Targets `managed_app_tool_approval` lookup semantics specifically.

*Call graph*: calls 1 internal fn (app_tool_requirements); 1 external calls (assert_eq!).


##### `managed_approval_overrides_user_tool_approval`  (lines 393–434)

```
fn managed_approval_overrides_user_tool_approval()
```

**Purpose**: Checks that managed approval takes precedence over a conflicting per-tool user approval setting.

**Data flow**: Builds user apps config with per-tool approval `Prompt` and requirements with managed approval `Approve` for the same tool → evaluates policy through `policy_from_config_parts` → asserts approval is `Approve`.

**Call relations**: Pins approval precedence ordering between managed and user config.

*Call graph*: calls 1 internal fn (app_tool_requirements); 3 external calls (default, from, assert_eq!).


##### `per_tool_enable_overrides_app_level_hints`  (lines 437–472)

```
fn per_tool_enable_overrides_app_level_hints()
```

**Purpose**: Verifies that an explicit per-tool `enabled = true` beats app-level destructive/open-world restrictions.

**Data flow**: Builds app config with both hint categories disabled but a per-tool override enabling `events/create` → evaluates policy with both hints true → asserts the result equals the default enabled policy.

**Call relations**: Exercises the explicit per-tool enable branch before hint-based gating.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `default_tools_enable_overrides_app_level_hints`  (lines 475–521)

```
fn default_tools_enable_overrides_app_level_hints()
```

**Purpose**: Checks both sides of `default_tools_enabled`: it can enable unspecified tools despite restrictive hints, and it can disable them while preserving app-level default approval mode.

**Data flow**: Builds one app config with `default_tools_enabled: Some(true)` and restrictive hints, evaluates an enabled policy; mutates the app config to permissive hints, `default_tools_enabled: Some(false)`, and `default_tools_approval_mode: Some(Approve)`, evaluates a disabled policy for another tool; asserts both results match expectations.

**Call relations**: Uses `policy_from_apps_config` twice to cover the app-level default-tools branch in both directions.

*Call graph*: calls 1 internal fn (policy_from_apps_config); 2 external calls (default, assert_eq!).


##### `evaluator_uses_default_tools_approval_mode`  (lines 524–555)

```
fn evaluator_uses_default_tools_approval_mode()
```

**Purpose**: Verifies that an app’s `default_tools_approval_mode` applies to tools without per-tool approval overrides.

**Data flow**: Builds app config with `default_tools_approval_mode: Some(Prompt)` and an empty tools map → evaluates policy for `events/list` → asserts the tool is enabled with approval `Prompt`.

**Call relations**: Targets the approval fallback chain after per-tool lookup misses.

*Call graph*: 4 external calls (default, from, new, assert_eq!).


##### `evaluator_matches_tool_title_for_user_config`  (lines 558–598)

```
fn evaluator_matches_tool_title_for_user_config()
```

**Purpose**: Checks that user per-tool config can match on `tool_title` when the raw tool name differs from the configured key.

**Data flow**: Builds app config whose tools map contains `events/create` with explicit enable and approval → evaluates policy for raw tool name `calendar_events/create` and title `events/create` with restrictive hints → asserts the configured title match yields enabled/approved policy.

**Call relations**: Exercises the `or_else` fallback from raw tool name to `tool_title` in user config lookup.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `input`  (lines 600–608)

```
fn input(tool_name: &'a str, tool_title: Option<&'a str>) -> AppToolPolicyInput<'a>
```

**Purpose**: Small helper that constructs a standard `AppToolPolicyInput` fixture for the `calendar` connector with both hints set true.

**Data flow**: Accepts `tool_name` and optional `tool_title` → returns `AppToolPolicyInput { connector_id: Some("calendar"), tool_name, tool_title, destructive_hint: Some(true), open_world_hint: Some(true) }`.

**Call relations**: Used by `evaluator_reuses_one_snapshot_across_tools` to reduce fixture repetition.


##### `policy_from_apps_config`  (lines 610–635)

```
fn policy_from_apps_config(
    apps_config: Option<&AppsConfigToml>,
    connector_id: Option<&str>,
    tool_name: &str,
    tool_title: Option<&str>,
    destructive_hint: Option<bool>,
    open_wo
```

**Purpose**: Test helper that evaluates policy from optional user apps config and an optional managed approval, synthesizing requirements when needed.

**Data flow**: Accepts optional `apps_config`, connector/tool identifiers, hints, and optional `managed_approval` → if approval is present, builds requirements via `app_tool_requirements(...)` → forwards everything to `policy_from_config_parts` → returns the resulting `AppToolPolicy`.

**Call relations**: Called by many tests as the main convenience wrapper around the full evaluator setup.

*Call graph*: calls 1 internal fn (policy_from_config_parts); called by 1 (default_tools_enable_overrides_app_level_hints).


##### `policy_from_config_parts`  (lines 637–676)

```
fn policy_from_config_parts(
    apps_config: Option<&AppsConfigToml>,
    requirements_apps_config: Option<&AppsRequirementsToml>,
    connector_id: Option<&str>,
    tool_name: &str,
    tool_title:
```

**Purpose**: Builds a realistic `ConfigLayerStack` from optional user apps config and optional requirements, then runs the real evaluator against one tool input.

**Data flow**: Constructs `ConfigRequirementsToml` from optional requirements and creates a base `ConfigLayerStack::new(Vec::new(), ConfigRequirements::default(), requirements)` → if `apps_config` is present, creates a mutable `TomlValue::Table`, inserts serialized `apps` config via `TomlValue::try_from(apps_config)`, synthesizes an absolute temp config path using `CONFIG_TOML_FILE`, and applies it with `with_user_config`; otherwise uses the base stack unchanged → constructs `AppToolPolicyEvaluator::new(&config_layer_stack)` and calls `.policy(AppToolPolicyInput { ... })` → returns the policy.

**Call relations**: Core test harness helper used directly by `policy_from_apps_config` and some tests that need explicit requirements control.

*Call graph*: calls 3 internal fn (new, new, try_from); called by 1 (policy_from_apps_config); 6 external calls (default, Table, try_from, new, default, temp_dir).


##### `app_enabled_requirement`  (lines 678–688)

```
fn app_enabled_requirement(app_id: &str, enabled: bool) -> AppsRequirementsToml
```

**Purpose**: Builds a minimal managed requirements structure that sets only one app’s enabled flag.

**Data flow**: Accepts `app_id` and `enabled` → returns `AppsRequirementsToml` containing one `AppRequirementToml { enabled: Some(enabled), tools: None }` keyed by that app id.

**Call relations**: Used by tests covering managed app enable/disable precedence.

*Call graph*: called by 3 (managed_disable_applies_without_apps_config, managed_disable_overrides_enabled_app, managed_enable_does_not_override_disabled_app); 1 external calls (from).


##### `app_tool_requirements`  (lines 690–711)

```
fn app_tool_requirements(
    app_id: &str,
    tool_name: &str,
    approval_mode: AppToolApproval,
) -> AppsRequirementsToml
```

**Purpose**: Builds a minimal managed requirements structure that sets approval mode for one exact app tool.

**Data flow**: Accepts `app_id`, `tool_name`, and `approval_mode` → returns `AppsRequirementsToml` containing one app entry whose `tools` map contains one `AppToolRequirementToml { approval_mode: Some(approval_mode) }` for that tool.

**Call relations**: Used by tests covering managed approval precedence and raw-name matching.

*Call graph*: called by 2 (managed_approval_overrides_user_tool_approval, managed_approval_uses_raw_tool_name); 1 external calls (from).


##### `defaults`  (lines 713–724)

```
fn defaults(
    enabled: bool,
    destructive_enabled: bool,
    open_world_enabled: bool,
) -> AppsDefaultConfig
```

**Purpose**: Constructs an `AppsDefaultConfig` fixture with the supplied enablement and hint-policy booleans.

**Data flow**: Accepts `enabled`, `destructive_enabled`, and `open_world_enabled` → returns `AppsDefaultConfig` with those values and `approvals_reviewer: None`.

**Call relations**: Shared fixture helper used by many tests that vary only the global app defaults.

*Call graph*: called by 6 (app_enablement_uses_defaults_and_per_app_overrides, evaluator_allows_per_app_enable_when_default_is_disabled, evaluator_defaults_missing_destructive_hint_to_true, evaluator_defaults_missing_open_world_hint_to_true, evaluator_honors_default_app_enabled_false, evaluator_uses_global_defaults_for_destructive_hints).


### `core/tests/common/test_environment_tests.rs`

`test` · `unit test execution for config/env parsing`

The module exercises `parse_test_environment` entirely through assertions on returned `Result<TestEnvironment, String>` values. Every test is table-like and concrete: it passes combinations of `Option<&OsStr>` for the configured environment, the legacy remote-environment variable, and the docker container variable, then compares the exact parsed enum or exact error string. The suite establishes several important invariants. First, absence of all inputs defaults to `TestEnvironment::Local`. Second, explicit values map to the expected variants: `local`, `docker` with a required container name, and `wine-exec`. Third, the deprecated legacy remote-environment variable is still interpreted as a Docker container name, both when no explicit environment is set and when `docker` is explicitly selected. Fourth, stale remote metadata must be ignored when `local` is explicitly requested, preventing accidental remote execution due to leftover environment variables. Finally, invalid configurations are rejected precisely: `docker` without a container name fails, an empty legacy container name fails, and unknown environment strings produce an enumerated validation error. Because the assertions compare exact strings built from constants like `LEGACY_REMOTE_ENV_ENV_VAR`, `DOCKER_CONTAINER_ENV_VAR`, and `TEST_ENVIRONMENT_ENV_VAR`, these tests also pin the user-facing diagnostics.

#### Function details

##### `defaults_to_local`  (lines 8–16)

```
fn defaults_to_local()
```

**Purpose**: Verifies the parser's fallback behavior when no environment-related inputs are provided. It ensures the absence of all configuration selects `TestEnvironment::Local` rather than erroring or inferring a remote mode.

**Data flow**: Supplies `None` for configured environment, legacy remote environment, and docker container → invokes `parse_test_environment` through the assertion expression → expects `Ok(TestEnvironment::Local)` and writes no state beyond the test assertion outcome.

**Call relations**: This is a standalone `#[test]` entry invoked by the Rust test harness. It does not delegate beyond the asserted parser call and serves as the baseline case against which the more specific parsing tests in this file refine behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `parses_each_explicit_environment`  (lines 19–46)

```
fn parses_each_explicit_environment()
```

**Purpose**: Checks the three supported explicit environment strings and confirms each maps to the correct `TestEnvironment` variant. It also verifies that Docker captures the provided container name into owned `String` storage.

**Data flow**: Builds three separate parser inputs using `Some(OsStr::new(...))` for `local`, `docker`, and `wine-exec`, with the Docker case also passing `Some("container-1")` as the container source → each parser result is compared against the exact expected enum value → the test returns success only if all three mappings match.

**Call relations**: The test harness invokes this test directly. Within the suite, it complements `defaults_to_local` by covering explicit positive cases and leaves legacy and invalid-input branches to the other tests.

*Call graph*: 1 external calls (assert_eq!).


##### `treats_the_legacy_remote_value_as_a_docker_container`  (lines 49–60)

```
fn treats_the_legacy_remote_value_as_a_docker_container()
```

**Purpose**: Confirms backward compatibility for the deprecated remote-environment variable. When no explicit environment is configured, the legacy value must still produce a Docker test environment using that value as the container name.

**Data flow**: Passes `None` for the configured environment, `Some("legacy-container")` for the legacy remote input, and `None` for the docker container input → parser output is asserted to equal `Ok(TestEnvironment::Docker { container_name: "legacy-container".to_string() })` → no persistent state is modified.

**Call relations**: This test is another direct harness entry. It isolates the compatibility path so regressions in legacy env-var support are caught independently of explicit Docker parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `explicit_docker_accepts_the_legacy_container_value`  (lines 63–82)

```
fn explicit_docker_accepts_the_legacy_container_value()
```

**Purpose**: Validates two Docker-specific compatibility behaviors: explicit `docker` may source its container name from the legacy variable, and an empty legacy value is rejected with a precise error. This prevents silent acceptance of malformed compatibility input.

**Data flow**: Runs two parser calls with configured environment `Some("docker")`: first with legacy value `Some("legacy-container")`, then with legacy value `Some("")`, both without a dedicated docker container variable → compares the first result to a Docker enum and the second to `Err(format!("{LEGACY_REMOTE_ENV_ENV_VAR} must not be empty"))` → only assertion results are produced.

**Call relations**: The test harness invokes it directly. It bridges the explicit Docker path and the legacy compatibility path, covering a branch not exercised by either the pure explicit-environment or pure legacy-only tests.

*Call graph*: 1 external calls (assert_eq!).


##### `explicit_local_ignores_stale_remote_metadata`  (lines 85–94)

```
fn explicit_local_ignores_stale_remote_metadata()
```

**Purpose**: Ensures that an explicit `local` selection wins over any leftover remote-related environment variables. This guards against stale CI or shell state accidentally forcing Docker execution.

**Data flow**: Passes `Some("local")` plus non-empty legacy remote and docker container values → parser output is asserted to be `Ok(TestEnvironment::Local)` → the test observes only the returned value and emits no side effects.

**Call relations**: This direct harness test covers precedence rules. It complements the compatibility tests by proving that legacy and Docker metadata are not consulted once `local` is explicitly chosen.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_invalid_or_incomplete_configuration`  (lines 97–118)

```
fn rejects_invalid_or_incomplete_configuration()
```

**Purpose**: Checks the parser's failure modes for incomplete Docker configuration and unsupported environment names. It pins the exact diagnostic strings so callers receive actionable validation errors.

**Data flow**: Invokes the parser twice: once with explicit `docker` but no container source, and once with explicit `other` → compares the returned `Err(String)` values to formatted messages referencing `DOCKER_CONTAINER_ENV_VAR` and `TEST_ENVIRONMENT_ENV_VAR` → no state is mutated outside the assertion framework.

**Call relations**: The test harness runs this as the suite's negative-case coverage. It closes the matrix established by the other tests by asserting that unsupported or underspecified inputs fail rather than falling back.

*Call graph*: 1 external calls (assert_eq!).


### `core/tests/suite/deprecation_notice.rs`

`test` · `startup / config validation`

This non-Windows test file builds short-lived `TestCodex` instances against a mock server and waits for protocol-level `EventMsg::DeprecationNotice` events. Each test mutates configuration before startup, using either direct legacy booleans or managed feature metadata on `config.features`, then confirms that the runtime surfaces a deprecation notice instead of silently accepting the old setting. The first case combines `Feature::UnifiedExec`, explicit legacy-usage recording via `record_legacy_usage_force`, and the old `use_experimental_unified_exec_tool` boolean to ensure the notice points users toward `[features].unified_exec`. The second iterates over both `true` and `false` values for the deprecated `web_search_request` feature-map entry, proving the warning is value-independent because web search is now enabled by default. The third checks the Linux-specific `use_legacy_landlock` feature-map entry and its removal guidance. All tests are guarded by `skip_if_no_network!`, use `start_mock_server` plus `test_codex()` to create a realistic session, and extract the event payload by pattern-matching `EventMsg`. The important invariant is that the emitted text is exact and user-facing, including migration instructions and documentation URLs.

#### Function details

##### `emits_deprecation_notice_for_legacy_feature_flag`  (lines 16–54)

```
async fn emits_deprecation_notice_for_legacy_feature_flag() -> anyhow::Result<()>
```

**Purpose**: Builds a Codex instance with the legacy unified-exec flag enabled and verifies that startup emits the corresponding deprecation notice. It checks both the summary string and the optional details text.

**Data flow**: Reads network availability through `skip_if_no_network!`, starts a mock server, then mutates the test config by cloning managed feature state, enabling `Feature::UnifiedExec`, recording legacy usage for `use_experimental_unified_exec_tool`, writing the updated feature set back, and setting `config.use_experimental_unified_exec_tool = true`. After building `TestCodex`, it waits for the first `EventMsg::DeprecationNotice`, destructures `DeprecationNoticeEvent { summary, details }`, and asserts exact string equality before returning `Ok(())`.

**Call relations**: This is a top-level async test invoked by Tokio’s test harness. Within the test flow it delegates environment setup to `start_mock_server` and `test_codex`, then blocks on `wait_for_event_match` until the runtime publishes the deprecation event generated during initialization.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


##### `emits_deprecation_notice_for_web_search_feature_flag_values`  (lines 57–101)

```
async fn emits_deprecation_notice_for_web_search_feature_flag_values() -> anyhow::Result<()>
```

**Purpose**: Verifies that deprecated `[features].web_search_request` entries trigger the same deprecation notice regardless of whether the stored value is `true` or `false`. The test proves the warning is tied to the obsolete key itself, not only to enabling behavior.

**Data flow**: After the network guard, it loops over `enabled in [true, false]`. For each iteration it starts a fresh mock server, constructs a `BTreeMap<String, bool>` containing `web_search_request -> enabled`, clones the managed feature set, applies the map with `apply_map`, writes it back into config, builds a `TestCodex`, waits for a `DeprecationNotice` whose summary mentions `[features].web_search_request`, then asserts the exact summary and details strings. The function returns `Ok(())` after both iterations succeed.

**Call relations**: This async test is run directly by the test harness. For each loop iteration it follows the same startup path as production-like tests—`start_mock_server`, `test_codex`, then `wait_for_event_match`—to observe the notice emitted by configuration processing.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


##### `emits_deprecation_notice_for_use_legacy_landlock`  (lines 104–143)

```
async fn emits_deprecation_notice_for_use_legacy_landlock() -> anyhow::Result<()>
```

**Purpose**: Checks that opting into the deprecated `use_legacy_landlock` feature emits a removal warning with the expected cleanup guidance. It focuses on the exact user-visible wording for this Linux sandbox compatibility flag.

**Data flow**: The test first exits early when networking is unavailable. It then starts a mock server, prepares a config closure that builds a `BTreeMap` with `use_legacy_landlock -> true`, clones and updates the managed feature set via `apply_map`, writes it back, and builds `TestCodex`. It waits for a `DeprecationNotice` whose summary contains `[features].use_legacy_landlock`, extracts `summary` and `details`, asserts exact equality, and returns `Ok(())`.

**Call relations**: This function is another Tokio async test. It relies on `start_mock_server` and `test_codex` to trigger normal startup behavior, and uses `wait_for_event_match` to capture the specific deprecation event emitted by the runtime.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


### `core/tests/suite/personality_migration.rs`

`test` · `startup migration regression coverage`

This module is a filesystem-focused migration suite around `maybe_migrate_personality`. It creates temporary Codex homes, writes synthetic rollout files, invokes the migration, and inspects both the returned `PersonalityMigrationStatus` and the persisted files. Several helpers build realistic rollout fixtures: `write_rollout_with_user_event` writes a JSONL file containing a `SessionMeta` line followed by an `EventMsg::UserMessage`, while `write_rollout_with_meta_only` writes only metadata so tests can distinguish real user activity from empty session shells. Convenience wrappers place those rollouts under either the dated active sessions tree or the archived sessions directory.

The tests establish the migration contract. If the marker file already exists, migration short-circuits and leaves config untouched. If there is no marker and no qualifying sessions, migration returns `SkippedNoSessions`, creates the marker, and does not create `config.toml`. A rollout containing a user event causes `Applied`, writes the marker, and persists `personality = Pragmatic`. Existing unrelated config fields such as `model` must survive the write. Explicit global personality in parsed config skips migration, but personality nested under a selected profile does not; the migration still writes a global pragmatic personality. Missing legacy profiles must not block migration decisions. Finally, running the migration twice after an applied migration must be idempotent: the first run applies, the second sees the marker and skips.

#### Function details

##### `read_config_toml`  (lines 24–27)

```
async fn read_config_toml(codex_home: &Path) -> io::Result<ConfigToml>
```

**Purpose**: Loads and parses the persisted `config.toml` from a temporary Codex home. It gives the tests a typed view of migration output.

**Data flow**: Takes a `&Path` to the Codex home, reads `config.toml` asynchronously as a string, parses it with `toml::from_str`, and returns `io::Result<ConfigToml>`, mapping TOML parse failures into `io::ErrorKind::InvalidData`.

**Call relations**: Called by tests that need to inspect the post-migration config file after `maybe_migrate_personality` runs. It is not part of migration execution itself; it is purely a verification helper.

*Call graph*: called by 5 (applied_migration_is_idempotent_on_second_run, no_marker_archived_sessions_sets_personality, no_marker_profile_personality_does_not_skip_migration, no_marker_sessions_preserves_existing_config_fields, no_marker_sessions_sets_personality); 3 external calls (join, read_to_string, from_str).


##### `write_session_with_user_event`  (lines 29–37)

```
async fn write_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a synthetic active-session rollout containing both session metadata and a user message event. This fixture represents a real prior session that should trigger migration.

**Data flow**: Generates a fresh `ThreadId`, builds the dated active sessions directory under `SESSIONS_SUBDIR/2025/01/01`, and delegates to `write_rollout_with_user_event` to create the JSONL rollout file there.

**Call relations**: Used by the tests that need qualifying session history in the active sessions tree. It is a thin wrapper over `write_rollout_with_user_event` that fixes the directory layout.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 5 (applied_migration_is_idempotent_on_second_run, no_marker_explicit_global_personality_skips_migration, no_marker_profile_personality_does_not_skip_migration, no_marker_sessions_preserves_existing_config_fields, no_marker_sessions_sets_personality); 1 external calls (join).


##### `write_archived_session_with_user_event`  (lines 39–43)

```
async fn write_archived_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a synthetic archived-session rollout containing a user event. It verifies that archived sessions count as prior usage for migration purposes.

**Data flow**: Generates a new `ThreadId`, points at the `ARCHIVED_SESSIONS_SUBDIR`, and delegates to `write_rollout_with_user_event` to create the rollout file.

**Call relations**: Only the archived-session migration test calls this helper. It reuses the same rollout-writing logic as active sessions but targets the archived location.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (no_marker_archived_sessions_sets_personality); 1 external calls (join).


##### `write_session_with_meta_only`  (lines 45–53)

```
async fn write_session_with_meta_only(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates an active-session rollout that contains only session metadata and no user event. This fixture represents a non-qualifying session shell that should not trigger migration.

**Data flow**: Generates a `ThreadId`, builds the dated active sessions directory, and delegates to `write_rollout_with_meta_only` to write a JSONL file containing only the metadata line.

**Call relations**: Used by the meta-only test to prove that migration looks for actual user activity rather than merely the existence of rollout files.

*Call graph*: calls 2 internal fn (write_rollout_with_meta_only, new); called by 1 (no_marker_meta_only_rollout_is_treated_as_no_sessions); 1 external calls (join).


##### `write_rollout_with_user_event`  (lines 55–103)

```
async fn write_rollout_with_user_event(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes a complete rollout JSONL file with a `SessionMeta` line followed by a `UserMessage` event line. It is the core fixture generator for qualifying session history.

**Data flow**: Accepts a target directory and `ThreadId`, creates the directory tree, opens `rollout-<timestamp>-<thread_id>.jsonl`, constructs a `SessionMetaLine` with fixed test metadata and a `RolloutLine::SessionMeta`, constructs a second `RolloutLine::EventMsg(EventMsg::UserMessage(...))`, serializes both lines with `serde_json::to_string`, writes each line plus newline to the file, and returns `io::Result<()>`.

**Call relations**: Called by both active and archived session fixture wrappers. The migration tests rely on this helper to produce realistic rollout content that `maybe_migrate_personality` will scan.

*Call graph*: called by 2 (write_archived_session_with_user_event, write_session_with_user_event); 11 external calls (default, join, new, format!, UserMessage, EventMsg, SessionMeta, to_string, from, create (+1 more)).


##### `write_rollout_with_meta_only`  (lines 105–140)

```
async fn write_rollout_with_meta_only(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes a rollout JSONL file containing only session metadata and no user event. It supports tests that distinguish empty rollouts from real sessions.

**Data flow**: Accepts a directory and `ThreadId`, creates the directory tree, opens the rollout file, builds a `SessionMetaLine` and wrapping `RolloutLine::SessionMeta`, serializes it to JSON, writes the single line plus newline, and returns `io::Result<()>`.

**Call relations**: Only `write_session_with_meta_only` delegates here. It exists to exercise the migration branch where rollout files exist but should still count as 'no sessions'.

*Call graph*: called by 1 (write_session_with_meta_only); 7 external calls (join, format!, SessionMeta, to_string, from, create, create_dir_all).


##### `parse_config_toml`  (lines 142–144)

```
fn parse_config_toml(contents: &str) -> io::Result<ConfigToml>
```

**Purpose**: Parses inline TOML snippets into `ConfigToml` values for tests that need custom preexisting configuration. It avoids writing files when only the in-memory config argument matters.

**Data flow**: Takes a TOML string slice, parses it with `toml::from_str`, and returns `io::Result<ConfigToml>`, converting parse errors into `io::ErrorKind::InvalidData`.

**Call relations**: Used by tests that pass explicit config states into `maybe_migrate_personality`, such as explicit global personality, profile personality, and missing legacy profile scenarios.

*Call graph*: called by 4 (marker_short_circuits_migration_with_legacy_profile, missing_legacy_profile_does_not_block_migration, no_marker_explicit_global_personality_skips_migration, no_marker_profile_personality_does_not_skip_migration); 1 external calls (from_str).


##### `migration_marker_exists_no_sessions_no_change`  (lines 147–161)

```
async fn migration_marker_exists_no_sessions_no_change() -> io::Result<()>
```

**Purpose**: Verifies that an existing migration marker causes migration to skip immediately, even when there are no sessions. It also confirms no config file is created as a side effect.

**Data flow**: Creates a temp home, writes the marker file with `v1`, calls `maybe_migrate_personality` with `ConfigToml::default()` and no state DB, then asserts the returned status is `SkippedMarker` and `config.toml` does not exist.

**Call relations**: This is a direct test entrypoint. It exercises the earliest short-circuit branch of the migration logic.

*Call graph*: calls 1 internal fn (maybe_migrate_personality); 4 external calls (new, assert_eq!, default, write).


##### `no_marker_no_sessions_no_change`  (lines 164–180)

```
async fn no_marker_no_sessions_no_change() -> io::Result<()>
```

**Purpose**: Checks that when there is no marker and no qualifying sessions, migration records the marker but does not create a config file. This is the baseline no-op path for fresh users.

**Data flow**: Creates a temp home with no rollout files, calls `maybe_migrate_personality` using default config, then asserts status `SkippedNoSessions`, marker existence `true`, and `config.toml` existence `false`.

**Call relations**: Invoked directly by the test runner. It complements the marker-short-circuit test by covering the first-run no-sessions branch.

*Call graph*: calls 1 internal fn (maybe_migrate_personality); 3 external calls (new, assert_eq!, default).


##### `no_marker_sessions_sets_personality`  (lines 183–199)

```
async fn no_marker_sessions_sets_personality() -> io::Result<()>
```

**Purpose**: Verifies that qualifying session history triggers the migration and persists a global pragmatic personality. It is the core positive-path test.

**Data flow**: Creates a temp home, writes an active rollout with a user event, calls `maybe_migrate_personality` with default config, asserts status `Applied` and marker existence, then reads `config.toml` via `read_config_toml` and asserts `persisted.personality == Some(Personality::Pragmatic)`.

**Call relations**: This direct test uses `write_session_with_user_event` to seed history and `read_config_toml` to inspect the migration result.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, default).


##### `no_marker_sessions_preserves_existing_config_fields`  (lines 202–215)

```
async fn no_marker_sessions_preserves_existing_config_fields() -> io::Result<()>
```

**Purpose**: Ensures that applying the migration augments existing config instead of overwriting unrelated fields. It specifically checks preservation of the configured model.

**Data flow**: Creates a temp home, writes a qualifying session rollout, writes `config.toml` containing `model = "gpt-5.4"`, parses that file with `read_config_toml`, passes the parsed config into `maybe_migrate_personality`, then rereads the persisted config and asserts both `model` and `personality = Pragmatic` are present.

**Call relations**: Called directly by the test runner. It extends the positive migration path by verifying merge semantics rather than just presence of the new personality field.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, write).


##### `no_marker_meta_only_rollout_is_treated_as_no_sessions`  (lines 218–235)

```
async fn no_marker_meta_only_rollout_is_treated_as_no_sessions() -> io::Result<()>
```

**Purpose**: Checks that a rollout containing only session metadata does not count as prior usage for migration. The migration should behave exactly like the no-sessions case.

**Data flow**: Creates a temp home, writes a meta-only rollout, calls `maybe_migrate_personality` with default config, and asserts status `SkippedNoSessions`, marker existence `true`, and absence of `config.toml`.

**Call relations**: This direct test uses `write_session_with_meta_only` to target the session-detection logic inside the migration.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, write_session_with_meta_only); 3 external calls (new, assert_eq!, default).


##### `no_marker_explicit_global_personality_skips_migration`  (lines 238–258)

```
async fn no_marker_explicit_global_personality_skips_migration() -> io::Result<()>
```

**Purpose**: Verifies that an explicitly configured global personality prevents the migration from writing a new one, even if qualifying sessions exist. This preserves user intent.

**Data flow**: Creates a temp home, writes a qualifying session rollout, parses inline TOML containing `personality = "friendly"`, calls `maybe_migrate_personality`, and asserts status `SkippedExplicitPersonality`, marker existence `true`, and absence of a newly written `config.toml`.

**Call relations**: Invoked directly by the test runner. It covers the branch where migration sees prior usage but must defer to an explicit top-level personality setting.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, parse_config_toml, write_session_with_user_event); 2 external calls (new, assert_eq!).


##### `no_marker_profile_personality_does_not_skip_migration`  (lines 261–287)

```
async fn no_marker_profile_personality_does_not_skip_migration() -> io::Result<()>
```

**Purpose**: Checks that personality configured only inside a selected profile does not count as an explicit global personality for migration purposes. The migration should still write a global pragmatic personality.

**Data flow**: Creates a temp home, writes a qualifying session rollout, parses TOML with `profile = "work"` and `[profiles.work].personality = "friendly"`, calls `maybe_migrate_personality`, asserts status `Applied`, marker existence, and existence of `config.toml`, then reads the file and asserts `persisted.personality == Some(Personality::Pragmatic)`.

**Call relations**: This direct test distinguishes profile-scoped legacy configuration from explicit global configuration. It uses both `parse_config_toml` and `read_config_toml` around the migration call.

*Call graph*: calls 4 internal fn (maybe_migrate_personality, parse_config_toml, read_config_toml, write_session_with_user_event); 2 external calls (new, assert_eq!).


##### `marker_short_circuits_migration_with_legacy_profile`  (lines 290–299)

```
async fn marker_short_circuits_migration_with_legacy_profile() -> io::Result<()>
```

**Purpose**: Ensures that the marker file short-circuits migration even when the provided config references a missing legacy profile. The marker check must happen before any legacy-profile interpretation can matter.

**Data flow**: Creates a temp home, writes the migration marker, parses TOML with `profile = "missing"`, calls `maybe_migrate_personality`, and asserts the status is `SkippedMarker`.

**Call relations**: This direct test combines two edge conditions—marker present and invalid legacy profile—to prove the marker branch dominates.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, parse_config_toml); 3 external calls (new, assert_eq!, write).


##### `missing_legacy_profile_does_not_block_migration`  (lines 302–314)

```
async fn missing_legacy_profile_does_not_block_migration() -> io::Result<()>
```

**Purpose**: Verifies that a missing legacy profile reference does not itself cause migration failure or application when there are no sessions. The result should still be the ordinary no-sessions skip with marker creation.

**Data flow**: Creates a temp home, parses TOML with `profile = "missing"`, calls `maybe_migrate_personality`, and asserts status `SkippedNoSessions` plus marker existence.

**Call relations**: Invoked directly by the test runner. It isolates the missing-profile edge case without any rollout history.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, parse_config_toml); 2 external calls (new, assert_eq!).


##### `applied_migration_is_idempotent_on_second_run`  (lines 317–331)

```
async fn applied_migration_is_idempotent_on_second_run() -> io::Result<()>
```

**Purpose**: Checks that once migration has applied and written its marker, rerunning it does nothing further. This protects startup from repeatedly rewriting config.

**Data flow**: Creates a temp home, writes a qualifying session rollout, calls `maybe_migrate_personality` twice with default config, asserts the first status is `Applied` and the second is `SkippedMarker`, then reads `config.toml` and confirms personality remains `Pragmatic`.

**Call relations**: This direct test chains two migration invocations in one temp home to validate idempotence across runs.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, default).


##### `no_marker_archived_sessions_sets_personality`  (lines 334–350)

```
async fn no_marker_archived_sessions_sets_personality() -> io::Result<()>
```

**Purpose**: Verifies that archived sessions are considered when deciding whether to apply the migration. Prior usage in the archive should still trigger a global pragmatic personality write.

**Data flow**: Creates a temp home, writes an archived rollout with a user event, calls `maybe_migrate_personality` with default config, asserts status `Applied` and marker existence, then reads `config.toml` and asserts `personality == Pragmatic`.

**Call relations**: This direct test is the archived-session counterpart to the active-session positive-path test, using `write_archived_session_with_user_event` as its fixture source.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_archived_session_with_user_event); 3 external calls (new, assert_eq!, default).


### `core/tests/suite/unstable_features_warning.rs`

`test` · `startup/config load during thread creation tests`

This file covers a narrow startup-time behavior in configuration handling. Both tests create a temporary Codex home, load the default test config, explicitly enable `Feature::ChildAgentsMd`, and then inject a user-config layer pointing at `config.toml` so the feature appears as config-driven rather than only runtime-mutated. They then construct a thread manager and auth manager from dummy API-key auth and call `resume_thread_with_history` with `InitialHistory::New` to spawn a fresh conversation thread.

The first test waits for an `EventMsg::Warning`, destructures `WarningEvent { message }`, and asserts the warning text mentions the specific feature name, the general under-development warning, and the suppression knob `suppress_unstable_features_warning = true`. The second test sets `config.suppress_unstable_features_warning = true` before spawning the thread and then wraps `wait_for_event` in a short `tokio::time::timeout`; the expected outcome is timeout rather than a warning event. Together these tests specify that the warning is emitted during thread startup, is tied to config-enabled unstable features, and is suppressible without disabling the feature itself.

#### Function details

##### `emits_warning_when_unstable_features_enabled_via_config`  (lines 19–61)

```
async fn emits_warning_when_unstable_features_enabled_via_config()
```

**Purpose**: Checks that starting a new thread with an unstable feature enabled via config emits a warning event describing the feature and suppression option.

**Data flow**: It creates a temp home, loads default config, enables `Feature::ChildAgentsMd`, injects a user config layer at `CONFIG_TOML_FILE` with `features.child_agents_md = true`, builds thread and auth managers from dummy API-key auth, resumes a new thread, waits for `EventMsg::Warning`, extracts the warning message, and asserts it contains the feature name and explanatory text.

**Call relations**: This test directly exercises thread startup rather than turn submission, using `wait_for_event` to observe the warning emitted by the newly resumed conversation.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, from_api_key, from_absolute_path); 6 external calls (new, assert!, load_default_config_for_test, wait_for_event, panic!, toml!).


##### `suppresses_warning_when_configured`  (lines 64–106)

```
async fn suppresses_warning_when_configured()
```

**Purpose**: Verifies that the unstable-features warning is not emitted when `suppress_unstable_features_warning` is enabled.

**Data flow**: It performs the same setup as the previous test but also sets `config.suppress_unstable_features_warning = true`, resumes a new thread, then wraps `wait_for_event` for `EventMsg::Warning` in a 150 ms timeout and asserts the timeout errors instead of yielding a warning.

**Call relations**: This is the negative counterpart to the first test, proving the suppression flag affects startup warning emission.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, from_api_key, from_absolute_path); 7 external calls (from_millis, new, assert!, load_default_config_for_test, wait_for_event, timeout, toml!).


### Cloud config and home environment providers
This group validates external configuration sources and environment-sensitive providers, from signed cloud-config caching and service refresh behavior to home-directory instructions and cloud task filtering.

### `cloud-config/src/cache_tests.rs`

`test` · `test-time verification of cache read/write behavior`

This test module validates the cache’s fail-closed behavior with concrete filesystem interactions. The fixture helpers build realistic `CloudConfigBundle` values containing one config fragment and one requirements fragment, construct valid signed payloads with current timestamps, and write serialized cache files directly to disk. `create_test_cache` resolves a temporary directory into the same `AbsolutePathBuf` form used in production so tests exercise the real path logic.

The main success test verifies more than simple round-tripping: after `save`, it parses the written JSON, checks that `expires_at` is positive and no more than 60 minutes after `cached_at`, reconstructs the expected signed file using the observed timestamps, and confirms `load` returns the exact signed payload for the matching identity. The remaining async tests each isolate one rejection condition: missing request identity short-circuits before file access, absent files report `CacheFileNotFound`, malformed JSON reports `CacheParseFailed`, payload tampering breaks signature verification, cached identity mismatch or incompleteness is rejected, expired entries are ignored, and unsupported version numbers are surfaced precisely.

Together these tests document the cache contract: identity is mandatory, signatures cover the payload bytes, and stale or structurally incompatible cache files are never trusted.

#### Function details

##### `test_bundle`  (lines 11–28)

```
fn test_bundle() -> CloudConfigBundle
```

**Purpose**: Builds a representative non-empty `CloudConfigBundle` fixture with one config fragment and one requirements fragment.

**Data flow**: Creates and returns a `CloudConfigBundle` whose `config_toml.enterprise_managed` contains a `CloudConfigFragment` and whose `requirements_toml.enterprise_managed` contains a `CloudRequirementsFragment`. It reads no external state.

**Call relations**: Used as the canonical bundle fixture both when constructing valid signed payloads and when asserting that saved and loaded cache contents match expected values.

*Call graph*: called by 2 (save_writes_signed_payload_and_loads_for_matching_identity, valid_signed_payload); 1 external calls (vec!).


##### `signed_cache_file`  (lines 30–38)

```
fn signed_cache_file(
    signed_payload: CloudConfigBundleCacheSignedPayload,
) -> CloudConfigBundleCacheFile
```

**Purpose**: Wraps a payload in the on-disk cache file structure with a valid signature.

**Data flow**: Consumes a `CloudConfigBundleCacheSignedPayload`, serializes it with `cache_payload_bytes`, signs the bytes with `sign_cache_payload`, and returns a `CloudConfigBundleCacheFile` containing both the original payload and generated signature.

**Call relations**: Used by tests that need to write handcrafted but correctly signed cache files before mutating or validating specific fields.

*Call graph*: called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version).


##### `valid_signed_payload`  (lines 40–50)

```
fn valid_signed_payload() -> CloudConfigBundleCacheSignedPayload
```

**Purpose**: Creates a baseline cache payload fixture with current timestamps, matching identity, supported version, and a valid bundle.

**Data flow**: Reads `Utc::now()` into `cached_at`, computes `expires_at` as 30 minutes later, fills in fixed `chatgpt_user_id` and `account_id`, inserts `test_bundle()`, and returns the assembled `CloudConfigBundleCacheSignedPayload`.

**Call relations**: Serves as the starting point for tests that then alter one field—such as expiry, version, or identity—to trigger a specific cache rejection path.

*Call graph*: calls 1 internal fn (test_bundle); called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version); 2 external calls (minutes, now).


##### `write_cache_file`  (lines 52–58)

```
fn write_cache_file(cache: &CloudConfigBundleCache, cache_file: &CloudConfigBundleCacheFile)
```

**Purpose**: Writes a prepared cache file structure directly to the cache path on disk.

**Data flow**: Borrows a `CloudConfigBundleCache` and `CloudConfigBundleCacheFile`, obtains the path via `cache.path()`, pretty-serializes the file with `serde_json::to_vec_pretty`, and writes it using synchronous `std::fs::write`.

**Call relations**: Used by tests that bypass `save` so they can place malformed or specially crafted cache contents on disk before calling `load`.

*Call graph*: calls 1 internal fn (path); called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version); 2 external calls (to_vec_pretty, write).


##### `create_test_cache`  (lines 60–62)

```
fn create_test_cache(codex_home: &Path) -> CloudConfigBundleCache
```

**Purpose**: Constructs a production-style cache object rooted at a temporary test directory.

**Data flow**: Takes a `&Path`, resolves it against `/` into an `AbsolutePathBuf`, passes that into `CloudConfigBundleCache::new`, and returns the resulting cache.

**Call relations**: Shared setup helper for all cache tests so each test gets an isolated cache file location.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 7 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_missing_request_identity_before_reading_cache_file, load_rejects_tampered_payload, load_rejects_unsupported_cache_version, load_reports_missing_and_malformed_cache_files, save_writes_signed_payload_and_loads_for_matching_identity).


##### `save_writes_signed_payload_and_loads_for_matching_identity`  (lines 65–103)

```
async fn save_writes_signed_payload_and_loads_for_matching_identity()
```

**Purpose**: Verifies that `save` writes a correctly signed cache file with a bounded TTL and that `load` accepts it for the matching identity.

**Data flow**: Creates a temp directory and cache, builds `test_bundle()`, awaits `cache.save(...)`, reads and parses the written file from disk, asserts timestamp bounds and exact signed-file equality, then awaits `cache.load(Some("user-12345"), Some("account-12345"))` and compares the result to the parsed payload.

**Call relations**: This is the primary happy-path integration test for the cache implementation, exercising both write and read logic together.

*Call graph*: calls 2 internal fn (create_test_cache, test_bundle); 5 external calls (assert!, assert_eq!, from_slice, read, tempdir).


##### `load_rejects_missing_request_identity_before_reading_cache_file`  (lines 106–120)

```
async fn load_rejects_missing_request_identity_before_reading_cache_file()
```

**Purpose**: Confirms that cache lookup fails immediately when either request identity component is absent.

**Data flow**: Creates a temp cache and calls `cache.load` twice: once with missing user ID and once with missing account ID. It asserts both results are `Err(CacheLoadStatus::AuthIdentityIncomplete)`.

**Call relations**: Documents the invariant that cache reads are identity-scoped and should not even inspect disk without a complete request identity.

*Call graph*: calls 1 internal fn (create_test_cache); 2 external calls (assert_eq!, tempdir).


##### `load_reports_missing_and_malformed_cache_files`  (lines 123–137)

```
async fn load_reports_missing_and_malformed_cache_files()
```

**Purpose**: Checks that absent cache files and malformed JSON are reported as distinct load statuses.

**Data flow**: Creates a temp cache, first awaits `load` on a nonexistent file and asserts `CacheFileNotFound`, then writes `{` directly to the cache path and asserts a subsequent `load` returns `CacheParseFailed(_)`.

**Call relations**: Covers the earliest filesystem and parsing failure branches in `CloudConfigBundleCache::load`.

*Call graph*: calls 1 internal fn (create_test_cache); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `load_rejects_tampered_payload`  (lines 140–156)

```
async fn load_rejects_tampered_payload()
```

**Purpose**: Ensures that modifying a signed payload without recomputing the signature causes signature verification failure.

**Data flow**: Creates a valid signed cache file from `valid_signed_payload()`, mutates the nested requirements fragment contents after signing, writes the altered file, then awaits `cache.load` for the matching identity and asserts `CacheSignatureInvalid`.

**Call relations**: Demonstrates that the HMAC covers the serialized payload bytes and prevents silent acceptance of edited cache contents.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


##### `load_rejects_cache_for_incomplete_or_different_identity`  (lines 159–178)

```
async fn load_rejects_cache_for_incomplete_or_different_identity()
```

**Purpose**: Verifies that cache entries are rejected when the cached identity does not match the request or is incomplete.

**Data flow**: Writes a valid signed cache file, then loads it with a different user ID and asserts `CacheIdentityMismatch`. Next it creates another signed payload with `chatgpt_user_id = None`, writes it, and asserts loading with the normal identity returns `CacheIdentityIncomplete`.

**Call relations**: Exercises the identity-scoping checks that prevent one user/account’s cache from being reused for another.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


##### `load_rejects_expired_cache`  (lines 181–192)

```
async fn load_rejects_expired_cache()
```

**Purpose**: Checks that a cache entry whose `expires_at` is in the past is ignored.

**Data flow**: Builds a valid signed payload, sets `expires_at` to one second before `Utc::now()`, writes the signed file, then awaits `cache.load` and asserts `CacheExpired`.

**Call relations**: Covers the TTL enforcement branch in `CloudConfigBundleCache::load`.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 4 external calls (seconds, now, assert_eq!, tempdir).


##### `load_rejects_unsupported_cache_version`  (lines 195–206)

```
async fn load_rejects_unsupported_cache_version()
```

**Purpose**: Ensures that cache files with an unexpected version number are rejected explicitly.

**Data flow**: Creates a valid signed payload, changes `version` to `2`, writes the signed file, then awaits `cache.load` and asserts `CacheVersionUnsupported(2)`.

**Call relations**: Exercises the version gate that allows future cache format changes to fail safely rather than being misinterpreted.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


### `cloud-config/src/service_tests.rs`

`test` · `test-time verification of service orchestration and helper semantics`

This large test module is the executable specification for `CloudConfigBundleService`. It starts with helpers that write `auth.json` files, construct `AuthManager` instances for API-key auth or ChatGPT token auth with specific plan types and identities, and synthesize fake JWT-bearing auth payloads. Additional bundle fixtures cover valid config/requirements fragments, invalid TOML content, and a standard retryable request error.

The file defines multiple fake clients tailored to specific control-flow branches: `StaticBundleClient` always returns the same bundle while counting requests; `PendingBundleClient` never resolves, enabling timeout tests; `SequenceBundleClient` pops a queued sequence of successes/failures to exercise retries and refresh replacement; `TokenBundleClient` checks the access token inside `CodexAuth` to verify unauthorized recovery reloads auth; and `UnauthorizedBundleClient` always returns a 401 with caller-controlled text.

The tests cover the full lifecycle. Startup skips non-ChatGPT auth and unsupported plans, accepts only workspace-like plans, validates remote bundles before caching, prefers valid cache, ignores invalid or identity-mismatched cache, treats empty bundles as successful `None`, retries retryable failures up to the configured maximum, and times out cleanly. Unauthorized tests verify both successful token refresh and failure modes, including cache identity updates after recovery and generic versus specific auth error messages. Additional tests assert that refresh updates the cache, `bundle_shape_tag` emits stable sorted labels, and `bundle_from_response` preserves fragment order while treating missing sections as empty.

#### Function details

##### `write_auth_json`  (lines 29–32)

```
fn write_auth_json(codex_home: &Path, value: serde_json::Value) -> std::io::Result<()>
```

**Purpose**: Writes a JSON auth fixture to `auth.json` under a temporary Codex home directory.

**Data flow**: Takes a base `&Path` and a `serde_json::Value`, joins `auth.json`, serializes the value to a string, writes it with `std::fs::write`, and returns `std::io::Result<()>`.

**Call relations**: Used by auth-manager fixture builders and unauthorized-recovery tests to control exactly what `AuthManager` reads from disk before and after simulated refreshes.

*Call graph*: called by 6 (auth_manager_with_api_key, auth_manager_with_plan_and_identity, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_surfaces_auth_recovery_message, get_bundle_unauthorized_without_recovery_uses_generic_message); 3 external calls (join, to_string, write).


##### `create_test_cache`  (lines 34–36)

```
fn create_test_cache(codex_home: &Path) -> CloudConfigBundleCache
```

**Purpose**: Builds a real `CloudConfigBundleCache` rooted at a test directory.

**Data flow**: Resolves the provided `&Path` against `/` into an `AbsolutePathBuf`, passes it to `CloudConfigBundleCache::new`, and returns the cache.

**Call relations**: Used in tests that inspect or preload the cache independently of the service.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 3 (get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, refresh_from_remote_updates_cached_bundle).


##### `auth_manager_with_api_key`  (lines 38–56)

```
async fn auth_manager_with_api_key() -> Arc<AuthManager>
```

**Purpose**: Creates an `AuthManager` configured with API-key auth rather than ChatGPT token auth.

**Data flow**: Creates a temp directory, writes an `auth.json` containing `OPENAI_API_KEY` and null token fields, constructs `AuthManager::new(...)` with file-backed credentials and default keyring backend, wraps it in `Arc`, and returns it.

**Call relations**: Used by the non-ChatGPT-auth test to verify the service skips cloud-config loading entirely for API-key authentication.

*Call graph*: calls 3 internal fn (write_auth_json, default, new); called by 1 (get_bundle_skips_non_chatgpt_auth); 3 external calls (new, json!, tempdir).


##### `auth_manager_with_plan_and_identity`  (lines 58–85)

```
async fn auth_manager_with_plan_and_identity(
    plan_type: &str,
    chatgpt_user_id: Option<&str>,
    account_id: Option<&str>,
) -> Arc<AuthManager>
```

**Purpose**: Creates an `AuthManager` whose token auth advertises a specific plan type and optional user/account identity.

**Data flow**: Creates a temp directory, writes `auth.json` generated by `chatgpt_auth_json(...)`, constructs `AuthManager::new(...)` with file-backed credentials and default keyring backend, wraps it in `Arc`, and returns it.

**Call relations**: This is the main auth fixture builder used by tests that need to vary plan eligibility or cache identity matching.

*Call graph*: calls 4 internal fn (chatgpt_auth_json, write_auth_json, default, new); called by 3 (auth_manager_with_plan, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity); 2 external calls (new, tempdir).


##### `auth_manager_with_plan`  (lines 87–89)

```
async fn auth_manager_with_plan(plan_type: &str) -> Arc<AuthManager>
```

**Purpose**: Convenience wrapper that creates token auth for a plan type with the standard test identity.

**Data flow**: Takes a plan type string and delegates to `auth_manager_with_plan_and_identity(plan_type, Some("user-12345"), Some("account-12345"))`.

**Call relations**: Used by most service tests that care about plan eligibility but not custom identity values.

*Call graph*: calls 1 internal fn (auth_manager_with_plan_and_identity); called by 12 (get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_empty_response_is_success_and_cached, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_rejects_invalid_remote_bundle_before_cache_write, get_bundle_retries_until_success, get_bundle_skips_individual_plan, get_bundle_skips_team_like_usage_based_plan, get_bundle_stops_after_max_retries, get_bundle_times_out (+2 more)).


##### `chatgpt_auth_json`  (lines 91–106)

```
fn chatgpt_auth_json(
    plan_type: &str,
    chatgpt_user_id: Option<&str>,
    account_id: Option<&str>,
    access_token: &str,
    refresh_token: &str,
) -> serde_json::Value
```

**Purpose**: Builds a token-auth JSON fixture with a default `last_refresh` timestamp.

**Data flow**: Takes plan type, optional user/account IDs, access token, and refresh token, then delegates to `chatgpt_auth_json_with_last_refresh(...)` with a fixed timestamp string.

**Call relations**: Used by auth fixture builders and one auth-recovery failure test to generate realistic persisted auth state.

*Call graph*: calls 1 internal fn (chatgpt_auth_json_with_last_refresh); called by 2 (auth_manager_with_plan_and_identity, get_bundle_surfaces_auth_recovery_message).


##### `chatgpt_auth_json_with_last_refresh`  (lines 108–125)

```
fn chatgpt_auth_json_with_last_refresh(
    plan_type: &str,
    chatgpt_user_id: Option<&str>,
    account_id: Option<&str>,
    access_token: &str,
    refresh_token: &str,
    last_refresh: &str,
)
```

**Purpose**: Builds a token-auth JSON fixture while allowing the caller to control the persisted `last_refresh` timestamp.

**Data flow**: Takes plan type, optional identity, access token, refresh token, and `last_refresh`, then delegates to `chatgpt_auth_json_with_mode(...)` with `auth_mode` set to `None`.

**Call relations**: Used when tests need to prevent proactive auth reload or simulate a particular freshness state before unauthorized recovery.

*Call graph*: calls 1 internal fn (chatgpt_auth_json_with_mode); called by 3 (chatgpt_auth_json, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity).


##### `chatgpt_auth_json_with_mode`  (lines 127–165)

```
fn chatgpt_auth_json_with_mode(
    plan_type: &str,
    chatgpt_user_id: Option<&str>,
    account_id: Option<&str>,
    access_token: &str,
    refresh_token: &str,
    last_refresh: &str,
    auth_
```

**Purpose**: Constructs the full persisted auth JSON fixture, including a fake JWT carrying plan and user identity claims and an optional auth mode field.

**Data flow**: Takes plan type, optional identity, access token, refresh token, `last_refresh`, and optional `auth_mode`. It builds JWT header and payload JSON, base64url-encodes them plus a fake signature, formats them into `header.payload.signature`, inserts that as `id_token` alongside access/refresh tokens and account ID in an auth JSON object, optionally adds `auth_mode`, and returns the resulting `serde_json::Value`.

**Call relations**: This is the lowest-level auth fixture generator used by higher-level helpers and tests that need to control auth mode behavior.

*Call graph*: called by 2 (chatgpt_auth_json_with_last_refresh, get_bundle_unauthorized_without_recovery_uses_generic_message); 4 external calls (format!, json!, String, to_vec).


##### `test_bundle`  (lines 167–176)

```
fn test_bundle() -> CloudConfigBundle
```

**Purpose**: Creates the standard valid bundle fixture used across service tests.

**Data flow**: Returns a `CloudConfigBundle` containing one config fragment from `test_config_fragment()` and one requirements fragment from `test_requirements_fragment()`.

**Call relations**: Used throughout tests as the canonical successful backend response and expected cached bundle.

*Call graph*: called by 10 (get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_skips_individual_plan, get_bundle_skips_non_chatgpt_auth, get_bundle_skips_team_like_usage_based_plan, get_bundle_uses_cache_when_valid); 1 external calls (vec!).


##### `test_config_fragment`  (lines 178–184)

```
fn test_config_fragment() -> CloudConfigFragment
```

**Purpose**: Creates the standard valid config fragment fixture.

**Data flow**: Returns a `CloudConfigFragment` with fixed `id`, `name`, and TOML `contents`.

**Call relations**: Used by `test_bundle` and bundle-shape tests to populate config-side bundle content.


##### `test_requirements_fragment`  (lines 186–192)

```
fn test_requirements_fragment() -> CloudRequirementsFragment
```

**Purpose**: Creates the standard valid requirements fragment fixture.

**Data flow**: Returns a `CloudRequirementsFragment` with fixed `id`, `name`, and TOML `contents`.

**Call relations**: Used by `test_bundle` and bundle-shape tests to populate requirements-side bundle content.


##### `invalid_config_bundle`  (lines 194–205)

```
fn invalid_config_bundle() -> CloudConfigBundle
```

**Purpose**: Builds a bundle fixture whose config TOML is syntactically invalid.

**Data flow**: Returns a `CloudConfigBundle` with one `CloudConfigFragment` containing malformed TOML (`"model = ["`) and default empty requirements.

**Call relations**: Used to verify that both remote and cached invalid bundles are rejected before use.

*Call graph*: called by 2 (get_bundle_ignores_invalid_cache_and_refetches, get_bundle_rejects_invalid_remote_bundle_before_cache_write); 2 external calls (default, vec!).


##### `request_error`  (lines 207–209)

```
fn request_error() -> BundleRequestError
```

**Purpose**: Creates the standard retryable request failure fixture used in retry tests.

**Data flow**: Returns `BundleRequestError::Retryable(RetryableFailureKind::Request { status_code: None })`.

**Call relations**: Used by sequence-based fake clients to drive the service into retry logic without involving auth recovery.

*Call graph*: 1 external calls (Retryable).


##### `StaticBundleClient::new`  (lines 217–222)

```
fn new(bundle: CloudConfigBundle) -> Self
```

**Purpose**: Constructs a fake client that always returns the same bundle and counts requests.

**Data flow**: Consumes a `CloudConfigBundle`, stores it, initializes `request_count` to `AtomicUsize::new(0)`, and returns the client.

**Call relations**: Used in tests that need deterministic success responses and want to assert whether the service hit the backend at all.

*Call graph*: called by 10 (get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_empty_response_is_success_and_cached, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_rejects_invalid_remote_bundle_before_cache_write, get_bundle_skips_individual_plan, get_bundle_skips_non_chatgpt_auth, get_bundle_skips_team_like_usage_based_plan, get_bundle_uses_cache_when_valid); 1 external calls (new).


##### `StaticBundleClient::get_bundle`  (lines 226–229)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements `BundleClient` by returning the stored bundle every time.

**Data flow**: Borrows `self`, ignores auth, increments `request_count` with `fetch_add`, clones the stored bundle, and returns it in `Ok(...)`.

**Call relations**: Exercised by many startup-path tests to verify eligibility checks, cache preference, and cache writes without introducing transport variability.

*Call graph*: 2 external calls (fetch_add, clone).


##### `PendingBundleClient::get_bundle`  (lines 235–238)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements `BundleClient` with a future that never resolves, enabling timeout tests.

**Data flow**: Borrows `self`, ignores auth, awaits `pending::<()>()` forever, and contains an unreachable `Ok(CloudConfigBundle::default())` after the pending await.

**Call relations**: Used only by the timeout test to ensure `load_startup_bundle_with_timeout` fails due to elapsed time rather than backend error.

*Call graph*: 1 external calls (default).


##### `SequenceBundleClient::new`  (lines 247–252)

```
fn new(responses: Vec<Result<CloudConfigBundle, BundleRequestError>>) -> Self
```

**Purpose**: Constructs a fake client that returns a queued sequence of results across successive requests.

**Data flow**: Consumes a `Vec<Result<CloudConfigBundle, BundleRequestError>>`, converts it into a `VecDeque`, wraps it in `tokio::sync::Mutex`, initializes `request_count` to zero, and returns the client.

**Call relations**: Used by retry, cache-miss, cache-refresh, and retry-exhaustion tests that need precise control over successive backend outcomes.

*Call graph*: called by 6 (get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_retries_until_success, get_bundle_stops_after_max_retries, get_bundle_uses_cache_when_valid, refresh_from_remote_updates_cached_bundle); 3 external calls (new, from, new).


##### `SequenceBundleClient::get_bundle`  (lines 256–262)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements `BundleClient` by popping and returning the next queued response.

**Data flow**: Borrows `self`, ignores auth, increments `request_count`, locks the async mutex guarding `responses`, pops the front item, and returns it; if the queue is empty, it falls back to `Ok(CloudConfigBundle::default())`.

**Call relations**: Drives multi-attempt service flows where the first request fails and later ones succeed, or where refresh returns a replacement bundle.

*Call graph*: 1 external calls (fetch_add).


##### `TokenBundleClient::get_bundle`  (lines 272–285)

```
async fn get_bundle(&self, auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements `BundleClient` that succeeds only when the auth object carries an expected access token, otherwise returning unauthorized.

**Data flow**: Borrows `self` and `auth`, increments `request_count`, reads `auth.get_token().as_deref()`, compares it to `self.expected_token`, and returns `Ok(self.bundle.clone())` on match or `Err(BundleRequestError::Unauthorized { status_code: Some(401), message: ... })` otherwise.

**Call relations**: Used by unauthorized-recovery tests to prove that the service actually reloads refreshed auth and retries with the new token.

*Call graph*: 3 external calls (fetch_add, clone, matches!).


##### `UnauthorizedBundleClient::get_bundle`  (lines 294–300)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements `BundleClient` that always returns a 401 unauthorized error with a configurable message.

**Data flow**: Borrows `self`, ignores auth, increments `request_count`, clones `self.message`, and returns `Err(BundleRequestError::Unauthorized { status_code: Some(401), message })`.

**Call relations**: Used to test auth-recovery failure paths and the exact error messages surfaced when recovery is unavailable or unrecoverable.

*Call graph*: 1 external calls (fetch_add).


##### `bundle_shape_tag_describes_sorted_enterprise_sources`  (lines 304–339)

```
fn bundle_shape_tag_describes_sorted_enterprise_sources()
```

**Purpose**: Verifies that `bundle_shape_tag` returns the expected labels for none, empty, config-only, requirements-only, and combined bundles.

**Data flow**: Calls `bundle_shape_tag` with `None`, `CloudConfigBundle::default()`, and several constructed bundles, asserting the returned strings match expected stable values.

**Call relations**: Documents the metrics helper’s output contract independently of service behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `get_bundle_skips_non_chatgpt_auth`  (lines 342–354)

```
async fn get_bundle_skips_non_chatgpt_auth()
```

**Purpose**: Checks that API-key auth does not trigger cloud-config fetching.

**Data flow**: Builds a `StaticBundleClient`, temp home, and service using `auth_manager_with_api_key()`, awaits `service.load_startup_bundle()`, and asserts the result is `Ok(None)` and backend request count remains zero.

**Call relations**: Exercises the early auth-type eligibility gate in `load_startup_bundle`.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_api_key, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_skips_individual_plan`  (lines 357–369)

```
async fn get_bundle_skips_individual_plan()
```

**Purpose**: Checks that an individual/pro plan is not eligible for cloud-config loading.

**Data flow**: Creates a service with plan `"pro"`, awaits startup load, and asserts `Ok(None)` with zero backend requests.

**Call relations**: Covers the plan-type branch of `cloud_config_eligible_auth` for unsupported individual subscriptions.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_allows_eligible_workspace_plans_and_writes_cache`  (lines 372–409)

```
async fn get_bundle_allows_eligible_workspace_plans_and_writes_cache()
```

**Purpose**: Verifies that all supported workspace-like plan strings trigger a backend fetch, return the bundle, and create the cache file.

**Data flow**: Loops over several plan strings, and for each creates a fresh bundle, client, temp home, and service; it awaits startup load and asserts `Ok(Some(bundle))`, exactly one backend request, and existence of `cloud-config-bundle-cache.json`.

**Call relations**: Acts as a table-driven test for the positive eligibility cases accepted by `cloud_config_eligible_auth`.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 4 external calls (new, assert!, assert_eq!, tempdir).


##### `get_bundle_skips_team_like_usage_based_plan`  (lines 412–424)

```
async fn get_bundle_skips_team_like_usage_based_plan()
```

**Purpose**: Checks that the self-serve business usage-based plan is intentionally excluded from cloud-config eligibility.

**Data flow**: Creates a service with plan `"self_serve_business_usage_based"`, awaits startup load, and asserts `Ok(None)` with zero backend requests.

**Call relations**: Documents a subtle negative eligibility case distinct from ordinary individual plans.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_rejects_invalid_remote_bundle_before_cache_write`  (lines 427–451)

```
async fn get_bundle_rejects_invalid_remote_bundle_before_cache_write()
```

**Purpose**: Ensures that an invalid remotely fetched bundle fails closed and is not cached.

**Data flow**: Creates a service whose static client returns `invalid_config_bundle()`, awaits startup load expecting an error, asserts the error code is `InvalidBundle` and message mentions invalid cloud config bundle, checks one backend request occurred, and asserts the cache file does not exist.

**Call relations**: Exercises `validate_and_cache_remote_bundle`’s validation gate and confirms cache writes happen only after successful validation.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, invalid_config_bundle); 4 external calls (new, assert!, assert_eq!, tempdir).


##### `get_bundle_ignores_invalid_cache_and_refetches`  (lines 454–487)

```
async fn get_bundle_ignores_invalid_cache_and_refetches()
```

**Purpose**: Verifies that a signed but semantically invalid cached bundle is ignored and replaced by a fresh valid remote bundle.

**Data flow**: Prewrites invalid bundle content into the cache via `cache.save(...)`, creates a service whose client returns a valid replacement bundle, awaits startup load, asserts the replacement bundle is returned and one backend request occurred, then reloads the cache and asserts it now contains the replacement bundle.

**Call relations**: Covers the path where cache integrity passes but `validate_bundle` rejects the cached payload, forcing a remote refetch.

*Call graph*: calls 6 internal fn (new, new, auth_manager_with_plan, create_test_cache, invalid_config_bundle, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_empty_response_is_success_and_cached`  (lines 490–508)

```
async fn get_bundle_empty_response_is_success_and_cached()
```

**Purpose**: Checks that an empty bundle is treated as a successful `None` result and still persisted to cache.

**Data flow**: Creates a service whose static client returns `CloudConfigBundle::default()`, awaits startup load, asserts `Ok(None)`, checks one backend request, and verifies the cache file exists.

**Call relations**: Documents the `optional_bundle` normalization rule and the fact that empty bundles are cacheable successful responses.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `get_bundle_uses_cache_when_valid`  (lines 511–532)

```
async fn get_bundle_uses_cache_when_valid()
```

**Purpose**: Verifies that a valid identity-matched cache entry suppresses any backend request on subsequent startup.

**Data flow**: First primes the cache by running a service with a static successful client. Then it creates a second service over the same home directory with a sequence client that would fail if called, awaits startup load, and asserts the cached bundle is returned while backend request count stays zero.

**Call relations**: Exercises the preferred-cache path in `load_startup_bundle` and proves remote fetch is skipped entirely on a valid cache hit.

*Call graph*: calls 5 internal fn (new, new, new, auth_manager_with_plan, test_bundle); 4 external calls (new, assert_eq!, tempdir, vec!).


##### `get_bundle_ignores_cache_for_different_auth_identity`  (lines 535–572)

```
async fn get_bundle_ignores_cache_for_different_auth_identity()
```

**Purpose**: Checks that a cache entry written for one user is not reused when startup auth has a different identity.

**Data flow**: Primes the cache under one user/account identity, then creates a second service over the same home with a different user ID and a sequence client returning a replacement bundle. It awaits startup load and asserts the replacement bundle is fetched and one backend request occurs.

**Call relations**: Covers the cache identity mismatch branch and confirms the service refetches rather than reusing another identity’s cached policy.

*Call graph*: calls 5 internal fn (new, new, new, auth_manager_with_plan_and_identity, test_bundle); 5 external calls (new, assert_eq!, default, tempdir, vec!).


##### `get_bundle_times_out`  (lines 575–592)

```
async fn get_bundle_times_out()
```

**Purpose**: Verifies that the timeout wrapper fails closed when bundle loading does not complete within `CLOUD_CONFIG_BUNDLE_TIMEOUT`.

**Data flow**: Creates a service using `PendingBundleClient`, spawns `load_startup_bundle_with_timeout()` on Tokio, advances paused time past the timeout, awaits the task, extracts the error, and asserts its message mentions timing out waiting for the cloud config bundle.

**Call relations**: Exercises the outer timeout path in `load_startup_bundle_with_timeout` independently of retry or auth logic.

*Call graph*: calls 2 internal fn (new, auth_manager_with_plan); 6 external calls (new, from_millis, assert!, tempdir, spawn, advance).


##### `get_bundle_retries_until_success`  (lines 595–614)

```
async fn get_bundle_retries_until_success()
```

**Purpose**: Checks that a retryable request failure is retried and a later success is returned.

**Data flow**: Creates a sequence client returning `Err(request_error())` then `Ok(test_bundle())`, spawns `service.load_startup_bundle()`, yields, advances paused time enough for backoff sleep, then asserts the task returns `Ok(Some(test_bundle()))` and request count is two.

**Call relations**: Covers the retry loop and `retry_after_request_failure` path for transient non-auth backend failures.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 8 external calls (new, from_secs, assert_eq!, tempdir, spawn, yield_now, advance, vec!).


##### `get_bundle_recovers_after_unauthorized_reload`  (lines 617–671)

```
async fn get_bundle_recovers_after_unauthorized_reload()
```

**Purpose**: Verifies that an unauthorized response triggers auth recovery, reloads refreshed auth from disk, and retries successfully with the new token.

**Data flow**: Writes initial auth with a stale access token, constructs `AuthManager`, overwrites `auth.json` with a fresh access token, creates a `TokenBundleClient` expecting the fresh token, runs startup load, and asserts success with `test_bundle()` after exactly two backend requests.

**Call relations**: Exercises `handle_unauthorized`’s successful recovery branch and proves the service retries the same attempt using refreshed credentials.

*Call graph*: calls 6 internal fn (new, chatgpt_auth_json_with_last_refresh, test_bundle, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_recovers_after_unauthorized_reload_updates_cache_identity`  (lines 674–735)

```
async fn get_bundle_recovers_after_unauthorized_reload_updates_cache_identity()
```

**Purpose**: Checks that after unauthorized recovery changes the authenticated user identity, the cache is written under the refreshed identity rather than the stale one.

**Data flow**: Writes initial auth for one user, constructs `AuthManager`, overwrites auth on disk with a different user ID and fresh token, runs startup load through a `TokenBundleClient`, then loads the cache using the refreshed identity and asserts it contains `test_bundle()`. It also checks two backend requests occurred.

**Call relations**: Covers the subtle interaction between auth recovery and cache scoping, proving `validate_and_cache_remote_bundle` uses post-recovery identity.

*Call graph*: calls 7 internal fn (new, chatgpt_auth_json_with_last_refresh, create_test_cache, test_bundle, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_surfaces_auth_recovery_message`  (lines 738–798)

```
async fn get_bundle_surfaces_auth_recovery_message()
```

**Purpose**: Verifies that when unauthorized recovery fails permanently due to account mismatch, the specific recovery error message is surfaced to callers.

**Data flow**: Writes initial enterprise auth, constructs `AuthManager`, overwrites auth on disk with mismatched account identity, uses an always-unauthorized client, awaits startup load expecting an error, and asserts the returned `CloudConfigBundleLoadError` equals one with code `Auth`, status `401`, and the specific refresh failure message. It also checks one backend request.

**Call relations**: Exercises the `RefreshTokenError::Permanent` branch in `handle_unauthorized`.

*Call graph*: calls 5 internal fn (new, chatgpt_auth_json, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_unauthorized_without_recovery_uses_generic_message`  (lines 801–854)

```
async fn get_bundle_unauthorized_without_recovery_uses_generic_message()
```

**Purpose**: Checks that when no unauthorized recovery path is available, the service returns the generic sign-in-again message rather than backend HTML or transport details.

**Data flow**: Writes auth JSON with explicit `auth_mode` disabling recovery, constructs `AuthManager`, uses an always-unauthorized client with a noisy HTML-containing message, awaits startup load expecting an error, and asserts the returned error equals one with code `Auth`, status `401`, and `CLOUD_CONFIG_BUNDLE_AUTH_RECOVERY_FAILED_MESSAGE`. It also checks one backend request.

**Call relations**: Covers the no-recovery-available branch in `handle_unauthorized` and documents the sanitized user-facing error contract.

*Call graph*: calls 5 internal fn (new, chatgpt_auth_json_with_mode, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_does_not_use_cache_when_auth_identity_is_incomplete`  (lines 857–897)

```
async fn get_bundle_does_not_use_cache_when_auth_identity_is_incomplete()
```

**Purpose**: Verifies that startup does not trust an existing cache entry when current auth lacks a complete identity tuple.

**Data flow**: Primes the cache under a complete identity, then creates a second service over the same home with auth missing `chatgpt_user_id` and a sequence client returning a replacement bundle. It awaits startup load and asserts the replacement bundle is fetched and request count is one.

**Call relations**: Exercises the `AuthIdentityIncomplete` cache-load path and confirms the service falls back to remote fetch rather than using an ambiguously scoped cache.

*Call graph*: calls 6 internal fn (new, new, new, auth_manager_with_plan, auth_manager_with_plan_and_identity, test_bundle); 5 external calls (new, assert_eq!, default, tempdir, vec!).


##### `get_bundle_stops_after_max_retries`  (lines 900–928)

```
async fn get_bundle_stops_after_max_retries()
```

**Purpose**: Checks that repeated retryable failures stop after the configured maximum attempts and surface a request-failed load error.

**Data flow**: Creates a sequence client containing `CLOUD_CONFIG_BUNDLE_MAX_ATTEMPTS` identical retryable errors, spawns startup load, advances paused time enough for all retries, awaits the task, and asserts the error message equals `CLOUD_CONFIG_BUNDLE_LOAD_FAILED_MESSAGE`, the code is `RequestFailed`, and request count equals the max attempts.

**Call relations**: Exercises the retry exhaustion path and final error emission in `fetch_remote_bundle_and_update_cache_with_retries`.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 8 external calls (new, from_secs, assert_eq!, tempdir, spawn, yield_now, advance, vec!).


##### `refresh_from_remote_updates_cached_bundle`  (lines 931–963)

```
async fn refresh_from_remote_updates_cached_bundle()
```

**Purpose**: Verifies that the background refresh logic can replace the cached bundle with newer remote content after startup.

**Data flow**: Creates a sequence client returning `test_bundle()` for startup and a different replacement bundle for refresh, runs startup load, then awaits `service.refresh_cache_once()` and asserts it returns `true`. It then loads the cache and checks the stored bundle equals the replacement bundle.

**Call relations**: Exercises the refresh path’s reuse of remote fetch and cache write logic, showing that refresh updates persisted state for future startups.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, create_test_cache); 6 external calls (new, assert!, assert_eq!, default, tempdir, vec!).


##### `bundle_response_conversion_preserves_fragment_order`  (lines 966–1019)

```
fn bundle_response_conversion_preserves_fragment_order()
```

**Purpose**: Checks that backend response conversion keeps fragment ordering intact and maps fields exactly.

**Data flow**: Constructs a `ConfigBundleResponse` with two config fragments and one requirements fragment in a specific order, calls `bundle_from_response(response)`, and asserts the resulting `CloudConfigBundle` contains fragments in the same order with matching IDs, names, and contents.

**Call relations**: Documents the behavior of the backend conversion helper independently of service orchestration.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `bundle_response_conversion_treats_missing_sections_as_empty`  (lines 1022–1027)

```
fn bundle_response_conversion_treats_missing_sections_as_empty()
```

**Purpose**: Verifies that an entirely empty backend response converts to `CloudConfigBundle::default()` rather than erroring.

**Data flow**: Calls `bundle_from_response(ConfigBundleResponse::new())` and asserts equality with `CloudConfigBundle::default()`.

**Call relations**: Covers the defensive flatten/default behavior in the backend response conversion helper.

*Call graph*: 1 external calls (assert_eq!).


### `cloud-tasks/tests/env_filter.rs`

`test` · `test run`

This test file contains a single async Tokio test that exercises `CloudBackend::list_tasks` against `codex_cloud_tasks_mock_client::MockClient`. It checks three cases: no environment filter, `env-A`, and `env-B`. For the unfiltered root listing, it asserts that at least one returned task title contains `Update README`, proving the global dataset is present. For `env-A`, it expects exactly one task and requires its title to be `A: First`. For `env-B`, it expects exactly two tasks and requires the first title to start with `B: `.

The test is intentionally concrete rather than structural: it validates both filtering behavior and the mock fixture contents that downstream UI/tests rely on. Because it uses the trait-style `CloudBackend::list_tasks` API directly, it also confirms that the mock client conforms to the same backend interface as production implementations. Any change to mock environment partitioning, ordering, or seeded titles will surface here immediately.

#### Function details

##### `mock_backend_varies_by_env`  (lines 5–39)

```
async fn mock_backend_varies_by_env()
```

**Purpose**: Exercises the mock backend’s environment filter and asserts that each environment exposes the expected seeded tasks. It confirms both filtering and fixture shape.

**Data flow**: Creates a `MockClient`, asynchronously calls `CloudBackend::list_tasks` three times with `None`, `Some("env-A")`, and `Some("env-B")`, unwraps each result, and inspects the returned `.tasks` vectors. It writes no external state; its outputs are assertions on task presence, lengths, and titles.

**Call relations**: Run by the test harness under Tokio. It directly invokes the backend listing API and does not delegate to any local helper functions.

*Call graph*: 3 external calls (assert!, assert_eq!, list_tasks).


### `codex-home/src/instructions/tests.rs`

`test` · `test execution`

This test file builds temporary home directories and populates them with combinations of the default and local AGENTS.md filenames to validate `CodexHomeUserInstructionsProvider`. Two small helpers keep assertions precise: `provider` constructs the provider rooted at a temp directory converted into an `AbsolutePathBuf`, and `expected` builds the exact `LoadedUserInstructions` structure expected from successful reads, including the resolved absolute source path and any warnings.

The tests focus on the provider’s selection logic rather than generic I/O. They confirm that missing files yield the default empty result; a local override wins over the default file; an override containing only whitespace is treated as empty so the provider falls back to the default after trimming surrounding whitespace; and a directory at the override path is ignored in favor of the default. A platform-specific `create_symlink_loop` helper creates an unreadable self-referential path so the provider can be checked for recoverable read failures: it must emit a warning string naming the failing path and still return default instructions. The final test writes invalid UTF-8 bytes and asserts that decoding is lossy, replacing the bad byte with U+FFFD instead of failing. Together these tests document the provider’s invariants: prefer override when meaningful, trim textual content, degrade gracefully on recoverable override errors, and never crash on malformed bytes.

#### Function details

##### `provider`  (lines 15–19)

```
fn provider(home: &TempDir) -> CodexHomeUserInstructionsProvider
```

**Purpose**: Constructs a `CodexHomeUserInstructionsProvider` rooted at a temporary directory used by the tests. It centralizes conversion from `TempDir` to the absolute-path type expected by production code.

**Data flow**: Takes a `&TempDir`, reads its filesystem path via `home.path()`, converts that `PathBuf` into `AbsolutePathBuf` with `try_from`, and passes it into `CodexHomeUserInstructionsProvider::new`. It returns the initialized provider and does not mutate external state.

**Call relations**: This helper is used by tests that need to invoke `load_user_instructions`; the call graph records it from `invalid_utf8_is_lossy`, and the same pattern supports the rest of the file’s assertions by hiding setup boilerplate.

*Call graph*: calls 2 internal fn (new, try_from); called by 1 (invalid_utf8_is_lossy); 1 external calls (path).


##### `expected`  (lines 21–35)

```
fn expected(
    home: &TempDir,
    filename: &str,
    text: &str,
    warnings: Vec<String>,
) -> LoadedUserInstructions
```

**Purpose**: Builds the exact `LoadedUserInstructions` value expected from a successful provider read. It packages instruction text, absolute source path, and warning strings into the API type used in assertions.

**Data flow**: Consumes a temp home directory reference, a filename, instruction text, and a warning vector. It joins the filename onto the temp directory path, converts that joined path into `AbsolutePathBuf`, wraps the text and source in `UserInstructions`, places it in `LoadedUserInstructions.instructions`, and returns the assembled struct.

**Call relations**: This helper is only used inside the test module’s assertions to compare provider output against a concrete expected structure, especially in precedence, fallback, warning, and invalid-UTF8 scenarios.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (path).


##### `create_symlink_loop`  (lines 47–53)

```
fn create_symlink_loop(path: &Path)
```

**Purpose**: Creates a self-referential symlink at the given path so reads fail with a recoverable filesystem error. The implementation is platform-specific for Unix and Windows.

**Data flow**: Accepts a `&Path`, extracts its own file name, and creates a symlink at `path` pointing to that same file name using the OS-specific symlink API. It returns unit and writes a filesystem entry that intentionally cannot be read normally.

**Call relations**: It is invoked only by `recoverable_override_read_error_warns_and_falls_back_to_default` to force the provider down its warning-and-fallback path without depending on permissions or other environment-specific failures.

*Call graph*: called by 1 (recoverable_override_read_error_warns_and_falls_back_to_default); 3 external calls (file_name, symlink, symlink_file).


##### `missing_files_return_no_instructions`  (lines 56–63)

```
async fn missing_files_return_no_instructions()
```

**Purpose**: Verifies that an empty home directory produces no loaded instructions and no warnings. This is the baseline behavior when neither default nor override files exist.

**Data flow**: Creates a fresh `TempDir`, constructs a provider for it, awaits `load_user_instructions`, and compares the result to `LoadedUserInstructions::default()`. It writes no files and only reads provider output.

**Call relations**: This async test is a top-level assertion of the provider’s no-input behavior; nothing delegates from it, and it directly exercises the provider’s missing-file branch.

*Call graph*: 2 external calls (new, assert_eq!).


##### `override_takes_precedence_over_default`  (lines 66–75)

```
async fn override_takes_precedence_over_default()
```

**Purpose**: Checks that the local override file is chosen when both override and default instruction files are present. The returned source path must point at the override file.

**Data flow**: Creates a temp directory, writes `DEFAULT_AGENTS_MD_FILENAME` with `default` and `LOCAL_AGENTS_MD_FILENAME` with `override`, then awaits provider loading and compares the result to an `expected` value naming the local file and text `override` with no warnings.

**Call relations**: This test drives the provider through the precedence branch where both files exist, proving that override selection happens before considering the default.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `empty_override_falls_back_to_trimmed_default`  (lines 78–96)

```
async fn empty_override_falls_back_to_trimmed_default()
```

**Purpose**: Verifies that an override containing only whitespace is treated as empty and does not suppress a usable default file. It also confirms that default text is trimmed before being returned.

**Data flow**: Writes whitespace-only content to the local override path and a newline-padded string to the default path, then loads instructions and asserts that the result points to the default file with text normalized to `default instructions` and no warnings.

**Call relations**: This test covers two subtle behaviors in one flow: override emptiness detection and trimming of retained instruction text after fallback.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `directory_override_falls_back_to_default`  (lines 99–108)

```
async fn directory_override_falls_back_to_default()
```

**Purpose**: Ensures that if the override path exists as a directory rather than a readable file, the provider ignores it and uses the default file instead. This prevents a malformed override path from blocking valid defaults.

**Data flow**: Creates a directory at the local override filename, writes `default` to the default file, loads instructions, and asserts that the returned `LoadedUserInstructions` references the default file with no warnings.

**Call relations**: This test exercises the provider’s special-case handling for non-file override paths, demonstrating that such a path is not treated as a fatal error.

*Call graph*: 4 external calls (new, assert_eq!, create_dir, write).


##### `recoverable_override_read_error_warns_and_falls_back_to_default`  (lines 111–126)

```
async fn recoverable_override_read_error_warns_and_falls_back_to_default()
```

**Purpose**: Checks that a recoverable read failure on the override file emits a warning and still falls back to the default instructions. The warning text must include the failing path and the underlying read error.

**Data flow**: Creates a temp directory, builds a symlink loop at the override path, writes `default` to the default file, independently reads the override path to capture the expected OS error text, formats the warning string, then loads instructions and asserts that the provider returns default instructions plus that warning.

**Call relations**: This test depends on `create_symlink_loop` to manufacture the failure condition and validates the provider’s non-fatal error path where override read errors do not prevent default loading.

*Call graph*: calls 1 internal fn (create_symlink_loop); 5 external calls (new, assert_eq!, format!, read, write).


##### `invalid_utf8_is_lossy`  (lines 129–147)

```
async fn invalid_utf8_is_lossy()
```

**Purpose**: Verifies that instruction files containing invalid UTF-8 bytes are decoded lossily rather than rejected. The replacement character should appear in the returned text.

**Data flow**: Creates a temp directory, writes a byte vector containing `global`, an invalid `0xff` byte, and ` doc` to the default file, then loads instructions through `provider` and asserts that the resulting text is `global� doc` with the default file as source and no warnings.

**Call relations**: This test invokes `provider` and drives the provider through its byte-to-string decoding path, documenting that malformed bytes are tolerated and normalized for downstream consumers.

*Call graph*: calls 1 internal fn (provider); 3 external calls (new, assert_eq!, write).


### Permissions, sandbox, and network policy
These tests define how permission profiles, proxy and network rules, sandbox transforms, Windows sandbox behavior, and execution environments are interpreted and enforced.

### `core/src/config/permissions_tests.rs`

`test` · `test-only`

This test module exercises the permission-domain helpers in `permissions.rs` and one targeted integration path through `Config::load_from_base_config_with_overrides`. Several tests focus on path parsing and glob handling: Windows verbatim device prefixes should normalize cleanly and not be mistaken for glob syntax; trailing `/**` should compile as subtree access for read/write permissions; broader read/write globs should still be rejected; and deny-read `**` warnings should disappear when `glob_scan_max_depth` is configured.

Another cluster of tests covers permission-profile inheritance and network translation. They verify that `PermissionsToml::resolve_profile` merges parent filesystem/network settings before child overrides, rejects undefined parents, rejects unsupported built-in parents like `:danger-full-access`, and detects inheritance cycles. Network-specific tests confirm that legacy list keys are ignored by `NetworkToml`, allowed and denied domain containers project correctly, unix-socket permissions overlay by path, and profile-derived `NetworkProxyConfig` always keeps the managed proxy disabled even when network access or proxy policy is configured.

The integration-style `restricted_read_implicitly_allows_helper_executables` test is especially important: it loads a config with a custom workspace profile and runtime helper executable paths, then asserts that the resulting filesystem sandbox policy automatically grants read access to the active bundled zsh path and the current session’s execve-wrapper directory under `~/.codex/tmp/arg0`, but not sibling session directories. This captures the runtime invariant enforced by `get_readable_roots_required_for_codex_runtime`.

#### Function details

##### `normalize_absolute_path_for_platform_simplifies_windows_verbatim_paths`  (lines 26–32)

```
fn normalize_absolute_path_for_platform_simplifies_windows_verbatim_paths()
```

**Purpose**: Verifies that Windows verbatim drive paths are normalized into ordinary drive paths.

**Data flow**: It calls `normalize_absolute_path_for_platform` with a `\\?\D:\...` path and asserts that the result equals a normal `PathBuf` with the verbatim prefix removed.

**Call relations**: This test targets the Windows path-normalization helper directly.

*Call graph*: 1 external calls (assert_eq!).


##### `windows_verbatim_path_prefix_does_not_count_as_glob_syntax`  (lines 35–44)

```
fn windows_verbatim_path_prefix_does_not_count_as_glob_syntax()
```

**Purpose**: Checks that Windows verbatim path prefixes are not misinterpreted as glob syntax, while real glob characters still are.

**Data flow**: It calls `contains_glob_chars_for_platform` on a plain verbatim path and on a verbatim path containing `**/*.env`, asserting false for the former and true for the latter.

**Call relations**: This test documents the interaction between Windows path normalization and glob detection.

*Call graph*: 1 external calls (assert!).


##### `restricted_read_implicitly_allows_helper_executables`  (lines 47–112)

```
async fn restricted_read_implicitly_allows_helper_executables() -> std::io::Result<()>
```

**Purpose**: Verifies that restricted filesystem permissions still grant read access to required helper executables and only the active session’s arg0 wrapper directory.

**Data flow**: It creates a temporary workspace and `.codex` tree, writes dummy zsh and execve-wrapper files, loads a config from a custom `ConfigToml` and `ConfigOverrides` pointing at those paths, extracts the resulting filesystem sandbox policy, and asserts readable access for the zsh path and active arg0 directory but not a sibling arg0 directory.

**Call relations**: This integration test exercises `Config::load_from_base_config_with_overrides` plus the helper-readable-root augmentation performed during config loading.

*Call graph*: calls 2 internal fn (from_absolute_path, try_from); 8 external calls (from, new, default, new, load_from_base_config_with_overrides, assert!, create_dir_all, write).


##### `network_toml_ignores_legacy_network_list_keys`  (lines 115–124)

```
fn network_toml_ignores_legacy_network_list_keys()
```

**Purpose**: Ensures that deprecated list-style network keys are ignored when deserializing `NetworkToml`.

**Data flow**: It deserializes a TOML snippet containing `allowed_domains = [...]` into `NetworkToml` and asserts that the result equals `NetworkToml::default()`.

**Call relations**: This test documents backward-compatibility behavior in the TOML type rather than the compiler logic.

*Call graph*: 1 external calls (assert_eq!).


##### `network_permission_containers_project_allowed_and_denied_entries`  (lines 127–182)

```
fn network_permission_containers_project_allowed_and_denied_entries()
```

**Purpose**: Checks that domain and unix-socket permission containers split allow and deny entries correctly.

**Data flow**: It constructs `NetworkDomainPermissionsToml` and `NetworkUnixSocketPermissionsToml` maps with mixed allow/deny entries, then asserts the outputs of `allowed_domains()`, `denied_domains()`, and `allow_unix_sockets()`.

**Call relations**: This test validates the lower-level TOML container helpers used by network proxy config translation.

*Call graph*: 2 external calls (from, assert_eq!).


##### `network_toml_overlays_unix_socket_permissions_by_path`  (lines 185–241)

```
fn network_toml_overlays_unix_socket_permissions_by_path()
```

**Purpose**: Verifies that applying multiple `NetworkToml` overlays updates unix-socket permissions by path rather than replacing the whole set blindly.

**Data flow**: It starts from `NetworkProxyConfig::default()`, applies one `NetworkToml` with two allowed sockets, applies a second with one extra allow and one deny override, and asserts that the final proxy config contains the merged per-path permission map.

**Call relations**: This test documents the overlay semantics used when feature-level and profile-level network config are combined.

*Call graph*: 4 external calls (from, default, assert_eq!, default).


##### `permissions_profiles_resolve_extends_parent_first_with_child_overrides`  (lines 244–330)

```
fn permissions_profiles_resolve_extends_parent_first_with_child_overrides()
```

**Purpose**: Checks that permission-profile inheritance merges parent settings first and then applies child overrides for filesystem, network, and metadata.

**Data flow**: It deserializes a TOML permissions catalog with `base` and `child` profiles, resolves `child`, deserializes an expected merged `PermissionProfileToml`, and asserts equality.

**Call relations**: This test targets the profile-resolution behavior consumed by `resolve_permission_profile`.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_undefined_extends_parent`  (lines 333–350)

```
fn permissions_profiles_reject_undefined_extends_parent()
```

**Purpose**: Verifies that extending a nonexistent parent profile is rejected.

**Data flow**: It deserializes a permissions catalog where `child` extends `base`, attempts to resolve `child`, captures the error, and asserts on the exact error string.

**Call relations**: This test documents one failure mode of profile inheritance resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_unsupported_builtin_extends_parent`  (lines 353–370)

```
fn permissions_profiles_reject_unsupported_builtin_extends_parent()
```

**Purpose**: Verifies that profiles cannot extend unsupported built-in parents such as `:danger-full-access`.

**Data flow**: It deserializes a permissions catalog where `child` extends `:danger-full-access`, attempts resolution, and asserts on the resulting error message.

**Call relations**: This test covers the boundary of `extensible_builtin_parent_profile` support.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_extends_cycles`  (lines 373–393)

```
fn permissions_profiles_reject_extends_cycles()
```

**Purpose**: Checks that cyclic permission-profile inheritance is detected and rejected.

**Data flow**: It deserializes a two-profile cycle (`alpha -> beta -> alpha`), attempts to resolve `alpha`, and asserts that the error message names the cycle.

**Call relations**: This test documents cycle detection in the underlying TOML profile resolver.

*Call graph*: 1 external calls (assert_eq!).


##### `profile_network_proxy_config_keeps_proxy_disabled_for_bare_network_access`  (lines 396–403)

```
fn profile_network_proxy_config_keeps_proxy_disabled_for_bare_network_access()
```

**Purpose**: Ensures that profile network access alone does not enable the managed proxy.

**Data flow**: It builds a `NetworkToml` with `enabled = true`, converts it through `network_proxy_config_from_profile_network`, and asserts that `config.network.enabled` is false.

**Call relations**: This test captures the intentional separation between profile network policy and managed proxy startup.

*Call graph*: 2 external calls (default, assert!).


##### `profile_network_proxy_config_keeps_proxy_disabled_for_proxy_policy`  (lines 406–432)

```
fn profile_network_proxy_config_keeps_proxy_disabled_for_proxy_policy()
```

**Purpose**: Ensures that even profile-specified proxy URL and domain policy do not directly enable the managed proxy.

**Data flow**: It builds a richer `NetworkToml` with `enabled`, `proxy_url`, `enable_socks5`, and allowed domains, converts it through `network_proxy_config_from_profile_network`, and asserts that the proxy remains disabled while the other proxy-policy fields are preserved.

**Call relations**: This complements the previous test for the more detailed profile-network case.

*Call graph*: 4 external calls (from, default, assert!, assert_eq!).


##### `compile_permission_profile_workspace_roots_resolves_enabled_entries`  (lines 435–467)

```
fn compile_permission_profile_workspace_roots_resolves_enabled_entries() -> std::io::Result<()>
```

**Purpose**: Verifies that only enabled workspace-root entries are resolved and returned as absolute paths.

**Data flow**: It creates a temporary cwd, constructs a `PermissionsToml` with one enabled and one disabled workspace root, calls `compile_permission_profile_workspace_roots`, and asserts that only the enabled root resolved against cwd is returned.

**Call relations**: This test targets the workspace-root extraction path used during config loading.

*Call graph*: 3 external calls (from, new, assert_eq!).


##### `read_write_glob_warnings_skip_supported_deny_read_globs_and_trailing_subpaths`  (lines 470–501)

```
fn read_write_glob_warnings_skip_supported_deny_read_globs_and_trailing_subpaths()
```

**Purpose**: Checks that unsupported-glob warnings are emitted only for truly unsupported read/write glob patterns, not deny globs or trailing-subtree syntax.

**Data flow**: It constructs a `FilesystemPermissionsToml` with mixed top-level and scoped entries, calls `unsupported_read_write_glob_paths`, and asserts that only the broad read/write glob patterns are reported.

**Call relations**: This test documents the warning logic used by `compile_permission_profile` on non-macOS platforms.

*Call graph*: 4 external calls (from, assert_eq!, Access, Scoped).


##### `unreadable_globstar_warning_is_suppressed_when_scan_depth_is_configured`  (lines 504–529)

```
fn unreadable_globstar_warning_is_suppressed_when_scan_depth_is_configured()
```

**Purpose**: Verifies that deny-read `**` warnings disappear once `glob_scan_max_depth` is configured.

**Data flow**: It builds a filesystem config with deny globstars under `:workspace_roots`, asserts that `unbounded_unreadable_globstar_paths` reports the pattern when no depth is set, then clones the config with `glob_scan_max_depth = Some(2)` and asserts that the warning list becomes empty.

**Call relations**: This test captures the intended interaction between deny-glob warnings and explicit scan-depth configuration.

*Call graph*: 3 external calls (from, assert_eq!, Scoped).


##### `glob_scan_max_depth_must_be_positive`  (lines 532–542)

```
fn glob_scan_max_depth_must_be_positive()
```

**Purpose**: Checks that zero `glob_scan_max_depth` is rejected while positive values are accepted.

**Data flow**: It calls `validate_glob_scan_max_depth(Some(0))`, asserts the error kind and message, then calls the same helper with `Some(2)` and asserts the successful return value.

**Call relations**: This test targets the explicit validation helper used during profile compilation.

*Call graph*: 1 external calls (assert_eq!).


##### `read_write_trailing_glob_suffix_compiles_as_subpath`  (lines 545–586)

```
fn read_write_trailing_glob_suffix_compiles_as_subpath() -> std::io::Result<()>
```

**Purpose**: Verifies that a read/write scoped path ending in `/**` compiles as subtree access rather than as a glob pattern.

**Data flow**: It creates a temporary cwd and warning vector, compiles a profile whose `:workspace_roots` scoped entry is `docs/** = "read"`, and asserts that the resulting filesystem policy contains a `FileSystemPath::Special { project_roots(Some("docs")) }` read entry.

**Call relations**: This test exercises the `compile_read_write_glob_path` normalization path through full profile compilation.

*Call graph*: 5 external calls (from, new, new, assert_eq!, Scoped).


##### `read_write_glob_patterns_still_reject_non_subpath_globs`  (lines 589–599)

```
fn read_write_glob_patterns_still_reject_non_subpath_globs()
```

**Purpose**: Checks that broader read/write glob patterns like `src/**/*.rs` are still rejected.

**Data flow**: It calls `compile_read_write_glob_path("src/**/*.rs", Read)`, captures the error, and asserts the error kind and that the message mentions unsupported read/write glob access.

**Call relations**: This test documents the hard rejection path for unsupported read/write glob syntax.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `core/src/config/network_proxy_spec_tests.rs`

`test` · `test-only`

This test module focuses narrowly on `NetworkProxySpec::from_config_and_constraints` and `build_state_with_audit_metadata`. It constructs small `NetworkProxyConfig` and `NetworkConstraints` values, then asserts on the resulting effective config and derived `NetworkProxyConstraints`. The helper `domain_permissions` builds `NetworkDomainPermissionsToml` from concise tuples so each test can describe allow/deny patterns inline.

The tests cover several subtle invariants. In ordinary managed/default modes (`PermissionProfile::workspace_write()` or `read_only()`), managed allowed and denied domains act as baselines: they appear in `constraints`, are merged into the effective config, and user-added entries remain mutable because expansion flags are `Some(true)`. Separate tests verify that a user deny can still override a managed allow for the same pattern, and vice versa, because the managed baseline should not erase user intent.

For unrestricted/full-access mode (`PermissionProfile::Disabled`), the semantics change: managed allowlists and denylists become fixed baselines rather than expandable ones, so user additions do not become part of the effective managed set. The `managed_allowed_domains_only` flag tightens this further by treating the managed allowlist as authoritative and setting `hard_deny_allowlist_misses`, including the edge case where no managed allowlist exists and the effective allowed-domain constraint becomes an empty vector. One test also verifies that audit metadata passed into `build_state_with_audit_metadata` is preserved in the resulting proxy state.

#### Function details

##### `domain_permissions`  (lines 10–19)

```
fn domain_permissions(
    entries: impl IntoIterator<Item = (&'static str, NetworkDomainPermissionToml)>,
) -> NetworkDomainPermissionsToml
```

**Purpose**: Builds a `NetworkDomainPermissionsToml` from a compact iterator of `(pattern, permission)` pairs for use in tests.

**Data flow**: It consumes any iterable of static string and `NetworkDomainPermissionToml` pairs, converts each pattern to `String`, collects them into the `entries` map, and returns the resulting `NetworkDomainPermissionsToml`.

**Call relations**: Most tests in this file call it to create concise managed domain requirement fixtures.

*Call graph*: called by 11 (allow_only_requirements_do_not_create_deny_constraints_in_full_access, danger_full_access_keeps_managed_allowlist_and_denylist_fixed, deny_only_requirements_do_not_create_allow_constraints_in_full_access, managed_allowed_domains_only_disables_default_mode_allowlist_expansion, managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses, managed_unrestricted_profile_allows_domain_expansion, requirements_allowed_domains_are_a_baseline_for_user_allowlist, requirements_allowed_domains_do_not_override_user_denies_for_same_pattern, requirements_allowlist_expansion_keeps_user_entries_mutable, requirements_denied_domains_are_a_baseline_for_default_mode (+1 more)); 1 external calls (into_iter).


##### `build_state_with_audit_metadata_threads_metadata_to_state`  (lines 22–41)

```
fn build_state_with_audit_metadata_threads_metadata_to_state()
```

**Purpose**: Verifies that audit metadata supplied to the spec is preserved in the built `NetworkProxyState`.

**Data flow**: It constructs a minimal `NetworkProxySpec` with default config and constraints, creates a `NetworkProxyAuditMetadata` with several populated fields, calls `build_state_with_audit_metadata`, and asserts that `state.audit_metadata()` equals the original metadata.

**Call relations**: This test directly exercises the state-building path rather than the higher-level proxy startup flow.

*Call graph*: 4 external calls (assert_eq!, default, default, default).


##### `requirements_allowed_domains_are_a_baseline_for_user_allowlist`  (lines 44–76)

```
fn requirements_allowed_domains_are_a_baseline_for_user_allowlist()
```

**Purpose**: Checks that managed allowed domains are prepended as a baseline while preserving user allowlist entries in default mode.

**Data flow**: It creates a config with `api.example.com` allowed, requirements allowing `*.example.com`, builds a spec for `PermissionProfile::read_only()`, and asserts that the effective allowed domains contain both entries while constraints record only the managed pattern and allowlist expansion is enabled.

**Call relations**: This test documents the normal merge behavior implemented by `apply_requirements`.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, read_only); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_allowed_domains_do_not_override_user_denies_for_same_pattern`  (lines 79–108)

```
fn requirements_allowed_domains_do_not_override_user_denies_for_same_pattern()
```

**Purpose**: Verifies that a managed allow entry does not erase a user deny for the same domain pattern.

**Data flow**: It creates a config denying `api.example.com`, requirements allowing that same host, builds a spec for `workspace_write`, and asserts that the effective allowlist remains `None`, the denylist still contains the host, and constraints still record the managed allow.

**Call relations**: This test captures the intended precedence interaction between managed allow baselines and user deny entries.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_allowlist_expansion_keeps_user_entries_mutable`  (lines 111–148)

```
fn requirements_allowlist_expansion_keeps_user_entries_mutable()
```

**Purpose**: Shows that user-added allowlist entries remain mutable under managed baseline mode.

**Data flow**: It builds a spec with managed `*.example.com` plus user `api.example.com`, clones the effective config, flips `api.example.com` to `Deny` via `upsert_domain_permission`, and asserts that the managed allow remains while the user entry moves to the denylist and still validates against the original constraints.

**Call relations**: This test demonstrates why `constraints.allowed_domains` stores only the managed baseline, not merged user entries.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_unrestricted_profile_allows_domain_expansion`  (lines 151–183)

```
fn managed_unrestricted_profile_allows_domain_expansion()
```

**Purpose**: Confirms that a `PermissionProfile::Managed` with unrestricted filesystem still counts as managed for network allowlist expansion.

**Data flow**: It creates a managed permission profile with unrestricted filesystem and restricted network, builds a spec from managed allow requirements plus a user allow entry, and asserts that both domains appear and allowlist expansion remains enabled.

**Call relations**: This test targets the `managed_sandbox_active` predicate rather than filesystem restrictions.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `danger_full_access_keeps_managed_allowlist_and_denylist_fixed`  (lines 186–219)

```
fn danger_full_access_keeps_managed_allowlist_and_denylist_fixed()
```

**Purpose**: Verifies that full-access mode pins both managed allowlist and denylist baselines instead of merging user entries.

**Data flow**: It creates a config with user allow and deny entries, requirements with managed allow and deny entries, builds a spec for `PermissionProfile::Disabled`, and asserts that only the managed entries remain effective and both expansion flags are `Some(false)`.

**Call relations**: This test documents the non-managed/full-access branch of requirement application.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_disables_default_mode_allowlist_expansion`  (lines 222–248)

```
fn managed_allowed_domains_only_disables_default_mode_allowlist_expansion()
```

**Purpose**: Checks that `managed_allowed_domains_only` disables allowlist expansion even in default managed mode.

**Data flow**: It creates a config with a user allow entry, requirements with a managed allow entry and `managed_allowed_domains_only = true`, builds a spec for `workspace_write`, and asserts that only the managed allow remains and allowlist expansion is disabled.

**Call relations**: This test covers the stricter allowlist mode that suppresses user extension of the managed baseline.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses`  (lines 251–282)

```
fn managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses()
```

**Purpose**: Verifies that managed-only allowlist mode both ignores user allowlist entries and marks allowlist misses for hard denial.

**Data flow**: It builds a spec from a user allow entry plus managed-only requirements allowing `managed.example.com`, then asserts that the effective allowlist and constraints contain only the managed domain, expansion is disabled, and `hard_deny_allowlist_misses` is true.

**Call relations**: This test exercises the constructor’s `managed_allowed_domains_only` detection and its downstream effects.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains`  (lines 285–306)

```
fn managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains()
```

**Purpose**: Checks the edge case where managed-only mode is enabled but no managed allowlist is provided.

**Data flow**: It creates a config with a user allow entry, requirements with only `managed_allowed_domains_only = true`, builds a spec for `workspace_write`, and asserts that the effective allowlist is `None`, constraints contain `Some(Vec::new())`, expansion is disabled, and hard-deny mode is active.

**Call relations**: This test documents that missing managed allowlists are treated as an empty authoritative allowlist in managed-only mode.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list`  (lines 309–330)

```
fn managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list()
```

**Purpose**: Verifies the same empty-managed-allowlist behavior under full-access permissions.

**Data flow**: It repeats the previous setup but uses `PermissionProfile::Disabled`, then asserts the same empty-allowlist constraint and hard-deny behavior.

**Call relations**: This confirms that managed-only empty-allowlist semantics apply regardless of managed/default vs full-access permission mode.

*Call graph*: calls 1 internal fn (from_config_and_constraints); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `deny_only_requirements_do_not_create_allow_constraints_in_full_access`  (lines 333–363)

```
fn deny_only_requirements_do_not_create_allow_constraints_in_full_access()
```

**Purpose**: Ensures that deny-only managed requirements do not accidentally constrain the allowlist in full-access mode.

**Data flow**: It creates a config with a user allow entry, requirements with only a managed deny entry, builds a spec for `PermissionProfile::Disabled`, and asserts that the user allowlist remains effective, `constraints.allowed_domains` is `None`, and the managed deny appears in the effective denylist.

**Call relations**: This test guards against over-constraining unrelated parts of the policy when only deny requirements are present.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `allow_only_requirements_do_not_create_deny_constraints_in_full_access`  (lines 366–396)

```
fn allow_only_requirements_do_not_create_deny_constraints_in_full_access()
```

**Purpose**: Ensures that allow-only managed requirements do not accidentally constrain the denylist in full-access mode.

**Data flow**: It creates a config with a user deny entry, requirements with only a managed allow entry, builds a spec for `PermissionProfile::Disabled`, and asserts that the managed allow becomes effective, the user deny remains effective, and deny-related constraints stay `None`.

**Call relations**: This complements the previous test for the opposite half of domain-policy constraints.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_denied_domains_are_a_baseline_for_default_mode`  (lines 399–431)

```
fn requirements_denied_domains_are_a_baseline_for_default_mode()
```

**Purpose**: Checks that managed denied domains act as a baseline merged with user deny entries in default mode.

**Data flow**: It creates a config denying `blocked.example.com`, requirements denying `managed-blocked.example.com`, builds a spec for `workspace_write`, and asserts that both denies appear in the effective config while constraints record only the managed deny and denylist expansion is enabled.

**Call relations**: This test documents the denylist analogue of the managed allowlist baseline behavior.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_denylist_expansion_keeps_user_entries_mutable`  (lines 434–471)

```
fn requirements_denylist_expansion_keeps_user_entries_mutable()
```

**Purpose**: Shows that user-added denylist entries remain mutable under managed denylist baseline mode.

**Data flow**: It builds a spec with managed and user deny entries, clones the effective config, flips the user deny to `Allow`, and asserts that the managed deny remains while the user entry moves to the allowlist and still validates against the original constraints.

**Call relations**: This test demonstrates why deny constraints track only managed entries when expansion is enabled.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


### `core/src/network_proxy_loader_tests.rs`

`test` · `unit tests for network proxy config loading and constraint derivation`

This file is the detailed regression suite for `network_proxy_loader.rs`. It uses inline TOML snippets and synthetic `ConfigLayerStack` values to verify how permission-profile network settings are selected, inherited, normalized, and merged across layers. Several tests exercise the test-only `apply_network_tables` helper and `NetworkConfigAccumulator` directly so they can inspect incremental overlay behavior without going through the full loader.

The suite covers domain overlay semantics in two dimensions: higher-precedence layers should add new domain entries while overriding matching lower-precedence entries, and host normalization should collapse case differences before precedence is applied. It also verifies that named MITM actions are overridden by higher-precedence definitions while hooks continue to reference the updated action body. Profile-selection tests confirm that built-in profiles like `:workspace` do not require a `[permissions]` table, unknown built-ins are rejected, custom profiles can inherit from built-ins or other profiles, and only the final selected profile contributes network settings across merged layers. The same “final selected profile only” rule is tested for trusted constraints derived from system/managed layers. Additional tests confirm that `apply_network_constraints` carries flags such as `dangerously_allow_all_unix_sockets`, skips empty allow/deny sides, and overlays domain entries correctly. Finally, exec-policy overlay tests ensure compiled allow/deny rules are merged into the runtime network lists with overwrite semantics.

#### Function details

##### `higher_precedence_profile_network_overlays_domain_entries`  (lines 17–65)

```
fn higher_precedence_profile_network_overlays_domain_entries()
```

**Purpose**: Verifies that applying a higher-precedence network profile adds new domain entries without removing unrelated lower-precedence entries.

**Data flow**: Parses lower and higher TOML configs selecting the same profile with different domain entries, applies each in order to a default `NetworkProxyConfig` via `apply_network_tables`, and asserts the final allowed domains contain both hosts while denied domains retain the lower-layer deny entry.

**Call relations**: Tests incremental overlay behavior of profile network tables using the test-only helper.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `higher_precedence_profile_network_overrides_matching_domain_entries`  (lines 68–113)

```
fn higher_precedence_profile_network_overrides_matching_domain_entries()
```

**Purpose**: Checks that a higher-precedence domain permission replaces a lower-precedence permission for the same normalized host.

**Data flow**: Parses lower and higher TOML configs where `shared.example.com` changes from deny to allow, applies both to a default config, and asserts the final allowed domains contain `other.example.com` and `shared.example.com` while denied domains are cleared.

**Call relations**: Covers overwrite semantics for matching domain entries during incremental application.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `higher_precedence_profile_network_overrides_named_mitm_actions`  (lines 116–183)

```
fn higher_precedence_profile_network_overrides_named_mitm_actions()
```

**Purpose**: Verifies that higher-precedence MITM action definitions override lower-precedence actions referenced by existing hooks.

**Data flow**: Parses lower and higher TOML configs for the same profile, where the lower layer defines a MITM hook and action `strip_auth` and the higher layer redefines that action. It applies both through `NetworkConfigAccumulator`, finalizes the config, and asserts mode, MITM enablement, allowed domains, hook count, hook matcher fields, and that the hook’s runtime action uses the higher-layer `strip_request_headers` value.

**Call relations**: Exercises the accumulator’s separate hook/action merging and finalization logic.

*Call graph*: 4 external calls (assert!, assert_eq!, default, from_str).


##### `execpolicy_network_rules_overlay_network_lists`  (lines 186–226)

```
fn execpolicy_network_rules_overlay_network_lists()
```

**Purpose**: Checks that exec-policy allow/deny rules are overlaid onto existing config-derived allowed and denied domain lists.

**Data flow**: Starts with a default `NetworkProxyConfig` seeded with one allowed and one denied domain, builds an empty `Policy`, adds an allow rule for `blocked.example.com` and a deny rule for `api.example.com`, applies `apply_exec_policy_network_rules`, and asserts the final allowed and denied domain lists reflect the overlay.

**Call relations**: Tests the post-config exec-policy overlay step used by `config_from_layers`.

*Call graph*: 4 external calls (assert_eq!, empty, default, vec!).


##### `apply_network_constraints_includes_allow_all_unix_sockets_flag`  (lines 229–249)

```
fn apply_network_constraints_includes_allow_all_unix_sockets_flag()
```

**Purpose**: Verifies that `dangerously_allow_all_unix_sockets` from a selected network profile is copied into trusted constraints.

**Data flow**: Parses a TOML config selecting a profile with `dangerously_allow_all_unix_sockets = true`, selects the network table, applies it to default `NetworkProxyConstraints` with `apply_network_constraints`, and asserts the corresponding constraint field is `Some(true)`.

**Call relations**: Covers one scalar-field branch in constraint application.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `selected_network_from_tables_ignores_builtin_profile_without_permissions_table`  (lines 252–266)

```
fn selected_network_from_tables_ignores_builtin_profile_without_permissions_table()
```

**Purpose**: Checks that selecting a built-in profile like `:workspace` returns no custom network table and does not require a `[permissions]` section.

**Data flow**: Parses TOML containing only `default_permissions = ":workspace"`, deserializes it with `network_tables_from_toml`, passes it to `selected_network_from_tables`, and asserts the result is `None`.

**Call relations**: Tests the built-in-profile fast path in profile selection.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_rejects_unknown_builtin_profile_without_permissions_table`  (lines 269–286)

```
fn selected_network_from_tables_rejects_unknown_builtin_profile_without_permissions_table()
```

**Purpose**: Verifies that unknown built-in profile names are rejected explicitly.

**Data flow**: Parses TOML with `default_permissions = ":unknown"`, deserializes it, calls `selected_network_from_tables`, captures the error, and asserts the error string names the unknown built-in profile.

**Call relations**: Covers the validation branch in built-in profile handling.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_resolves_builtin_workspace_parent`  (lines 289–325)

```
fn selected_network_from_tables_resolves_builtin_workspace_parent()
```

**Purpose**: Checks that a custom permission profile extending built-in `:workspace` resolves correctly and exposes its child network settings.

**Data flow**: Parses TOML defining profile `dev` with `extends = ":workspace"`, `enabled = true`, and one allowed domain, selects the network table, and asserts the resulting `NetworkToml` contains the expected enabled flag and domain map.

**Call relations**: Tests inheritance resolution through `resolve_permission_profile` when the parent is built-in.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_resolves_permission_profile_inheritance`  (lines 328–385)

```
fn selected_network_from_tables_resolves_permission_profile_inheritance()
```

**Purpose**: Verifies inheritance and override semantics across custom permission profiles.

**Data flow**: Parses TOML defining base and child profiles with inherited flags and domain entries, selects the final network table for `dev`, and asserts the resulting `NetworkToml` contains inherited `enabled` and `dangerously_allow_all_unix_sockets`, child `allow_local_binding`, and merged/overridden domain entries.

**Call relations**: Covers the richer profile-inheritance path in `selected_network_from_tables`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_from_layers_resolves_inherited_profiles_across_layers`  (lines 388–427)

```
fn config_from_layers_resolves_inherited_profiles_across_layers()
```

**Purpose**: Checks that profile inheritance still resolves correctly when parent and child definitions are split across separate config layers.

**Data flow**: Builds two `ConfigLayerEntry` values using `toml!`, one defining `permissions.base.network.domains` and one selecting `default_permissions = "dev"` with `permissions.dev.extends = "base"` plus a child domain. It constructs a `ConfigLayerStack`, calls `config_from_layers`, and asserts the final allowed domains contain both base and child hosts.

**Call relations**: Exercises full-layer merging before profile resolution in the effective-config path.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `config_from_layers_normalizes_profile_network_domains_before_merging_layers`  (lines 430–464)

```
fn config_from_layers_normalizes_profile_network_domains_before_merging_layers()
```

**Purpose**: Verifies that domain normalization happens before precedence resolution across layers, so case-only differences collapse correctly.

**Data flow**: Builds lower and higher `ConfigLayerEntry` values where `example.com` is denied in one layer and `EXAMPLE.COM` is allowed in the next, constructs a layer stack, calls `config_from_layers`, and asserts the final config allows `example.com` and has no denied domains.

**Call relations**: Regression test for normalization-aware merge semantics in effective config loading.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `config_from_layers_uses_only_the_final_selected_profile_network`  (lines 467–497)

```
fn config_from_layers_uses_only_the_final_selected_profile_network()
```

**Purpose**: Checks that only the final selected permission profile contributes network settings after layer merging.

**Data flow**: Builds a lower layer selecting custom profile `dev` with an allowed domain and a higher layer switching `default_permissions` to built-in `:workspace`, constructs a layer stack, calls `config_from_layers`, and asserts both allowed and denied domains are `None`.

**Call relations**: Tests the invariant that profile selection is final, not cumulative across layers.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `trusted_constraints_use_only_the_final_selected_profile_network`  (lines 500–536)

```
fn trusted_constraints_use_only_the_final_selected_profile_network()
```

**Purpose**: Verifies the same final-profile-only rule for trusted constraints derived from system and managed layers.

**Data flow**: Builds system and legacy-managed `ConfigLayerEntry` values with absolute paths, where the lower layer selects `dev` and the higher layer switches to `:workspace`, constructs a layer stack, calls `network_constraints_from_trusted_layers`, and asserts both allowed and denied domains are `None`.

**Call relations**: Covers the trusted-constraints path parallel to the effective-config test above.

*Call graph*: calls 3 internal fn (new, new, try_from); 6 external calls (default, assert_eq!, default, from, toml!, vec!).


##### `trusted_constraints_normalize_profile_network_domains_before_merging_layers`  (lines 539–579)

```
fn trusted_constraints_normalize_profile_network_domains_before_merging_layers()
```

**Purpose**: Checks that trusted constraint derivation also normalizes domains before applying precedence across trusted layers.

**Data flow**: Builds system and managed layers where `example.com` is denied in lower config and `EXAMPLE.COM` is allowed in higher config, constructs a layer stack, calls `network_constraints_from_trusted_layers`, and asserts the final constraints allow `example.com` and have no denied domains.

**Call relations**: Regression test for normalization-aware merge semantics in the trusted-constraints path.

*Call graph*: calls 3 internal fn (new, new, try_from); 6 external calls (default, assert_eq!, default, from, toml!, vec!).


##### `apply_network_constraints_skips_empty_domain_sides`  (lines 582–608)

```
fn apply_network_constraints_skips_empty_domain_sides()
```

**Purpose**: Verifies that applying constraints from a profile with only allowed domains leaves denied domains unset rather than creating an empty list.

**Data flow**: Parses a TOML config selecting a profile with one allowed domain, selects the network table, applies it to default `NetworkProxyConstraints`, and asserts `allowed_domains` is populated while `denied_domains` remains `None`.

**Call relations**: Covers the domain-overlay behavior in `apply_network_constraints` when only one side is present.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `apply_network_constraints_overlay_domain_entries`  (lines 611–658)

```
fn apply_network_constraints_overlay_domain_entries()
```

**Purpose**: Checks that applying multiple selected network tables overlays domain entries in constraints the same way effective config overlay does.

**Data flow**: Parses lower and higher TOML configs selecting the same profile with a denied domain and an allowed domain respectively, selects each network table, applies both in order to default `NetworkProxyConstraints`, and asserts the final constraints contain the allowed host on the allow side and the lower-layer blocked host on the deny side.

**Call relations**: Tests incremental domain overlay semantics specifically for trusted constraints.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


### `core/src/network_policy_decision_tests.rs`

`test` · `unit tests for network approval and denial conversion logic`

This file is the unit test suite for `network_policy_decision.rs`. It constructs concrete `NetworkPolicyDecisionPayload`, `BlockedRequest`, and `NetworkPolicyAmendment` values and checks the exact outputs of the conversion helpers. The tests are intentionally explicit about protocol variants and serialized forms so they lock down compatibility with proxy-produced payloads.

The approval-context tests verify that only ask decisions from the decider produce a `NetworkApprovalContext`, and that all supported protocols—HTTP, HTTPS, SOCKS5 TCP, and SOCKS5 UDP—are preserved correctly. A separate deserialization test confirms that proxy protocol aliases such as `https_connect` and `http-connect` deserialize into `NetworkApprovalProtocol::Https`, protecting compatibility with upstream wire formats. The amendment test checks the full mapping from approval-layer deny action plus SOCKS5 UDP context into `ExecPolicyNetworkRuleAmendment`, including the exact justification string. Finally, the denial-message tests verify that messages are emitted only for deny decisions and that a denylist block produces the explicit explanatory sentence rather than a generic fallback.

#### Function details

##### `network_approval_context_requires_ask_from_decider`  (lines 9–20)

```
fn network_approval_context_requires_ask_from_decider()
```

**Purpose**: Verifies that non-ask payloads do not produce a network approval context even when host and protocol are present.

**Data flow**: Builds a `NetworkPolicyDecisionPayload` with `decision = Deny`, `source = Decider`, protocol and host populated, calls `network_approval_context_from_payload`, and asserts the result is `None`.

**Call relations**: Covers the early rejection branch in approval-context extraction.

*Call graph*: 1 external calls (assert_eq!).


##### `network_approval_context_maps_http_https_and_socks_protocols`  (lines 23–103)

```
fn network_approval_context_maps_http_https_and_socks_protocols()
```

**Purpose**: Checks that ask-from-decider payloads preserve each supported protocol in the resulting approval context.

**Data flow**: Constructs several `NetworkPolicyDecisionPayload` values for HTTP, HTTPS, SOCKS5 TCP, and SOCKS5 UDP, each with `decision = Ask` and a host, calls `network_approval_context_from_payload` on each, and asserts the returned `NetworkApprovalContext` contains the same host and protocol.

**Call relations**: Exercises the positive-path protocol mapping in `network_approval_context_from_payload`.

*Call graph*: 1 external calls (assert_eq!).


##### `network_policy_decision_payload_deserializes_proxy_protocol_aliases`  (lines 106–132)

```
fn network_policy_decision_payload_deserializes_proxy_protocol_aliases()
```

**Purpose**: Verifies serde compatibility for proxy protocol alias strings that should map to HTTPS approval protocol.

**Data flow**: Deserializes two JSON strings into `NetworkPolicyDecisionPayload`, one with `protocol: "https_connect"` and one with `protocol: "http-connect"`, then asserts both payloads have `protocol = Some(NetworkApprovalProtocol::Https)`.

**Call relations**: Protects wire-format compatibility relied on before `network_approval_context_from_payload` is even called.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `execpolicy_network_rule_amendment_maps_protocol_action_and_justification`  (lines 135–153)

```
fn execpolicy_network_rule_amendment_maps_protocol_action_and_justification()
```

**Purpose**: Checks the exact conversion from approval amendment plus approval context into exec-policy amendment fields.

**Data flow**: Builds a deny `NetworkPolicyAmendment` and a `NetworkApprovalContext` using `Socks5Udp`, calls `execpolicy_network_rule_amendment`, and asserts the returned struct has `protocol = ExecPolicyNetworkRuleProtocol::Socks5Udp`, `decision = ExecPolicyDecision::Forbidden`, and the expected justification string.

**Call relations**: Covers the mapping logic used when persisting network approval decisions.

*Call graph*: 1 external calls (assert_eq!).


##### `denied_network_policy_message_requires_deny_decision`  (lines 156–170)

```
fn denied_network_policy_message_requires_deny_decision()
```

**Purpose**: Verifies that blocked requests marked as `ask` do not produce a denial message.

**Data flow**: Builds a `BlockedRequest` with `decision = Some("ask")`, calls `denied_network_policy_message`, and asserts the result is `None`.

**Call relations**: Tests the decision gate before reason-code formatting is applied.

*Call graph*: 1 external calls (assert_eq!).


##### `denied_network_policy_message_for_denylist_block_is_explicit`  (lines 173–192)

```
fn denied_network_policy_message_for_denylist_block_is_explicit()
```

**Purpose**: Checks that a denylisted host produces the explicit denylist explanation string.

**Data flow**: Builds a `BlockedRequest` with host `example.com`, reason `denied`, and decision `deny`, calls `denied_network_policy_message`, and asserts the returned string exactly matches the explicit denylist wording.

**Call relations**: Covers one of the named reason-code branches in denial message formatting.

*Call graph*: 1 external calls (assert_eq!).


### `sandboxing/src/policy_transforms_tests.rs`

`test` · `test execution`

The module exercises the policy transformation functions imported from the parent module against concrete permission structures from `codex_protocol`. Most tests build `PermissionProfile`, `FileSystemPermissions`, and `FileSystemSandboxPolicy` values with combinations of `FileSystemSandboxEntry` records over special paths (`Root`, `project_roots(None)`), concrete absolute paths, and glob patterns, then assert exact transformed outputs. Temporary directories and canonicalized absolute paths are used heavily so path comparisons are stable and realistic; on Unix, a helper creates a symlinked directory tree to prove normalization preserves user-specified symlink write paths instead of collapsing them to canonical targets.

The suite focuses on subtle invariants: unrestricted root write does not always require the platform sandbox, but carve-outs and restricted networking do; normalization preserves network settings, rejects unsupported read-glob grants, keeps deny globs and bounded scan depth, and drops empty nested permission objects. Intersection tests cover explicit empty read lists, dropping ungranted requests, materializing current-working-directory-relative special paths into concrete paths for reuse, deduplicating overlapping grants, preserving or dropping deny entries depending on whether filesystem grants survive, converting relative deny globs into absolute reusable patterns, and honoring the granted profile's glob scan depth. Final tests confirm merging additional permissions into a base filesystem policy preserves deny carve-outs and propagates glob depth, while `effective_file_system_sandbox_policy` either returns the base policy unchanged or augments it with additional write roots.

#### Function details

##### `symlink_dir`  (lines 23–25)

```
fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()>
```

**Purpose**: Creates a directory symlink on Unix for tests that need a symlinked filesystem layout. It is a tiny wrapper around the platform `std::os::unix::fs::symlink` call.

**Data flow**: It takes `original: &Path` and `link: &Path`, forwards them unchanged to the OS symlink primitive, and returns the resulting `std::io::Result<()>` without additional state changes beyond filesystem mutation.

**Call relations**: This helper is only invoked by `normalize_additional_permissions_preserves_symlinked_write_paths` to set up a symlinked root before exercising normalization logic.

*Call graph*: called by 1 (normalize_additional_permissions_preserves_symlinked_write_paths); 1 external calls (symlink).


##### `full_access_restricted_policy_skips_platform_sandbox_when_network_is_enabled`  (lines 28–44)

```
fn full_access_restricted_policy_skips_platform_sandbox_when_network_is_enabled()
```

**Purpose**: Verifies that a restricted filesystem policy consisting solely of `Root` with `Write` access is treated as effectively full filesystem access, so platform sandboxing is unnecessary when networking is fully enabled and there are no managed network requirements.

**Data flow**: The test constructs a `FileSystemSandboxPolicy::restricted` containing one `FileSystemSandboxEntry` for special path `Root` with `Write`, passes that policy plus `NetworkSandboxPolicy::Enabled` and `false` into `should_require_platform_sandbox`, and asserts the returned boolean is `false`.

**Call relations**: It directly exercises `should_require_platform_sandbox` in the permissive-network case and does not delegate further beyond the assertion.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert_eq!, vec!).


##### `root_write_policy_with_carveouts_still_uses_platform_sandbox`  (lines 47–73)

```
fn root_write_policy_with_carveouts_still_uses_platform_sandbox()
```

**Purpose**: Checks that adding a deny carve-out to an otherwise root-write policy makes the policy nontrivial enough that the platform sandbox must still be used.

**Data flow**: It resolves a concrete `blocked` path against the current directory into an `AbsolutePathBuf`, builds a restricted policy with `Root` `Write` plus a `Path` `Deny` entry for that blocked path, calls `should_require_platform_sandbox` with network enabled and no managed requirements, and asserts the result is `true`.

**Call relations**: This test contrasts with the previous full-access case by invoking the same decision function under a carve-out condition.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 3 external calls (assert_eq!, current_dir, vec!).


##### `full_access_restricted_policy_still_uses_platform_sandbox_for_restricted_network`  (lines 76–92)

```
fn full_access_restricted_policy_still_uses_platform_sandbox_for_restricted_network()
```

**Purpose**: Confirms that even a full-access filesystem policy still requires the platform sandbox when network access is restricted.

**Data flow**: It builds the same single-entry restricted root-write policy as the permissive case, calls `should_require_platform_sandbox` with `NetworkSandboxPolicy::Restricted`, and asserts the returned boolean is `true`.

**Call relations**: It exercises the network-policy branch of `should_require_platform_sandbox`, showing network restrictions override the filesystem shortcut.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert_eq!, vec!).


##### `normalize_additional_permissions_preserves_network`  (lines 95–125)

```
fn normalize_additional_permissions_preserves_network()
```

**Purpose**: Ensures normalization keeps an explicit network permission block intact while also preserving canonical read/write filesystem roots.

**Data flow**: The test creates a temporary directory, canonicalizes it, converts it to `AbsolutePathBuf`, builds a `PermissionProfile` with `network.enabled = Some(true)` and filesystem read/write roots both pointing at that path, passes it to `normalize_additional_permissions`, and asserts the returned profile still contains the same network block and equivalent filesystem roots.

**Call relations**: It directly validates `normalize_additional_permissions` on a mixed network/filesystem profile.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_preserves_symlinked_write_paths`  (lines 129–158)

```
fn normalize_additional_permissions_preserves_symlinked_write_paths()
```

**Purpose**: Verifies that normalization does not canonicalize away a symlinked write path, preserving the user-visible symlink location in additional permissions.

**Data flow**: It creates a temp directory tree with `real/write`, creates a symlink `link -> real`, constructs an `AbsolutePathBuf` for `link/write`, wraps that as a write root in `PermissionProfile.file_system`, normalizes the profile, and asserts the resulting filesystem permissions still contain `link/write` rather than the canonical `real/write` path.

**Call relations**: This test uses `symlink_dir` for setup, then exercises `normalize_additional_permissions` on the symlink-sensitive path case.

*Call graph*: calls 3 internal fn (from_read_write_roots, symlink_dir, from_absolute_path); 6 external calls (default, new, assert_eq!, create_dir_all, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_rejects_glob_read_grants`  (lines 161–180)

```
fn normalize_additional_permissions_rejects_glob_read_grants()
```

**Purpose**: Checks that normalization rejects unsupported glob-based positive grants and only allows glob entries for deny rules.

**Data flow**: It builds a `PermissionProfile` whose filesystem entries contain a `GlobPattern("**/*.env")` with `Read` access, calls `normalize_additional_permissions`, expects an error, and asserts the error string exactly matches the unsupported-glob message.

**Call relations**: It drives the validation/error path of `normalize_additional_permissions` rather than a successful normalization path.

*Call graph*: 4 external calls (default, assert_eq!, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_preserves_deny_globs`  (lines 183–213)

```
fn normalize_additional_permissions_preserves_deny_globs()
```

**Purpose**: Confirms that deny glob entries are accepted unchanged, including their configured maximum scan depth.

**Data flow**: The test constructs a profile with one filesystem entry `GlobPattern("**/*.env")` using `Deny` access and `glob_scan_max_depth = Some(2)`, normalizes it, and asserts the returned `PermissionProfile` is structurally identical.

**Call relations**: It complements the previous rejection test by exercising the supported deny-glob branch of `normalize_additional_permissions`.

*Call graph*: 5 external calls (default, assert_eq!, new, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_drops_empty_nested_profiles`  (lines 216–224)

```
fn normalize_additional_permissions_drops_empty_nested_profiles()
```

**Purpose**: Verifies that normalization removes nested permission objects that carry no effective settings.

**Data flow**: It passes a `PermissionProfile` containing `network.enabled = None` and a default/empty `FileSystemPermissions` into `normalize_additional_permissions`, then asserts the result is `PermissionProfile::default()`.

**Call relations**: This test targets cleanup behavior in `normalize_additional_permissions`, ensuring empty substructures do not survive normalization.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, normalize_additional_permissions).


##### `intersect_permission_profiles_preserves_explicit_empty_requested_reads`  (lines 227–246)

```
fn intersect_permission_profiles_preserves_explicit_empty_requested_reads()
```

**Purpose**: Checks that an explicitly empty requested read-root list is preserved when the granted profile matches, rather than being collapsed away.

**Data flow**: It creates a canonical temp path, builds a requested profile with `read = Some(vec![])` and `write = Some(vec![path])`, clones it as the granted profile, calls `intersect_permission_profiles(requested, granted, cwd)`, and asserts the returned profile equals the original requested profile.

**Call relations**: It exercises `intersect_permission_profiles` on a successful exact-match case involving the semantic distinction between absent and explicitly empty read permissions.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_drops_ungranted_nonempty_path_requests`  (lines 249–267)

```
fn intersect_permission_profiles_drops_ungranted_nonempty_path_requests()
```

**Purpose**: Verifies that a concrete requested filesystem path is removed entirely when no corresponding grant exists.

**Data flow**: The test builds a requested profile with one read root pointing at a canonical temp path, intersects it with `PermissionProfile::default()` using the temp directory as cwd, and asserts the result is the default empty profile.

**Call relations**: It drives the no-grant branch of `intersect_permission_profiles` for nonempty path requests.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_drops_explicit_empty_reads_without_grant`  (lines 270–288)

```
fn intersect_permission_profiles_drops_explicit_empty_reads_without_grant()
```

**Purpose**: Ensures that even an explicit empty read list is discarded if there is no filesystem grant at all to justify retaining the filesystem section.

**Data flow**: It constructs a requested profile with `read = Some(vec![])` and a concrete write root, intersects it against an empty granted profile, and asserts the result is `PermissionProfile::default()`.

**Call relations**: This test refines the previous semantics by showing explicit emptiness is preserved only when a grant survives intersection.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_accepts_child_path_granted_for_requested_cwd`  (lines 291–322)

```
fn intersect_permission_profiles_accepts_child_path_granted_for_requested_cwd()
```

**Purpose**: Checks that a request for write access to the current project roots can be satisfied by a grant to a concrete child path under that cwd.

**Data flow**: It canonicalizes a temp directory as `cwd`, derives `child = cwd.join("child")`, builds a requested profile containing a special `project_roots(None)` write entry, builds a granted profile with write roots containing `child`, intersects them using `cwd`, and asserts the result equals the granted profile.

**Call relations**: It exercises `intersect_permission_profiles` where a special cwd-relative request is matched by a narrower concrete grant.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_materializes_cwd_grant_for_reuse`  (lines 325–374)

```
fn intersect_permission_profiles_materializes_cwd_grant_for_reuse()
```

**Purpose**: Verifies that when both requested and granted permissions refer to cwd-relative project roots, intersection materializes that special path into the concrete request cwd so the result can be reused later without depending on a future cwd.

**Data flow**: It creates distinct `request_cwd` and `later_cwd` absolute paths, builds a profile containing a special `project_roots(None)` write entry, intersects that profile with itself using `request_cwd`, and asserts the result becomes a concrete write root at `request_cwd`. It then reuses that intersected profile as the grant for a later request to `later_cwd.join("child")` under `later_cwd` and asserts the second intersection yields the default empty profile.

**Call relations**: This test calls `intersect_permission_profiles` twice: first to observe materialization of cwd-relative grants, then to prove the materialized result is anchored to the original cwd and does not overgrant in a later context.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (default, new, assert_eq!, intersect_permission_profiles, vec!).


##### `intersect_permission_profiles_deduplicates_materialized_grants`  (lines 377–410)

```
fn intersect_permission_profiles_deduplicates_materialized_grants()
```

**Purpose**: Ensures that materializing a cwd-relative grant does not leave duplicate equivalent entries when the same concrete path was already present.

**Data flow**: It builds a profile containing both a special `project_roots(None)` write entry and an explicit `Path { path: cwd }` write entry, intersects the profile with itself using that `cwd`, and asserts the result contains only one concrete write root for `cwd`.

**Call relations**: It exercises deduplication logic inside `intersect_permission_profiles` after special-path materialization.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (default, new, assert_eq!, vec!).


##### `intersect_permission_profiles_materializes_cwd_deny_entries`  (lines 413–459)

```
fn intersect_permission_profiles_materializes_cwd_deny_entries()
```

**Purpose**: Checks that cwd-relative deny entries are also materialized into concrete paths during intersection, while unrelated root-wide grants remain unchanged.

**Data flow**: It creates `request_cwd`, builds a profile with `Root` `Write` plus `project_roots(None)` `Deny`, intersects the profile with itself using `request_cwd`, and asserts the result contains the original root-write entry and a concrete `Path { path: request_cwd }` deny entry.

**Call relations**: It validates that `intersect_permission_profiles` materializes deny entries, not just positive grants.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (default, new, assert_eq!, vec!).


##### `intersect_permission_profiles_drops_deny_entries_without_filesystem_grants`  (lines 462–500)

```
fn intersect_permission_profiles_drops_deny_entries_without_filesystem_grants()
```

**Purpose**: Verifies that deny filesystem entries are discarded when intersection leaves no filesystem grant section at all, while unrelated network permissions are preserved.

**Data flow**: It constructs a requested profile with `network.enabled = Some(true)` and filesystem entries consisting of a cwd-relative write plus a concrete deny path, intersects it with a granted profile containing only the same network permission, and asserts the result equals that granted network-only profile.

**Call relations**: This test exercises `intersect_permission_profiles` on a mixed network/filesystem profile to show filesystem deny rules do not survive independently of filesystem grants.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_rejects_concrete_grants_matched_by_requested_deny_globs`  (lines 503–542)

```
fn intersect_permission_profiles_rejects_concrete_grants_matched_by_requested_deny_globs()
```

**Purpose**: Checks that a concrete granted path is rejected if it falls under a deny glob requested alongside a broader write permission.

**Data flow**: It canonicalizes a temp cwd, derives `env_file = cwd.join(".env")`, builds a requested profile with cwd-relative write plus deny glob `**/*.env` and bounded scan depth, builds a granted profile with a concrete write root at `env_file`, intersects them using `cwd`, and asserts the result is the default empty profile.

**Call relations**: It drives the deny-glob filtering path of `intersect_permission_profiles`, proving deny patterns constrain otherwise matching concrete grants.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize, new, vec!).


##### `intersect_permission_profiles_materializes_relative_deny_globs_for_reuse`  (lines 545–611)

```
fn intersect_permission_profiles_materializes_relative_deny_globs_for_reuse()
```

**Purpose**: Verifies that relative deny globs are rewritten into absolute cwd-anchored glob patterns during intersection so the resulting grant can be reused safely later.

**Data flow**: It creates `request_cwd` and `later_cwd`, builds a profile with a cwd-relative write entry and a deny glob `**/*.env` with scan depth 2, intersects the profile with itself using `request_cwd`, and asserts the result contains a concrete write path at `request_cwd` plus a glob pattern prefixed with `request_cwd`. It then intersects a later request for `later_cwd/token.env` against that materialized profile using `later_cwd` and asserts the result is empty.

**Call relations**: Like the cwd-grant reuse test, this one invokes `intersect_permission_profiles` twice: first to observe glob materialization, then to prove the anchored deny glob does not accidentally apply as a generic relative rule in a different cwd.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (default, new, project_roots, assert_eq!, new, intersect_permission_profiles, vec!).


##### `intersect_permission_profiles_drops_broader_cwd_grant_for_requested_child_path`  (lines 614–645)

```
fn intersect_permission_profiles_drops_broader_cwd_grant_for_requested_child_path()
```

**Purpose**: Checks that a broader cwd-relative grant does not satisfy a request for a narrower explicit child path when the intersection logic requires the grant to be concretely reusable and no exact child grant exists.

**Data flow**: It canonicalizes a temp cwd, derives `child = cwd.join("child")`, builds a requested profile with that explicit child write root, builds a granted profile with only a special `project_roots(None)` write entry, intersects them using `cwd`, and asserts the result is the default empty profile.

**Call relations**: This test exercises the asymmetry in `intersect_permission_profiles`: a concrete child grant can satisfy a cwd-relative request, but a cwd-relative grant is not retained as a match for a narrower explicit child request.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_uses_granted_bounded_glob_scan_depth`  (lines 648–700)

```
fn intersect_permission_profiles_uses_granted_bounded_glob_scan_depth()
```

**Purpose**: Verifies that when both requested and granted profiles contain the same deny glob, the intersected result carries the granted profile's bounded scan depth and materializes the glob relative to the current directory.

**Data flow**: It gets the current directory, builds requested and granted profiles each containing `Root` `Write` and deny glob `**/*.env`, with requested depth 2 and granted depth 4, intersects them, and asserts the result contains the root-write entry, an absolute glob pattern resolved against `cwd`, and `glob_scan_max_depth = Some(4)`.

**Call relations**: It exercises `intersect_permission_profiles` on matching glob-deny policies to confirm scan-depth propagation comes from the grant.

*Call graph*: 5 external calls (default, assert_eq!, current_dir, new, vec!).


##### `intersect_permission_profiles_uses_granted_unbounded_glob_scan_depth`  (lines 703–755)

```
fn intersect_permission_profiles_uses_granted_unbounded_glob_scan_depth()
```

**Purpose**: Checks the same glob-depth propagation behavior when the granted profile is unbounded, ensuring the result remains unbounded rather than inheriting the request's bound.

**Data flow**: It builds requested and granted profiles with identical root-write and deny-glob entries, but with requested depth 2 and granted depth `None`, intersects them using the current directory, and asserts the result contains the absolute glob pattern and `glob_scan_max_depth = None`.

**Call relations**: This complements the bounded-depth test by exercising the unbounded branch of `intersect_permission_profiles`.

*Call graph*: 5 external calls (default, assert_eq!, current_dir, new, vec!).


##### `merge_file_system_policy_with_additional_permissions_preserves_unreadable_roots`  (lines 758–801)

```
fn merge_file_system_policy_with_additional_permissions_preserves_unreadable_roots()
```

**Purpose**: Verifies that merging additional filesystem permissions into a base restricted policy adds newly allowed roots without losing existing deny carve-outs from the base policy.

**Data flow**: It canonicalizes a temp cwd, derives `allowed_path` and `denied_path`, builds a base restricted policy with `Root` `Read` and a deny entry for `denied_path`, builds additional permissions with `allowed_path` as a read root and an explicit empty write-root list, merges them via `merge_file_system_policy_with_additional_permissions`, and asserts the merged policy still contains the deny entry and now also contains a read entry for `allowed_path`.

**Call relations**: It directly exercises the merge helper on a base-policy-plus-additional-permissions case where preserving negative rules is critical.

*Call graph*: calls 3 internal fn (from_read_write_roots, restricted, from_absolute_path); 6 external calls (new, new, assert_eq!, canonicalize, merge_file_system_policy_with_additional_permissions, vec!).


##### `merge_file_system_policy_with_additional_permissions_carries_bounded_glob_scan_depth`  (lines 804–837)

```
fn merge_file_system_policy_with_additional_permissions_carries_bounded_glob_scan_depth()
```

**Purpose**: Checks that merging additional permissions containing deny globs also transfers their bounded glob scan depth into the resulting sandbox policy.

**Data flow**: It builds a base restricted policy with `Root` `Write`, builds additional filesystem permissions containing one deny glob `**/*.env` and `glob_scan_max_depth = Some(2)`, merges them, and asserts the resulting `FileSystemSandboxPolicy` equals a restricted policy containing both entries with `glob_scan_max_depth` set to `Some(2)`.

**Call relations**: This test targets `merge_file_system_policy_with_additional_permissions` specifically for metadata propagation, not just entry concatenation.

*Call graph*: calls 1 internal fn (restricted); 4 external calls (assert_eq!, new, merge_file_system_policy_with_additional_permissions, vec!).


##### `effective_file_system_sandbox_policy_returns_base_policy_without_additional_permissions`  (lines 840–864)

```
fn effective_file_system_sandbox_policy_returns_base_policy_without_additional_permissions()
```

**Purpose**: Ensures the effective-policy helper is a no-op when no additional permission profile is supplied.

**Data flow**: It canonicalizes a temp cwd, builds a base restricted policy with `Root` `Read` and a deny entry for `denied_path`, calls `effective_file_system_sandbox_policy(&base_policy, None)`, and asserts the returned policy equals the original base policy.

**Call relations**: It exercises the `None` branch of `effective_file_system_sandbox_policy`, confirming no merge occurs without additional permissions.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, effective_file_system_sandbox_policy, vec!).


##### `effective_file_system_sandbox_policy_merges_additional_write_roots`  (lines 867–914)

```
fn effective_file_system_sandbox_policy_merges_additional_write_roots()
```

**Purpose**: Verifies that the effective-policy helper augments a base policy with write roots from an additional permission profile while preserving existing deny carve-outs.

**Data flow**: It canonicalizes a temp cwd, derives `allowed_path` and `denied_path`, builds a base restricted policy with `Root` `Read` and a deny entry for `denied_path`, builds an additional `PermissionProfile` whose filesystem section has an explicit empty read-root list and `allowed_path` as a write root, calls `effective_file_system_sandbox_policy(&base_policy, Some(&additional_permissions))`, and asserts the resulting policy contains both the original deny entry and a write entry for `allowed_path`.

**Call relations**: It exercises the merge path of `effective_file_system_sandbox_policy`, which internally depends on the additional filesystem permissions being present and mergeable.

*Call graph*: calls 3 internal fn (from_read_write_roots, restricted, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize, effective_file_system_sandbox_policy, vec!).


### `sandboxing/src/bwrap_tests.rs`

`test` · `test execution`

This test module exercises the decision logic in `bwrap.rs` without depending on a real system `bwrap`. It creates temporary shell scripts marked executable and uses them as fake `bwrap` binaries whose stderr, exit status, and runtime behavior are fully controlled.

The warning tests cover the three main branches of `system_bwrap_warning_for_path`: missing path returns `MISSING_BWRAP_WARNING`; stderr containing any string from `USER_NAMESPACE_FAILURES` returns `USER_NAMESPACE_WARNING`; and unrelated failures produce no warning. Two probe-behavior tests verify that `system_bwrap_has_user_namespace_access` does not block excessively: one script sleeps longer than the timeout and should be treated as acceptable after a quick timeout, while another exits with a namespace error but leaves a background descendant holding stderr open, ensuring the nonblocking stderr read avoids hanging.

The WSL parser tests feed representative `/proc/version` strings directly into `proc_version_indicates_wsl1`, checking both positive WSL1 formats and negative WSL2/native cases. Path-discovery tests build temporary directory trees with fake `bwrap` executables to confirm `find_system_bwrap_in_search_paths` picks the first executable candidate, skips a workspace-local `bwrap` when cwd is inside that workspace, and does not over-filter when cwd is `/`. Helper functions centralize creation of executable temp files and named `bwrap` binaries, including a workaround for environments where the OS temp directory is mounted `noexec`.

#### Function details

##### `system_bwrap_warning_reports_missing_system_bwrap`  (lines 10–15)

```
fn system_bwrap_warning_reports_missing_system_bwrap()
```

**Purpose**: Asserts that passing no `bwrap` path yields the missing-bwrap warning string.

**Data flow**: Calls `system_bwrap_warning_for_path(None)` and compares the result to `Some(MISSING_BWRAP_WARNING.to_string())` with `assert_eq!`. It has no side effects.

**Call relations**: This is the simplest branch test for the warning classifier, directly targeting the missing-path case.

*Call graph*: 1 external calls (assert_eq!).


##### `system_bwrap_warning_reports_user_namespace_failures`  (lines 18–34)

```
fn system_bwrap_warning_reports_user_namespace_failures()
```

**Purpose**: Checks that each known namespace-related stderr fragment is recognized and mapped to the user-namespace warning.

**Data flow**: Iterates over `USER_NAMESPACE_FAILURES`, creates a fake executable script that prints the current failure string to stderr and exits 1, converts its temp path to `&Path`, and asserts `system_bwrap_warning_for_path(Some(fake_bwrap_path))` returns `Some(USER_NAMESPACE_WARNING.to_string())`.

**Call relations**: This test drives the stderr-classification path in `system_bwrap_has_user_namespace_access` and `is_user_namespace_failure` through the higher-level warning API.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (assert_eq!, format!).


##### `system_bwrap_warning_skips_unrelated_bwrap_failures`  (lines 37–47)

```
fn system_bwrap_warning_skips_unrelated_bwrap_failures()
```

**Purpose**: Verifies that an unsuccessful `bwrap` probe with unrelated stderr does not trigger the namespace warning.

**Data flow**: Creates a fake executable that prints an unrelated error and exits 1, passes its path into `system_bwrap_warning_for_path`, and asserts the result is `None`.

**Call relations**: This complements the namespace-failure test by covering the branch where probe failure is not classified as a user-namespace problem.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 1 external calls (assert_eq!).


##### `system_bwrap_probe_times_out_without_reporting_a_warning`  (lines 50–65)

```
fn system_bwrap_probe_times_out_without_reporting_a_warning()
```

**Purpose**: Ensures the probe treats a long-running `bwrap` invocation as acceptable after the timeout instead of blocking or warning.

**Data flow**: Creates a fake executable that sleeps for one second, records `Instant::now()`, calls `system_bwrap_has_user_namespace_access` with a 10 ms timeout, asserts the result is true, and asserts elapsed wall time stayed below 500 ms.

**Call relations**: This test targets the timeout branch of the probe loop, confirming that ambiguous hangs are treated as non-fatal and terminated promptly.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (now, assert!).


##### `system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open`  (lines 68–84)

```
fn system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open()
```

**Purpose**: Checks that the probe returns promptly even when a child process exits but leaves a background descendant keeping stderr open.

**Data flow**: Creates a fake executable that prints a namespace failure, backgrounds a sleep process, and exits 1. It records start time, calls `system_bwrap_has_user_namespace_access` with a short timeout, asserts the result is false, and asserts elapsed time remains under 500 ms.

**Call relations**: This test specifically validates the nonblocking stderr-read logic in `system_bwrap_has_user_namespace_access`, which avoids hanging on inherited pipe handles.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (now, assert!).


##### `detects_wsl1_proc_version_formats`  (lines 87–97)

```
fn detects_wsl1_proc_version_formats()
```

**Purpose**: Verifies that several representative `/proc/version` strings are recognized as WSL1.

**Data flow**: Calls `proc_version_indicates_wsl1` with multiple hard-coded kernel version strings and asserts each result is true.

**Call relations**: This is a pure parser test for the helper beneath `is_wsl1`, covering explicit and mixed-format WSL1 markers.

*Call graph*: 1 external calls (assert!).


##### `does_not_treat_wsl2_or_native_linux_as_wsl1`  (lines 100–114)

```
fn does_not_treat_wsl2_or_native_linux_as_wsl1()
```

**Purpose**: Ensures the WSL parser does not misclassify WSL2 or ordinary Linux version strings as WSL1.

**Data flow**: Passes several WSL2/native-looking version strings into `proc_version_indicates_wsl1` and asserts each result is false.

**Call relations**: This complements the positive WSL1 parser test by covering exclusion cases important to warning correctness.

*Call graph*: 1 external calls (assert!).


##### `finds_first_executable_bwrap_in_joined_search_path`  (lines 117–133)

```
fn finds_first_executable_bwrap_in_joined_search_path()
```

**Purpose**: Checks that search-path discovery skips non-executable files and returns the first executable `bwrap` candidate.

**Data flow**: Creates temporary cwd, first, and second directories; writes a non-executable `bwrap` file in the first directory; creates an executable named `bwrap` in the second directory; joins the two directories into a search path; and asserts `find_system_bwrap_in_search_paths` returns the canonical path from the second directory.

**Call relations**: This test exercises the path-search helper directly, focusing on executable discovery order rather than workspace trust filtering.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 5 external calls (assert_eq!, join_paths, create_dir_all, write, tempdir).


##### `skips_workspace_local_bwrap_in_joined_search_path`  (lines 136–150)

```
fn skips_workspace_local_bwrap_in_joined_search_path()
```

**Purpose**: Verifies that a `bwrap` executable inside the current workspace is ignored in favor of a trusted external candidate.

**Data flow**: Creates temporary cwd and trusted directories, writes executable `bwrap` files in both, joins them into a search path with cwd first, and asserts `find_system_bwrap_in_search_paths` returns the trusted directory's canonical path rather than the workspace-local one.

**Call relations**: This test targets the trust policy in the search helper that rejects candidates under the current working directory.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 4 external calls (assert_eq!, join_paths, create_dir_all, tempdir).


##### `root_cwd_does_not_hide_system_bwrap_candidates`  (lines 153–164)

```
fn root_cwd_does_not_hide_system_bwrap_candidates()
```

**Purpose**: Ensures the workspace-local filtering rule is disabled when the current directory is `/`, so normal system paths remain visible.

**Data flow**: Creates a temporary bin directory with an executable named `bwrap`, joins it into a search path, calls `find_system_bwrap_in_search_paths` with `Path::new("/")` as cwd, and asserts the candidate is returned.

**Call relations**: This test covers the special-case branch where cwd root should not cause all absolute candidates to be treated as workspace-local.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 4 external calls (assert_eq!, join_paths, create_dir_all, tempdir).


##### `write_fake_bwrap`  (lines 166–171)

```
fn write_fake_bwrap(contents: &str) -> tempfile::TempPath
```

**Purpose**: Creates an executable temporary script containing arbitrary shell contents, preferring the current directory to avoid `noexec` temp mounts.

**Data flow**: Reads the current directory with fallback to `.` and forwards that directory plus the provided script contents into `write_fake_bwrap_in`, returning the resulting `tempfile::TempPath`.

**Call relations**: Several warning and probe tests call this wrapper to create disposable fake `bwrap` executables without repeating directory-selection logic.

*Call graph*: calls 1 internal fn (write_fake_bwrap_in); called by 4 (system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open, system_bwrap_probe_times_out_without_reporting_a_warning, system_bwrap_warning_reports_user_namespace_failures, system_bwrap_warning_skips_unrelated_bwrap_failures); 1 external calls (current_dir).


##### `write_fake_bwrap_in`  (lines 173–190)

```
fn write_fake_bwrap_in(dir: &Path, contents: &str) -> tempfile::TempPath
```

**Purpose**: Writes an executable temporary file with the supplied shell script contents in a chosen directory.

**Data flow**: Creates a `NamedTempFile` in the requested directory if possible, otherwise in the default temp dir, converts it into a `TempPath`, writes the provided contents to disk, sets mode `0o755` via `PermissionsExt`, and returns the path.

**Call relations**: This helper underlies `write_fake_bwrap` and encapsulates the file-creation details needed by the fake-executable tests.

*Call graph*: called by 1 (write_fake_bwrap); 4 external calls (new_in, from_mode, set_permissions, write).


##### `write_named_fake_bwrap_in`  (lines 192–201)

```
fn write_named_fake_bwrap_in(dir: &Path) -> PathBuf
```

**Purpose**: Creates a canonical executable file literally named `bwrap` inside a specified directory and returns its canonicalized path.

**Data flow**: Joins `dir` with `"bwrap"`, writes a minimal shell script to that path, sets executable permissions `0o755`, canonicalizes the path, and returns the resulting `PathBuf`.

**Call relations**: The search-path tests use this helper because `find_system_bwrap_in_search_paths` looks specifically for a file named `bwrap`.

*Call graph*: called by 3 (finds_first_executable_bwrap_in_joined_search_path, root_cwd_does_not_hide_system_bwrap_candidates, skips_workspace_local_bwrap_in_joined_search_path); 5 external calls (join, from_mode, canonicalize, set_permissions, write).


### `core/src/windows_sandbox_read_grants_tests.rs`

`test` · `test execution`

This test file targets the guard rails in `grant_read_root_non_elevated`. A small helper, `workspace_roots_for`, converts a temporary directory path into the `Vec<AbsolutePathBuf>` shape expected by the production API. Each test creates an isolated `TempDir`, uses `PermissionProfile::workspace_write()` and an empty `HashMap` environment, and then invokes the grant helper with a deliberately invalid path.

The three cases correspond exactly to the production function's ordered validation checks. `rejects_relative_path` passes `Path::new("relative")` and asserts the returned error string contains `"path must be absolute"`. `rejects_missing_path` constructs a child path that does not exist and checks for `"path does not exist"`. `rejects_file_path` first writes a real file inside the temp directory, then passes that file path and asserts the error mentions `"path must be a directory"`. Because all tests use `expect_err`, they also implicitly verify that these invalid inputs fail before any successful canonicalization or sandbox refresh can occur.

#### Function details

##### `workspace_roots_for`  (lines 8–10)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the workspace-root vector expected by sandbox APIs from a single absolute filesystem path.

**Data flow**: Accepts `&Path`, converts it with `AbsolutePathBuf::from_absolute_path`, panics if the path is not absolute, wraps the result in a one-element `Vec`, and returns it.

**Call relations**: This helper is used by all three tests in the file to prepare the `workspace_roots` argument for `grant_read_root_non_elevated`.

*Call graph*: called by 3 (rejects_file_path, rejects_missing_path, rejects_relative_path); 1 external calls (vec!).


##### `rejects_relative_path`  (lines 13–26)

```
fn rejects_relative_path()
```

**Purpose**: Verifies that a relative read-root path is rejected with the absolute-path validation error.

**Data flow**: Creates a temporary directory, derives workspace roots from its absolute path, calls `grant_read_root_non_elevated` with `Path::new("relative")`, expects an error, converts that error to a string, and asserts the message contains `"path must be absolute"`.

**Call relations**: The test runner invokes this directly. It uses `workspace_roots_for` to satisfy the API shape and exercises the first validation branch in `grant_read_root_non_elevated`.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 5 external calls (new, new, new, assert!, grant_read_root_non_elevated).


##### `rejects_missing_path`  (lines 29–43)

```
fn rejects_missing_path()
```

**Purpose**: Verifies that a non-existent absolute path is rejected with the missing-path validation error.

**Data flow**: Creates a temp directory, constructs a child path that does not exist, prepares workspace roots, calls `grant_read_root_non_elevated` with that missing path, expects an error, and asserts the error string contains `"path does not exist"`.

**Call relations**: This test is run by the test harness and targets the second validation branch in `grant_read_root_non_elevated`, after the absolute-path check passes.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 4 external calls (new, new, assert!, grant_read_root_non_elevated).


##### `rejects_file_path`  (lines 46–61)

```
fn rejects_file_path()
```

**Purpose**: Verifies that an existing file path is rejected because only directories may be granted as read roots.

**Data flow**: Creates a temp directory, writes `file.txt` inside it, prepares workspace roots, calls `grant_read_root_non_elevated` with the file path, expects an error, and asserts the message contains `"path must be a directory"`.

**Call relations**: This test is invoked by the test runner and exercises the third validation branch in `grant_read_root_non_elevated`, where existence passes but directory-ness fails.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 5 external calls (new, new, assert!, write, grant_read_root_non_elevated).


### `core/src/windows_sandbox_tests.rs`

`test` · `test execution`

This file is the unit-test companion to `windows_sandbox.rs`. The first group of tests exercises `WindowsSandboxLevel::from_features` using a mutable `Features` initialized with defaults. They confirm that enabling only `Feature::WindowsSandboxElevated` yields `WindowsSandboxLevel::Elevated`, enabling only `Feature::WindowsSandbox` yields `RestrictedToken`, enabling neither yields `Disabled`, and enabling both still resolves to `Elevated`, documenting the precedence rule.

The next group targets legacy configuration compatibility. By constructing raw `BTreeMap<String, bool>` entries, the tests verify that `legacy_windows_sandbox_mode_from_entries` prefers the elevated legacy key over the unelevated one and also recognizes the alias key `enable_experimental_windows_sandbox` as `Unelevated`. Another test wraps such entries in `FeaturesToml` inside a `ConfigToml` and confirms `resolve_windows_sandbox_mode` falls back to those legacy keys when the newer `windows.sandbox` field is absent.

Finally, the file checks `resolve_windows_sandbox_private_desktop`: with a default `ConfigToml` it returns `true`, while an explicit `windows.sandbox_private_desktop = false` is respected. Together these tests pin down the exact compatibility and defaulting semantics expected during config loading.

#### Function details

##### `elevated_flag_works_by_itself`  (lines 9–17)

```
fn elevated_flag_works_by_itself()
```

**Purpose**: Asserts that enabling only the elevated sandbox feature resolves to the elevated sandbox level.

**Data flow**: Creates `Features::with_defaults()`, enables `Feature::WindowsSandboxElevated`, calls `WindowsSandboxLevel::from_features(&features)`, and asserts the result equals `WindowsSandboxLevel::Elevated`.

**Call relations**: This standalone test is run by the test harness and validates one branch of the feature-resolution logic in `WindowsSandboxLevel::from_features`.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `restricted_token_flag_works_by_itself`  (lines 20–28)

```
fn restricted_token_flag_works_by_itself()
```

**Purpose**: Asserts that enabling only the legacy Windows sandbox feature resolves to restricted-token mode.

**Data flow**: Builds default features, enables `Feature::WindowsSandbox`, computes `WindowsSandboxLevel::from_features`, and asserts it equals `RestrictedToken`.

**Call relations**: The test runner invokes it directly. It covers the non-elevated positive branch of feature-based sandbox resolution.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `no_flags_means_no_sandbox`  (lines 31–38)

```
fn no_flags_means_no_sandbox()
```

**Purpose**: Asserts that with no sandbox-related feature flags enabled, sandboxing is disabled.

**Data flow**: Creates default features without enabling any sandbox flags, calls `WindowsSandboxLevel::from_features`, and asserts the result is `Disabled`.

**Call relations**: This test documents the default branch of the feature-resolution logic.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `elevated_wins_when_both_flags_are_enabled`  (lines 41–50)

```
fn elevated_wins_when_both_flags_are_enabled()
```

**Purpose**: Verifies the precedence rule that elevated mode overrides the legacy sandbox flag when both are enabled.

**Data flow**: Creates default features, enables both `Feature::WindowsSandbox` and `Feature::WindowsSandboxElevated`, computes the level with `from_features`, and asserts it is `Elevated`.

**Call relations**: This test directly validates the ordering of checks inside `WindowsSandboxLevel::from_features`.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `legacy_mode_prefers_elevated`  (lines 53–65)

```
fn legacy_mode_prefers_elevated()
```

**Purpose**: Checks that legacy feature-entry parsing returns elevated mode when both elevated and unelevated legacy keys are true.

**Data flow**: Constructs a `BTreeMap<String, bool>` containing `experimental_windows_sandbox = true` and `elevated_windows_sandbox = true`, passes it to `legacy_windows_sandbox_mode_from_entries`, and asserts the result is `Some(Elevated)`.

**Call relations**: The test runner invokes this directly to pin down precedence in the legacy-key parser.

*Call graph*: 2 external calls (new, assert_eq!).


##### `legacy_mode_supports_alias_key`  (lines 68–79)

```
fn legacy_mode_supports_alias_key()
```

**Purpose**: Checks that the alias legacy key `enable_experimental_windows_sandbox` is accepted as the unelevated sandbox mode.

**Data flow**: Builds a `BTreeMap` with only the alias key set to true, calls `legacy_windows_sandbox_mode_from_entries`, and asserts the result is `Some(Unelevated)`.

**Call relations**: This test covers backward compatibility for older config key names in the legacy parser.

*Call graph*: 2 external calls (new, assert_eq!).


##### `resolve_windows_sandbox_mode_falls_back_to_legacy_keys`  (lines 82–97)

```
fn resolve_windows_sandbox_mode_falls_back_to_legacy_keys()
```

**Purpose**: Verifies that config resolution uses legacy feature entries when the newer `windows.sandbox` field is absent.

**Data flow**: Creates a `BTreeMap` with `experimental_windows_sandbox = true`, wraps it in `FeaturesToml`, embeds that in a `ConfigToml` with other fields defaulted, calls `resolve_windows_sandbox_mode(&cfg)`, and asserts the result is `Some(Unelevated)`.

**Call relations**: This test exercises the integration between `resolve_windows_sandbox_mode` and `legacy_windows_sandbox_mode` rather than the raw entry parser alone.

*Call graph*: calls 1 internal fn (from); 3 external calls (new, default, assert_eq!).


##### `resolve_windows_sandbox_private_desktop_defaults_to_true`  (lines 100–104)

```
fn resolve_windows_sandbox_private_desktop_defaults_to_true()
```

**Purpose**: Asserts that the private-desktop setting defaults to enabled when omitted from config.

**Data flow**: Constructs `ConfigToml::default()`, passes it to `resolve_windows_sandbox_private_desktop`, and asserts the returned boolean is true.

**Call relations**: This test documents the default branch of the private-desktop resolver used during config loading.

*Call graph*: 1 external calls (assert!).


##### `resolve_windows_sandbox_private_desktop_respects_explicit_cfg_value`  (lines 107–117)

```
fn resolve_windows_sandbox_private_desktop_respects_explicit_cfg_value()
```

**Purpose**: Asserts that an explicit `sandbox_private_desktop = false` in config overrides the default.

**Data flow**: Builds a `ConfigToml` whose `windows` section contains `WindowsToml { sandbox_private_desktop: Some(false), ..Default::default() }`, calls `resolve_windows_sandbox_private_desktop`, and asserts the result is false.

**Call relations**: This test complements the defaulting test by covering the explicit-config branch of the resolver.

*Call graph*: 2 external calls (default, assert!).


### `core/src/exec_env_tests.rs`

`test` · `test execution`

This test module builds small synthetic environment variable sets and checks the exact `HashMap<String, String>` produced by the helpers in `exec_env.rs`. The shared helper `make_vars` converts `&str` pairs into owned `(String, String)` tuples so each test can feed deterministic input into `populate_env` or, on Windows, `create_env_from_vars`.

The tests cover the policy matrix in detail: default inheritance behavior, whether default excludes remove variables containing names like `KEY`, `SECRET`, or `TOKEN`, `include_only` glob matching, and `r#set` overrides that inject or replace variables. Several tests verify the special invariant that `CODEX_THREAD_ID_ENV_VAR` is inserted whenever a `ThreadId` is supplied and omitted otherwise.

Inheritance modes are checked explicitly for `All`, `Core`, and `None`. Windows-only tests verify that core variable names are matched case-insensitively (`Path`, `PathExt`, `TEMP`) and that `PATHEXT` is synthesized when absent but not duplicated when an existing mixed-case variant is present. Together these tests pin down subtle platform-specific behavior that would be easy to regress if environment filtering moved or changed.

#### Function details

##### `make_vars`  (lines 6–11)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: Converts a borrowed slice of key/value string pairs into owned environment tuples for test inputs. It keeps test bodies concise and avoids repeated allocation boilerplate.

**Data flow**: Reads `pairs: &[(&str, &str)]`, maps each borrowed pair to `(String, String)` with `to_string`, collects into `Vec<(String, String)>`, and returns it.

**Call relations**: Nearly every test in this file calls it first to prepare deterministic input for `populate_env` or `create_env_from_vars`. It does not delegate further; it is a local fixture helper.

*Call graph*: called by 12 (create_env_inserts_pathext_on_windows_when_missing, create_env_preserves_existing_pathext_case_insensitively_on_windows, populate_env_inserts_thread_id, populate_env_omits_thread_id_when_missing, test_core_inherit_defaults_keep_sensitive_vars, test_core_inherit_respects_case_insensitive_names_on_windows, test_core_inherit_with_default_excludes_enabled, test_include_only, test_inherit_all, test_inherit_all_with_default_excludes (+2 more)).


##### `test_core_inherit_defaults_keep_sensitive_vars`  (lines 14–35)

```
fn test_core_inherit_defaults_keep_sensitive_vars()
```

**Purpose**: Verifies the default shell-environment policy preserves all provided variables, including names that look sensitive, while still injecting the thread id. This captures the current default semantics rather than the stricter filtered mode.

**Data flow**: Builds variables containing `PATH`, `HOME`, `API_KEY`, and `SECRET_TOKEN`; reads `ShellEnvironmentPolicy::default()` and a fresh `ThreadId`; runs `populate_env`; constructs an expected `HashMap` plus `CODEX_THREAD_ID_ENV_VAR`; asserts equality.

**Call relations**: This test invokes `make_vars` to create input and then exercises the test-only environment population path. It serves as a baseline expectation for the default policy configuration.

*Call graph*: calls 3 internal fn (make_vars, default, new); 2 external calls (assert_eq!, hashmap!).


##### `test_core_inherit_with_default_excludes_enabled`  (lines 38–60)

```
fn test_core_inherit_with_default_excludes_enabled()
```

**Purpose**: Checks that when default excludes are active, variables with secret-like names are removed while ordinary core variables remain. It confirms the filtering branch of the policy algorithm.

**Data flow**: Creates a variable set with safe and sensitive names, constructs a `ShellEnvironmentPolicy` with `ignore_default_excludes: false`, generates a `ThreadId`, calls `populate_env`, builds an expected map containing only `PATH`, `HOME`, and the injected thread id, and asserts equality.

**Call relations**: The test is driven by `make_vars` and validates the exclusion logic in the shared environment-population helper. It contrasts directly with the previous default-policy test.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `test_include_only`  (lines 63–82)

```
fn test_include_only()
```

**Purpose**: Ensures `include_only` patterns restrict inherited variables to matching names, while the Codex thread id still survives filtering. It demonstrates that explicit inclusion wins over broad inheritance.

**Data flow**: Creates `PATH` and `FOO`, builds a policy with `ignore_default_excludes: true` and `include_only` containing a case-insensitive `*PATH` pattern, generates a thread id, calls `populate_env`, and compares the result to a map containing only `PATH` plus the thread id.

**Call relations**: This test uses `make_vars` for setup and then exercises the include-only branch of the policy algorithm. It specifically validates the documented exception that thread-id injection is not blocked by include-only filtering.

*Call graph*: calls 2 internal fn (make_vars, new); 4 external calls (default, assert_eq!, hashmap!, vec!).


##### `test_set_overrides`  (lines 85–104)

```
fn test_set_overrides()
```

**Purpose**: Verifies that variables in `policy.r#set` are added to the final environment alongside inherited values. It confirms explicit policy-set values are materialized in the output map.

**Data flow**: Creates a single `PATH` variable, builds a mutable policy with default excludes disabled, inserts `NEW_VAR=42` into `policy.r#set`, generates a thread id, calls `populate_env`, and asserts the output contains `PATH`, `NEW_VAR`, and the thread id.

**Call relations**: The test prepares input with `make_vars` and validates the override/injection stage of environment population. It complements the inheritance and filtering tests by checking policy-authored additions.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `populate_env_inserts_thread_id`  (lines 107–119)

```
fn populate_env_inserts_thread_id()
```

**Purpose**: Checks the positive case for thread-id propagation into the child environment. It isolates the special Codex metadata variable from other policy concerns.

**Data flow**: Creates a minimal `PATH` environment, uses the default policy and a new `ThreadId`, calls `populate_env`, constructs the expected map with `PATH` and `CODEX_THREAD_ID_ENV_VAR`, and asserts equality.

**Call relations**: This test uses `make_vars` and directly targets the thread-id injection invariant implemented by the underlying shell-environment logic.

*Call graph*: calls 3 internal fn (make_vars, default, new); 2 external calls (assert_eq!, hashmap!).


##### `populate_env_omits_thread_id_when_missing`  (lines 122–132)

```
fn populate_env_omits_thread_id_when_missing()
```

**Purpose**: Checks that no Codex thread-id variable is inserted when no thread id is supplied. It verifies the optional nature of that metadata.

**Data flow**: Creates a minimal environment, uses the default policy with `thread_id` set to `None`, calls `populate_env`, builds an expected map containing only `PATH`, and asserts equality.

**Call relations**: This test pairs with `populate_env_inserts_thread_id` to cover both branches of the optional thread-id input.

*Call graph*: calls 2 internal fn (make_vars, default); 2 external calls (assert_eq!, hashmap!).


##### `test_inherit_all`  (lines 135–149)

```
fn test_inherit_all()
```

**Purpose**: Verifies `ShellEnvironmentPolicyInherit::All` preserves every provided variable when default excludes are disabled. It confirms the broadest inheritance mode behaves as a straight copy plus thread-id injection.

**Data flow**: Creates `PATH` and `FOO`, builds a policy with `inherit: All` and `ignore_default_excludes: true`, generates a thread id, calls `populate_env`, converts the original vars into a `HashMap`, inserts the thread id, and asserts equality.

**Call relations**: The test uses `make_vars` and validates the all-inherit branch of the policy algorithm under permissive filtering settings.

*Call graph*: calls 2 internal fn (make_vars, new); 2 external calls (default, assert_eq!).


##### `test_inherit_all_with_default_excludes`  (lines 152–168)

```
fn test_inherit_all_with_default_excludes()
```

**Purpose**: Checks that `inherit: All` still respects default secret filtering when excludes are enabled. It proves inheritance breadth does not bypass the exclusion pass.

**Data flow**: Creates `PATH` and `API_KEY`, builds a policy with `inherit: All` and `ignore_default_excludes: false`, generates a thread id, calls `populate_env`, and asserts the result contains only `PATH` plus the thread id.

**Call relations**: This test complements `test_inherit_all` by showing how the same inheritance mode behaves when the exclusion filter is active.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `test_core_inherit_respects_case_insensitive_names_on_windows`  (lines 172–196)

```
fn test_core_inherit_respects_case_insensitive_names_on_windows()
```

**Purpose**: Verifies Windows core-variable inheritance treats names case-insensitively, preserving mixed-case spellings like `Path` and `PathExt`. It captures platform-specific matching semantics.

**Data flow**: On Windows, creates mixed-case core variables and a non-core `FOO`, builds a `Core` inheritance policy with excludes disabled, generates a thread id, calls `populate_env`, and asserts the result contains `Path`, `PathExt`, `TEMP`, and the thread id but not `FOO`.

**Call relations**: This Windows-only test uses `make_vars` and validates the case-insensitive core-variable selection logic in the environment helper.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `create_env_inserts_pathext_on_windows_when_missing`  (lines 200–215)

```
fn create_env_inserts_pathext_on_windows_when_missing()
```

**Purpose**: Checks that Windows environment creation synthesizes a default `PATHEXT` when no inherited variables are present and inheritance is disabled. This preserves executable lookup behavior for spawned commands.

**Data flow**: On Windows, creates an empty variable list, builds a policy with `inherit: None` and excludes disabled, calls `create_env_from_vars` with no thread id, constructs an expected map containing only `PATHEXT=.COM;.EXE;.BAT;.CMD`, and asserts equality.

**Call relations**: This test uses `make_vars` and the Windows-only helper from `exec_env.rs` to validate post-processing that occurs during environment creation rather than simple population.

*Call graph*: calls 1 internal fn (make_vars); 3 external calls (default, assert_eq!, hashmap!).


##### `create_env_preserves_existing_pathext_case_insensitively_on_windows`  (lines 219–237)

```
fn create_env_preserves_existing_pathext_case_insensitively_on_windows()
```

**Purpose**: Ensures Windows environment creation does not duplicate or overwrite an existing `PATHEXT` variable when it appears with mixed casing. It verifies case-insensitive preservation rather than normalization by force.

**Data flow**: On Windows, creates a single `PathExt` variable, builds a `Core` inheritance policy, calls `create_env_from_vars`, filters the resulting map for keys equal to `PATHEXT` ignoring ASCII case, and asserts there is exactly one such entry with the original value.

**Call relations**: This test uses `make_vars` and the Windows-only helper to validate deduplication/preservation behavior around `PATHEXT` handling.

*Call graph*: calls 1 internal fn (make_vars); 2 external calls (default, assert_eq!).


##### `test_inherit_none`  (lines 240–259)

```
fn test_inherit_none()
```

**Purpose**: Verifies `ShellEnvironmentPolicyInherit::None` drops all inherited variables and keeps only explicitly set policy variables plus the optional thread id. It confirms the strictest inheritance mode.

**Data flow**: Creates `PATH` and `HOME`, builds a mutable policy with `inherit: None` and excludes disabled, inserts `ONLY_VAR=yes` into `policy.r#set`, generates a thread id, calls `populate_env`, and asserts the result contains only `ONLY_VAR` and the thread id.

**Call relations**: This test uses `make_vars` and covers the no-inheritance branch of the policy algorithm, complementing the `All` and `Core` cases.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


### `utils/path-utils/src/path_utils_tests.rs`

`test` · `test execution`

This file validates the behavior of the `path-utils` crate's small but platform-sensitive helpers. The `symlinks` module contains a Unix-only regression test proving that `resolve_symlink_write_paths` detects cycles and falls back to the original root path as the write target while suppressing a resolved read target. The `wsl` module, enabled on Linux, exercises the pure `normalize_for_wsl_with_flag` helper directly so tests do not depend on the actual runtime environment: `/mnt/C/...` is lowercased, while `/mnt/cc/...` and non-`/mnt` paths are left untouched.

The `native_workdir` module similarly tests `normalize_for_native_workdir_with_flag` in isolation. On Windows, verbatim paths like `\\?\D:\...` are simplified to ordinary drive paths; with the flag disabled, the same input remains unchanged. Finally, the `path_comparison` module checks the public comparison API. Existing identical paths compare equal after normalization, missing paths fall back to raw equality rather than erroring, and on Windows a verbatim path compares equal to its non-verbatim equivalent. These tests are intentionally narrow and concrete: they target the branch conditions and fallback behavior that would be easy to miss when reading the utility implementations.

#### Function details

##### `symlinks::symlink_cycles_fall_back_to_root_write_path`  (lines 8–21)

```
fn symlink_cycles_fall_back_to_root_write_path() -> std::io::Result<()>
```

**Purpose**: Verifies that a two-node symlink cycle is detected and causes `resolve_symlink_write_paths` to return no resolved read target and the original path as the write target. This protects callers from infinite resolution loops.

**Data flow**: Creates a temporary directory, defines paths `a` and `b`, creates symlinks `a -> b` and `b -> a`, calls `resolve_symlink_write_paths(&a)`, and asserts `read_path == None` and `write_path == a` before returning `Ok(())`.

**Call relations**: Unix-only test invoked by the harness to exercise the cycle-detection branch in `resolve_symlink_write_paths`.

*Call graph*: 4 external calls (assert_eq!, symlink, resolve_symlink_write_paths, tempdir).


##### `wsl::wsl_mnt_drive_paths_lowercase`  (lines 31–36)

```
fn wsl_mnt_drive_paths_lowercase()
```

**Purpose**: Checks that WSL normalization lowercases mounted Windows-drive paths when the explicit WSL flag is enabled. It validates the positive case for `/mnt/<drive>` detection.

**Data flow**: Constructs `PathBuf::from("/mnt/C/Users/Dev")`, passes it to `normalize_for_wsl_with_flag(..., true)`, and compares the result with `/mnt/c/users/dev`.

**Call relations**: Linux-only test run by the harness against the pure helper `normalize_for_wsl_with_flag`, avoiding dependence on actual environment detection.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `wsl::wsl_non_drive_paths_unchanged`  (lines 39–44)

```
fn wsl_non_drive_paths_unchanged()
```

**Purpose**: Ensures WSL normalization does not lowercase paths whose second component under `/mnt` is not a single drive letter. This guards against overbroad matching.

**Data flow**: Builds `/mnt/cc/Users/Dev`, clones it, normalizes with `normalize_for_wsl_with_flag(..., true)`, and asserts the result equals the original path.

**Call relations**: Linux-only test invoked by the harness as a negative case for `is_wsl_case_insensitive_path`.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `wsl::wsl_non_mnt_paths_unchanged`  (lines 47–52)

```
fn wsl_non_mnt_paths_unchanged()
```

**Purpose**: Checks that WSL normalization leaves ordinary Linux paths untouched even when WSL mode is enabled. Only mounted Windows-drive paths should be transformed.

**Data flow**: Builds `/home/Dev`, clones it, normalizes with `normalize_for_wsl_with_flag(..., true)`, and compares the result with the original path.

**Call relations**: Linux-only test run by the harness as another negative case for WSL-specific lowercasing.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `native_workdir::windows_verbatim_paths_are_simplified`  (lines 62–70)

```
fn windows_verbatim_paths_are_simplified()
```

**Purpose**: On Windows, verifies that native workdir normalization strips the `\\?\` verbatim prefix. This ensures downstream consumers receive a conventional path spelling.

**Data flow**: Constructs a verbatim `PathBuf`, passes it to `normalize_for_native_workdir_with_flag(path, true)`, and compares the result with the simplified drive path.

**Call relations**: Windows-only test invoked by the harness to exercise the `dunce::simplified` branch of `normalize_for_native_workdir_with_flag`.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_native_workdir_with_flag).


##### `native_workdir::non_windows_paths_are_unchanged`  (lines 73–79)

```
fn non_windows_paths_are_unchanged()
```

**Purpose**: Ensures the native-workdir helper is a no-op when the explicit Windows flag is false. This isolates the platform-conditional behavior.

**Data flow**: Constructs a verbatim-looking `PathBuf`, clones it, passes it to `normalize_for_native_workdir_with_flag(..., false)`, and asserts the result equals the original path.

**Call relations**: Run by the test harness as the negative-path companion to the Windows simplification test.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_native_workdir_with_flag).


##### `path_comparison::matches_identical_existing_paths`  (lines 87–92)

```
fn matches_identical_existing_paths() -> std::io::Result<()>
```

**Purpose**: Checks that two references to the same existing directory compare equal after normalization. This is the straightforward success case for the public comparison API.

**Data flow**: Creates a temporary directory, calls `paths_match_after_normalization(dir.path(), dir.path())`, asserts the result is true, and returns `Ok(())`.

**Call relations**: Invoked by the test harness to exercise the successful canonicalization branch of `paths_match_after_normalization`.

*Call graph*: 2 external calls (assert!, tempdir).


##### `path_comparison::falls_back_to_raw_equality_when_paths_cannot_be_normalized`  (lines 95–104)

```
fn falls_back_to_raw_equality_when_paths_cannot_be_normalized()
```

**Purpose**: Verifies that path comparison falls back to direct equality when canonicalization fails, rather than returning false for all missing paths. It checks both equal and unequal missing-path cases.

**Data flow**: Calls `paths_match_after_normalization` on two identical missing `PathBuf`s and asserts true, then on two different missing `PathBuf`s and asserts false.

**Call relations**: Run by the test harness to validate the fallback branch in `paths_match_after_normalization` when normalization errors occur.

*Call graph*: 1 external calls (assert!).


##### `path_comparison::matches_windows_verbatim_paths`  (lines 108–114)

```
fn matches_windows_verbatim_paths() -> std::io::Result<()>
```

**Purpose**: On Windows, checks that a verbatim path and its ordinary equivalent compare equal after normalization. This confirms the comparison API benefits from workdir-style simplification.

**Data flow**: Creates a temporary directory, formats a verbatim path string `\\?\<dir>`, converts it to `PathBuf`, calls `paths_match_after_normalization(verbatim_dir, dir.path())`, asserts true, and returns `Ok(())`.

**Call relations**: Windows-only test invoked by the harness to validate normalized equality across verbatim and non-verbatim path spellings.

*Call graph*: 4 external calls (from, assert!, format!, tempdir).


### `git-utils/src/fsmonitor_tests.rs`

`test` · `test execution`

This test module validates the conservative fsmonitor policy from `fsmonitor.rs` without spawning real git processes. It defines `ProbeResponse`, which pairs an expected argument vector with an optional byte output, and `FakeRunner`, which stores a `VecDeque` of these scripted responses. The `FsmonitorProbeRunner` implementation pops the next response, asserts that the requested probe arguments exactly match the expected sequence, and returns a ready future containing the scripted output.

The main async test, `detects_supported_builtin_fsmonitor_values`, enumerates a table of scenarios: missing config, helper-path config, explicit false spellings, unsupported Git lacking daemon capability, common true spellings, numeric truthy values, valueless keys, and explicit empty false. Each case constructs the exact probe transcript expected from `detect_fsmonitor_override`, runs the detector, and asserts both the resulting `FsmonitorOverride` and that all scripted responses were consumed. Small helper functions build the canonical argument vectors for the raw config probe, typed bool probe, and capability probe, plus the capability output bytes.

Because the fake runner asserts probe order and arguments, these tests verify not just final outcomes but also the subtle implementation detail that raw effective config is queried before typed normalization.

#### Function details

##### `FakeRunner::run_probe`  (lines 20–24)

```
fn run_probe(&mut self, args: &[&str]) -> impl Future<Output = Option<Vec<u8>>> + Send
```

**Purpose**: Implements the probe trait by replaying scripted responses and asserting the detector asks exactly the expected git probe commands in order.

**Data flow**: Pops the front `ProbeResponse` from `self.responses`, asserts `args == response.args`, and returns a ready future containing `response.output`.

**Call relations**: Called by `detect_fsmonitor_override` during tests; its strict assertions make probe ordering part of the tested behavior.

*Call graph*: 3 external calls (pop_front, assert_eq!, ready).


##### `detects_supported_builtin_fsmonitor_values`  (lines 28–108)

```
async fn detects_supported_builtin_fsmonitor_values()
```

**Purpose**: Runs a table of fsmonitor configuration scenarios and checks that each yields the expected override decision and consumes the expected probes.

**Data flow**: Builds an array of `(name, responses, expected)` cases, constructs a `FakeRunner` for each, awaits `detect_fsmonitor_override(&mut runner)`, and asserts both the returned override and that `runner.responses.len() == 0`.

**Call relations**: This is the module’s main test and exercises the full decision tree in `detect_fsmonitor_override`.

*Call graph*: 3 external calls (assert_eq!, detect_fsmonitor_override, vec!).


##### `response`  (lines 110–115)

```
fn response(args: Vec<&'static str>, output: Option<&[u8]>) -> ProbeResponse
```

**Purpose**: Convenience constructor for one scripted probe response.

**Data flow**: Takes expected `args` and optional byte slice `output`, converts the output to an owned `Vec<u8>` when present, and returns `ProbeResponse`.

**Call relations**: Used by the table-driven test to build fake probe transcripts concisely.


##### `config_args`  (lines 117–119)

```
fn config_args() -> Vec<&'static str>
```

**Purpose**: Returns the canonical raw-config probe argument vector used by the detector.

**Data flow**: Constructs and returns `vec!["config", "--null", "--get", "core.fsmonitor"]`.

**Call relations**: Used in test case setup to mirror the detector’s first probe.

*Call graph*: 1 external calls (vec!).


##### `typed_config_args`  (lines 121–131)

```
fn typed_config_args(value: &'static str) -> Vec<&'static str>
```

**Purpose**: Returns the canonical typed bool-normalization probe argument vector for a specific raw config value.

**Data flow**: Builds and returns the `git config --null --type=bool --fixed-value --get core.fsmonitor <value>` argument list.

**Call relations**: Used in cases where the detector should perform the second-stage bool normalization probe.

*Call graph*: 1 external calls (vec!).


##### `capability_args`  (lines 133–135)

```
fn capability_args() -> Vec<&'static str>
```

**Purpose**: Returns the canonical build-options capability probe argument vector.

**Data flow**: Constructs and returns `vec!["version", "--build-options"]`.

**Call relations**: Used in test cases where a truthy config should trigger daemon capability detection.

*Call graph*: 1 external calls (vec!).


##### `fsmonitor_capability`  (lines 137–139)

```
fn fsmonitor_capability() -> &'static [u8]
```

**Purpose**: Provides the exact capability output bytes that indicate built-in fsmonitor daemon support.

**Data flow**: Returns the static byte string `b"feature: fsmonitor--daemon\n"`.

**Call relations**: Used by tests to simulate a Git build that advertises daemon support.


### Hooks, prompts, and runtime guards
The final group exercises runtime-facing policy presentation and enforcement, including hook engine behavior, rendered permission instructions, and a memory-write rate-limit guard.

### `hooks/src/engine/mod_tests.rs`

`test` · `test-time coverage of startup discovery, preview, and hook execution paths`

This test module exercises the hook engine at the boundary where configuration, discovery, trust, and execution meet. Its helpers construct concrete `HookEventsToml`, `TomlValue`, `ManagedHooksRequirementsToml`, and `ConfigRequirements` values so tests can simulate user config, system config, legacy managed config, MDM requirements, and plugin-provided hooks without relying on external fixtures. Several tests create temporary directories and scripts, then instantiate `ClaudeHooksEngine::new` and inspect both the engine’s internal `handlers` list and externally visible results from `preview_pre_tool_use`, `run_pre_tool_use`, and `crate::list_hooks`.

The main themes are policy precedence and source classification. Managed hooks supplied through requirements remain managed even with `RequirementSource::Unknown`, user disablement cannot suppress managed hooks, and `allow_managed_hooks_only` only takes effect when present in requirements rather than ordinary config TOML. The file also verifies mixed-source discovery details: hooks loaded from both `hooks.json` and TOML in one layer produce a startup warning but both are retained; shared `hooks.json` for base/profile user layers is loaded once; malformed JSON becomes a startup warning instead of a crash. Plugin-specific tests confirm trusted plugin hooks are surfaced as `HookSource::Plugin`, receive plugin environment variables and placeholder expansion, and propagate plugin IDs into listing output. Overall, the tests encode subtle invariants around what counts as managed, trusted, enabled, and executable.

#### Function details

##### `cwd`  (lines 35–37)

```
fn cwd() -> AbsolutePathBuf
```

**Purpose**: Returns the current working directory as an `AbsolutePathBuf` for use in hook requests. The helper centralizes the conversion and panics if the process cwd cannot be resolved.

**Data flow**: Reads process state via `AbsolutePathBuf::current_dir()` → converts the current directory into an absolute-path wrapper → returns that path, or panics with `expect("current dir")` on failure.

**Call relations**: Used by multiple tests that need a realistic `cwd` field in `PreToolUseRequest` values before calling engine preview or execution methods.

*Call graph*: calls 1 internal fn (current_dir); called by 6 (discovers_hooks_from_json_and_toml_in_the_same_layer, plugin_hook_sources_run_with_plugin_env_and_plugin_source, profile_user_layers_load_shared_hooks_json_once, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing).


##### `managed_hooks_for_current_platform`  (lines 39–57)

```
fn managed_hooks_for_current_platform(
    managed_dir: impl AsRef<Path>,
    hooks: HookEventsToml,
) -> ManagedHooksRequirementsToml
```

**Purpose**: Builds a `ManagedHooksRequirementsToml` that places the managed hooks directory into the platform-appropriate field. It abstracts the Windows/non-Windows split between `managed_dir` and `windows_managed_dir`.

**Data flow**: Takes a path-like `managed_dir` and a `HookEventsToml` payload → clones the path and, based on `cfg!(windows)`, stores it in either `managed_dir` or `windows_managed_dir` while leaving the other `None` → returns the assembled `ManagedHooksRequirementsToml`.

**Call relations**: Called by tests that model managed hooks coming from requirements; those tests then feed the returned structure into `ConfigRequirements` and `ConfigRequirementsToml` before constructing a `ConfigLayerStack`.

*Call graph*: called by 6 (allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing, unknown_requirement_source_hooks_stay_managed, user_disablement_filters_non_managed_hooks_but_not_managed_hooks); 3 external calls (as_ref, clone, cfg!).


##### `pre_tool_use_hook_events`  (lines 59–73)

```
fn pre_tool_use_hook_events(command: impl Into<String>) -> HookEventsToml
```

**Purpose**: Creates a minimal `HookEventsToml` containing one `PreToolUse` matcher group for the `Bash` tool and one command handler. It is a compact fixture for tests that only care about one hook event.

**Data flow**: Accepts a command string → embeds it into `HookHandlerConfig::Command` with timeout 10, synchronous execution, and status message `checking`, wrapped in a `MatcherGroup` matching `^Bash$` → returns a `HookEventsToml` with other events left at `Default`.

**Call relations**: Used where tests need a concise managed or plugin hook definition without manually constructing the full TOML structure.

*Call graph*: called by 1 (allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks); 2 external calls (default, vec!).


##### `config_toml_with_pre_tool_use`  (lines 75–113)

```
fn config_toml_with_pre_tool_use(command: &str) -> TomlValue
```

**Purpose**: Constructs a raw `TomlValue` tree representing a config file with one `hooks.PreToolUse` command hook. It intentionally builds the nested TOML structure by hand to mirror config parsing inputs.

**Data flow**: Starts from an empty root `TomlValue::Table` → creates nested `hooks`, `PreToolUse`, matcher-group, and handler tables/arrays → inserts `type=command`, `command`, `timeout=10`, and `statusMessage=checking` → returns the finished TOML value.

**Call relations**: Used by tests that need a user/system config layer containing TOML-defined hooks, especially policy tests around `allow_managed_hooks_only` and mixed-source discovery.

*Call graph*: called by 1 (allow_managed_hooks_only_in_config_toml_does_not_enable_policy); 7 external calls (default, Array, Integer, String, Table, unreachable!, vec!).


##### `requirements_with_managed_hooks_only`  (lines 115–139)

```
fn requirements_with_managed_hooks_only(
    allow_managed_hooks_only: bool,
    managed_hooks: Option<ManagedHooksRequirementsToml>,
) -> (ConfigRequirements, ConfigRequirementsToml)
```

**Purpose**: Builds matching runtime and TOML representations of the managed-hooks-only policy. It packages both `ConfigRequirements` and `ConfigRequirementsToml` so tests can initialize `ConfigLayerStack::new` consistently.

**Data flow**: Takes a boolean policy flag and optional managed hooks definition → wraps the boolean in `Sourced<bool>` with `RequirementSource::LegacyManagedConfigTomlFromMdm`, wraps managed hooks in `ConstrainedWithSource<ManagedHooksRequirementsToml>` when present, and mirrors the same values into `ConfigRequirementsToml` → returns the pair.

**Call relations**: Used by tests that compare behavior when the policy is absent, false, or true, and when managed hooks are or are not supplied alongside it.

*Call graph*: calls 1 internal fn (new); called by 4 (allow_managed_hooks_only_false_keeps_unmanaged_hooks, allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks, allow_managed_hooks_only_skips_unmanaged_plugin_hooks); 2 external calls (default, default).


##### `requirements_managed_hooks_execute_from_managed_dir`  (lines 142–262)

```
async fn requirements_managed_hooks_execute_from_managed_dir()
```

**Purpose**: Verifies that managed hooks supplied through requirements execute successfully, are marked as managed, and use the managed directory as their source path. It also confirms the hook receives serialized `PreToolUse` input by having a Python script append stdin JSON to a log file.

**Data flow**: Creates a temp managed-hooks directory and writes a Python script plus log path → builds managed hook requirements pointing at that script → constructs a `ConfigLayerStack`, then a `ClaudeHooksEngine` → checks warnings, handler count/source, and `list_hooks` metadata → previews a `PreToolUseRequest` and asserts the preview source path equals the managed dir → runs the hook asynchronously and reads the log file to confirm the payload contained `hook_event_name: PreToolUse`.

**Call relations**: This is a top-level async test that drives the full path from requirements-based discovery through preview and actual command execution.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new, try_from); 15 external calls (default, new, new, default, assert!, assert_eq!, default, list_hooks, format!, create_dir_all (+5 more)).


##### `requirements_managed_hooks_execute_windows_command_override`  (lines 265–342)

```
async fn requirements_managed_hooks_execute_windows_command_override()
```

**Purpose**: Checks that managed command hooks honor `command_windows` on Windows and the normal `command` elsewhere. The test uses failing shell commands so the selected branch is visible in the reported exit code.

**Data flow**: Builds managed hooks with `command = "exit 17"` and `command_windows = Some("exit /B 19")` → creates engine and runs a `PreToolUseRequest` → computes expected exit code from `cfg!(windows)` → asserts the single hook event failed with one `Error` entry saying `hook exited with code {expected_exit_code}`.

**Call relations**: Invoked as an async integration test of execution-time command selection after managed-hook discovery.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new, try_from); 12 external calls (default, new, new, default, assert!, assert_eq!, cfg!, default, create_dir_all, json! (+2 more)).


##### `unknown_requirement_source_hooks_stay_managed`  (lines 345–410)

```
fn unknown_requirement_source_hooks_stay_managed()
```

**Purpose**: Ensures hooks originating from requirements remain classified as managed even when the requirement source is `Unknown`. The source enum changes, but managed/trust semantics must not degrade.

**Data flow**: Creates managed hook requirements tagged with `RequirementSource::Unknown` → builds engine and separately calls discovery → asserts the engine handler source is `HookSource::Unknown`, and the discovered entry is enabled, `is_managed = true`, and `trust_status = HookTrustStatus::Managed`.

**Call relations**: This test covers the discovery/classification path rather than execution, checking both engine materialization and raw discovery output.

*Call graph*: calls 7 internal fn (new, allow_any, new, new, discover_handlers, managed_hooks_for_current_platform, try_from); 9 external calls (default, new, new, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `user_disablement_filters_non_managed_hooks_but_not_managed_hooks`  (lines 413–498)

```
fn user_disablement_filters_non_managed_hooks_but_not_managed_hooks()
```

**Purpose**: Verifies that user hook-state disablement can suppress a user hook but cannot suppress a managed hook, even if the user config contains disabled state entries for both keys. It tests the filtering boundary between managed and unmanaged sources.

**Data flow**: Creates a managed hook requirement and a user config TOML containing one user `PreToolUse` hook plus disabled state entries for both the managed hook key and the user hook key → builds engine and discovery output → asserts only the managed hook remains in `engine.handlers`, while discovery still lists both entries with the managed one enabled and the user one disabled.

**Call relations**: Runs through discovery and engine construction to prove that disablement state is interpreted differently depending on `is_managed`.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, discover_handlers, config_with_pre_tool_use_hook_and_states, managed_hooks_for_current_platform, try_from); 11 external calls (default, new, new, default, assert!, assert_eq!, default, format!, create_dir_all, tempdir (+1 more)).


##### `user_disablement_does_not_filter_managed_layer_hooks`  (lines 501–561)

```
fn user_disablement_does_not_filter_managed_layer_hooks()
```

**Purpose**: Checks that hooks loaded from a managed config layer are not disabled by user hook-state entries targeting their key. This covers managed config layers, not just managed requirements.

**Data flow**: Builds a `ConfigLayerStack` with a user layer containing `hooks.state` disabling a managed-layer key and a legacy managed config layer containing a `PreToolUse` hook → constructs engine and discovery output → asserts the managed hook is still present, enabled, managed, and trusted as `Managed`.

**Call relations**: This test complements the previous one by exercising managed-layer hooks instead of requirement-injected hooks.

*Call graph*: calls 4 internal fn (new, new, discover_handlers, try_from); 9 external calls (new, new, default, assert!, assert_eq!, default, format!, tempdir, vec!).


##### `config_with_hook_state`  (lines 563–574)

```
fn config_with_hook_state(key: &str, enabled: bool) -> TomlValue
```

**Purpose**: Creates a TOML value containing a single `hooks.state.<key>.enabled` entry. It is a small fixture for tests that need only hook-state overrides.

**Data flow**: Takes a hook key and boolean → builds a JSON object with nested `hooks.state` structure → deserializes it into `TomlValue` via `serde_json::from_value` → returns the TOML representation.

**Call relations**: Used to populate user config layers that disable a specific discovered hook key.

*Call graph*: 2 external calls (from_value, json!).


##### `config_with_pre_tool_use_hook_and_states`  (lines 576–596)

```
fn config_with_pre_tool_use_hook_and_states(
    command: &str,
    disabled_keys: [&str; N],
) -> TomlValue
```

**Purpose**: Builds a TOML config containing both a `PreToolUse` command hook and a `hooks.state` map disabling an arbitrary set of keys. It lets tests model user config that defines hooks while also storing per-hook state.

**Data flow**: Accepts a command string and fixed-size array of disabled keys → maps each key to `{ enabled: false }` in a `serde_json::Map` → embeds that map plus a `PreToolUse` command hook into a JSON object → converts it into `TomlValue` and returns it.

**Call relations**: Used by the disablement test that needs one user hook plus disabled-state entries for both managed and user hook keys.

*Call graph*: called by 1 (user_disablement_filters_non_managed_hooks_but_not_managed_hooks); 2 external calls (from_value, json!).


##### `config_with_pre_tool_use_hook`  (lines 598–610)

```
fn config_with_pre_tool_use_hook(command: &str) -> TomlValue
```

**Purpose**: Creates a TOML config containing only one `PreToolUse` command hook. It is the simplest fixture for managed-layer hook definitions.

**Data flow**: Takes a command string → builds a JSON object with `hooks.PreToolUse[0].hooks[0] = { type: "command", command }` → deserializes to `TomlValue` and returns it.

**Call relations**: Used in tests that need a config layer with a single hook and no state metadata.

*Call graph*: 2 external calls (from_value, json!).


##### `trusted_plugin_hook_stack`  (lines 612–653)

```
fn trusted_plugin_hook_stack(
    config_path: AbsolutePathBuf,
    plugin_hook_sources: &[PluginHookSource],
) -> ConfigLayerStack
```

**Purpose**: Synthesizes a user config layer that marks discovered plugin hooks as trusted by storing each hook’s current hash in `hooks.state`. This allows plugin hook execution tests to bypass trust prompts without bypassing trust logic globally.

**Data flow**: Takes a config path and plugin hook sources → calls discovery with no config stack to obtain plugin `hook_entries` and their `current_hash` values → builds a `hooks.state` map of `trusted_hash` entries keyed by discovered hook key → wraps that config in a user `ConfigLayerEntry` and returns a new `ConfigLayerStack`.

**Call relations**: Called by plugin execution tests before constructing `ClaudeHooksEngine`, so those tests can exercise the normal trusted-plugin path.

*Call graph*: calls 2 internal fn (new, discover_handlers); called by 2 (plugin_hook_sources_expand_plugin_placeholders, plugin_hook_sources_run_with_plugin_env_and_plugin_source); 7 external calls (new, default, default, to_vec, from_value, json!, vec!).


##### `requirements_managed_hooks_load_when_managed_dir_is_missing`  (lines 656–724)

```
fn requirements_managed_hooks_load_when_managed_dir_is_missing()
```

**Purpose**: Confirms that managed hooks still load from requirements even if the referenced managed directory does not exist on disk. The source path should still point at the configured directory and the command should remain intact.

**Data flow**: Creates a temp path for a missing managed directory without creating it → builds managed hook requirements pointing there → constructs engine → asserts no warnings, previews one matching hook, and checks the handler command is `echo hi` while `source_path` equals the missing absolute directory.

**Call relations**: This test targets startup/discovery behavior and ensures missing directories do not silently drop requirement-defined hooks.

*Call graph*: calls 7 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new); 10 external calls (default, new, new, default, assert!, assert_eq!, default, json!, tempdir, vec!).


##### `allow_managed_hooks_only_false_keeps_unmanaged_hooks`  (lines 727–773)

```
fn allow_managed_hooks_only_false_keeps_unmanaged_hooks()
```

**Purpose**: Shows that setting `allow_managed_hooks_only` to `false` in requirements does not remove unmanaged hooks from discovery. The engine still excludes them from active handlers because they are untrusted, but discovery retains them.

**Data flow**: Builds a user config layer with one TOML `PreToolUse` hook and requirements where `allow_managed_hooks_only = false` → constructs engine and discovery output → asserts no warnings, `engine.handlers` is empty, and discovery still contains one unmanaged hook with the expected command.

**Call relations**: This test distinguishes discovery from activation and demonstrates that the policy flag only filters when true.

*Call graph*: calls 5 internal fn (new, new, discover_handlers, requirements_with_managed_hooks_only, try_from); 6 external calls (new, new, assert!, assert_eq!, tempdir, vec!).


##### `allow_managed_hooks_only_in_config_toml_does_not_enable_policy`  (lines 776–827)

```
fn allow_managed_hooks_only_in_config_toml_does_not_enable_policy()
```

**Purpose**: Verifies that a user config file setting `allow_managed_hooks_only = true` does not activate the managed-only policy. Only requirements, not ordinary config TOML, can enforce that restriction.

**Data flow**: Builds a TOML config with one `PreToolUse` hook and manually inserts root-level `allow_managed_hooks_only = true` → constructs engine and discovery output with default requirements → asserts no warnings, no active handlers, and one discovered unmanaged hook remains present.

**Call relations**: This test complements the requirements-based policy tests by proving the same field in plain config is informational or ignored for enforcement.

*Call graph*: calls 5 internal fn (new, new, discover_handlers, config_toml_with_pre_tool_use, try_from); 10 external calls (new, Boolean, new, default, assert!, assert_eq!, default, tempdir, unreachable!, vec!).


##### `allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks`  (lines 830–885)

```
fn allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks()
```

**Purpose**: Checks that when the managed-only policy is enabled through requirements, unmanaged hooks from both `hooks.json` and TOML are skipped entirely. The engine should start cleanly with no handlers and no warnings.

**Data flow**: Writes a `hooks.json` file containing a `PreToolUse` hook next to a user config TOML containing another `PreToolUse` hook → builds requirements with `allow_managed_hooks_only = true` and no managed hooks → constructs engine → asserts `handlers` is empty and `warnings` is empty.

**Call relations**: This test exercises startup filtering across both file formats within the same unmanaged layer.

*Call graph*: calls 4 internal fn (new, new, requirements_with_managed_hooks_only, try_from); 6 external calls (new, new, assert!, write, tempdir, vec!).


##### `allow_managed_hooks_only_skips_unmanaged_plugin_hooks`  (lines 888–924)

```
fn allow_managed_hooks_only_skips_unmanaged_plugin_hooks()
```

**Purpose**: Verifies that the managed-only policy also excludes plugin-provided hooks when they are not managed. Plugin hooks are treated like other unmanaged sources for this policy.

**Data flow**: Creates a `PluginHookSource` with one `PreToolUse` command hook → builds a config stack with requirements enabling managed-only mode → constructs engine with the plugin source → asserts no handlers and no warnings.

**Call relations**: This extends managed-only filtering coverage from config-file hooks to plugin hook sources.

*Call graph*: calls 5 internal fn (new, new, requirements_with_managed_hooks_only, parse, try_from); 5 external calls (new, new, assert!, tempdir, vec!).


##### `allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks`  (lines 927–1016)

```
fn allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks()
```

**Purpose**: Ensures managed-only mode preserves every managed source type: requirement-injected hooks, MDM layer hooks, system layer hooks, and legacy managed config layers. It also verifies all discovered entries are marked managed.

**Data flow**: Creates managed requirement hooks plus four config layers (`Mdm`, `System`, `LegacyManagedConfigTomlFromFile`, `LegacyManagedConfigTomlFromMdm`) each with one `PreToolUse` hook → enables managed-only requirements → constructs engine and discovery output → asserts the active handler commands appear in managed precedence order and every discovered entry has `is_managed = true`.

**Call relations**: This is the positive counterpart to the managed-only exclusion tests, proving which sources survive the filter.

*Call graph*: calls 7 internal fn (new, new, discover_handlers, managed_hooks_for_current_platform, pre_tool_use_hook_events, requirements_with_managed_hooks_only, try_from); 7 external calls (new, new, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `discovers_hooks_from_json_and_toml_in_the_same_layer`  (lines 1019–1135)

```
fn discovers_hooks_from_json_and_toml_in_the_same_layer()
```

**Purpose**: Tests that a single config layer can contribute hooks from both adjacent `hooks.json` and inline TOML, with both retained and a warning emitted about dual loading. It also checks preview ordering and source-path attribution.

**Data flow**: Writes a `hooks.json` file and manually builds a TOML config in the same directory, both defining `PreToolUse` hooks → constructs a system-layer stack and engine → asserts a warning mentions both file paths, preview returns two hooks, both handlers have `HookSource::System`, and preview source paths are `hooks.json` then `config.toml`.

**Call relations**: This test drives discovery plus preview to validate mixed-source layer behavior and warning generation.

*Call graph*: calls 5 internal fn (new, new, cwd, new, try_from); 15 external calls (default, new, Array, String, Table, new, default, assert!, assert_eq!, default (+5 more)).


##### `profile_user_layers_load_shared_hooks_json_once`  (lines 1138–1226)

```
fn profile_user_layers_load_shared_hooks_json_once()
```

**Purpose**: Verifies that base user config and profile user config sharing the same directory do not cause the same `hooks.json` file to be loaded twice. The shared JSON hook should appear once in both engine preview and `list_hooks` output.

**Data flow**: Creates empty base and profile user config layers in one temp directory, writes one shared `hooks.json`, and constructs the engine with trust bypass enabled → asserts one handler and one preview row sourced from `hooks.json` → calls `crate::list_hooks` and asserts it also reports exactly one hook with no warnings.

**Call relations**: This test covers deduplication logic across multiple user layers that point at the same hooks file.

*Call graph*: calls 5 internal fn (new, new, cwd, new, try_from); 12 external calls (default, new, new, default, assert!, assert_eq!, default, list_hooks, write, json! (+2 more)).


##### `malformed_hooks_json_is_reported_as_startup_warning`  (lines 1229–1282)

```
fn malformed_hooks_json_is_reported_as_startup_warning()
```

**Purpose**: Checks that invalid `hooks.json` content becomes a startup warning rather than crashing or producing handlers. The warning must identify the file and include the parse error detail.

**Data flow**: Writes malformed hook JSON using an unsupported top-level field (`SessionStart` in the wrong shape) → constructs a system-layer engine → asserts no handlers, exactly one warning, and that the warning contains the file path plus `failed to parse hooks config` and `unknown field `SessionStart``.

**Call relations**: This test targets startup robustness and warning propagation from hooks-file parsing.

*Call graph*: calls 3 internal fn (new, new, try_from); 9 external calls (new, new, default, assert!, assert_eq!, default, write, tempdir, vec!).


##### `plugin_hook_sources_run_with_plugin_env_and_plugin_source`  (lines 1285–1414)

```
async fn plugin_hook_sources_run_with_plugin_env_and_plugin_source()
```

**Purpose**: Exercises trusted plugin hook execution end-to-end, confirming plugin hooks preview and run as `HookSource::Plugin`, expose plugin IDs in listing output, and receive plugin root environment variables. The hook script prints those env vars back as JSON so the test can inspect them.

**Data flow**: Creates plugin root/data directories and a Python script under `hooks/` that emits `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` → builds a `PluginHookSource`, synthesizes trusted state with `trusted_plugin_hook_stack`, and constructs the engine → previews and lists hooks to verify source/path/plugin ID → runs `PreToolUse`, then parses the warning entry text as JSON and asserts both env vars equal the plugin root path.

**Call relations**: This async test covers plugin discovery, trust, preview, listing, environment injection, and execution output parsing in one flow.

*Call graph*: calls 6 internal fn (new, cwd, trusted_plugin_hook_stack, parse, new, try_from); 10 external calls (new, new, assert_eq!, list_hooks, create_dir_all, write, from_str, json!, tempdir, vec!).


##### `plugin_hook_sources_expand_plugin_placeholders`  (lines 1417–1491)

```
fn plugin_hook_sources_expand_plugin_placeholders()
```

**Purpose**: Verifies placeholder substitution for plugin hook commands and environment maps. `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_DATA}`, and `${CLAUDE_PLUGIN_DATA}` must be expanded before execution.

**Data flow**: Creates a plugin hook source whose command string contains all four placeholders → builds a trusted config stack and engine → asserts the first handler’s `command` string contains the concrete plugin root/data paths and its `env` map contains the same four resolved variables.

**Call relations**: This test inspects engine handler materialization after plugin discovery rather than running the command.

*Call graph*: calls 4 internal fn (new, trusted_plugin_hook_stack, parse, try_from); 5 external calls (new, new, assert_eq!, tempdir, vec!).


##### `plugin_hook_load_warnings_are_startup_warnings`  (lines 1494–1508)

```
fn plugin_hook_load_warnings_are_startup_warnings()
```

**Purpose**: Checks that warnings produced while loading plugin hooks are surfaced directly as engine startup warnings. No config stack or handlers are needed.

**Data flow**: Constructs `ClaudeHooksEngine` with an explicit `plugin_hook_load_warnings` vector containing one string → reads `engine.warnings()` → asserts it equals that single warning.

**Call relations**: This is a narrow startup-warning propagation test for plugin loading failures.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, assert_eq!, vec!).


### `prompts/src/permissions_instructions_tests.rs`

`test` · `test run`

This test module validates both the public `PermissionsInstructions` constructors and several internal formatting helpers from `permissions_instructions.rs`. It checks that `sandbox_text` renders the expected one-line descriptions for `WorkspaceWrite`, `ReadOnly`, and `DangerFullAccess`, including network-access wording. Several tests construct `PermissionsPromptConfig` values and call the test-only `from_permissions_with_network` helper to isolate approval-policy behavior without needing a full `PermissionProfile`; these verify inclusion of escalation guidance, approved command prefixes, inline shell permission request instructions, and the `# request_permissions Tool` section under the right combinations of `AskForApproval`, `exec_permission_approvals_enabled`, and `request_permissions_tool_enabled`. Profile-based tests build realistic `PermissionProfile` values from `FileSystemSandboxPolicy` and `NetworkSandboxPolicy`, including writable roots and explicit deny entries for roots and glob patterns, then assert that the final body includes writable-root paths and the denied-read warning section. The module also contains helper functions to build expected granular-policy strings, allowing exact `assert_eq!` comparisons for prompted versus auto-rejected categories and for whether shell-permission or tool sections should appear. Together these tests document subtle invariants: auto-review suffixes are omitted for `Never`, the request-permissions category is not listed when the tool is globally unavailable, and granular category visibility depends on both config and feature availability.

#### Function details

##### `renders_sandbox_mode_text`  (lines 14–29)

```
fn renders_sandbox_mode_text()
```

**Purpose**: Checks the exact rendered sandbox descriptions for all three sandbox modes and both restricted/enabled network wording combinations used in the assertions.

**Data flow**: Calls `sandbox_text` with concrete `SandboxMode` and `NetworkAccess` pairs, compares each returned string against a hard-coded expected sentence using `assert_eq!`, and returns nothing.

**Call relations**: Executed by the test harness as a direct regression test for template rendering. It validates the static sandbox templates independently of the larger permissions assembly flow.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_permissions_with_network_access_override`  (lines 32–55)

```
fn builds_permissions_with_network_access_override()
```

**Purpose**: Verifies that the test-only constructor can inject explicit network access and still include approval guidance in the final permissions body.

**Data flow**: Builds a `PermissionsPromptConfig` for `AskForApproval::OnRequest`, calls `PermissionsInstructions::from_permissions_with_network` with `WorkspaceWrite` and `NetworkAccess::Enabled`, extracts the body string, and asserts that it mentions enabled network access and escalation guidance.

**Call relations**: This test isolates the constructor path that bypasses `PermissionProfile`. It confirms that explicit network-access inputs propagate through to the rendered text.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `builds_permissions_from_profile`  (lines 58–85)

```
fn builds_permissions_from_profile()
```

**Purpose**: Checks end-to-end rendering from a real `PermissionProfile` containing a writable root and enabled network access.

**Data flow**: Creates a `/tmp` cwd, constructs an absolute writable root under it, builds a restricted `FileSystemSandboxPolicy` with write access to that root, wraps it in a `PermissionProfile` with enabled network, passes everything to `from_permission_profile`, then asserts the body contains workspace-write mode, enabled network text, and the writable-root path.

**Call relations**: Run by the test harness to cover the main public constructor. It exercises the path through policy reduction helpers rather than the direct test-only constructor.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); 4 external calls (from, assert!, empty, vec!).


##### `builds_permissions_from_profile_with_denied_reads`  (lines 88–131)

```
fn builds_permissions_from_profile_with_denied_reads()
```

**Purpose**: Ensures denied filesystem roots and glob patterns are surfaced in a dedicated warning section that forbids escalation requests.

**Data flow**: Builds a cwd, a denied absolute root, and a denied glob under that cwd; constructs a restricted filesystem policy with root read access plus explicit deny entries; wraps it in a restricted-network `PermissionProfile`; renders permissions instructions; and asserts the body contains the denied-reads heading, anti-escalation wording, the denied root path, and the denied glob.

**Call relations**: This test covers the `denied_reads_text` branch reached through `from_permission_profile`. It verifies that policy denials are represented distinctly from ordinary approval-gated restrictions.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert!, test_path_buf, empty, vec!).


##### `includes_request_rule_instructions_for_on_request`  (lines 134–156)

```
fn includes_request_rule_instructions_for_on_request()
```

**Purpose**: Checks that `OnRequest` approval text includes approved command prefix information when the execution policy already allows a prefix rule.

**Data flow**: Creates a mutable empty `Policy`, adds an allow prefix rule for `git pull`, renders permissions instructions via `from_permissions_with_network` using `AskForApproval::OnRequest`, then asserts the body mentions `prefix_rule`, the approved-prefixes section heading, and the serialized prefix array.

**Call relations**: Invoked by the test harness to validate the interaction between on-request approval text and execution-policy allow prefixes.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled`  (lines 159–176)

```
fn includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled()
```

**Purpose**: Verifies that `UnlessTrusted` approval text appends the `request_permissions` tool section when that tool is enabled.

**Data flow**: Constructs permissions instructions with `AskForApproval::UnlessTrusted` and `request_permissions_tool_enabled = true`, reads the body, and asserts it contains both the policy identifier and the `# request_permissions Tool` heading.

**Call relations**: This test targets the closure path inside `approval_text` that conditionally appends tool guidance to non-granular policy templates.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_on_failure_when_enabled`  (lines 179–196)

```
fn includes_request_permissions_tool_instructions_for_on_failure_when_enabled()
```

**Purpose**: Checks the same tool-guidance behavior for the `OnFailure` approval policy.

**Data flow**: Builds instructions with `AskForApproval::OnFailure` and tool enabled, extracts the body, and asserts presence of the on-failure policy wording and the tool section heading.

**Call relations**: Run independently to confirm `approval_text` applies the same conditional tool-section logic to the on-failure branch.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permission_rule_instructions_for_on_request_when_enabled`  (lines 199–216)

```
fn includes_request_permission_rule_instructions_for_on_request_when_enabled()
```

**Purpose**: Ensures `OnRequest` approval text switches to the inline shell permission request instructions when exec permission approvals are enabled.

**Data flow**: Calls `from_permissions_with_network` with `AskForApproval::OnRequest`, `exec_permission_approvals_enabled = true`, and tool disabled; then asserts the body contains `with_additional_permissions` and `additional_permissions`, indicating the alternate on-request rule template was selected.

**Call relations**: This test covers the branch in `approval_text` where on-request guidance changes based on inline shell permission request support.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled`  (lines 219–236)

```
fn includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled()
```

**Purpose**: Checks that `OnRequest` approval text includes the dedicated tool section when the request-permissions tool is available.

**Data flow**: Builds instructions with `AskForApproval::OnRequest` and `request_permissions_tool_enabled = true`, then asserts the body contains the tool heading and explanatory sentence about the built-in tool.

**Call relations**: This test validates the on-request composition path where tool guidance is appended alongside the base on-request instructions.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist`  (lines 239–256)

```
fn on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist()
```

**Purpose**: Verifies that on-request approval text can include both inline shell permission request guidance and the separate tool section simultaneously.

**Data flow**: Constructs instructions with `AskForApproval::OnRequest`, both `exec_permission_approvals_enabled` and `request_permissions_tool_enabled` set true, then asserts the body contains markers from both instruction styles.

**Call relations**: This test covers the combined-feature case in `approval_text`, ensuring one guidance path does not suppress the other.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `auto_review_approvals_append_auto_review_specific_guidance`  (lines 259–271)

```
fn auto_review_approvals_append_auto_review_specific_guidance()
```

**Purpose**: Checks that non-`Never` approval policies gain the auto-review suffix when approvals are reviewed automatically.

**Data flow**: Calls `approval_text` directly with `AskForApproval::OnRequest`, `ApprovalsReviewer::AutoReview`, and empty policy/disabled flags, then asserts the returned text mentions `auto_review`, omits the old `guardian_subagent` wording, and includes the safer-alternative guidance.

**Call relations**: This is a focused unit test for the final suffix-appending branch in `approval_text`.

*Call graph*: 2 external calls (assert!, empty).


##### `auto_review_approvals_omit_auto_review_specific_guidance_when_approval_is_never`  (lines 274–285)

```
fn auto_review_approvals_omit_auto_review_specific_guidance_when_approval_is_never()
```

**Purpose**: Ensures the auto-review suffix is not appended when the approval policy is `Never`, even if the reviewer mode is auto-review.

**Data flow**: Calls `approval_text` with `AskForApproval::Never` and `ApprovalsReviewer::AutoReview`, then asserts the returned text contains neither the auto-review wording nor the deprecated guardian wording.

**Call relations**: This test covers the explicit exception in `approval_text` that suppresses auto-review guidance when no approvals can ever occur.

*Call graph*: 2 external calls (assert!, empty).


##### `granular_categories_section`  (lines 287–289)

```
fn granular_categories_section(title: &str, categories: &[&str]) -> String
```

**Purpose**: Formats a titled granular-category section by joining bullet lines under the supplied heading.

**Data flow**: Accepts a title string and a slice of category lines, concatenates them with a newline after the title, and returns the resulting `String`.

**Call relations**: Used only by `granular_prompt_expected` inside this test module to build exact expected strings for granular approval assertions.

*Call graph*: called by 1 (granular_prompt_expected); 1 external calls (format!).


##### `granular_prompt_expected`  (lines 291–317)

```
fn granular_prompt_expected(
    prompted_categories: &[&str],
    rejected_categories: &[&str],
    include_shell_permission_request_instructions: bool,
    include_request_permissions_tool_section:
```

**Purpose**: Builds the expected full granular approval text for tests, mirroring the production section ordering and optional inclusions.

**Data flow**: Starts with `granular_prompt_intro_text`, conditionally appends prompted and rejected category sections via `granular_categories_section`, conditionally appends the shell permission request template and request-permissions tool section based on boolean flags, joins sections with blank lines, and returns the expected string.

**Call relations**: This helper is called by multiple granular-policy tests to avoid duplicating long expected strings while still asserting exact output.

*Call graph*: calls 1 internal fn (granular_categories_section); 1 external calls (vec!).


##### `granular_policy_lists_prompted_and_rejected_categories_separately`  (lines 320–354)

```
fn granular_policy_lists_prompted_and_rejected_categories_separately()
```

**Purpose**: Checks that granular approval text splits allowed and disallowed categories into separate sections and omits categories that should not appear.

**Data flow**: Calls `approval_text` with a `GranularApprovalConfig` where only `rules` is allowed among the visible categories, then compares the entire returned string against a manually assembled expected value using `assert_eq!`.

**Call relations**: This test exercises the category partitioning logic inside `granular_instructions` through the public `approval_text` entry.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_includes_command_permission_instructions_when_sandbox_approval_can_prompt`  (lines 357–386)

```
fn granular_policy_includes_command_permission_instructions_when_sandbox_approval_can_prompt()
```

**Purpose**: Verifies that granular approval text includes inline shell permission request instructions when sandbox approval is allowed and exec permission approvals are enabled.

**Data flow**: Builds an all-true `GranularApprovalConfig`, calls `approval_text` with inline permission approvals enabled and tool disabled, then compares the full output to `granular_prompt_expected` configured to include shell permission request instructions.

**Call relations**: This test covers the `shell_permission_requests_available` branch in `granular_instructions`.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_omits_shell_permission_instructions_when_inline_requests_are_disabled`  (lines 389–418)

```
fn granular_policy_omits_shell_permission_instructions_when_inline_requests_are_disabled()
```

**Purpose**: Ensures granular approval text does not include shell permission request instructions when the global inline-request feature is disabled.

**Data flow**: Uses an all-true granular config but passes `exec_permission_approvals_enabled = false` into `approval_text`, then asserts exact equality with an expected string that omits the shell-permission section.

**Call relations**: This test isolates the global feature-flag gate that suppresses one optional section in `granular_instructions`.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_includes_request_permissions_tool_only_when_that_prompt_can_still_fire`  (lines 421–451)

```
fn granular_policy_includes_request_permissions_tool_only_when_that_prompt_can_still_fire()
```

**Purpose**: Checks that the `request_permissions` tool section appears only when both the tool is globally enabled and the granular category itself is allowed.

**Data flow**: Calls `approval_text` twice with tool enabled: once with `request_permissions = true` and once with it false. It asserts the first output contains the tool heading and the second does not.

**Call relations**: This test targets the `request_permissions_tool_prompts_allowed` condition inside `granular_instructions`.

*Call graph*: 3 external calls (Granular, assert!, empty).


##### `granular_policy_lists_request_permissions_category_without_tool_section_when_tool_unavailable`  (lines 454–471)

```
fn granular_policy_lists_request_permissions_category_without_tool_section_when_tool_unavailable()
```

**Purpose**: Verifies that when the tool is globally unavailable, the granular output neither lists the `request_permissions` category nor includes the tool section.

**Data flow**: Calls `approval_text` with a granular config that allows only `request_permissions` among the hidden/tool-dependent category and with `request_permissions_tool_enabled = false`, then asserts the output lacks both the category bullet and the tool heading.

**Call relations**: This test documents a subtle design choice in `granular_instructions`: the request-permissions category is omitted entirely when the corresponding tool cannot be used in the session.

*Call graph*: 3 external calls (Granular, assert!, empty).


### `memories/write/src/guard_tests.rs`

`test` · `test execution`

This test module exercises the pure decision logic in `guard.rs`, especially `snapshot_allows_startup`. Two local helpers construct protocol objects with only the fields relevant to startup gating. `snapshot` always sets `limit_id` to the crate’s Codex limit identifier and leaves unrelated fields like credits and plan metadata as `None`; it maps optional used-percent values into optional windows via the `window` helper. `window` itself creates a `RateLimitWindow` with just `used_percent` populated.

The tests cover three policy dimensions. First, `startup_check_uses_configured_remaining_threshold` verifies the conversion from minimum remaining percent to maximum used percent by checking that 89.9% used passes when 10% remaining is required but fails when 11% remaining is required. Second, `startup_check_skips_when_primary_or_secondary_is_too_low` confirms that either primary or secondary exceeding the threshold blocks startup, while both just under the threshold allow it. Third, `startup_check_skips_when_limit_is_reached` mutates an otherwise healthy snapshot to set `rate_limit_reached_type`, proving that this flag overrides percentage calculations and forces a denial.

These tests are intentionally pure and synchronous: they avoid auth and backend I/O entirely and pin down the startup policy at the snapshot-comparison layer.

#### Function details

##### `snapshot`  (lines 4–18)

```
fn snapshot(
    primary_used_percent: Option<f64>,
    secondary_used_percent: Option<f64>,
) -> RateLimitSnapshot
```

**Purpose**: Builds a `RateLimitSnapshot` fixture with optional primary and secondary windows and the crate’s Codex limit identifier. It leaves unrelated protocol fields unset so tests can focus on startup gating inputs.

**Data flow**: Accepts `primary_used_percent: Option<f64>` and `secondary_used_percent: Option<f64>`, converts each present value with `window`, and returns a `RateLimitSnapshot` populated with `limit_id = Some(CODEX_LIMIT_ID.to_string())`, optional `primary` and `secondary`, and `None` for all other fields including `rate_limit_reached_type`.

**Call relations**: This helper is used by tests such as `startup_check_uses_configured_remaining_threshold` and `startup_check_skips_when_limit_is_reached` to create concise snapshot fixtures without repeating protocol struct initialization.

*Call graph*: called by 2 (startup_check_skips_when_limit_is_reached, startup_check_uses_configured_remaining_threshold).


##### `window`  (lines 20–26)

```
fn window(used_percent: f64) -> RateLimitWindow
```

**Purpose**: Constructs a minimal `RateLimitWindow` fixture containing only a used-percent value. It supports the snapshot fixture builder.

**Data flow**: Takes `used_percent: f64` and returns a `RateLimitWindow` with that field set and `window_minutes` and `resets_at` left as `None`.

**Call relations**: This helper is called by `snapshot` when a test wants a present primary or secondary window. It is not itself a test case, but a fixture constructor used to keep snapshot setup compact.


##### `startup_check_uses_configured_remaining_threshold`  (lines 29–41)

```
fn startup_check_uses_configured_remaining_threshold()
```

**Purpose**: Verifies that the configured minimum remaining percentage is enforced precisely at the used-percent boundary. It demonstrates that tightening the threshold by one percentage point can flip the decision.

**Data flow**: Creates a snapshot fixture with primary 89.9% used and secondary 50.0% used, then calls `snapshot_allows_startup` twice—once with `min_remaining_percent` 10 and once with 11—and asserts true for the first result and false for the second.

**Call relations**: This test drives `snapshot_allows_startup` through the `snapshot` helper to validate the threshold conversion logic in isolation from auth or backend fetching.

*Call graph*: calls 1 internal fn (snapshot); 1 external calls (assert!).


##### `startup_check_skips_when_primary_or_secondary_is_too_low`  (lines 44–66)

```
fn startup_check_skips_when_primary_or_secondary_is_too_low()
```

**Purpose**: Checks that either rate-limit window can independently block startup when it exceeds the allowed used-percent ceiling. It also confirms that both windows just below the ceiling permit startup.

**Data flow**: Calls `snapshot_allows_startup` with three inline snapshot fixtures under a 25% remaining requirement: one where primary is 75.1 and secondary 10.0, one where primary is 10.0 and secondary 75.1, and one where both are 74.9. It asserts false for the first two and true for the third.

**Call relations**: This test directly targets the combined primary/secondary logic inside `snapshot_allows_startup`, covering the conjunction behavior that depends on both windows passing.

*Call graph*: 1 external calls (assert!).


##### `startup_check_skips_when_limit_is_reached`  (lines 69–79)

```
fn startup_check_skips_when_limit_is_reached()
```

**Purpose**: Proves that an explicit `rate_limit_reached_type` blocks startup even when percentage usage would otherwise be acceptable. It validates the early-return override in the snapshot policy.

**Data flow**: Builds a low-usage snapshot with the `snapshot` helper, mutates `snapshot.rate_limit_reached_type` to `Some(RateLimitReachedType::RateLimitReached)`, then calls `snapshot_allows_startup` with a 25% remaining threshold and asserts the result is false.

**Call relations**: This test uses the `snapshot` fixture builder and then modifies the returned struct to exercise the branch in `snapshot_allows_startup` that ignores window percentages once the backend marks the limit as reached.

*Call graph*: calls 1 internal fn (snapshot); 1 external calls (assert!).
