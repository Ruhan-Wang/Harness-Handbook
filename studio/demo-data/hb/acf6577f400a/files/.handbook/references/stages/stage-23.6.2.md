# Configuration, policy, and environment tests  `stage-23.6.2`

This stage is a safety check area for Codex’s behind-the-scenes rules: how it reads settings, applies policy, and builds the environment before real work begins. The configuration tests check that TOML and JSON files are parsed, merged, edited, and rejected correctly when they contain typos, old names, unsafe values, or conflicting profiles. Cloud-config tests add the organization-managed layer: they build fake bundles, load cached or downloaded settings, verify signatures and account ownership, and make sure enterprise rules override user settings in the right order.

Other tests cover the policy machinery. Permission, sandbox, Windows sandbox, Bubblewrap, and network proxy tests make sure file access, internet access, and approval prompts are safe and predictable. Feature-flag and tool-config tests check which experimental or model-dependent abilities turn on. Hook, prompt, MCP, instruction, and memory-guard tests verify the smaller “control panels” around tools, user instructions, external servers, and quota safety. Environment, path, Git, and test-runner tests ensure commands run with the right variables, paths, and platform assumptions. Together, these tests keep startup choices and safety boundaries from drifting silently.

## Files in this stage

### Config test fixtures and cloud layers
These tests establish the shared fixture builders and validate how managed cloud-config fragments and requirement layers are constructed and named before broader loader and parser coverage uses them.

### `config/src/test_support.rs`

`test` · `test setup`

This is test-only support code. The real application has to load cloud configuration data, but tests often need a simple, predictable version of that data. This file gives tests a builder called CloudConfigBundleFixture, which is like a small packing box for cloud config fragments: tests can add one or more enterprise-managed requirement snippets or config snippets, then turn the box into either the raw bundle or a loader that pretends to fetch that bundle.

The helper gives each added item a stable id and a friendly name. The first requirement is named “Base requirements” and later ones become “Requirements 2”, “Requirements 3”, and so on. Config fragments follow the same pattern with “Base config” and “Config 2”. That matters because tests can check ordering and merging behavior using realistic-looking bundle entries.

The most important final step is into_loader. It wraps the prepared bundle in a CloudConfigBundleLoader, using an asynchronous closure that immediately returns the bundle. In plain terms, it creates a fake cloud service response without using the network. Without this file, many cross-crate integration tests would need to hand-build nested config structures themselves, making the tests noisier and easier to get wrong.

#### Function details

##### `CloudConfigBundleFixture::enterprise_requirement`  (lines 16–18)

```
fn enterprise_requirement(contents: impl Into<String>) -> Self
```

**Purpose**: Creates a new fixture containing one enterprise-managed requirements fragment. Tests use it when they only need a single cloud requirements snippet.

**Data flow**: It starts from an empty default fixture, takes the provided text, and passes that text into the method that adds a requirements fragment. The result is a fixture whose bundle now contains one requirements entry.

**Call relations**: This is a convenience shortcut over building a default fixture and then calling the add method. It is used by tests that need to check how enterprise requirements are added and ordered.

*Call graph*: called by 1 (adds_enterprise_requirements_in_order); 1 external calls (default).


##### `CloudConfigBundleFixture::enterprise_config`  (lines 20–22)

```
fn enterprise_config(contents: impl Into<String>) -> Self
```

**Purpose**: Creates a new fixture containing one enterprise-managed config fragment. Tests use it when they only need a single cloud config snippet.

**Data flow**: It starts from an empty default fixture, takes the provided text, and passes that text into the method that adds a config fragment. The result is a fixture whose bundle now contains one config entry.

**Call relations**: This is the config-side twin of CloudConfigBundleFixture::enterprise_requirement. Other helper methods build on it when they need a ready-made loader for cloud config tests.

*Call graph*: 1 external calls (default).


##### `CloudConfigBundleFixture::loader_with_enterprise_requirement`  (lines 24–28)

```
fn loader_with_enterprise_requirement(
        contents: impl Into<String>,
    ) -> CloudConfigBundleLoader
```

**Purpose**: Creates a fake cloud bundle loader containing one enterprise-managed requirements fragment. Tests use this when they want the config system to behave as if cloud requirements were loaded.

**Data flow**: It receives requirements text, builds a fixture with that text as a requirements fragment, then turns the fixture into a CloudConfigBundleLoader. The output is a loader that will return the prepared bundle during the test.

**Call relations**: Many config-layer tests call this helper before exercising the real loading code. It first relies on CloudConfigBundleFixture::enterprise_requirement to build the bundle, then hands that bundle to CloudConfigBundleFixture::into_loader so the rest of the system can consume it through the normal loader path.

*Call graph*: called by 36 (write_value_rejects_feature_requirement_conflict, load_config_layers_applies_matching_remote_sandbox_config, load_config_layers_can_ignore_managed_requirements, load_config_layers_includes_cloud_config_bundle, load_config_layers_includes_cloud_hook_requirements, load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home, mdm_requirements_take_precedence_over_cloud_config_bundle, active_profile_is_cleared_when_requirements_force_fallback, approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements, browser_feature_requirements_are_valid (+15 more)); 1 external calls (enterprise_requirement).


##### `CloudConfigBundleFixture::loader_with_enterprise_config`  (lines 30–32)

```
fn loader_with_enterprise_config(contents: impl Into<String>) -> CloudConfigBundleLoader
```

**Purpose**: Creates a fake cloud bundle loader containing one enterprise-managed config fragment. Tests use this to check how cloud config is inserted, merged, or rejected by the normal config loading code.

**Data flow**: It receives config text, builds a fixture with that text as a config fragment, then converts the fixture into a CloudConfigBundleLoader. The result is a loader that returns the prepared bundle without contacting any real service.

**Call relations**: This helper is called by tests that need cloud config, rather than cloud requirements. It builds on CloudConfigBundleFixture::enterprise_config and then uses CloudConfigBundleFixture::into_loader to present the fixture through the same interface production code expects.

*Call graph*: called by 2 (load_config_layers_inserts_cloud_config_between_system_and_user, strict_config_rejects_unknown_cloud_config_key); 1 external calls (enterprise_config).


##### `CloudConfigBundleFixture::add_enterprise_requirement`  (lines 34–49)

```
fn add_enterprise_requirement(mut self, contents: impl Into<String>) -> Self
```

**Purpose**: Adds one enterprise-managed requirements fragment to an existing fixture. This lets tests build bundles with several requirement snippets in a known order.

**Data flow**: It takes the current fixture and new requirements text. It counts how many requirements fragments are already present, chooses the next id and name from that count, stores the text in a new CloudRequirementsFragment, and pushes that fragment into the bundle. It returns the updated fixture so more additions can be chained.

**Call relations**: This is the core helper behind CloudConfigBundleFixture::enterprise_requirement. Tests or other helper methods can call it repeatedly to create multi-fragment bundles, which is useful when testing ordering, precedence, or merging behavior.

*Call graph*: 2 external calls (into, format!).


##### `CloudConfigBundleFixture::add_enterprise_config`  (lines 51–66)

```
fn add_enterprise_config(mut self, contents: impl Into<String>) -> Self
```

**Purpose**: Adds one enterprise-managed config fragment to an existing fixture. This lets tests build bundles with several config snippets in a predictable order.

**Data flow**: It takes the current fixture and new config text. It counts the existing config fragments, creates the next id and display name, stores the text in a new CloudConfigFragment, and appends it to the bundle. It returns the updated fixture so callers can keep building.

**Call relations**: This is the core helper behind CloudConfigBundleFixture::enterprise_config. It prepares the config fragments that later get returned directly as a bundle or indirectly through a fake loader.

*Call graph*: 2 external calls (into, format!).


##### `CloudConfigBundleFixture::into_bundle`  (lines 68–70)

```
fn into_bundle(self) -> CloudConfigBundle
```

**Purpose**: Finishes the fixture and returns the CloudConfigBundle inside it. Tests use this when they want the built bundle itself rather than a loader around it.

**Data flow**: It consumes the fixture, meaning the fixture is used up, and extracts its stored CloudConfigBundle. Nothing is copied or further changed; the prepared bundle simply becomes the return value.

**Call relations**: CloudConfigBundleFixture::into_loader calls this first so it can wrap the finished bundle in a loader. It is the handoff point from the test builder object to the actual cloud bundle data structure.

*Call graph*: called by 1 (into_loader).


##### `CloudConfigBundleFixture::into_loader`  (lines 72–75)

```
fn into_loader(self) -> CloudConfigBundleLoader
```

**Purpose**: Turns the prepared fixture into a fake CloudConfigBundleLoader. This allows tests to run the normal config-loading path while controlling exactly what cloud data appears.

**Data flow**: It consumes the fixture, extracts the finished bundle, and creates a new loader around an asynchronous function that returns that bundle wrapped as a successful optional result. The output is a loader ready to be passed into code under test.

**Call relations**: This is the final step used by the loader convenience helpers. After requirements or config fragments have been added, this function packages them behind CloudConfigBundleLoader::new so tests can plug fake cloud data into the same flow that production code uses.

*Call graph*: calls 2 internal fn (new, into_bundle).


### `config/src/test_support_tests.rs`

`test` · `test run`

This is a small test file for the project’s configuration test support. The project has a helper called a fixture, which is a convenient way to build example data for tests without writing all the details by hand each time. Here, the example data is a cloud configuration bundle with enterprise-managed requirements inside it.

The test creates a bundle that starts with one requirement, then adds a second one. It then checks the final stored list exactly matches what a real test would expect: the first requirement gets the base identifier and name, and the second requirement gets the next identifier and name. The order matters because requirements are a list, not just a loose collection. If the helper swapped items, skipped numbering, or reused the same label, other tests could pass or fail for misleading reasons.

In everyday terms, this test is like checking that a form-filling shortcut still numbers checklist items correctly: item one stays first, item two becomes second, and both keep the text you typed.

#### Function details

##### `adds_enterprise_requirements_in_order`  (lines 5–25)

```
fn adds_enterprise_requirements_in_order()
```

**Purpose**: This test proves that the cloud configuration fixture builder appends enterprise requirements in the same order they are added. It also verifies the helper gives each generated requirement the expected identifier and display name.

**Data flow**: The test starts with the text "first" and uses it to create a fixture bundle with one enterprise requirement. It then adds the text "second" as another requirement and turns the fixture into the final bundle object. Finally, it reads the bundle’s enterprise-managed requirements list and compares it with the exact two expected requirement records; the output is a passing test if they match, or a clear test failure if they do not.

**Call relations**: During the test run, this function calls the fixture helper that creates the first enterprise requirement, then builds on that fixture before checking the result. It hands the actual and expected lists to the assertion macro so the test framework can report whether the helper behaved correctly.

*Call graph*: calls 1 internal fn (enterprise_requirement); 1 external calls (assert_eq!).


### `config/src/cloud_config_bundle_tests.rs`

`test` · `test run`

This is a test file. It does not define the cloud configuration system itself; instead, it checks that the system behaves correctly in a few important situations. The code is concerned with configuration bundles that come from the cloud. A bundle can contain config fragments, which are small pieces of settings, and requirements fragments, which are rules about what settings are allowed.

The first test checks a performance and correctness promise: if two parts of the program ask for the same cloud bundle at the same time, the loader should run the real loading work only once and share the result. This is like two people asking the same receptionist for the same document; the receptionist should fetch one copy, not make two separate trips.

The second test checks ordering. Enterprise-managed configuration often has priority rules, where one layer can override another. The test builds a fake bundle with “high” and “low” fragments and confirms that the converted layers are arranged so that composition produces the intended final policy.

The third test checks strict validation. When strict mode is used, a cloud config fragment with an unknown setting should be rejected with a clear error naming the bad fragment and field.

#### Function details

##### `shared_future_runs_once`  (lines 13–24)

```
async fn shared_future_runs_once()
```

**Purpose**: This test proves that a cloud config loader shares one in-progress load instead of running duplicate work. It matters because loading cloud configuration may involve network or disk work, and doing it twice could waste time or cause inconsistent results.

**Data flow**: The test starts with a counter set to zero. It creates a loader whose async loading function increments that counter and returns an empty default cloud bundle. Then it asks the loader for the bundle twice at the same time. After both requests finish, it checks two things: both callers got the same result, and the counter says the loading function ran exactly once.

**Call relations**: During the test, `shared_future_runs_once` creates a `CloudConfigBundleLoader` with `new`, then uses Tokio's `join!` helper to call `loader.get()` twice concurrently. The assertions confirm the loader's shared-future behavior: concurrent callers are joined to the same underlying load rather than starting separate loads.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, new, assert_eq!, default, join!).


##### `bundle_layers_preserve_enterprise_managed_bucket_order`  (lines 27–92)

```
fn bundle_layers_preserve_enterprise_managed_bucket_order()
```

**Purpose**: This test checks that enterprise-managed cloud config and requirements are converted into layers in the correct priority order. That is important because later or higher-priority layers can decide which setting wins when multiple fragments mention the same kind of rule.

**Data flow**: The test creates a temporary directory to stand in for a real config base directory. It builds a fake cloud bundle containing two config fragments and two requirements fragments, labeled high and low. It passes that bundle into `CloudConfigBundleLayers::from_bundle`, then inspects the resulting layers. The config layers should appear in the expected low-then-high order, and composing the requirements should leave the final allowed approval policy as `on-request`.

**Call relations**: This test calls `from_bundle` to exercise the normal conversion path from raw cloud bundle data into config layers. It then calls `compose_requirements` on the requirements layers to check the practical effect of that ordering: the composed result should reflect the intended enterprise-managed priority.

*Call graph*: calls 2 internal fn (from_bundle, from_absolute_path); 3 external calls (assert_eq!, tempdir, vec!).


##### `bundle_layers_can_strict_validate_enterprise_managed_config`  (lines 95–125)

```
fn bundle_layers_can_strict_validate_enterprise_managed_config()
```

**Purpose**: This test confirms that strict validation rejects cloud configuration containing fields the program does not recognize. This prevents a misspelled or unsupported cloud setting from being silently ignored.

**Data flow**: The test creates a temporary base directory and builds a fake cloud bundle with one enterprise-managed config fragment. That fragment contains `unknown_key = true`, which is not a valid configuration field. It passes the bundle into `CloudConfigBundleLayers::from_bundle_strict_config` and expects an error. Finally, it checks that the error identifies the exact fragment and clearly says the unknown field was rejected.

**Call relations**: This test uses `from_bundle_strict_config`, which is the stricter version of bundle-to-layer conversion. Instead of accepting the fragment and moving on, that path hands back a `CloudConfigLayerError::Invalid`, and the test verifies the error is precise enough for a human or calling system to understand what went wrong.

*Call graph*: calls 2 internal fn (from_bundle_strict_config, from_absolute_path); 4 external calls (new, assert_eq!, tempdir, vec!).


### `config/src/cloud_config_layers_tests.rs`

`test` · `test run`

This is a test file for the configuration system. The project can receive configuration fragments from the cloud, such as enterprise policy set by an organization. Those fragments need to become ordinary configuration layers, so they can be combined with system-wide settings and a user’s own settings. If this went wrong, an organization’s policy might apply in the wrong order, bad fields might be silently accepted, or error messages might point to a confusing place.

The tests build small fake cloud fragments, give them a fixed pretend base directory, and then check the resulting layer stack. One important idea here is “precedence,” meaning which setting wins when several layers set the same option. The tests confirm that enterprise-managed layers sit after system config but before user config, like papers stacked in order where later papers can cover earlier ones.

The file also checks stricter parsing behavior: unknown fields should be rejected in strict mode. It verifies that path-like settings are rewritten relative to the cloud configuration base directory, including paths that begin with `~`, which usually means the user’s home area. Finally, it checks diagnostics: when raw TOML, the configuration file format, has the wrong type, the error should name the enterprise layer clearly instead of pretending it came from an ordinary file.

#### Function details

##### `fragment`  (lines 15–21)

```
fn fragment(id: &str, name: &str, contents: &str) -> CloudConfigFragment
```

**Purpose**: Creates a small fake cloud configuration fragment for tests. It saves each test from repeatedly writing out the same struct fields by hand.

**Data flow**: It takes an id, a human-readable name, and a text block of configuration. It copies those strings into a new CloudConfigFragment, which the tests can pass into the cloud-layer conversion code.

**Call relations**: This is a local test helper. The tests use it when they need realistic-looking cloud fragments without involving any real cloud service.


##### `toml`  (lines 23–25)

```
fn toml(contents: &str) -> TomlValue
```

**Purpose**: Parses a short TOML configuration string into the in-memory TOML value used by the configuration stack. TOML is the project’s text format for configuration.

**Data flow**: It receives configuration text, asks the TOML parser to turn that text into structured data, and returns that structured value. If the test text is not valid TOML, it stops the test immediately because the test setup itself is wrong.

**Call relations**: The enterprise layer ordering test calls this helper to build expected and input configuration values. Inside, it hands parsing to the external TOML parser through from_str.

*Call graph*: called by 1 (enterprise_layers_precede_user_and_override_system); 1 external calls (from_str).


##### `base_dir`  (lines 27–29)

```
fn base_dir() -> AbsolutePathBuf
```

**Purpose**: Provides a fixed pretend base directory for cloud configuration tests. Using one shared path keeps the tests simple and makes expected path results stable.

**Data flow**: It starts from the test path `/var/lib/codex`, converts it into the project’s absolute-path type, and returns that value. Nothing on disk needs to exist; this is just a controlled path value for comparison.

**Call relations**: All tests that need a cloud configuration base directory call this helper. It relies on the test path-building helper so each test gets the same absolute path shape.

*Call graph*: called by 6 (enterprise_layers_precede_user_and_override_system, home_relative_path_fields_are_allowed_and_resolved, layers_are_returned_in_stack_order, raw_toml_diagnostics_use_enterprise_layer_name, relative_absolute_path_fields_resolve_against_base_dir, strict_layers_reject_unknown_config_fields); 1 external calls (test_path_buf).


##### `layers_are_returned_in_stack_order`  (lines 32–59)

```
fn layers_are_returned_in_stack_order()
```

**Purpose**: Checks that multiple cloud fragments come back in the order the configuration stack expects. This matters because order decides which layer has more influence when settings overlap.

**Data flow**: It builds two fake cloud fragments, converts them into configuration layers using the fixed base directory, then looks only at each layer’s source name. It compares those names to the expected low-priority-then-high-priority order.

**Call relations**: During the test, it first calls base_dir for the shared path, then exercises the cloud-fragment conversion code. It finishes by using an equality assertion to prove the produced layer order matches the intended stack order.

*Call graph*: calls 1 internal fn (base_dir); 2 external calls (assert_eq!, vec!).


##### `strict_layers_reject_unknown_config_fields`  (lines 62–80)

```
fn strict_layers_reject_unknown_config_fields()
```

**Purpose**: Verifies that strict cloud configuration refuses fields the system does not recognize. This protects administrators from thinking a misspelled or unsupported setting is being enforced when it is actually ignored.

**Data flow**: It creates one fake cloud fragment containing `unknown_key = true`, runs the strict conversion path, and expects an error instead of layers. It then compares that error to the exact enterprise-layer error message that should be shown.

**Call relations**: The test calls base_dir for context, then calls the strict cloud-layer conversion function. The final assertion checks that the rejection is tied to the correct fragment id and name.

*Call graph*: calls 1 internal fn (base_dir); 2 external calls (assert_eq!, vec!).


##### `enterprise_layers_precede_user_and_override_system`  (lines 83–159)

```
fn enterprise_layers_precede_user_and_override_system()
```

**Purpose**: Tests the full priority story among system settings, enterprise-managed cloud settings, and user settings. It proves enterprise settings can override system defaults, while user settings still have the final say where allowed.

**Data flow**: It starts with a system configuration layer, adds two enterprise cloud layers, and then adds a user layer. It builds a ConfigLayerStack from those inputs, checks the visible layer order, and then checks the final effective configuration produced by merging all layers.

**Call relations**: This is the broadest test in the file. It uses base_dir and toml helpers, constructs layer entries, creates the stack, and then asserts both the ordering and the final merged result.

*Call graph*: calls 4 internal fn (base_dir, toml, new, new); 5 external calls (default, assert_eq!, test_path_buf, default, vec!).


##### `relative_absolute_path_fields_resolve_against_base_dir`  (lines 162–182)

```
fn relative_absolute_path_fields_resolve_against_base_dir()
```

**Purpose**: Checks that a relative path in a cloud configuration fragment is converted into an absolute path using the cloud base directory. This keeps managed policy files from being interpreted relative to whatever directory the program happens to run from.

**Data flow**: It builds a fragment whose `model_instructions_file` is `instructions.md`, converts it into layers, reads the stored path back out, and compares it with the expected path resolved against `/var/lib/codex`.

**Call relations**: The test calls base_dir, sends the fragment through the cloud-layer conversion code, and uses the shared path resolver to compute the expected answer before asserting equality.

*Call graph*: calls 2 internal fn (base_dir, resolve_path_against_base); 2 external calls (assert_eq!, vec!).


##### `home_relative_path_fields_are_allowed_and_resolved`  (lines 185–205)

```
fn home_relative_path_fields_are_allowed_and_resolved()
```

**Purpose**: Checks that cloud configuration may use paths beginning with `~` and that they are resolved consistently. This confirms cloud config follows the same path rules as other managed configuration paths.

**Data flow**: It creates a fragment with `model_instructions_file = "~/instructions.md"`, converts it into layers, extracts the stored path string, and compares it with the result of resolving that home-relative path against the test base directory.

**Call relations**: Like the relative-path test, it calls base_dir, runs the cloud-layer conversion, asks the absolute-path utility for the expected result, and then checks the two strings match.

*Call graph*: calls 2 internal fn (base_dir, resolve_path_against_base); 2 external calls (assert_eq!, vec!).


##### `raw_toml_diagnostics_use_enterprise_layer_name`  (lines 208–231)

```
async fn raw_toml_diagnostics_use_enterprise_layer_name()
```

**Purpose**: Makes sure validation errors from enterprise cloud configuration name the enterprise layer clearly. Good diagnostics matter because an administrator or user needs to know which managed policy caused the problem.

**Data flow**: It creates a cloud fragment whose TOML syntax is parseable but whose `model` value has the wrong type. It asks the configuration diagnostic code for the first layer error, then checks that the reported path names the enterprise-managed layer and that the error points to the expected line, column, and message.

**Call relations**: This asynchronous test calls base_dir, creates cloud layers, then hands those layers to first_layer_config_error_from_entries for deeper validation as ConfigToml. It uses assertions to confirm the diagnostic is attached to the enterprise layer rather than to a normal file path.

*Call graph*: calls 1 internal fn (base_dir); 3 external calls (assert!, assert_eq!, vec!).


### `config/src/requirements_layers/stack_tests.rs`

`test` · `test run`

This is a test file for the requirements-layer composer. A "requirements layer" is a chunk of TOML configuration, usually supplied by an organization or system administrator, that says what Codex is allowed to do. The composer’s job is to stack these layers into one final set of rules. This is like stacking transparent sheets: some items from the top sheet cover items below, while other items, such as rule lists or denied file paths, are collected from every sheet.

The tests check several kinds of behavior. Simple settings, such as the default permissions or whether remote control is allowed, should use the higher-priority layer. Nested TOML tables, such as feature flags, apps, network maps, and Windows settings, should merge carefully instead of replacing whole sections too broadly. Lists of command rules and hook groups should be appended in priority order. File read-deny paths should be unioned so a higher layer cannot accidentally make a lower layer’s secret path readable.

The file also checks special cases: hostname-specific remote sandbox settings, hook directory conflicts, source tracking, non-cloud sources such as system files and managed device preferences, and parse errors that name the bad layer. Without these tests, policy composition could silently become less restrictive or much harder to debug.

#### Function details

##### `layer`  (lines 17–25)

```
fn layer(id: &str, name: &str, contents: &str) -> RequirementsLayerEntry
```

**Purpose**: Builds a test requirements layer from an id, a human-readable name, and TOML text. Tests use it to avoid repeating the same setup code for enterprise-managed layers.

**Data flow**: It receives an id, a name, and a TOML string. It wraps the id and name into an enterprise-managed source label, then asks the production parser to turn the TOML into a RequirementsLayerEntry. The result is a ready-to-compose layer used by the tests.

**Call relations**: Most tests call this helper when they need one or more sample layers. It hands off to RequirementsLayerEntry::from_toml, so the tests exercise the same parsing path as real enterprise-managed configuration.

*Call graph*: calls 1 internal fn (from_toml).


##### `compose`  (lines 27–34)

```
fn compose(
    layers: Vec<RequirementsLayerEntry>,
) -> Result<Option<ConfigRequirementsToml>, RequirementsCompositionError>
```

**Purpose**: Combines test layers using the normal hostname-free composition path and returns only the plain TOML-shaped result. It keeps tests focused on the final policy values instead of source-tracking details.

**Data flow**: It receives a list of layer entries. It passes them to the real composer with no hostname, then converts the sourced result into ConfigRequirementsToml if any requirements are present. It returns either no requirements, a final requirements object, or a composition error.

**Call relations**: Many tests call this helper for ordinary layer-stacking cases. Internally it calls compose_requirements_for_hostname, then strips source metadata with into_toml so the assertion can compare plain configuration.

*Call graph*: called by 10 (deny_read_only_layers_do_not_leave_empty_permissions_tables, empty_layers_compose_to_none, mcp_requirements_use_regular_toml_merge, network_maps_use_regular_toml_merge, parse_error_names_layer, permissions_deny_read_unions_while_profiles_use_regular_toml_merge, regular_toml_merge_recurses_into_tables, rules_are_appended_in_priority_order, top_level_values_use_toml_priority, windows_requirements_use_regular_toml_merge); 1 external calls (compose_requirements_for_hostname).


##### `compose_with_hook_directory_field`  (lines 36–46)

```
fn compose_with_hook_directory_field(
    layers: Vec<RequirementsLayerEntry>,
    hook_directory_field: HookDirectoryField,
) -> Result<Option<ConfigRequirementsToml>, RequirementsCompositionError>
```

**Purpose**: Combines layers while telling the composer which hook directory field is active for the current platform or situation. Tests use it to check that only the active managed hook directory is treated as conflict-sensitive.

**Data flow**: It receives layers and a HookDirectoryField value. It calls the real hook-aware composer with no hostname, converts the result into plain TOML form if present, and returns either the composed requirements or an error.

**Call relations**: The hook-related tests call this helper. It delegates to compose_requirements_for_hostname_and_hook_directory, which contains the real conflict and merge behavior under test.

*Call graph*: called by 3 (active_windows_managed_dir_conflicts_fail_closed, hooks_append_groups_and_reject_conflicting_managed_dirs, inactive_hook_dir_conflicts_do_not_fail_composition); 1 external calls (compose_requirements_for_hostname_and_hook_directory).


##### `expected_requirements`  (lines 48–50)

```
fn expected_requirements(contents: impl AsRef<str>) -> ConfigRequirementsToml
```

**Purpose**: Parses a TOML snippet into the same requirements type produced by the composer, so tests can compare structured values rather than raw strings.

**Data flow**: It receives anything that can be viewed as text. It reads that text as TOML and returns a ConfigRequirementsToml value, failing the test immediately if the expected TOML itself is invalid.

**Call relations**: Assertion-heavy tests use this helper to build the expected answer. It relies on toml::from_str, so both expected and actual values are compared as parsed configuration, not as formatting-sensitive text.

*Call graph*: 2 external calls (as_ref, from_str).


##### `empty_layers_compose_to_none`  (lines 53–56)

```
fn empty_layers_compose_to_none()
```

**Purpose**: Checks that composing no layers produces no requirements at all. This matters because an empty policy stack should not invent a default requirements object.

**Data flow**: It starts with an empty list. The list is passed through the compose helper, and the test expects the result to be None. Nothing else is changed.

**Call relations**: This is a basic boundary test for compose. It shows that compose_requirements_for_hostname treats an empty input as absence of policy, not as an empty but present policy.

*Call graph*: calls 1 internal fn (compose); 2 external calls (new, assert_eq!).


##### `top_level_values_use_toml_priority`  (lines 59–109)

```
fn top_level_values_use_toml_priority()
```

**Purpose**: Checks that simple top-level settings from a higher-priority layer override lower-priority settings. It also verifies that map-like settings keep keys from lower layers unless a higher layer replaces the same key.

**Data flow**: It creates a low layer and a high layer with conflicting approval, sandbox, permission, and remote-control values. After composition, the high layer’s direct values are present, while the allowed permission profiles table contains a careful merge of high and low keys.

**Call relations**: This test calls compose through the helper layer setup. It confirms the basic priority rule used by the broader requirements composition system.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `composition_strategy_applies_to_non_cloud_layers`  (lines 112–218)

```
fn composition_strategy_applies_to_non_cloud_layers()
```

**Purpose**: Checks that the same merging rules apply to configuration from non-cloud sources, such as managed device preferences and system files. This prevents local administrator policy sources from behaving differently from enterprise cloud policy.

**Data flow**: It builds one system-file layer and one managed-device-preferences layer. The composer combines top-level values, feature flags, command rules, and denied read paths. The test then checks both the final plain TOML and the source labels on selected values.

**Call relations**: This test calls compose_requirements_for_hostname directly because it needs the source-aware result, not just plain TOML. It proves that source tracking and merge priority still work when layers do not come from the usual enterprise-managed helper.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, cfg!, compose_requirements_for_hostname, vec!).


##### `single_regular_layer_keeps_enterprise_managed_source`  (lines 221–245)

```
fn single_regular_layer_keeps_enterprise_managed_source()
```

**Purpose**: Checks that a value from one enterprise-managed layer remembers where it came from. This is useful for diagnostics, audits, and error messages.

**Data flow**: It creates one layer that sets allow_managed_hooks_only. After composing, it inspects the sourced field and expects both the boolean value and the enterprise source id and name to be preserved.

**Call relations**: This test calls compose_requirements_for_hostname directly so it can inspect source metadata. It depends on the layer helper to create the enterprise-managed source.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `regular_toml_merge_recurses_into_tables`  (lines 248–307)

```
fn regular_toml_merge_recurses_into_tables()
```

**Purpose**: Checks that nested TOML tables are merged inside their sub-sections instead of being replaced wholesale. This lets a high layer override one nested value without deleting unrelated lower-layer settings.

**Data flow**: It creates low and high layers with overlapping feature flags and app connector settings. Composition keeps lower-only entries, replaces shared entries with high-priority values, and preserves nested tool settings that the high layer did not mention.

**Call relations**: This test uses compose and expected_requirements. It exercises the general recursive table-merge behavior that many requirement sections depend on.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `merged_table_source_is_composite_in_priority_order`  (lines 310–350)

```
fn merged_table_source_is_composite_in_priority_order()
```

**Purpose**: Checks that when a final table contains values from multiple layers, its source is recorded as a composite source in priority order. This makes it clear that the resulting table is not owned by only one layer.

**Data flow**: It builds separate low and high sources, each contributing one feature flag. After composition, the feature requirements contain both flags and a source label made from high source followed by low source.

**Call relations**: This test calls compose_requirements_for_hostname directly to inspect sourced data. It verifies that merge behavior and source reporting stay aligned.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `mcp_requirements_use_regular_toml_merge`  (lines 353–390)

```
fn mcp_requirements_use_regular_toml_merge()
```

**Purpose**: Checks that MCP server requirements use the ordinary nested TOML merge rules. MCP servers are external tool servers, and their identity settings should merge predictably with layer priority.

**Data flow**: It creates a low layer with one shared MCP server and one low-only server, then a high layer that changes the shared server command. Composition keeps the low-only server and uses the high command for the shared server.

**Call relations**: This test uses the compose helper. It connects MCP-specific configuration to the same merge behavior tested for other nested tables.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `network_maps_use_regular_toml_merge`  (lines 393–447)

```
fn network_maps_use_regular_toml_merge()
```

**Purpose**: Checks that experimental network allow/deny maps merge by key. This matters because a higher layer should be able to override one domain or socket without erasing unrelated network rules.

**Data flow**: It creates low and high layers with domain decisions and Unix socket decisions. Composition keeps unique entries from both layers and uses high-priority values where the same domain or socket appears twice.

**Call relations**: This test calls compose and compares against parsed expected requirements. It verifies that network policy maps follow the general table-merge model.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `windows_requirements_use_regular_toml_merge`  (lines 450–481)

```
fn windows_requirements_use_regular_toml_merge()
```

**Purpose**: Checks that the Windows-specific requirements table follows the normal merge rules. In this case, the higher-priority allowed sandbox implementation replaces the lower one.

**Data flow**: It creates a low layer allowing one Windows sandbox implementation and a high layer allowing another. Composition returns the high layer’s allowed implementation in the Windows section.

**Call relations**: This test uses compose. It anchors platform-specific configuration to the same priority behavior as the rest of the requirements system.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `remote_sandbox_config_is_applied_per_layer`  (lines 484–518)

```
fn remote_sandbox_config_is_applied_per_layer()
```

**Purpose**: Checks that hostname-specific remote sandbox settings are applied when the current machine name matches. This lets organizations set different sandbox rules for different classes of machines.

**Data flow**: It creates a low general sandbox rule and a high remote sandbox rule that matches a build-machine hostname pattern. The composer receives a mixed-case hostname with a trailing dot, normalizes/matches it, and the high remote sandbox value becomes the final setting.

**Call relations**: This test calls compose_requirements_for_hostname directly because hostname matching is part of the behavior under test. It shows that matching remote sandbox entries participate in normal priority composition.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `unmatched_remote_sandbox_config_does_not_shadow_lower_layers`  (lines 521–555)

```
fn unmatched_remote_sandbox_config_does_not_shadow_lower_layers()
```

**Purpose**: Checks that a remote sandbox block that does not match the current hostname does not erase lower-priority settings. A non-matching special case should behave as if it was not present.

**Data flow**: It creates a low general sandbox rule and a high remote sandbox rule for a different hostname pattern. The composer receives a hostname that does not match the high rule, so the low layer’s sandbox mode remains in the final output.

**Call relations**: This test calls compose_requirements_for_hostname directly. It complements the matching-hostname test by checking the safe non-match path.

*Call graph*: 3 external calls (assert_eq!, compose_requirements_for_hostname, vec!).


##### `hostname_resolver_is_not_called_without_remote_sandbox_config`  (lines 558–586)

```
fn hostname_resolver_is_not_called_without_remote_sandbox_config()
```

**Purpose**: Checks that the composer does not ask for the machine hostname when no layer needs hostname-based selection. This avoids unnecessary work and avoids depending on hostname lookup when it cannot affect the result.

**Data flow**: It sets up a counter and a hostname resolver closure that would increment that counter if called. The only layer has a normal sandbox setting, so composition succeeds, the counter stays at zero, and the normal setting appears in the result.

**Call relations**: This test calls compose_requirements_with_hostname_resolver directly. It verifies lazy behavior: the resolver is only used when remote sandbox configuration exists.

*Call graph*: 4 external calls (default, assert_eq!, compose_requirements_with_hostname_resolver, vec!).


##### `hostname_resolver_is_called_once_for_multiple_remote_sandbox_layers`  (lines 589–630)

```
fn hostname_resolver_is_called_once_for_multiple_remote_sandbox_layers()
```

**Purpose**: Checks that hostname lookup is shared across multiple remote sandbox layers. The composer should not repeatedly ask for the same hostname while processing one stack.

**Data flow**: It creates two layers with hostname-based sandbox settings and a resolver that counts calls. Composition uses the resolver once, matches both layers, and the higher-priority sandbox mode becomes the final value.

**Call relations**: This test calls compose_requirements_with_hostname_resolver directly. It proves the composer caches or otherwise reuses the resolved hostname during one composition pass.

*Call graph*: 4 external calls (default, assert_eq!, compose_requirements_with_hostname_resolver, vec!).


##### `rules_are_appended_in_priority_order`  (lines 633–671)

```
fn rules_are_appended_in_priority_order()
```

**Purpose**: Checks that command prefix rules are collected rather than overwritten, with higher-priority rules placed first. This order matters because earlier policy rules may be checked before later ones.

**Data flow**: It creates a low layer with an npm rule and a high layer with a git rule. After composition, both rules are present, and the high layer’s git rule appears before the low layer’s npm rule.

**Call relations**: This test uses compose. It verifies the special list-combining behavior for rules, which differs from simple scalar overriding.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert_eq!, vec!).


##### `hooks_append_groups_and_reject_conflicting_managed_dirs`  (lines 674–762)

```
fn hooks_append_groups_and_reject_conflicting_managed_dirs()
```

**Purpose**: Checks two hook behaviors: hook groups are appended in priority order, and conflicting active managed hook directories cause composition to fail closed. "Fail closed" means refusing the configuration rather than choosing a potentially unsafe path.

**Data flow**: First it composes two layers with the same managed hook directory and different hook groups; the final TOML keeps the shared directory and includes both hook groups with the high group first. Then it composes two layers with different active managed directories; the result is an error that names the field and both conflicting layers.

**Call relations**: This test uses compose_with_hook_directory_field because the active hook directory field is central to the check. It exercises both successful hook merging and the error path for dangerous directory disagreement.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 3 external calls (assert!, assert_eq!, vec!).


##### `active_windows_managed_dir_conflicts_fail_closed`  (lines 765–792)

```
fn active_windows_managed_dir_conflicts_fail_closed()
```

**Purpose**: Checks that conflicting active Windows managed hook directories also cause composition to fail closed. This keeps Windows hook policy from silently choosing one managed directory over another.

**Data flow**: It creates two layers with different hooks.windows_managed_dir values and marks the Windows managed directory field as active. Composition returns an error, and the test checks that the message names the field and both layers.

**Call relations**: This test calls compose_with_hook_directory_field. It is the Windows counterpart to the managed_dir conflict check.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 2 external calls (assert!, vec!).


##### `inactive_hook_dir_conflicts_do_not_fail_composition`  (lines 795–925)

```
fn inactive_hook_dir_conflicts_do_not_fail_composition()
```

**Purpose**: Checks that conflicts in the inactive hook directory field do not block composition. Only the directory field that matters for the current platform is treated as safety-critical.

**Data flow**: It runs two scenarios. In one, managed_dir is active, so differing windows_managed_dir values are allowed while hooks merge normally. In the other, windows_managed_dir is active, so differing managed_dir values are allowed. Each scenario produces a final requirements object with hook groups in priority order and regular TOML priority for the inactive field.

**Call relations**: This test calls compose_with_hook_directory_field for both active-field choices. It completes the hook-directory conflict story by showing which conflicts are ignored and why.

*Call graph*: calls 1 internal fn (compose_with_hook_directory_field); 2 external calls (assert_eq!, vec!).


##### `permissions_deny_read_unions_while_profiles_use_regular_toml_merge`  (lines 928–984)

```
fn permissions_deny_read_unions_while_profiles_use_regular_toml_merge()
```

**Purpose**: Checks that filesystem deny-read paths are unioned, while permission profile tables still use normal TOML merging. This is important because deny-read paths protect secrets and should not disappear just because a higher layer lists fewer paths.

**Data flow**: It chooses platform-appropriate path strings, then creates low and high layers. The final filesystem deny_read list contains every unique denied path, while the managed-standard permission profile combines fields with high-priority values overriding matching lower fields.

**Call relations**: This test uses compose. It verifies a special safety-oriented merge rule for deny_read alongside ordinary profile merging in the same permissions section.

*Call graph*: calls 1 internal fn (compose); 3 external calls (assert_eq!, cfg!, vec!).


##### `deny_read_only_layers_do_not_leave_empty_permissions_tables`  (lines 987–1015)

```
fn deny_read_only_layers_do_not_leave_empty_permissions_tables()
```

**Purpose**: Checks that a layer containing only filesystem deny-read settings produces a clean permissions section, not extra empty tables. This keeps the generated requirements clear and avoids misleading empty configuration.

**Data flow**: It creates one layer with only a deny_read path. After composition, the expected output contains exactly the filesystem deny_read table and no unrelated empty permissions tables.

**Call relations**: This test calls compose and compares the plain TOML-shaped result. It focuses on output shape after the special deny_read merge logic runs.

*Call graph*: calls 1 internal fn (compose); 3 external calls (assert_eq!, cfg!, vec!).


##### `parse_error_names_layer`  (lines 1018–1028)

```
fn parse_error_names_layer()
```

**Purpose**: Checks that invalid TOML content produces an error message that identifies the bad layer. This makes administrator mistakes much easier to find and fix.

**Data flow**: It creates one layer with an invalid value type for allowed_approval_policies. Composition fails, and the test checks that the error text includes both the layer name/id and the problematic field.

**Call relations**: This test uses compose to trigger the normal parsing and composition path. It verifies that errors coming from layer parsing are wrapped with useful source context.

*Call graph*: calls 1 internal fn (compose); 2 external calls (assert!, vec!).


### Config parsing and editing semantics
This group covers the core config data model, strict parsing, merge behavior, specialized sections like hooks and MCP, and the persistence/editing paths that round-trip configuration back to TOML.

### `config/src/types_tests.rs`

`test` · `test run`

This is a test file for the configuration layer. Configuration is often written by people in a text file, so small mistakes or edge cases can easily turn into confusing behavior later. These tests make sure two areas behave safely.

First, it checks skill configuration. A skill can be selected either by a name, such as a GitHub-style identifier, or by a local file path. The tests confirm that TOML text is turned into the right Rust data: name-based entries fill the name field, path-based entries fill the path field, and the enabled flag is preserved.

Second, it checks memory-related limits. Some settings are counts or percentages, and bad values could cause trouble. For example, a limit of zero could mean the system never processes anything, while a percentage above 100 does not make sense. These tests confirm that the conversion from raw TOML settings into the final runtime configuration clamps unsafe values into a useful range. In plain terms, this file is like a safety inspector for user settings: it does not run the feature itself, but it makes sure the settings arrive in a form the rest of the program can trust.

#### Function details

##### `deserialize_skill_config_with_name_selector`  (lines 5–17)

```
fn deserialize_skill_config_with_name_selector()
```

**Purpose**: This test proves that a skill can be configured by name in TOML text. It also checks that disabling the skill in the text file is preserved in the resulting configuration.

**Data flow**: It starts with a small TOML snippet containing a skill name and `enabled = false`. That text is parsed into a `SkillConfig`. The test then checks that the name was stored, no path was set, and the skill is marked as disabled.

**Call relations**: During the test run, the Rust test framework calls this function. The function relies on TOML parsing to build the config object, then uses assertions to confirm the parsed result matches the expected name-based skill selection.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_skill_config_with_path_selector`  (lines 20–43)

```
fn deserialize_skill_config_with_path_selector()
```

**Purpose**: This test proves that a skill can be configured by a local file path instead of by name. It checks that the path is converted into the project’s absolute-path type, which helps prevent later ambiguity about where the file is.

**Data flow**: It creates a temporary directory, builds a pretend path to a `SKILL.md` file, and inserts that path into TOML text. The TOML is parsed into a `SkillConfig`. The test compares the result with the exact expected configuration: path filled in, name empty, and enabled set to false.

**Call relations**: The test framework calls this function as part of the configuration test suite. It uses a temporary directory so the path is real enough for path conversion, then hands the TOML text to the parser and checks the final `SkillConfig` against a manually built expected value.

*Call graph*: 4 external calls (assert_eq!, format!, tempdir, from_str).


##### `memories_config_clamps_count_limits_to_nonzero_values`  (lines 46–61)

```
fn memories_config_clamps_count_limits_to_nonzero_values()
```

**Purpose**: This test checks that memory-related count limits cannot become zero after configuration is cleaned up. That matters because a zero count could stop useful work from happening at all.

**Data flow**: It starts with a raw `MemoriesToml` value where two count settings are explicitly set to zero. That raw value is converted into a final `MemoriesConfig`. The test then checks that both zero values were raised to one, while all other settings stayed at their defaults.

**Call relations**: The test framework calls this function when running config tests. The function exercises the conversion from raw TOML-shaped data into the safer runtime configuration, then verifies the conversion enforces minimum usable values.

*Call graph*: calls 1 internal fn (from); 2 external calls (default, assert_eq!).


##### `memories_config_clamps_rate_limit_remaining_threshold`  (lines 64–88)

```
fn memories_config_clamps_rate_limit_remaining_threshold()
```

**Purpose**: This test checks that a memory configuration percentage is kept between 0 and 100. This prevents impossible settings, such as requiring 101 percent of a rate limit to remain.

**Data flow**: It first builds raw memory settings with the percentage set to 101, converts them into the final config, and checks that the value becomes 100. Then it repeats the same process with -1 and checks that the value becomes 0. Other settings are expected to remain at their defaults.

**Call relations**: The test framework calls this function during the configuration test run. It focuses on the cleanup step that turns user-provided memory settings into safe runtime values, verifying both the upper and lower boundaries.

*Call graph*: calls 1 internal fn (from); 2 external calls (default, assert_eq!).


### `config/src/merge_tests.rs`

`test` · `test suite`

This is a test file for the configuration merger. The project can combine several TOML files or layers, where TOML is a common human-readable settings format. That sounds simple, but small details matter: an older config key may have been renamed, and domain names like "EXAMPLE.COM" and "example.com" should mean the same website. If these rules were wrong, a user could upgrade and silently lose a setting, or a permission rule could be duplicated instead of replaced. The tests build small fake configuration snippets, merge them, and compare the merged result with the exact TOML shape that should come out. They also sometimes convert the merged TOML into the real ConfigToml type, which checks that the result is not only textually right but also usable by the rest of the program. The main behavior under test is normalization: before or during merging, the code should turn legacy names into the current official name, prefer the official name if both are present, and lowercase network permission domain names before deciding which layer wins.

#### Function details

##### `parse_toml`  (lines 6–8)

```
fn parse_toml(value: &str) -> TomlValue
```

**Purpose**: This small helper turns a TOML text snippet into the in-memory TOML value used by the tests. It keeps the test cases short and makes each test focus on the merge behavior instead of parsing setup.

**Data flow**: It receives a string containing TOML text. It asks the TOML parser to read that string, and if parsing fails it stops the test with a clear message. On success, it returns a TomlValue that the test can pass into the merge code or compare against an expected result.

**Call relations**: All four tests call this helper when they need a base layer, an overlay layer, or an expected merged TOML value. The helper delegates the actual reading to the external TOML parser, so the tests can speak in realistic TOML snippets rather than manually building every nested value.

*Call graph*: called by 4 (merge_toml_values_normalizes_legacy_key_from_base_layer, merge_toml_values_normalizes_legacy_key_from_overlay_layer, merge_toml_values_normalizes_permission_network_domains_before_overlaying, merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names); 1 external calls (from_str).


##### `merge_toml_values_normalizes_legacy_key_from_base_layer`  (lines 11–43)

```
fn merge_toml_values_normalizes_legacy_key_from_base_layer()
```

**Purpose**: This test proves that an old memories setting name in the base configuration is converted to the current setting name when another layer is merged over it. This protects users who still have the old key in an older config file.

**Data flow**: It starts with a base TOML layer that uses the legacy key, and an overlay layer that uses the newer key. After merging, it expects the result to contain only the newer key with the overlay value. It then converts the merged value into ConfigToml and checks that the real memories setting is set to true.

**Call relations**: The test uses parse_toml to create its input and expected TOML values, then runs the configuration merge being tested. It finishes with equality checks so the test runner can catch both a wrong TOML shape and a wrong deserialized configuration value.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


##### `merge_toml_values_normalizes_legacy_key_from_overlay_layer`  (lines 46–78)

```
fn merge_toml_values_normalizes_legacy_key_from_overlay_layer()
```

**Purpose**: This test checks the opposite layering case: the base uses the current memories setting name, while the overlay still uses the old name. It makes sure an older overlay file can still override the modern setting correctly.

**Data flow**: It builds a base layer where the current key is false and an overlay where the legacy key is true. After merging, the expected output keeps only the current key and sets it to true. The test also turns the merged TOML into ConfigToml to confirm the program will read the final value as the current memories option.

**Call relations**: Like the other merge tests, it relies on parse_toml for readable TOML fixtures and uses equality assertions to verify the outcome. It exercises the merge path where the later layer must be normalized before it can correctly replace the earlier value.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


##### `merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names`  (lines 81–100)

```
fn merge_toml_values_prefers_canonical_key_when_one_layer_has_both_names()
```

**Purpose**: This test makes sure that if a single layer contains both the new and old names for the same memories setting, the new official name wins. That prevents an obsolete duplicate key from overriding the value the user put under the current name.

**Data flow**: It starts with an empty TOML table as the base. The overlay contains both the current key set to true and the legacy key set to false. After merging, the expected result contains only the current key with the true value.

**Call relations**: This test creates an empty TOML table directly, then uses parse_toml for the overlay and expected result. It checks the final merged TOML with an equality assertion, focusing on the cleanup rule that removes the legacy duplicate and keeps the canonical, meaning official, key.

*Call graph*: calls 1 internal fn (parse_toml); 3 external calls (Table, assert_eq!, new).


##### `merge_toml_values_normalizes_permission_network_domains_before_overlaying`  (lines 103–126)

```
fn merge_toml_values_normalizes_permission_network_domains_before_overlaying()
```

**Purpose**: This test verifies that network permission domain names are normalized before layers are combined. In practice, it means "EXAMPLE.COM" and "example.com" are treated as the same domain, as they should be on the internet.

**Data flow**: It creates a base permission rule that denies example.com and an overlay rule that allows EXAMPLE.COM. During merging, the domain name should be lowercased before deciding whether the overlay replaces the base rule. The final expected TOML has one entry, example.com, with the overlay value allow.

**Call relations**: The test uses parse_toml to build the base, overlay, and expected permission tables. It then checks the merged value with an equality assertion, confirming that normalization happens early enough for the overlay rule to replace the matching base rule rather than creating a second differently-cased entry.

*Call graph*: calls 1 internal fn (parse_toml); 1 external calls (assert_eq!).


### `config/src/strict_config_tests.rs`

`test` · `test run`

This is a test file, not production code. Its job is to prove that configuration errors are reported in a helpful and predictable way. A configuration file is written in TOML, a common plain-text settings format. If someone writes a setting name the program does not understand, the strict checker should reject it and show exactly where the bad key appears. That matters because a misspelled setting can otherwise look like it worked while being silently ignored.

The tests build small fake TOML snippets, feed them into the config validation helpers, and compare the returned error with the exact error expected. The expected error includes three important pieces: the source name or path, the line and column range where the problem appears, and a plain message such as “unknown configuration field `unknown_key`.”

The file also checks priority rules. If a value has the wrong type, such as text where a number is expected, that type error should be shown before any unrelated unknown-field warning. Finally, it checks an exception: keys under the `desktop` section are allowed to be opaque, meaning this layer does not try to understand every nested desktop setting. That keeps shared config validation strict without blocking desktop-specific data.

#### Function details

##### `ignored_toml_field_errors_accept_non_file_source_names`  (lines 9–37)

```
fn ignored_toml_field_errors_accept_non_file_source_names()
```

**Purpose**: This test checks that strict config errors work even when the configuration source is not a normal file path. That is useful for configs passed through another channel, such as an encoded string, while still giving a clear source name in the error.

**Data flow**: It starts with a made-up source name and TOML text containing a valid `model` setting plus an unknown `unknown_key`. The TOML text is parsed, then passed to the strict unknown-field checker. The test expects one error to come out, pointing at `unknown_key` with the custom source name preserved.

**Call relations**: During the test run, the Rust test harness runs this function. The function relies on the strict config checker to produce an error, then uses `assert_eq!` to compare that actual error with the exact error it should have produced.

*Call graph*: 1 external calls (assert_eq!).


##### `type_errors_take_precedence_over_ignored_fields`  (lines 40–66)

```
fn type_errors_take_precedence_over_ignored_fields()
```

**Purpose**: This test proves that type mistakes are reported before unknown setting names. In human terms, if one setting is shaped wrong and another is unknown, the parser should first explain the concrete value problem it hit.

**Data flow**: It gives the checker a fake `/tmp/config.toml` path and TOML text where `model_context_window` is wrongly written as the string `"wide"` instead of a number, while `unknown_key` is also present. The checker returns an error. The test verifies that the returned error points to `"wide"` and says a number was expected, rather than complaining first about the unknown key.

**Call relations**: The test harness calls this function as part of the config test suite. Inside, it asks the strict config helper for the first error, builds the expected `ConfigError` using `new`, and uses `assert_eq!` to confirm the helper chose the right error priority.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_rejects_unknown_feature_key`  (lines 69–89)

```
fn strict_config_rejects_unknown_feature_key()
```

**Purpose**: This test checks that unknown keys inside the top-level `[features]` section are rejected. It prevents users from thinking they enabled a feature when they actually typed a feature name the program does not know.

**Data flow**: It creates TOML text with a `[features]` table containing `foo = true`. The strict checker reads that text and should return an error because `foo` is not a known feature flag. The test compares the result with an expected error that points at `foo` and names it as `features.foo`.

**Call relations**: The Rust test runner invokes this function. The function sends a small config snippet through the strict validation path, creates the expected error with `new`, and then uses `assert_eq!` to make sure the produced message and text location match exactly.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_rejects_unknown_profile_feature_key`  (lines 92–112)

```
fn strict_config_rejects_unknown_profile_feature_key()
```

**Purpose**: This test checks the same unknown-feature behavior inside a named profile. Profiles are alternate sets of settings, so strict checking must still catch bad feature names there.

**Data flow**: It starts with TOML text under `[profiles.work.features]` containing `foo = true`. The strict checker examines the nested profile feature table and returns an error. The expected output is an error pointing at `foo` and spelling out the full setting path: `profiles.work.features.foo`.

**Call relations**: When the test suite runs, this function exercises the profile-specific branch of strict config validation. It constructs the expected `ConfigError` with `new` and uses `assert_eq!` to verify the actual error has the right path, location, and message.

*Call graph*: 2 external calls (new, assert_eq!).


##### `strict_config_accepts_opaque_desktop_keys`  (lines 115–127)

```
fn strict_config_accepts_opaque_desktop_keys()
```

**Purpose**: This test confirms that the `desktop` config section is allowed to contain keys this strict checker does not understand. That exception lets desktop-specific settings pass through without forcing the shared config parser to know every desktop detail.

**Data flow**: It provides TOML text with a `[desktop]` table and a nested `[desktop.workspace]` table, containing keys such as `appearanceTheme` and `collapsed`. The strict checker reads the config and should return no error. The test verifies that the result is `None`, meaning nothing was rejected.

**Call relations**: The test harness runs this function with the rest of the strict config tests. Unlike the rejection tests, this one expects the validation helper to stay quiet, and it uses `assert_eq!` to confirm that no error was returned.

*Call graph*: 2 external calls (new, assert_eq!).


### `config/src/hooks_tests.rs`

`test` · `test suite, especially when validating config parsing changes`

Hooks are user- or organization-defined commands that run at certain moments, such as before a tool is used. This test file acts like a set of sample paperwork for the configuration parser: it feeds in small JSON or TOML snippets and checks that they become the exact Rust data structures the rest of the program expects. That matters because hook configuration is an external contract. If the parser silently changed what it accepts, existing users could find their hooks ignored or misread.

The tests cover several important cases. They confirm the older JSON shape, where events live under a top-level "hooks" object. They also confirm that putting events directly at the root of that JSON file is rejected, so malformed files do not look valid by accident. For TOML, they verify that hook events can be written as arrays of tables, that hook state such as "enabled" and "trusted_hash" can sit alongside inline events, and that managed enterprise hook requirements can combine a managed directory with hook definitions.

The file also checks Windows-specific command overrides. It accepts both snake_case, "command_windows", and camelCase, "commandWindows", so configurations can stay compatible with different naming styles. These tests do not run hooks; they only prove that configuration text is translated into the right in-memory meaning.

#### Function details

##### `hooks_file_deserializes_existing_json_shape`  (lines 13–53)

```
fn hooks_file_deserializes_existing_json_shape()
```

**Purpose**: This test proves that the existing JSON hook file format is still accepted. It uses a realistic hook that runs a command before Bash is used, including a timeout and a status message.

**Data flow**: It starts with a JSON string shaped like a hooks file. The JSON parser reads that text into a HooksFile value. The test then compares the result with the exact expected structure: one PreToolUse matcher group containing one command hook with its command, timeout, async flag, and status message filled in.

**Call relations**: The Rust test runner calls this test during the test suite. Inside the test, serde_json::from_str does the reading, and assert_eq! checks that the parsed result matches the expected configuration exactly.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hooks_file_rejects_events_outside_hooks_object`  (lines 56–77)

```
fn hooks_file_rejects_events_outside_hooks_object()
```

**Purpose**: This test makes sure JSON hook events are not accepted when they appear in the wrong place. It protects against confusing or accidentally permissive configuration files.

**Data flow**: It starts with JSON where SessionStart is placed at the top level instead of inside the expected hooks object. The parser is expected to fail. The test then inspects the error text and checks that it complains about the unknown SessionStart field.

**Call relations**: The Rust test runner calls this test as part of parser validation. The test relies on JSON deserialization to produce an error, then uses assert! to confirm the error is the kind the project expects.

*Call graph*: 1 external calls (assert!).


##### `hook_events_deserialize_from_toml_arrays_of_tables`  (lines 80–111)

```
fn hook_events_deserialize_from_toml_arrays_of_tables()
```

**Purpose**: This test checks that hook events can be written in TOML using arrays of tables, a common TOML style for repeated sections. It confirms that a readable TOML hook definition becomes the right event structure.

**Data flow**: It begins with TOML text containing a PreToolUse section and one nested hook command. The TOML parser turns that text into a HookEventsToml value. The test compares it with the expected structure: a Bash matcher and a command hook with timeout and status message preserved.

**Call relations**: The Rust test runner invokes this test. The test hands the TOML sample to toml::from_str, then uses assert_eq! to verify that the parser and the hook data model agree on the meaning of the file.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hooks_toml_deserializes_inline_events_and_state_map`  (lines 114–156)

```
fn hooks_toml_deserializes_inline_events_and_state_map()
```

**Purpose**: This test verifies that a full TOML hooks file can contain both hook definitions and saved hook state. The state records things like whether a hook is enabled and which command hash is trusted.

**Data flow**: It starts with TOML that includes a state entry keyed by a hook identifier, plus an inline PreToolUse hook definition. The TOML parser reads it into a HooksToml value. The test checks that the events land in the events field and the state entry lands in the state map with enabled and trusted_hash values intact.

**Call relations**: The Rust test runner calls this test when tests run. It uses toml::from_str to translate text into structured data, BTreeMap to express the expected ordered map, and assert_eq! to confirm the whole combined file is read correctly.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `managed_hooks_requirements_flatten_hook_events`  (lines 159–194)

```
fn managed_hooks_requirements_flatten_hook_events()
```

**Purpose**: This test checks the TOML format for managed hook requirements, such as enterprise-controlled hook directories. It confirms that directory settings and hook events can live together in one requirements file.

**Data flow**: It starts with TOML containing a managed_dir path and a PreToolUse command hook. The TOML parser reads this into ManagedHooksRequirementsToml. The test expects the managed directory to become a PathBuf, the Windows directory field to remain empty, and the hook event to appear under the hooks field.

**Call relations**: The Rust test runner invokes this test. The test uses toml::from_str for parsing and assert_eq! to prove the flattened TOML event sections are collected into the managed requirements structure correctly.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hook_events_deserialize_windows_override_from_toml`  (lines 197–229)

```
fn hook_events_deserialize_windows_override_from_toml()
```

**Purpose**: This test proves that a hook command can include a Windows-specific replacement command using the snake_case field name command_windows. This lets one hook definition work across operating systems.

**Data flow**: It begins with TOML containing a normal Unix-style command and a command_windows override. The TOML parser turns the text into HookEventsToml. The test checks that the main command remains unchanged and the Windows command is stored separately in command_windows.

**Call relations**: The Rust test runner calls this test. It delegates the text reading to toml::from_str, then assert_eq! verifies that the Windows override is accepted and attached to the command hook.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `hook_events_deserialize_camel_case_windows_override_from_toml`  (lines 232–264)

```
fn hook_events_deserialize_camel_case_windows_override_from_toml()
```

**Purpose**: This test confirms that the Windows-specific command override is also accepted with the camelCase field name commandWindows. That keeps the configuration forgiving for users or tools that use camelCase naming.

**Data flow**: It starts with TOML containing a base command and a commandWindows override. The TOML parser reads it into HookEventsToml. The test checks that the parsed command hook has the same command_windows value as the snake_case version would have produced.

**Call relations**: The Rust test runner invokes this test along with the other parser tests. It uses toml::from_str to parse the sample and assert_eq! to confirm that the alias field name feeds into the same internal setting.

*Call graph*: 2 external calls (assert_eq!, from_str).


### `config/src/mcp_types_tests.rs`

`test` · `test suite`

MCP servers can be configured in two main ways: as a local command started through standard input/output, or as a remote HTTP endpoint. This test file acts like a checklist for that configuration format. It feeds small TOML snippets into the configuration parser and checks that the resulting Rust values match what the rest of the program expects.

The tests cover the happy paths first: a command server with arguments, environment variables, a working directory, enabled or required flags, and tool-related options; and an HTTP server with a URL, bearer-token environment variable, headers, and OAuth settings. They also check “round trips,” meaning a config can be read, turned back into TOML text, and read again without losing meaning.

Just as important, the file tests what must be rejected. For example, a server cannot be both a command and a URL, HTTP headers do not belong on a standard-input command server, and inline bearer tokens are refused so secrets are not stored directly in config. Remote command servers must also name an absolute working directory, so the command runs in a clear place rather than depending on where the process happens to start.

#### Function details

##### `deserialize_stdio_command_server_config`  (lines 7–29)

```
fn deserialize_stdio_command_server_config()
```

**Purpose**: Checks the simplest command-based MCP server configuration: a TOML file with only a command. It proves that the parser fills in safe defaults for everything else.

**Data flow**: A short TOML string with `command = "echo"` goes in. The TOML parser turns it into an `McpServerConfig`, and the test compares the result with the expected standard-input/output transport, no arguments, no environment overrides, enabled by default, not required, and no tool filters. The output is a passing test if all defaults are correct.

**Call relations**: The Rust test runner calls this test. Inside it, `from_str` does the real parsing work, and the assertions verify that the configuration model received exactly the values later code would rely on.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_args`  (lines 32–52)

```
fn deserialize_stdio_command_server_config_with_args()
```

**Purpose**: Checks that command-line arguments in TOML are preserved for a command-based MCP server. This matters because many local MCP servers need extra words after the command to start correctly.

**Data flow**: A TOML snippet containing a command and an `args` list goes in. The parser builds an `McpServerConfig`, and the test checks that the transport is standard-input/output with `echo` plus the two arguments `hello` and `world`. The test also confirms the server is still enabled by default.

**Call relations**: The test runner invokes it as part of the configuration test suite. It relies on `from_str` to exercise the same deserialization path used by real config loading, then uses equality checks to catch any change in argument handling.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_remote_stdio_server_requires_absolute_cwd`  (lines 55–82)

```
fn deserialize_remote_stdio_server_requires_absolute_cwd()
```

**Purpose**: Verifies that a remote command-based MCP server must have a clear, absolute working directory. This avoids ambiguity about where the command should run on a remote machine.

**Data flow**: Two invalid TOML snippets go in: one with a remote environment but no `cwd`, and one with a relative `cwd`. Each parse is expected to fail. The test then reads the error text and checks that it explains the missing or non-absolute working directory problem.

**Call relations**: The test runner calls this when checking validation rules. It does not pass data to another project function directly; instead, it depends on the parser returning errors, and the assertions make sure those errors are specific enough to help users.

*Call graph*: 1 external calls (assert!).


##### `deserialize_remote_stdio_server_accepts_absolute_cwd`  (lines 85–108)

```
fn deserialize_remote_stdio_server_accepts_absolute_cwd()
```

**Purpose**: Checks the matching valid case for remote command servers: an absolute working directory is accepted. This proves the rule is not too strict.

**Data flow**: The test asks the operating system for a temporary directory path, formats it into TOML as `cwd`, and parses that TOML. If parsing fails, the test panics with a clear message. If parsing succeeds, it checks that the resulting config stores the same absolute path in the standard-input/output transport.

**Call relations**: The test runner calls it after setup by the normal test framework. It uses `temp_dir` and `format!` to build realistic input, sends that input through `from_str`, and uses an equality assertion to verify the accepted configuration.

*Call graph*: 5 external calls (assert_eq!, format!, panic!, temp_dir, from_str).


##### `deserialize_stdio_command_server_config_with_arg_with_args_and_env`  (lines 111–132)

```
fn deserialize_stdio_command_server_config_with_arg_with_args_and_env()
```

**Purpose**: Checks that a command-based MCP server can include both command-line arguments and fixed environment variables. Environment variables are name-value settings passed to the child process when it starts.

**Data flow**: A TOML string with `command`, `args`, and an `env` table goes in. The parser turns it into an `McpServerConfig`, and the test confirms that the command, argument list, and `FOO=BAR` environment map all land in the standard-input/output transport. The result is a passing test if no information is lost.

**Call relations**: The test runner calls this case. It exercises `from_str` and then uses assertions to make sure process-launch settings are grouped under the correct transport type.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_env_vars`  (lines 135–154)

```
fn deserialize_stdio_command_server_config_with_env_vars()
```

**Purpose**: Checks the legacy shorthand for passing through environment variable names to a command-based MCP server. Instead of giving values in the config, the server can ask to copy named variables from the surrounding environment.

**Data flow**: A TOML snippet with `env_vars = ["FOO", "BAR"]` goes in. The parser creates a config where those two names are stored as environment-variable requests, with no fixed `env` map and no arguments. The output is verified by comparing the whole transport value.

**Call relations**: The test runner invokes it with the rest of the MCP config tests. It calls `from_str` to use the real parser and hands the parsed result to an equality assertion.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_with_env_var_sources`  (lines 157–190)

```
fn deserialize_stdio_command_server_config_with_env_var_sources()
```

**Purpose**: Checks the newer, more detailed environment-variable format, where each variable can say where its value should come from. It also confirms the older plain-string format still works.

**Data flow**: A TOML list containing one plain variable name and two structured variable entries goes in. The parser converts the plain string into a simple name entry, and converts the structured entries into configs with `local` and `remote` sources. The test compares the full resulting list to the expected mixed format.

**Call relations**: The test runner calls this as a compatibility and feature test. It relies on `from_str` to interpret both old and new shapes, then uses equality checking to ensure downstream code will see a consistent internal form.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_stdio_command_server_config_rejects_unknown_env_var_source`  (lines 193–207)

```
fn deserialize_stdio_command_server_config_rejects_unknown_env_var_source()
```

**Purpose**: Checks that only supported environment-variable sources are accepted. This prevents a misspelled or invented source from silently doing the wrong thing.

**Data flow**: A TOML snippet asks for an environment variable source named `elsewhere`. Parsing is expected to fail. The test reads the error message and checks that it mentions the unsupported source value.

**Call relations**: The test runner calls this negative test. The parser is expected to stop the bad configuration, and the assertion checks that the error is understandable rather than vague.

*Call graph*: 1 external calls (assert!).


##### `deserialize_stdio_command_server_config_with_cwd`  (lines 210–229)

```
fn deserialize_stdio_command_server_config_with_cwd()
```

**Purpose**: Checks that a command-based MCP server can set its working directory. The working directory is the folder the command starts in, like choosing the folder before running a terminal command.

**Data flow**: A TOML snippet with `cwd = "/tmp"` goes into the parser. The resulting config should contain a standard-input/output transport whose `cwd` field is the path `/tmp`. The test output is simply pass or fail based on that equality check.

**Call relations**: The test runner invokes it. It uses `from_str` to parse the same TOML syntax users write, then confirms the path is stored where process-starting code will later look for it.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_disabled_server_config`  (lines 232–243)

```
fn deserialize_disabled_server_config()
```

**Purpose**: Checks that an MCP server can be explicitly turned off in configuration. This lets users keep a server entry around without starting it.

**Data flow**: A TOML snippet with a command and `enabled = false` goes in. The parser creates a config, and the test confirms `enabled` is false while `required` remains false. The result is a passing test if disabling does not accidentally make the server required.

**Call relations**: The test runner calls it during config tests. It sends the input through `from_str` and uses assertions to check the boolean flags that later startup code will consult.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_required_server_config`  (lines 246–256)

```
fn deserialize_required_server_config()
```

**Purpose**: Checks that an MCP server can be marked as required. A required server is one the application may treat as important enough that failure to start should matter.

**Data flow**: A TOML snippet with `required = true` is parsed into an `McpServerConfig`. The test checks that the resulting `required` field is true. Nothing else is changed outside the test.

**Call relations**: The test runner invokes this test. It calls `from_str` for real parsing and then checks the specific flag used by later orchestration code.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_streamable_http_server_config`  (lines 259–277)

```
fn deserialize_streamable_http_server_config()
```

**Purpose**: Checks the simplest remote HTTP MCP server configuration: a TOML file with just a URL. It proves that a URL selects the HTTP transport and that optional HTTP fields default to empty.

**Data flow**: A TOML string with `url = "https://example.com/mcp"` goes in. The parser creates a config whose transport is streamable HTTP, with no bearer-token environment variable and no header maps. The test also confirms the server is enabled by default.

**Call relations**: The test runner calls this case. It uses `from_str` to choose the transport from the TOML fields, then assertions confirm that later networking code would see an HTTP endpoint.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_env_var`  (lines 280–299)

```
fn deserialize_streamable_http_server_config_with_env_var()
```

**Purpose**: Checks that an HTTP MCP server can name an environment variable containing its bearer token. A bearer token is a secret string used to prove the client is allowed to connect.

**Data flow**: A TOML snippet with a URL and `bearer_token_env_var = "GITHUB_TOKEN"` goes in. The parser stores the URL and the token variable name in the HTTP transport, without reading the secret itself. The test confirms those exact fields.

**Call relations**: The test runner invokes it. `from_str` parses the user-facing config, and the assertions verify that secret lookup is deferred to runtime by storing only the environment-variable name.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_headers`  (lines 302–324)

```
fn deserialize_streamable_http_server_config_with_headers()
```

**Purpose**: Checks that HTTP MCP servers can include fixed request headers and headers whose values come from environment variables. Headers are extra named values sent with web requests.

**Data flow**: A TOML snippet provides a URL, one fixed header, and one environment-backed header. The parser builds an HTTP transport with two optional maps: one mapping `X-Foo` to `bar`, and one mapping `X-Token` to the environment variable `TOKEN_ENV`. The test compares those maps with the expected result.

**Call relations**: The test runner calls it. It exercises the HTTP-specific part of `from_str`, then uses equality checking so later request-building code can depend on these header fields being shaped correctly.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_oauth_resource`  (lines 327–340)

```
fn deserialize_streamable_http_server_config_with_oauth_resource()
```

**Purpose**: Checks that an HTTP MCP server can declare an OAuth resource. OAuth is a common web sign-in and authorization system; the resource says what service the authorization is for.

**Data flow**: A TOML snippet with a URL and `oauth_resource` goes into the parser. The resulting server config should store that resource string at the top level. The test compares the stored value with the expected URL.

**Call relations**: The test runner invokes it. It calls `from_str` and checks the field that later OAuth setup code can use when requesting or validating authorization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_streamable_http_server_config_with_oauth_client_id`  (lines 343–360)

```
fn deserialize_streamable_http_server_config_with_oauth_client_id()
```

**Purpose**: Checks that an HTTP MCP server can include an OAuth client ID in a nested `oauth` section. The client ID identifies this application to the authorization service.

**Data flow**: A TOML snippet with a URL and an `[oauth]` table containing `client_id` goes in. The parser creates an `McpServerOAuthConfig` with that client ID and attaches it to the server config. The test confirms the nested structure is read correctly.

**Call relations**: The test runner calls this test. It sends nested TOML through `from_str`, then asserts that the OAuth configuration is available in the form later authentication code expects.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_server_config_with_tool_filters`  (lines 363–375)

```
fn deserialize_server_config_with_tool_filters()
```

**Purpose**: Checks that a server can list tools to allow and tools to block. This gives users a way to limit what an MCP server may expose.

**Data flow**: A TOML snippet with `enabled_tools = ["allowed"]` and `disabled_tools = ["blocked"]` goes in. The parser turns those lists into optional string lists on the server config. The test checks both lists exactly.

**Call relations**: The test runner invokes it as part of feature-specific config coverage. It relies on `from_str`, then verifies the fields that tool-selection logic will later read.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_server_config_with_parallel_tool_calls`  (lines 378–388)

```
fn deserialize_server_config_with_parallel_tool_calls()
```

**Purpose**: Checks that a server can declare support for running multiple tool calls at the same time. This matters for performance, but only servers that safely support it should opt in.

**Data flow**: A TOML snippet sets `supports_parallel_tool_calls = true`. The parser fills the server config, and the test checks that the corresponding boolean is true. The test has no outside side effects.

**Call relations**: The test runner calls it. It uses `from_str` to exercise config loading and then checks the flag that later tool-running code can use to decide whether parallel calls are allowed.

*Call graph*: 2 external calls (assert!, from_str).


##### `deserialize_server_config_with_default_tool_approval_mode`  (lines 391–420)

```
fn deserialize_server_config_with_default_tool_approval_mode()
```

**Purpose**: Checks approval settings for tools, both a default setting and a per-tool override. Approval mode controls whether a tool call is automatically allowed or should ask the user first.

**Data flow**: A TOML snippet sets `default_tools_approval_mode = "approve"` and gives the `search` tool `approval_mode = "prompt"`. The parser creates the config, and the test checks both the default and the specific tool entry. It then serializes the config back to TOML, checks the text contains the default setting, parses it again, and confirms the round-tripped config is identical.

**Call relations**: The test runner invokes it. It calls `from_str` to read TOML, `to_string` to write TOML, then `from_str` again to prove that reading and writing cooperate without changing approval behavior.

*Call graph*: 4 external calls (assert!, assert_eq!, from_str, to_string).


##### `serialize_round_trips_server_config_with_parallel_tool_calls`  (lines 423–439)

```
fn serialize_round_trips_server_config_with_parallel_tool_calls()
```

**Purpose**: Checks that parallel-tool-call support and a tool timeout survive being written back to TOML and read again. This guards against serialization accidentally dropping newer fields.

**Data flow**: A TOML snippet with a command, `supports_parallel_tool_calls = true`, and `tool_timeout_sec = 2.0` goes in. The parser builds a config, the serializer turns it back into TOML text, and the test checks that the parallel flag appears in the text. The text is parsed again, and the final config must equal the original.

**Call relations**: The test runner calls this round-trip test. It links `from_str` and `to_string` in the same way a config editor or persistence feature might, proving they agree on these fields.

*Call graph*: 4 external calls (assert!, assert_eq!, from_str, to_string).


##### `deserialize_ignores_unknown_server_fields`  (lines 442–477)

```
fn deserialize_ignores_unknown_server_fields()
```

**Purpose**: Checks that unknown fields in a server config are ignored rather than causing failure. This can help compatibility when configs contain fields from another version or another tool.

**Data flow**: A TOML snippet includes a normal command plus an unknown `trust_level` field. The parser creates a config instead of rejecting it. The test compares the whole config to an expected value with default environment ID, enabled true, required false, empty tools, and all optional fields unset.

**Call relations**: The test runner invokes it. It uses `from_str` to confirm permissive parsing, then a full equality check to make sure the unknown field does not secretly affect any real setting.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `deserialize_rejects_command_and_url`  (lines 480–488)

```
fn deserialize_rejects_command_and_url()
```

**Purpose**: Checks that a server config cannot specify both a local command and an HTTP URL. A server must choose one transport method, not two competing ways to connect.

**Data flow**: A TOML snippet containing both `command` and `url` goes in. Parsing is expected to fail. The test passes only if the parser rejects the ambiguous configuration.

**Call relations**: The test runner calls this negative test. It exercises the parser’s validation rule that separates standard-input/output servers from HTTP servers before any later code tries to start or connect to them.


##### `deserialize_rejects_env_for_http_transport`  (lines 491–499)

```
fn deserialize_rejects_env_for_http_transport()
```

**Purpose**: Checks that process environment settings are not accepted on HTTP-based MCP servers. Fixed `env` values only make sense when the program is launching a local command.

**Data flow**: A TOML snippet with a URL and an `env` table goes in. Parsing is expected to return an error. No config object is accepted from this input.

**Call relations**: The test runner invokes it. The parser is the part under test, and the expected failure protects HTTP connection code from receiving irrelevant process-launch settings.


##### `deserialize_rejects_headers_for_stdio`  (lines 502–545)

```
fn deserialize_rejects_headers_for_stdio()
```

**Purpose**: Checks that HTTP-only settings are rejected for command-based MCP servers. It covers request headers, environment-backed request headers, OAuth client settings, and OAuth resource settings.

**Data flow**: Several TOML snippets go in, each using `command = "echo"` together with a setting that only makes sense for HTTP. Each parse must fail. For the OAuth-related cases, the test also checks the error text so users get a clear explanation that OAuth is not supported for standard-input/output servers.

**Call relations**: The test runner calls this larger negative test. It repeatedly asks the parser to validate bad mixes of transport-specific fields, and the assertions confirm that the parser stops them before runtime startup or networking code sees them.

*Call graph*: 1 external calls (assert!).


##### `deserialize_rejects_inline_bearer_token_field`  (lines 548–561)

```
fn deserialize_rejects_inline_bearer_token_field()
```

**Purpose**: Checks that a config cannot contain a raw bearer token directly. This helps avoid storing secrets in plain configuration files.

**Data flow**: A TOML snippet with a URL and `bearer_token = "secret"` goes in. Parsing is expected to fail, and the test checks that the error message says inline bearer tokens are not supported. The accepted alternative is to name an environment variable instead.

**Call relations**: The test runner invokes this security-focused validation test. It depends on the parser rejecting the sensitive field and uses an assertion on the error text to make sure the reason is clear.

*Call graph*: 1 external calls (assert!).


### `config/src/mcp_edit_tests.rs`

`test` · `test run`

This is a test file for the configuration editor. MCP servers are external tool servers that Codex can talk to, and their settings live in a TOML config file, which is a human-readable settings format. These tests make sure that when the code replaces the MCP server section of the config, it does not lose important nested settings.

Each test creates a fresh temporary Codex home directory so it does not touch a real user’s files. It then builds an in-memory map of MCP server settings, asks `ConfigEditsBuilder` to write those settings to `config.toml`, and reads the file back as plain text. The text is compared against the exact TOML that should have been produced. After that, the test loads the MCP servers through the normal config-loading path and checks that the loaded data matches the original in-memory data.

This gives two kinds of protection. The exact text check catches formatting and serialization mistakes, such as writing a field in the wrong table. The load-back check catches round-trip mistakes, where the file may look plausible but would not actually recreate the same configuration. At the end, each test deletes its temporary directory, like cleaning up a scratch workspace after an experiment.

#### Function details

##### `replace_mcp_servers_serializes_per_tool_approval_overrides`  (lines 10–86)

```
async fn replace_mcp_servers_serializes_per_tool_approval_overrides() -> anyhow::Result<()>
```

**Purpose**: This test proves that tool-specific approval settings for an MCP server are saved correctly. It protects the case where a server has a default approval mode, but individual tools override that default.

**Data flow**: It starts by creating a unique temporary config directory and an in-memory MCP server named `docs`. That server has a default approval mode plus separate approval settings for the `search` and `read` tools. The test writes this server map through the config edit builder, reads the generated config file as text, and compares it to the expected TOML. Then it loads the MCP server config back through the normal loader and checks that the loaded structure is exactly the same as the original. Finally, it removes the temporary directory and returns success if all checks passed.

**Call relations**: During the test run, the async test harness calls this function directly. Inside it, the function relies on the config editing path, starting with `ConfigEditsBuilder::new`, then replacing the MCP server section and applying the edit. It also calls the normal MCP config loading path afterward, so the test covers both writing and reading rather than only one side.

*Call graph*: calls 1 internal fn (new); 9 external calls (from, from, now, new, assert_eq!, format!, temp_dir, read_to_string, remove_dir_all).


##### `replace_mcp_servers_serializes_oauth_client_id`  (lines 89–146)

```
async fn replace_mcp_servers_serializes_oauth_client_id() -> anyhow::Result<()>
```

**Purpose**: This test proves that an MCP server's OAuth client ID is saved in the right place in the config file. OAuth is a login/authorization system, and the client ID identifies this application to the service it connects to.

**Data flow**: It creates a unique temporary config directory and an in-memory MCP server named `maas_outlook` that connects over HTTP and includes an OAuth client ID. The test writes that server configuration to the temporary config file, reads the file back as text, and checks that the OAuth client ID appears under the server's OAuth section. It then loads the MCP server configuration through the normal loader and verifies that the loaded data matches what was originally written. At the end it deletes the temporary directory.

**Call relations**: The async test harness calls this function as part of the test suite. The function exercises the same config-editing path a real settings change would use, beginning with `ConfigEditsBuilder::new` and ending with applying the edit. It then hands the written file to the normal MCP server loader, confirming that the saved OAuth data can be understood by the rest of the configuration system.

*Call graph*: calls 1 internal fn (new); 8 external calls (from, new, now, assert_eq!, format!, temp_dir, read_to_string, remove_dir_all).


### `config/src/state_tests.rs`

`test` · `test run`

This is a test file for the configuration system. The project appears to build one final configuration by stacking several “layers,” much like laying transparent sheets on top of each other: defaults, user files, profile files, command-line or session settings, and so on. The top sheet can override what is underneath, but lower sheets can still provide values when the top sheet does not mention them.

The tests here focus on two important promises. First, old configuration key names must be translated to their newer official names before the system records where a setting came from. That means users can still write an older key, but the rest of the program sees one consistent modern name.

Second, when there are multiple user configuration files, a profile-specific file should be treated as the active user file if it has higher priority. At the same time, the effective user configuration should still include values inherited from the base user file when the profile file does not override them.

The last test checks that updating one user config file in memory does not accidentally switch the active profile file. This matters because a tool might save changes to the base config while the user is working under a profile, and the profile must remain active.

#### Function details

##### `test_user_config_path`  (lines 5–8)

```
fn test_user_config_path(temp_dir: &TempDir, file_name: &str) -> AbsolutePathBuf
```

**Purpose**: This small helper builds an absolute path to a fake user configuration file inside a temporary test folder. It keeps the tests short and makes sure the paths used by the tests look like real full file paths.

**Data flow**: It receives a temporary directory and a file name. It joins the directory path with that file name, checks that the result is an absolute path, and returns it wrapped in the project’s absolute-path type. If the path is unexpectedly not absolute, the test stops with a clear error message.

**Call relations**: The user-layer tests call this helper when they need paths for pretend config files, such as a base config file and a profile-specific config file. It does not take part in the configuration logic itself; it simply prepares realistic input for the tests.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (active_user_layer_is_highest_precedence_user_layer, with_user_config_updates_matching_user_layer_without_replacing_active_profile); 1 external calls (path).


##### `origins_use_canonical_key_aliases`  (lines 11–40)

```
fn origins_use_canonical_key_aliases()
```

**Purpose**: This test verifies that when a legacy configuration key is used, the configuration system records the setting under its modern official key name. This prevents the rest of the program from having to remember every old spelling of the same option.

**Data flow**: The test starts with a small TOML configuration snippet using an older key name. It wraps that snippet in a configuration layer that represents session-provided settings, builds a one-layer configuration stack, and asks the stack where each setting came from. The expected result is that the origin map contains the modern key name and does not contain the legacy key name.

**Call relations**: This test exercises the configuration stack creation path and then inspects the stack’s origin tracking. It relies on TOML parsing to turn text into configuration data, then uses the stack’s metadata and origins output to prove that key aliasing happened before origins were stored.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert!, assert_eq!, default, from_str, vec!).


##### `active_user_layer_is_highest_precedence_user_layer`  (lines 43–91)

```
fn active_user_layer_is_highest_precedence_user_layer()
```

**Purpose**: This test checks that when both a base user config and a profile-specific user config exist, the profile config is treated as the active user config. It also checks that the final merged user config still keeps useful values from the base file.

**Data flow**: The test creates two fake config file paths in a temporary directory. It builds one user layer for the base config, containing a model and an approval policy, and another user layer for a work profile, containing a different model. After building the configuration stack, it checks that the active user file is the profile file. It also checks that the merged user config uses the profile’s model while still keeping the base file’s approval policy.

**Call relations**: This test uses the path helper to create realistic file paths, then feeds two user layers into the configuration stack. It tells the story of normal profile selection: the stack should pick the higher-priority profile layer as active, while the merge logic combines profile overrides with base settings underneath.

*Call graph*: calls 3 internal fn (new, new, test_user_config_path); 6 external calls (new, default, assert_eq!, default, from_str, vec!).


##### `with_user_config_updates_matching_user_layer_without_replacing_active_profile`  (lines 94–141)

```
fn with_user_config_updates_matching_user_layer_without_replacing_active_profile()
```

**Purpose**: This test verifies that changing the contents of one user config layer updates that layer only, without accidentally changing which profile is active. This is important when saving or editing a base config while a profile-specific config is currently in use.

**Data flow**: The test creates a base user config file and a work profile config file. The base layer starts with a model value, while the profile layer supplies an approval policy. It builds a configuration stack, then asks the stack to replace the config contents for the base file with an updated model value. The returned stack should still report the profile file as active, but its merged user config should now include the updated base model and the profile’s approval policy.

**Call relations**: This test sets up the same kind of layered user configuration as the previous one, then calls the stack’s user-config update operation. It confirms that the update operation finds the matching file path and changes that layer’s data, while leaving the higher-priority active profile relationship intact.

*Call graph*: calls 3 internal fn (new, new, test_user_config_path); 6 external calls (new, default, assert_eq!, default, from_str, vec!).


### `config/src/loader/tests.rs`

`test` · `test run`

This file is a set of automated tests for the config loader. The config loader reads settings from TOML files, and this project has both an older profile format, such as `[profiles.work]` or `profile = "work"`, and a newer style where a selected profile can point at its own config file, such as `work.config.toml`. The risk is confusion: if both systems use the same profile name, the program might appear to load one profile while partly reading another. These tests make sure that does not happen.

The file creates temporary folders, writes small config files into them, and asks the real loader to read them. A small `TestFileSystem` stands in for the normal file system. It can turn paths into their canonical form and read files, which is all these tests need. Any write, copy, delete, directory listing, or metadata operation is deliberately unsupported, like a locked toolbox containing only the two tools needed for this job.

The three tests cover the important cases: reject a new `work` profile if the base config also has `[profiles.work]`; reject it if the base config says `profile = "work"`; but allow unrelated old profiles, such as `[profiles.dev]`, because they do not conflict.

#### Function details

##### `TestFileSystem::canonicalize`  (lines 17–27)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: This gives the loader a clean, absolute version of a path during tests. It lets the test file system behave enough like a real file system for config loading to work.

**Data flow**: It receives a project path wrapped as a `PathUri`, plus an unused sandbox setting. It converts the path to a normal absolute path, asks the operating system for the canonical version, then wraps that result back into a `PathUri`. The output is either the cleaned-up path or an input/output error if the path cannot be resolved.

**Call relations**: The configuration loader calls this through the `ExecutorFileSystem` interface when it needs reliable paths. Inside, this method delegates to path conversion helpers and the platform’s path canonicalization, then hands the normalized path back to the loader.

*Call graph*: calls 2 internal fn (from_abs_path, to_abs_path); 2 external calls (pin, canonicalize).


##### `TestFileSystem::read_file`  (lines 29–38)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: This lets the tests read the temporary config files they just wrote. It is the main file access operation the config loader needs in these tests.

**Data flow**: It receives a `PathUri` pointing to a file and an unused sandbox setting. It converts the path to an absolute local path, turns that into a normal filesystem path, and reads the file bytes asynchronously. The output is the file contents as raw bytes, or an input/output error if reading fails.

**Call relations**: The real config loader calls this method when it wants to load `config.toml` or the selected profile config file. This test implementation passes the actual disk read to Tokio’s asynchronous file reader and returns the bytes to the loader.

*Call graph*: calls 1 internal fn (to_abs_path); 3 external calls (pin, read, as_path).


##### `TestFileSystem::read_file_stream`  (lines 40–51)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: This says clearly that streaming reads are not available in this test file system. The tests do not need streaming, so supporting it would add noise without value.

**Data flow**: It receives a path and an optional sandbox setting, but does not use them. Instead of opening a stream, it immediately returns an error saying this operation is unsupported. Nothing is read or changed.

**Call relations**: If some tested code unexpectedly tried to read config files as a stream, this method would make that failure obvious. In the intended test path, the loader uses `read_file` instead, so this method acts as a guardrail.

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

**Purpose**: This marks file writing as outside the scope of the test file system. The tests create files directly with standard filesystem calls before invoking the loader.

**Data flow**: It receives a destination path, file contents, and an optional sandbox setting, but it does not use them. If called, it stops with an unimplemented error. No file is written.

**Call relations**: The config loader should only read files for these tests, so this method should never be part of the normal flow. Its presence is required because `TestFileSystem` must implement the full file system interface.

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

**Purpose**: This marks directory creation as unsupported in these tests. Temporary directories are created by the test setup, not by the config loader.

**Data flow**: It receives a directory path, creation options, and an optional sandbox setting, but ignores them. If called, it fails immediately with an unimplemented error. No directory is created.

**Call relations**: This exists only to satisfy the file system interface. The test flow creates its temporary folder separately with `tempdir`, then the loader only reads from it.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::get_metadata`  (lines 71–77)

```
fn get_metadata(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: This marks metadata lookup, such as checking whether a path is a file or directory, as unsupported for this narrow test file system.

**Data flow**: It receives a path and an optional sandbox setting, but does not inspect the path. If called, it stops with an unimplemented error. It returns no metadata.

**Call relations**: The tested config-loading path is expected not to need metadata. This method is included because the broader file system trait requires it, not because these tests depend on it.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `TestFileSystem::read_directory`  (lines 79–85)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: This marks directory listing as unsupported. These tests name the exact config files to read, so they do not need to scan folders.

**Data flow**: It receives a directory path and an optional sandbox setting, but does not read the directory. If called, it fails with an unimplemented error. No directory entries are returned.

**Call relations**: The normal test story writes known files and asks the loader to read known paths. If the loader unexpectedly started listing directories here, this method would reveal that mismatch.

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

**Purpose**: This marks deletion as unsupported in the test file system. The tests do not need the loader to remove files.

**Data flow**: It receives a path, removal options, and an optional sandbox setting, but ignores them. If called, it stops with an unimplemented error. Nothing is deleted.

**Call relations**: This is present only because the file system interface includes removal. The temporary directory cleanup is handled by the test framework, not by this method.

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

**Purpose**: This marks file copying as unsupported. Config loading should not copy files during these tests.

**Data flow**: It receives a source path, destination path, copy options, and an optional sandbox setting, but does not use them. If called, it fails with an unimplemented error. No data is copied.

**Call relations**: The method completes the required file system interface while keeping the test double intentionally small. The tested loader path should rely on `canonicalize` and `read_file`, not copying.

*Call graph*: 2 external calls (pin, unimplemented!).


##### `profile_v2_rejects_matching_legacy_profile_in_base_user_config`  (lines 108–165)

```
async fn profile_v2_rejects_matching_legacy_profile_in_base_user_config()
```

**Purpose**: This test proves that the loader rejects a new-style selected profile when the base config also defines an old-style profile with the same name. That prevents two different meanings of `work` from being mixed together.

**Data flow**: The test creates a temporary folder, writes a base `config.toml` containing `[profiles.work]`, and writes a separate `work.config.toml` for the new-style profile. It builds loader overrides that select the `work` profile and point at `work.config.toml`. After asking the loader to read this setup, it expects an error, then checks that the error is `InvalidData` and that the message explains the conflict and points to the advanced config documentation.

**Call relations**: During the test, setup helpers create the temporary directory, write files, and build test-only loader overrides. The test then calls the config loader through `load_config_layers_state` using `TestFileSystem`; the loader reads the files and returns the conflict error that the assertions inspect.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `profile_v2_rejects_matching_legacy_profile_selector_in_base_user_config`  (lines 168–219)

```
async fn profile_v2_rejects_matching_legacy_profile_selector_in_base_user_config()
```

**Purpose**: This test proves that the loader also rejects a collision when the base config selects the same old-style profile name with `profile = "work"`. This catches a second way the old and new profile systems could be confused.

**Data flow**: The test creates a temporary folder, writes a base `config.toml` containing `profile = "work"`, and writes a selected `work.config.toml`. It sets overrides so the loader uses the new-style `work` profile file. The loader is expected to fail; the test checks that the failure is an invalid configuration error and that the message mentions the conflicting selector and the selected config file.

**Call relations**: The test uses the same supporting pieces as the previous one: temporary files, test-only overrides, and `TestFileSystem` for reads. It hands this setup to `load_config_layers_state`, then verifies that the loader reports the legacy selector conflict instead of accepting it silently.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `profile_v2_allows_unrelated_legacy_profiles_in_base_user_config`  (lines 222–256)

```
async fn profile_v2_allows_unrelated_legacy_profiles_in_base_user_config()
```

**Purpose**: This test proves that the loader is not too strict. A new-style `work` profile should still load if the base config contains an old-style profile with a different name, such as `dev`.

**Data flow**: The test creates a temporary folder, writes a base `config.toml` with `[profiles.dev]`, and writes `work.config.toml` for the selected new-style profile. It sets overrides to choose `work`, asks the loader to read the configuration, and expects success. No error details are checked because success is the important outcome.

**Call relations**: This is the positive companion to the rejection tests. It uses the same loader path and file-system test double, but the loader should find no name collision and should complete normally.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, resolve_path_against_base); 2 external calls (write, tempdir).


### `core/src/config/edit_tests.rs`

`test` · `test suite`

Codex stores many user preferences in a TOML file, a human-readable settings format. Editing that file is delicate: users may have comments, profile-specific settings, symbolic links, old-style inline tables, or custom server definitions. This test file creates temporary fake Codex home folders, applies configuration edits, then reads the resulting file back to make sure the text and parsed values are exactly right. In plain terms, it checks that the config editor acts like a careful librarian: it updates the one card you asked for, but does not reorder the whole drawer or erase notes in the margins. The tests cover model choices, service tiers, terminal UI settings, key bindings, skill enablement, warning prompts, audio and realtime voice settings, and MCP server configuration. They also check tricky file-system behavior, such as writing through a chain of symbolic links and safely replacing a broken link loop. Without these tests, small changes to config-writing code could silently break user settings, remove comments, write values in the wrong place, or change profile-specific settings when only global settings were intended.

#### Function details

##### `blocking_set_model_top_level`  (lines 17–35)

```
fn blocking_set_model_top_level()
```

**Purpose**: Checks that setting the model and reasoning effort writes both values at the top level of a fresh config file. This protects the basic path used when a user changes their default model.

**Data flow**: It starts with an empty temporary Codex home folder. It applies a blocking config edit with a model name and high reasoning effort, reads `config.toml`, and compares the full text to the expected two-line file.

**Call relations**: The Rust test runner calls this test. Inside the test, temporary disk storage is created, the production `apply_blocking` edit path is exercised, then standard file reading and equality checking confirm the result.

*Call graph*: 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_saves_default_as_default`  (lines 38–49)

```
fn set_service_tier_saves_default_as_default()
```

**Purpose**: Checks that the default service tier is saved using the user-facing word `default`. This matters because the request value may come from protocol code, but the config file should stay clear and stable.

**Data flow**: It creates a temporary home, builds a config edit that sets the service tier to the default request value, applies it, reads the config file, and expects `service_tier = "default"`.

**Call relations**: The test runner invokes it. It uses `ConfigEditsBuilder::new` to build the edit flow and then verifies the builder wrote the expected TOML text.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_saves_priority_as_fast`  (lines 52–63)

```
fn set_service_tier_saves_priority_as_fast()
```

**Purpose**: Checks that the fast service tier is saved as `fast`. This keeps the saved configuration aligned with the service tier names users and other code expect.

**Data flow**: It creates a temporary home folder, asks the edit builder to set the service tier from the `Fast` request value, applies the edit, then reads the file and compares it with the expected text.

**Call relations**: The test runner calls this during tests. It goes through the same builder API that normal code would use, then hands the result to file reading and assertion code.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `set_service_tier_preserves_unknown_service_tier`  (lines 66–77)

```
fn set_service_tier_preserves_unknown_service_tier()
```

**Purpose**: Checks that an unrecognized service tier string is not rejected or rewritten. This is useful for experimental tiers that newer servers may understand before the local app does.

**Data flow**: It sends the string `experimental-tier-id` into the config edit builder, applies the edit in a temporary home, reads `config.toml`, and expects that exact string to be saved.

**Call relations**: The test runner starts it. The test exercises the builder path and then uses the file contents as proof that unknown values pass through unchanged.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `builder_with_edits_applies_custom_paths`  (lines 80–94)

```
fn builder_with_edits_applies_custom_paths()
```

**Purpose**: Checks that callers can give the builder a custom low-level edit path, not only use its convenience methods. This keeps the builder flexible for settings that do not have a special helper yet.

**Data flow**: It creates an edit saying `enabled = true`, gives that edit to the builder, applies it, then reads the config file and expects that single boolean setting.

**Call relations**: The test runner calls it. It uses `ConfigEditsBuilder::new`, passes a vector of edits into `with_edits`, and verifies the generic path-setting machinery.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, vec!).


##### `session_picker_view_edit_writes_root_tui_setting`  (lines 97–111)

```
fn session_picker_view_edit_writes_root_tui_setting()
```

**Purpose**: Checks that changing the session picker view writes the setting under the root terminal UI section. This prevents the setting from being misplaced in a profile or another table.

**Data flow**: It asks for the dense session picker view, applies the generated edit in a temporary home, reads the file, and expects a `[tui]` table with `session_picker_view = "dense"`.

**Call relations**: The test runner invokes it. The test uses the helper that creates the session-picker edit, then the builder applies it through the normal config-writing path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_binding_edit_writes_root_action_binding`  (lines 114–128)

```
fn keymap_binding_edit_writes_root_action_binding()
```

**Purpose**: Checks that a single keyboard shortcut for a terminal UI action is written in the right nested keymap table. This protects custom key bindings from being saved in the wrong place.

**Data flow**: It creates an edit for the `composer` context and `submit` action with `ctrl-enter`, applies it, and reads back a `[tui.keymap.composer]` section containing that binding.

**Call relations**: The test runner calls it. The keymap edit helper produces the edit, the builder persists it, and the assertion checks the final TOML text.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_bindings_edit_writes_single_binding_as_string`  (lines 131–149)

```
fn keymap_bindings_edit_writes_single_binding_as_string()
```

**Purpose**: Checks that when there is only one shortcut for an action, it is saved as a simple string rather than a list. This keeps the config compact and readable.

**Data flow**: It passes one binding, `ctrl-enter`, into the multi-binding helper, applies it, reads the file, and expects the same output format as the single-binding helper.

**Call relations**: The test runner invokes it. It exercises the keymap bindings helper through the builder and then confirms the writer chooses the simple string form.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `keymap_bindings_edit_writes_multiple_bindings_as_array`  (lines 152–183)

```
fn keymap_bindings_edit_writes_multiple_bindings_as_array()
```

**Purpose**: Checks that multiple shortcuts for one action are saved as a list. This is the format needed when one action should respond to more than one key combination.

**Data flow**: It supplies two bindings, applies the config edit, reads the TOML text, parses it into a TOML value tree, and checks that the nested `submit` value is an array containing both strings.

**Call relations**: The test runner calls it. The builder writes the file, then TOML parsing is used instead of raw text comparison so the test can focus on the stored list value.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `keymap_binding_edit_replaces_existing_binding_without_touching_profile`  (lines 186–230)

```
fn keymap_binding_edit_replaces_existing_binding_without_touching_profile()
```

**Purpose**: Checks that changing a root key binding updates only the root binding and leaves a profile-specific binding alone. This matters because profiles are separate named sets of preferences.

**Data flow**: It seeds a config file with both a root key binding and a profile key binding. After applying a root binding change, it parses the file and checks that only the root value changed.

**Call relations**: The test runner invokes it. The test writes seed data to disk, sends the edit through the builder, then uses TOML parsing to inspect both the root and profile branches.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `keymap_binding_clear_edit_removes_root_action_binding_without_touching_profile`  (lines 233–276)

```
fn keymap_binding_clear_edit_removes_root_action_binding_without_touching_profile()
```

**Purpose**: Checks that clearing a root key binding removes only that root entry. It guards against accidentally deleting a user's profile-specific shortcut.

**Data flow**: It starts with a config containing root and profile bindings. It applies a clear edit for the root action, parses the result, and confirms the root binding is gone while the profile binding remains.

**Call relations**: The test runner calls it. The clear-edit helper produces the edit, the builder writes it, and parsed TOML checks prove the edit stayed in the intended branch.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `set_model_availability_nux_count_writes_shown_count`  (lines 279–294)

```
fn set_model_availability_nux_count_writes_shown_count()
```

**Purpose**: Checks that the app records how many times a model availability new-user message has been shown. This prevents repeated prompts from feeling noisy.

**Data flow**: It creates a small map from model name to count, applies the builder method for this setting, reads the file, and expects the count under `[tui.model_availability_nux]`.

**Call relations**: The test runner invokes it. The builder turns the in-memory count map into TOML, and the assertion checks the saved table.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `set_skill_config_writes_disabled_entry`  (lines 297–315)

```
fn set_skill_config_writes_disabled_entry()
```

**Purpose**: Checks that disabling a skill by file path writes an entry saying that skill is disabled. This lets users turn off a specific skill without deleting it.

**Data flow**: It supplies a skill file path and `enabled: false`, applies the edit, reads the config, and expects one `[[skills.config]]` array entry with the path and disabled flag.

**Call relations**: The test runner calls it. The test creates a `SetSkillConfig` edit directly, routes it through the builder, and verifies the serialized TOML.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `set_skill_config_removes_entry_when_enabled`  (lines 318–340)

```
fn set_skill_config_removes_entry_when_enabled()
```

**Purpose**: Checks that re-enabling a skill removes its special disabled entry. This keeps the config file from storing unnecessary defaults.

**Data flow**: It seeds the config with a disabled skill entry, applies an edit marking that same path enabled, reads the file, and expects it to become empty.

**Call relations**: The test runner invokes it. The test writes seed TOML, uses the builder to apply the skill edit, and confirms the writer removed now-unneeded configuration.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, read_to_string, write, tempdir).


##### `set_skill_config_writes_name_selector_entry`  (lines 343–361)

```
fn set_skill_config_writes_name_selector_entry()
```

**Purpose**: Checks that a skill can be disabled by name, not only by file path. This supports skills identified by a registry-like name such as `github:yeet`.

**Data flow**: It applies a `SetSkillConfigByName` edit with `enabled: false`, reads `config.toml`, and expects a skills config entry containing the name and disabled flag.

**Call relations**: The test runner calls it. The test exercises direct edit construction plus builder persistence, then checks the written TOML text.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_set_model_ignores_inline_legacy_profile_contents`  (lines 364–412)

```
fn blocking_set_model_ignores_inline_legacy_profile_contents()
```

**Purpose**: Checks that setting the global model does not rewrite old inline profile settings. This protects users with older config styles from losing profile data.

**Data flow**: It seeds a config with an active profile stored as an inline TOML table. It applies a global model change, parses the result, and confirms the root model changed while the profile's model and sandbox setting stayed the same.

**Call relations**: The test runner invokes it. The test bypasses the builder and calls the blocking edit function directly, then uses TOML parsing to compare root and profile data separately.

*Call graph*: 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `blocking_set_model_writes_through_symlink_chain`  (lines 416–444)

```
fn blocking_set_model_writes_through_symlink_chain()
```

**Purpose**: On Unix systems, checks that editing `config.toml` follows a normal chain of symbolic links. A symbolic link is a file-system shortcut that points to another file.

**Data flow**: It creates a config path that points through one link to a target file, applies a model edit, checks that the config path is still a link, and reads the target file to confirm the content was written there.

**Call relations**: The Unix test runner calls it only on Unix. It uses file-system symlink calls to set up the case, then exercises `apply_blocking` and verifies both link behavior and file contents.

*Call graph*: 6 external calls (assert!, assert_eq!, read_to_string, symlink_metadata, symlink, tempdir).


##### `blocking_set_model_replaces_symlink_on_cycle`  (lines 448–475)

```
fn blocking_set_model_replaces_symlink_on_cycle()
```

**Purpose**: On Unix systems, checks that a broken symbolic-link loop does not trap the config writer. If links point in a circle, the editor should replace the unusable config link with a real file.

**Data flow**: It creates two links that point to each other and makes `config.toml` point into that loop. After applying a model edit, it checks that `config.toml` is no longer a symlink and contains the expected model setting.

**Call relations**: The Unix test runner invokes it on Unix. The test sets up the bad file-system state, calls the production blocking edit path, then checks that the fallback behavior produced a usable file.

*Call graph*: 6 external calls (assert!, assert_eq!, read_to_string, symlink_metadata, symlink, tempdir).


##### `batch_write_table_upsert_preserves_inline_comments`  (lines 478–535)

```
fn batch_write_table_upsert_preserves_inline_comments()
```

**Purpose**: Checks that changing values inside existing tables keeps nearby comments intact. This matters because many users document their config file by hand.

**Data flow**: It seeds a config with comments around MCP server and sandbox settings. It applies two path updates, reads the file, and expects only the target values to change while comments and layout remain.

**Call relations**: The test runner calls it. The blocking edit function receives a batch of path edits, and the assertion confirms the writer performs careful in-place-style updates.

*Call graph*: 5 external calls (assert_eq!, read_to_string, write, tempdir, vec!).


##### `blocking_clear_model_does_not_follow_legacy_active_profile`  (lines 538–567)

```
fn blocking_clear_model_does_not_follow_legacy_active_profile()
```

**Purpose**: Checks that clearing the global model does not clear the model inside the currently selected legacy profile. Profiles should not be edited just because they are active.

**Data flow**: It seeds a config with an active inline profile, applies a model edit where the model is absent but reasoning effort is set, then checks the final text keeps the profile unchanged and adds only the root effort setting.

**Call relations**: The test runner invokes it. It calls `apply_blocking` directly and uses a raw text comparison to make sure the exact layout and legacy profile content remain.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_model_does_not_follow_legacy_active_profile`  (lines 570–601)

```
fn blocking_set_model_does_not_follow_legacy_active_profile()
```

**Purpose**: Checks that setting the global model and effort does not overwrite the active profile's own effort setting. This keeps global settings and profile settings separate.

**Data flow**: It writes a config with `profile = "team"` and a profile-specific effort. It applies a global model and effort update, reads the file, and expects new root values while the profile table remains unchanged.

**Call relations**: The test runner calls it. The production blocking edit path is tested against seeded TOML, and the final string comparison proves the edit did not follow the active profile.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_full_access_warning_preserves_table`  (lines 604–633)

```
fn blocking_set_hide_full_access_warning_preserves_table()
```

**Purpose**: Checks that acknowledging the full-access warning adds a notice flag without disturbing an existing notice table. This keeps user comments and unrelated notice values safe.

**Data flow**: It seeds a `[notice]` table with a comment and existing value. It applies the hide-warning edit, reads the file, and expects the new boolean flag appended in the same table.

**Call relations**: The test runner invokes it. The test constructs the notice edit, sends it through `apply_blocking`, and compares the resulting TOML text exactly.

*Call graph*: 5 external calls (SetNoticeHideFullAccessWarning, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_rate_limit_model_nudge_preserves_table`  (lines 636–659)

```
fn blocking_set_hide_rate_limit_model_nudge_preserves_table()
```

**Purpose**: Checks that hiding the rate-limit model nudge adds the right flag inside the notice table. It ensures other notice settings are not replaced.

**Data flow**: It starts with a notice table containing `existing = "value"`, applies the hide-nudge edit, reads the file, and expects both the old value and new flag.

**Call relations**: The test runner calls it. The notice-specific edit is handed to the blocking config writer, and the assertion confirms the table was extended rather than rebuilt destructively.

*Call graph*: 5 external calls (SetNoticeHideRateLimitModelNudge, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_gpt5_1_migration_prompt_preserves_table`  (lines 662–687)

```
fn blocking_set_hide_gpt5_1_migration_prompt_preserves_table()
```

**Purpose**: Checks that hiding a model migration prompt with a simple key name writes that key under `[notice]`. This records that the user should not see that prompt again.

**Data flow**: It seeds an existing notice table, applies a migration-prompt hide edit for `hide_gpt5_1_migration_prompt`, reads the file, and expects the new boolean alongside the existing value.

**Call relations**: The test runner invokes it. The test uses the migration-prompt edit variant and verifies the blocking writer keeps the table content.

*Call graph*: 5 external calls (SetNoticeHideModelMigrationPrompt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_gpt_5_1_codex_max_migration_prompt_preserves_table`  (lines 690–715)

```
fn blocking_set_hide_gpt_5_1_codex_max_migration_prompt_preserves_table()
```

**Purpose**: Checks that migration prompt keys containing punctuation are quoted correctly in TOML. This prevents invalid config when a model name includes characters like dashes and dots.

**Data flow**: It seeds a notice table, applies a hide-prompt edit with a punctuation-heavy key, reads the file, and expects the key to be quoted while the old table entry remains.

**Call relations**: The test runner calls it. It exercises the same migration-prompt edit path as simpler names, but verifies the TOML writer uses safe key syntax.

*Call graph*: 5 external calls (SetNoticeHideModelMigrationPrompt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_record_model_migration_seen_preserves_table`  (lines 718–745)

```
fn blocking_record_model_migration_seen_preserves_table()
```

**Purpose**: Checks that recording a seen model migration adds a nested map from old model to new model. This helps the app avoid repeating migration notices.

**Data flow**: It starts with an existing notice table, applies an edit saying migration from `gpt-5.2` to `gpt-5.4` was seen, reads the file, and expects a `[notice.model_migrations]` section with that mapping.

**Call relations**: The test runner invokes it. The blocking config writer receives the record-migration edit and creates the nested notice table while preserving existing notice data.

*Call graph*: 4 external calls (assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_external_config_migration_prompt_home_preserves_table`  (lines 748–774)

```
fn blocking_set_hide_external_config_migration_prompt_home_preserves_table()
```

**Purpose**: Checks that hiding the external-config migration prompt for the home config writes a nested home flag. This records prompt state without overwriting the rest of `[notice]`.

**Data flow**: It seeds `[notice]`, applies the home prompt hide edit, reads the file, and expects a `[notice.external_config_migration_prompts]` table with `home = true`.

**Call relations**: The test runner calls it. It uses the specific edit constructor for the home prompt and verifies the blocking writer adds the nested table.

*Call graph*: 5 external calls (SetNoticeHideExternalConfigMigrationPromptHome, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_hide_external_config_migration_prompt_project_preserves_table`  (lines 777–806)

```
fn blocking_set_hide_external_config_migration_prompt_project_preserves_table()
```

**Purpose**: Checks that hiding an external-config migration prompt for one project stores that project's path as a key. This lets prompt state be tracked separately per project.

**Data flow**: It seeds a notice table, applies a project hide edit with a project path and `true`, reads the file, and expects that path under `[notice.external_config_migration_prompts.projects]`.

**Call relations**: The test runner invokes it. The project-specific notice edit flows through `apply_blocking`, and the text comparison checks the nested project table.

*Call graph*: 5 external calls (SetNoticeHideExternalConfigMigrationPromptProject, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_external_config_migration_prompt_home_last_prompted_at_preserves_table`  (lines 809–833)

```
fn blocking_set_external_config_migration_prompt_home_last_prompted_at_preserves_table()
```

**Purpose**: Checks that the last time the home migration prompt was shown is saved under the external-config prompt notice table. This supports throttling prompts so they do not appear too often.

**Data flow**: It seeds `[notice]`, applies an edit with a Unix-style timestamp number, reads the file, and expects `home_last_prompted_at` in the nested prompt table.

**Call relations**: The test runner calls it. The timestamp edit is passed to the blocking writer, and the assertion checks that existing notice content is preserved.

*Call graph*: 5 external calls (SetNoticeExternalConfigMigrationPromptHomeLastPromptedAt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_set_external_config_migration_prompt_project_last_prompted_at_preserves_table`  (lines 836–865)

```
fn blocking_set_external_config_migration_prompt_project_last_prompted_at_preserves_table()
```

**Purpose**: Checks that the last prompt time can be stored separately for a project path. This lets Codex remember prompt timing per project.

**Data flow**: It starts with a notice table, applies an edit with a project path and timestamp, reads the file, and expects the timestamp under `[notice.external_config_migration_prompts.project_last_prompted_at]` keyed by that path.

**Call relations**: The test runner invokes it. The project timestamp edit goes through the blocking config writer, then exact text comparison verifies the nested output.

*Call graph*: 5 external calls (SetNoticeExternalConfigMigrationPromptProjectLastPromptedAt, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_round_trips`  (lines 868–973)

```
fn blocking_replace_mcp_servers_round_trips()
```

**Purpose**: Checks that replacing the MCP server list writes a full, readable TOML representation for different server transports. MCP means Model Context Protocol, a way for Codex to connect to external tools and services.

**Data flow**: It builds two in-memory server configs: one command-line server and one HTTP server. It applies a replace-all edit, reads the config file, and compares it with the expected server tables, including headers, environment variables, timeouts, OAuth data, and tool lists.

**Call relations**: The test runner calls it. The test constructs realistic `McpServerConfig` values, sends them through `ConfigEdit::ReplaceMcpServers`, and checks that serialization to TOML is correct.

*Call graph*: 8 external calls (new, new, ReplaceMcpServers, assert_eq!, read_to_string, from_secs, tempdir, vec!).


##### `blocking_replace_mcp_servers_serializes_tool_approval_overrides`  (lines 976–1025)

```
fn blocking_replace_mcp_servers_serializes_tool_approval_overrides()
```

**Purpose**: Checks that MCP server tool approval settings are written correctly. These settings decide whether a tool can run automatically or must ask the user first.

**Data flow**: It builds a server with a default approval mode and one tool-specific approval override, applies the replace edit, reads the file, and expects both the server-level and tool-level approval values.

**Call relations**: The test runner invokes it. The replace-MCP-server edit exercises the production serializer, and the final string comparison confirms nested tool settings are kept.

*Call graph*: 7 external calls (new, from, new, ReplaceMcpServers, assert_eq!, read_to_string, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comments`  (lines 1028–1076)

```
fn blocking_replace_mcp_servers_preserves_inline_comments()
```

**Purpose**: Checks that replacing MCP servers does not remove a comment inside an existing `[mcp_servers]` table when the logical server data stays the same. This protects hand-written notes.

**Data flow**: It seeds a compact inline MCP server entry with a preceding comment. It applies a replace edit with matching server data, reads the file, and expects the original comment and inline entry to remain.

**Call relations**: The test runner calls it. The test writes seed TOML, constructs the matching server map, applies `ReplaceMcpServers`, and checks that the writer avoided unnecessary churn.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_suffix`  (lines 1079–1125)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_suffix()
```

**Purpose**: Checks that a comment after an inline MCP server entry remains after the entry is updated. This is important because trailing comments often explain a setting.

**Data flow**: It seeds an inline server followed by `# keep me`, then applies a replace edit that adds `enabled = false`. It reads the file and expects the added field before the preserved trailing comment.

**Call relations**: The test runner invokes it. The replace edit updates the inline TOML entry, and the assertion ensures the comment suffix is still attached.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_after_removing_keys`  (lines 1128–1174)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_after_removing_keys()
```

**Purpose**: Checks that removing fields from an inline MCP server entry does not lose its trailing comment. This protects comments even when the shape of the inline table shrinks.

**Data flow**: It seeds an inline server with an `args` field and a trailing comment. It replaces the server with one that has no args, reads the file, and expects the args field gone while the comment remains.

**Call relations**: The test runner calls it. The MCP replacement serializer edits the inline table, and the test verifies both key removal and comment preservation.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_replace_mcp_servers_preserves_inline_comment_prefix_on_update`  (lines 1177–1225)

```
fn blocking_replace_mcp_servers_preserves_inline_comment_prefix_on_update()
```

**Purpose**: Checks that a comment immediately before an inline MCP server entry remains when the entry is updated. This guards the common pattern of documenting a setting on the line above it.

**Data flow**: It seeds a `[mcp_servers]` table with a comment before `foo`. It replaces the server with a version that adds `enabled = false`, reads the file, and expects the comment still before the updated inline entry.

**Call relations**: The test runner invokes it. The replace edit updates the server configuration, while the exact text assertion checks that surrounding comments survived.

*Call graph*: 8 external calls (new, new, new, ReplaceMcpServers, assert_eq!, read_to_string, write, tempdir).


##### `blocking_clear_path_noop_when_missing`  (lines 1228–1244)

```
fn blocking_clear_path_noop_when_missing()
```

**Purpose**: Checks that clearing a missing setting does nothing and does not create a new config file. This avoids leaving empty files behind for no real change.

**Data flow**: It starts with an empty temporary home, applies a clear edit for a path that does not exist, then checks that `config.toml` was not created.

**Call relations**: The test runner calls it. The direct `apply_blocking` path receives a no-op clear edit, and a file-existence assertion confirms it stayed a no-op.

*Call graph*: 3 external calls (assert!, tempdir, vec!).


##### `blocking_set_path_updates_notifications`  (lines 1247–1269)

```
fn blocking_set_path_updates_notifications()
```

**Purpose**: Checks that a generic path edit can set the terminal UI notifications flag. This proves nested boolean settings are written in a parseable way.

**Data flow**: It applies a path edit for `tui.notifications = false`, reads the file, parses it as TOML, and checks that the nested value is the boolean `false`.

**Call relations**: The test runner invokes it. The blocking writer handles the generic path edit, and TOML parsing verifies the resulting data rather than only the text layout.

*Call graph*: 5 external calls (assert_eq!, read_to_string, tempdir, from_str, vec!).


##### `async_builder_set_model_persists`  (lines 1272–1287)

```
async fn async_builder_set_model_persists()
```

**Purpose**: Checks that the asynchronous builder path also persists model settings. Asynchronous code lets the app wait for file work without blocking other tasks.

**Data flow**: It creates a temporary home, uses the builder's async `apply` method to set model and effort, waits for it to finish, then reads the file and compares the expected text.

**Call relations**: The Tokio async test runner calls it. It uses `ConfigEditsBuilder::new`, the async apply path, and normal file reading to prove the async wrapper reaches the same writer.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_builder_set_model_round_trips_back_and_forth`  (lines 1290–1321)

```
fn blocking_builder_set_model_round_trips_back_and_forth()
```

**Purpose**: Checks that repeated model changes overwrite the previous values cleanly. This guards against duplicate keys or stale model settings accumulating.

**Data flow**: It writes an initial model and effort, verifies them, writes a different model and effort, verifies those, then writes the original pair again and verifies the file returns to the initial text.

**Call relations**: The test runner calls it. The builder's blocking apply path is exercised three times in a row, with file reads after each step to confirm stable round trips.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_set_asynchronous_helpers_available`  (lines 1324–1342)

```
async fn blocking_set_asynchronous_helpers_available()
```

**Purpose**: Checks that convenience helper methods can be used with the async builder path. In this case, it verifies the full-access warning acknowledgement can be saved asynchronously.

**Data flow**: It uses the builder to set the hide-full-access-warning flag and awaits the async apply. It reads and parses the file, then checks that the notice flag is `true`.

**Call relations**: The Tokio async test runner invokes it. The builder helper creates the edit, async apply writes it, and TOML parsing confirms the saved value.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `blocking_builder_set_realtime_audio_persists_and_clears`  (lines 1345–1386)

```
fn blocking_builder_set_realtime_audio_persists_and_clears()
```

**Purpose**: Checks that realtime audio device preferences can be saved and individually cleared. This lets users choose a microphone and speaker, then remove only one choice later.

**Data flow**: It first saves microphone and speaker names under the audio table and parses the file to confirm both. Then it clears only the microphone, reads again, and confirms the speaker remains while microphone is gone.

**Call relations**: The test runner calls it. The builder's realtime audio helper methods feed edits into the blocking writer, and TOML parsing checks the before-and-after state.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `blocking_builder_set_realtime_voice_persists_and_clears`  (lines 1389–1421)

```
fn blocking_builder_set_realtime_voice_persists_and_clears()
```

**Purpose**: Checks that a realtime voice preference can be saved and then cleared. This protects the voice setting used by realtime audio features.

**Data flow**: It saves the voice `cedar`, parses the config to confirm it appears under `[realtime]`, then applies a clear edit and parses again to confirm the voice key is gone.

**Call relations**: The test runner invokes it. The builder's realtime voice helper is used with blocking apply, and parsed TOML confirms both persistence and removal.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `replace_mcp_servers_blocking_clears_table_when_empty`  (lines 1424–1441)

```
fn replace_mcp_servers_blocking_clears_table_when_empty()
```

**Purpose**: Checks that replacing MCP servers with an empty map removes the MCP server table. This keeps the config from retaining old server definitions after the user deletes them.

**Data flow**: It seeds a config with one MCP server, applies `ReplaceMcpServers` with an empty collection, reads the file, and checks that the text no longer contains `mcp_servers`.

**Call relations**: The test runner calls it. The direct blocking replace edit exercises the cleanup path for MCP servers, and the final assertion confirms the table was removed.

*Call graph*: 6 external calls (new, ReplaceMcpServers, assert!, read_to_string, write, tempdir).


### `core/src/config/schema_tests.rs`

`test` · `test run`

This is a test file for the project's `config.toml` schema, which is the machine-readable description of what settings are allowed in the configuration file. Think of the schema like a form template: it tells editors, validators, and users which fields exist and what shape they should have. If this schema drifts away from the real code, users could get bad guidance or invalid configuration files could appear valid.

The main test generates the current schema from the Rust code, loads the saved `config.schema.json` fixture from the repository, and compares them as JSON data. Before comparing, it canonicalizes both values, meaning it normalizes them so harmless ordering differences do not cause a failure. If the content differs, the test prints a readable before-and-after diff and tells the developer to regenerate the fixture.

It then does a stricter check: it writes the schema to a temporary file and compares the exact text with the repository fixture, ignoring only one final newline and normalizing Windows line endings. This protects the committed file from formatting drift.

A second test checks a security-related schema detail: inline `bearer_token` is not advertised, while `bearer_token_env_var` is. In plain terms, the schema should guide users toward storing a token in an environment variable instead of putting the secret directly in the config file.

#### Function details

##### `trim_single_trailing_newline`  (lines 9–11)

```
fn trim_single_trailing_newline(contents: &str) -> &str
```

**Purpose**: This small helper removes one final newline from a text string if it has one. The tests use it so two otherwise identical files do not fail comparison just because one ends with a newline and the other does not.

**Data flow**: It receives a text slice. If the text ends with `\n`, it returns the same text without that last newline; otherwise it returns the original text unchanged. It does not allocate new text or change the original string.

**Call relations**: The exact schema text comparison calls this helper on both the repository fixture and the newly generated file. That lets the test focus on meaningful differences while tolerating a single trailing-newline mismatch.


##### `config_schema_matches_fixture`  (lines 14–55)

```
fn config_schema_matches_fixture()
```

**Purpose**: This test makes sure the schema generated by the code matches the schema file committed to the repository. It protects users and tools from seeing an outdated `config.schema.json`.

**Data flow**: It starts by finding and reading the saved schema fixture. It also asks the config code to generate a fresh schema, then parses both as JSON values and normalizes them before comparing. If the normalized JSON differs, it builds a readable diff and fails the test with instructions to regenerate the fixture. After that, it writes a fresh schema to a temporary file and compares the actual file text against the fixture, with small allowances for line endings and one trailing newline.

**Call relations**: During the test suite, this function acts as the main guardrail for schema drift. It calls the schema generator and schema writer from the config module, uses JSON parsing to compare meaning rather than raw text first, and uses the helper `trim_single_trailing_newline` for the final exact-text check.

*Call graph*: 12 external calls (new, from_lines, assert_eq!, find_resource!, panic!, from_slice, from_str, to_string_pretty, read_to_string, canonicalize (+2 more)).


##### `config_schema_hides_unsupported_inline_mcp_bearer_token`  (lines 58–75)

```
fn config_schema_hides_unsupported_inline_mcp_bearer_token()
```

**Purpose**: This test confirms that the public config schema does not expose an unsupported inline `bearer_token` setting for MCP server configuration. It also confirms that the safer `bearer_token_env_var` setting is still present.

**Data flow**: It generates the schema JSON, parses it into a JSON value, then looks inside the `RawMcpServerConfig` properties section. From that object, it checks whether two property names are present. The expected result is that `bearer_token` is absent and `bearer_token_env_var` is present.

**Call relations**: This test runs alongside the broader schema fixture test, but it checks one specific behavior directly. It depends on `config_schema_json` to produce the schema and then verifies the schema's public shape so users are guided away from putting bearer tokens directly in config files.

*Call graph*: 3 external calls (assert_eq!, from_slice, config_schema_json).


### `core/src/config/config_tests.rs`

`test` · `test run`

This is a test file, so it does not provide product features directly. Instead, it acts like a checklist for the configuration system. Codex has many settings that can come from files, command-line overrides, managed enterprise requirements, and defaults. If those settings are interpreted incorrectly, the program could use the wrong model provider, expose too much filesystem or network access, ignore user interface preferences, or start a proxy when it should not. The tests in this chunk build small example configurations, usually in TOML, which is a common human-readable config-file format. They then load those examples through the same paths used by the real program and check the final runtime config. A large part of the file focuses on permissions: filesystem access, network access, legacy sandbox compatibility, and the newer permission-profile system. Another group checks smaller config areas such as memories, tools, TUI display settings, Amazon Bedrock provider overrides, and MCP server test fixtures. In everyday terms, this file is the safety inspector for configuration: it feeds the system known inputs and confirms the final switches, locks, and access rules end up exactly where they should. This chunk of the test file acts like a safety checklist for Codex configuration. Codex can be told which folders it may read or write, whether it may use the network, and how the terminal interface should look. Small mistakes here could either block useful work or, worse, give Codex more access than the user expected. The tests build temporary fake projects, load hand-written TOML-style config objects, and then inspect the resulting runtime configuration. Many tests focus on permission profiles: named bundles such as read-only, workspace-write, or full-access. They check how built-in profiles are selected, how custom profiles extend them, how workspace roots are discovered, and how special paths like temporary directories or project roots are translated into sandbox rules. Other tests make sure bad configuration is rejected with clear errors, while forward-compatible unknown paths are allowed but warned about. The later tests cover terminal UI options, runtime defaults, deprecated settings, and legacy sandbox parsing. In plain terms, this file makes sure the configuration system behaves like a careful doorman: it opens the right doors, keeps dangerous doors shut, and tells the user when a key is old or unclear. This part of the test file acts like a safety checklist for configuration loading. Codex reads settings from several places: user config files, project config files, command-line overrides, managed enterprise policy, plugin metadata, and temporary session settings. These tests build small fake homes and workspaces, feed in example TOML config text, and check the final Config object or MCP configuration that comes out. MCP means Model Context Protocol, a way for external tools or servers to plug into Codex.

The main concern is precedence and safety. For example, enterprise requirements must be able to disable unapproved MCP servers, but selected plugins should still be able to supply a chosen server in the right place. Sandbox settings must give the runtime the same file and network restrictions as older legacy settings, without accidentally widening write access. Credential storage defaults must avoid unsafe keyring behavior in local development builds. Feature flags must map old names to new feature switches without changing unrelated behavior.

Without these tests, a small config change could silently make Codex trust the wrong project setting, enable an unapproved server, leak a secret token from config, or grant broader file access than intended. This test file protects the configuration system from quiet breakage. Configuration is the project’s set of knobs: model choice, MCP servers, prompt files, policy text, and agent roles. If these tests failed, Codex might save a setting in a form it could not later read, write to the wrong config file, leak settings from one server to another, or accept half-defined agent roles that later confuse the program.

Most tests create a temporary Codex home folder, write or edit a TOML config file, then load the config again and compare the result. TOML is a human-readable settings format, like an organized checklist with sections. The MCP tests focus on external tool servers, making sure command-based servers and HTTP-based servers serialize optional fields cleanly. The model tests check that editing defaults changes only the intended file and does not disturb profile-specific settings. The policy tests check which guardian policy text wins when the same idea appears in different config layers. The agent-role tests check how role definitions are discovered, merged from separate files, validated, and warned about. Overall, these tests act like a receipt checker: after Codex writes or reads configuration, they make sure every important item is still there, in the right place, and with the right meaning. This part of the test file acts like a safety checklist for the configuration system. Codex has many ways to get settings: a user config file, per-project files, command-line overrides, cloud or enterprise requirements, and defaults. These tests create temporary config homes and fake projects, load the configuration, and check that the final result is what users and administrators would expect. Without tests like these, a small change could silently weaken sandboxing, ignore an enterprise restriction, choose the wrong model provider, or misread an agent role. Several tests focus on precedence, meaning which setting wins when the same idea is defined in more than one place. Others check validation, such as rejecting unsafe nickname text or an empty model catalog. Some tests verify migration behavior, like converting old inline project trust entries into newer explicit TOML tables. The file also checks that helpful warnings appear when Codex falls back from disallowed settings. In short, it makes sure configuration behaves like a well-labeled control panel: every switch should mean what it says, old switches should fail clearly when removed, and safety limits should remain in force. This is a test file. It protects the configuration system, which is the part of Codex that reads user and enterprise settings before the app starts doing work. Configuration is like the control panel for the program: a small spelling change, a bad default, or a missing safety check can change how the whole system behaves. These tests create temporary Codex home folders, write small TOML files into them, load those files through the same configuration builders used by the real app, and then check the final `Config` values. TOML is the simple text format used for config files, with sections like `[features]` and key/value lines. The tests also check enterprise requirements, which are centrally supplied rules that can force or restrict user choices. A major theme is normalization: if a user asks for one thing but an enterprise requirement says otherwise, the final config should be changed in a known way and usually warn the user. This chunk also verifies newer multi-agent settings, including concurrency limits and wait timeout validation, plus cleanup rules for tool suggestions. Near the end, it checks experimental realtime settings and terminal notification parsing. Without tests like these, config changes could silently break startup behavior, safety defaults, or enterprise policy enforcement.

#### Function details

##### `stdio_mcp`  (lines 114–138)

```
fn stdio_mcp(command: &str) -> McpServerConfig
```

**Purpose**: Builds a simple test MCP server configuration that would launch a local command through standard input and output. MCP means Model Context Protocol, a way for Codex to talk to external tools or services.

**Data flow**: It receives a command name as text, puts that command into an MCP server config with empty arguments and mostly default settings, and returns the ready-made config object. It does not start anything; it only creates test data.

**Call relations**: Several MCP allowlist tests call this helper when they need a fake local-command MCP server. It keeps those tests focused on filtering rules instead of repeating the same setup details.

*Call graph*: called by 5 (filter_mcp_servers_by_allowlist_allows_all_when_unset, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin, filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules); 2 external calls (new, new).


##### `http_mcp`  (lines 140–163)

```
fn http_mcp(url: &str) -> McpServerConfig
```

**Purpose**: Builds a simple test MCP server configuration that would connect over HTTP. It is used when tests need a fake network-based MCP server.

**Data flow**: It receives a URL, places it into an HTTP MCP transport config, fills the rest with safe default-like values, and returns the config object. No network request is made.

**Call relations**: MCP allowlist and plugin-selection tests call this helper to create repeatable HTTP server examples. It plays the same setup role as `stdio_mcp`, but for URL-based servers.

*Call graph*: called by 5 (filter_mcp_servers_by_allowlist_allows_all_when_unset, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules, selected_plugin_wins_after_discovered_plugin_requirements); 1 external calls (new).


##### `derive_legacy_sandbox_policy_for_test`  (lines 165–189)

```
async fn derive_legacy_sandbox_policy_for_test(
    cfg: &ConfigToml,
    sandbox_mode_override: Option<SandboxMode>,
    windows_sandbox_level: WindowsSandboxLevel,
    active_project: Option<&Projec
```

**Purpose**: Converts the newer permission-profile configuration into the older sandbox policy shape used by legacy code paths. Tests use it to confirm old and new permission systems stay compatible.

**Data flow**: It receives a parsed config, optional sandbox override, Windows sandbox level, optional active project, and optional permission-profile constraint. It asks the config to derive a permission profile, then tries to turn that profile into a legacy sandbox policy rooted at `/`; if that conversion fails, it logs a warning and returns a read-only fallback.

**Call relations**: Sandbox-policy tests call this helper when they need to compare the newer permission model with the older sandbox representation. It hands off first to `derive_permission_profile`, then to the profile’s legacy conversion method.

*Call graph*: calls 1 internal fn (derive_permission_profile); called by 4 (derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults, derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback, test_sandbox_config_parsing, test_untrusted_project_gets_workspace_write_sandbox); 1 external calls (new).


##### `load_config_normalizes_relative_cwd_override`  (lines 192–207)

```
async fn load_config_normalizes_relative_cwd_override() -> std::io::Result<()>
```

**Purpose**: Checks that a relative current-working-directory override is converted into an absolute path. This matters because later file access checks need one clear, unambiguous directory.

**Data flow**: The test creates the expected absolute path for `nested`, loads config with `cwd` set to the relative path `nested`, and checks that the resulting runtime config stores the absolute version.

**Call relations**: The Rust test runner executes this test. It calls the normal config-loading path so the same path-normalization behavior used in real runs is verified.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 6 external calls (default, from, load_from_base_config_with_overrides, assert_eq!, default, tempdir).


##### `test_toml_parsing`  (lines 210–311)

```
async fn test_toml_parsing()
```

**Purpose**: Checks that several TOML snippets deserialize into the expected in-memory config values. It covers history settings and the memories feature, including an older legacy field name.

**Data flow**: The test feeds TOML strings into the TOML parser, compares the parsed structs with expected values, then loads one memories config into the full runtime config and checks that defaults and explicit values resolve correctly.

**Call relations**: The test runner calls it as part of the config test suite. It uses TOML parsing directly for raw config checks and `Config::load_from_base_config_with_overrides` for final runtime behavior.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir).


##### `parses_bundled_skills_config`  (lines 314–334)

```
fn parses_bundled_skills_config()
```

**Purpose**: Verifies that bundled skills settings can be read from TOML. Skills here are built-in capability packs or instructions that Codex can include.

**Data flow**: It parses a TOML snippet with `[skills]` and `[skills.bundled]`, then checks that the resulting config records bundled skills as disabled and instruction inclusion as false.

**Call relations**: The test runner calls it during config parsing tests. It exercises the TOML deserialization layer only, without loading the full runtime config.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_web_search_true_deserializes_to_none`  (lines 337–353)

```
fn tools_web_search_true_deserializes_to_none()
```

**Purpose**: Checks backward-compatible parsing for `tools.web_search = true`. The expected result is that the old boolean setting is accepted but does not create a detailed web-search config.

**Data flow**: It parses a TOML tools section with `web_search = true` and checks that the parsed `web_search` field is `None`, while other tool settings are also absent.

**Call relations**: The test runner calls it to guard old config compatibility. It relies only on TOML deserialization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_web_search_false_deserializes_to_none`  (lines 356–372)

```
fn tools_web_search_false_deserializes_to_none()
```

**Purpose**: Checks backward-compatible parsing for `tools.web_search = false`. Like the true case, the old boolean form is accepted but ignored into an empty optional field.

**Data flow**: It parses a TOML tools section with `web_search = false` and confirms the resulting tools config has no detailed web-search value.

**Call relations**: The test runner calls it alongside the matching true-value test. Together they make sure either old boolean value remains harmless.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_experimental_request_user_input_defaults_to_enabled`  (lines 375–390)

```
fn tools_experimental_request_user_input_defaults_to_enabled()
```

**Purpose**: Verifies that declaring the experimental request-user-input tool section without an explicit value turns it on by default.

**Data flow**: It parses an empty `[tools.experimental_request_user_input]` section and checks that the parsed config contains that tool with `enabled` set to true.

**Call relations**: The test runner calls it to protect default behavior at the TOML parsing layer.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tools_experimental_request_user_input_can_be_disabled`  (lines 393–409)

```
fn tools_experimental_request_user_input_can_be_disabled()
```

**Purpose**: Verifies that the experimental request-user-input tool can be explicitly turned off in TOML.

**Data flow**: It parses a TOML section where `enabled = false`, then checks that the parsed tool config records `enabled` as false.

**Call relations**: The test runner calls it as the counterpart to the default-enabled test. It checks parsing, not full runtime loading.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `load_config_resolves_experimental_request_user_input_enabled`  (lines 412–431)

```
async fn load_config_resolves_experimental_request_user_input_enabled() -> std::io::Result<()>
```

**Purpose**: Checks that the parsed request-user-input tool setting reaches the final runtime config. This ensures a user’s off switch is not lost during config loading.

**Data flow**: It builds a base config where the experimental tool is disabled, loads the full config, and verifies the final `experimental_request_user_input_enabled` flag is false.

**Call relations**: The test runner executes it. It passes through `Config::load_from_base_config_with_overrides`, so it covers the real config resolution path.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, default, tempdir).


##### `load_config_resolves_code_mode_config`  (lines 434–457)

```
async fn load_config_resolves_code_mode_config() -> std::io::Result<()>
```

**Purpose**: Checks that code-mode feature settings load correctly, including excluded tool namespaces. A namespace is a named group of tools.

**Data flow**: It parses TOML enabling code mode and listing namespaces to exclude, loads the runtime config, then checks both the exclusion list and that the Code Mode feature is enabled.

**Call relations**: The test runner calls it to cover both TOML parsing and final feature resolution through the normal config loader.

*Call graph*: 6 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir, from_str).


##### `rejects_provider_auth_with_env_key`  (lines 460–477)

```
fn rejects_provider_auth_with_env_key()
```

**Purpose**: Ensures a model provider cannot define both an environment-variable API key and a custom auth command. That would be ambiguous because there would be two competing ways to get credentials.

**Data flow**: It parses an invalid provider config and expects parsing to fail. It then checks the error message names the exact conflict.

**Call relations**: The test runner calls this as a validation test. The failure happens during TOML deserialization.

*Call graph*: 1 external calls (assert!).


##### `rejects_provider_aws_for_custom_provider`  (lines 480–497)

```
fn rejects_provider_aws_for_custom_provider()
```

**Purpose**: Ensures AWS-specific provider settings are only allowed for the built-in Amazon Bedrock provider. This prevents custom providers from accidentally accepting settings they cannot use.

**Data flow**: It parses a custom provider with an `[aws]` section, expects an error, and checks that the message explains AWS config is only supported for `amazon-bedrock`.

**Call relations**: The test runner calls it to guard provider validation in the config parser.

*Call graph*: 1 external calls (assert!).


##### `accepts_amazon_bedrock_aws_profile_override`  (lines 500–524)

```
fn accepts_amazon_bedrock_aws_profile_override()
```

**Purpose**: Checks that Amazon Bedrock accepts supported AWS override fields, specifically profile and region.

**Data flow**: It parses TOML under `model_providers.amazon-bedrock.aws`, then looks up the provider and confirms the profile and region values were stored.

**Call relations**: The test runner calls it as the positive counterpart to AWS provider rejection tests. It checks parsing only.

*Call graph*: 1 external calls (assert_eq!).


##### `load_config_applies_amazon_bedrock_aws_profile_override`  (lines 527–564)

```
async fn load_config_applies_amazon_bedrock_aws_profile_override()
```

**Purpose**: Checks that Amazon Bedrock AWS profile and region overrides survive the full config-loading process.

**Data flow**: It parses a config selecting Amazon Bedrock and setting AWS profile and region, loads the runtime config, then checks the active provider ID and its AWS fields.

**Call relations**: The test runner calls it to verify the real loader applies the parsed provider override, not just that parsing succeeds.

*Call graph*: 4 external calls (load_from_base_config_with_overrides, assert_eq!, default, tempdir).


##### `load_config_rejects_unsupported_amazon_bedrock_overrides`  (lines 567–597)

```
async fn load_config_rejects_unsupported_amazon_bedrock_overrides()
```

**Purpose**: Ensures Amazon Bedrock can only be customized in the supported AWS profile and region fields. Other provider fields are rejected to avoid creating a half-custom built-in provider.

**Data flow**: It parses TOML with both allowed AWS fields and unsupported provider changes, then loads config expecting an invalid-data error with a clear message.

**Call relations**: The test runner calls it to validate runtime config loading, because the rejection is checked when the full config is assembled.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, assert_eq!, default, tempdir).


##### `config_toml_deserializes_model_availability_nux`  (lines 600–635)

```
fn config_toml_deserializes_model_availability_nux()
```

**Purpose**: Checks that the TUI can remember how often a model-availability new-user notice has been shown for each model. TUI means terminal user interface.

**Data flow**: It parses a TOML map of model names to counts and checks that the parsed TUI config contains those counts plus the expected TUI defaults.

**Call relations**: The test runner calls it to protect TOML deserialization for terminal UI settings.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_status_line_use_colors_defaults_to_enabled`  (lines 638–650)

```
fn config_toml_status_line_use_colors_defaults_to_enabled()
```

**Purpose**: Verifies that the TUI status line uses colors by default when a `[tui]` section is present.

**Data flow**: It parses an otherwise empty TUI section and checks that `status_line_use_colors` is true.

**Call relations**: The test runner calls it as a default-value check in the TOML parsing layer.

*Call graph*: 2 external calls (assert!, from_str).


##### `config_toml_deserializes_status_line_use_colors_disabled`  (lines 653–666)

```
fn config_toml_deserializes_status_line_use_colors_disabled()
```

**Purpose**: Verifies that users can turn off colored status-line output in the TUI.

**Data flow**: It parses TOML with `status_line_use_colors = false` and checks that the parsed TUI config records false.

**Call relations**: The test runner calls it as the explicit-off counterpart to the default-enabled test.

*Call graph*: 2 external calls (assert!, from_str).


##### `config_toml_deserializes_terminal_resize_reflow_config`  (lines 669–683)

```
fn config_toml_deserializes_terminal_resize_reflow_config()
```

**Purpose**: Checks that the TUI resize reflow limit can be read from config. Reflow means rearranging terminal text after the window size changes.

**Data flow**: It parses TOML setting `terminal_resize_reflow_max_rows` to 9000 and checks that the parsed TUI config stores `Some(9000)`.

**Call relations**: The test runner calls it to cover one specific TUI parsing field.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `runtime_config_defaults_model_availability_nux`  (lines 686–699)

```
async fn runtime_config_defaults_model_availability_nux()
```

**Purpose**: Checks that the runtime config has a sensible default for model-availability notice tracking when no config is provided.

**Data flow**: It loads a completely default config and compares the final `model_availability_nux` value with its default struct.

**Call relations**: The test runner calls it to cover full config loading rather than just raw TOML parsing.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `test_tui_vim_mode_default_defaults_to_false`  (lines 702–713)

```
fn test_tui_vim_mode_default_defaults_to_false()
```

**Purpose**: Verifies that Vim-style key behavior in the TUI is off unless the user enables it.

**Data flow**: It parses an empty TUI section and checks that `vim_mode_default` is false.

**Call relations**: The test runner calls it as a TUI default parsing check.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_vim_mode_default_true`  (lines 716–728)

```
fn test_tui_vim_mode_default_true()
```

**Purpose**: Verifies that Vim-style key behavior can be turned on in TUI config.

**Data flow**: It parses TOML with `vim_mode_default = true` and checks that the parsed TUI config records true.

**Call relations**: The test runner calls it as the explicit-on counterpart to the Vim-mode default test.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_raw_output_mode_defaults_to_false`  (lines 731–742)

```
fn test_tui_raw_output_mode_defaults_to_false()
```

**Purpose**: Checks that raw output mode in the TUI is off by default. Raw output mode likely means showing less-formatted or less-processed output.

**Data flow**: It parses an empty TUI section and checks that `raw_output_mode` is false.

**Call relations**: The test runner calls it to protect the default value in parsed config.

*Call graph*: 2 external calls (assert!, from_str).


##### `test_tui_raw_output_mode_true`  (lines 745–757)

```
fn test_tui_raw_output_mode_true()
```

**Purpose**: Checks that raw output mode can be enabled in TUI config.

**Data flow**: It parses TOML with `raw_output_mode = true` and confirms the parsed TUI config stores true.

**Call relations**: The test runner calls it as the explicit-on counterpart to the raw-output default test.

*Call graph*: 2 external calls (assert!, from_str).


##### `runtime_config_uses_tui_raw_output_mode`  (lines 760–775)

```
async fn runtime_config_uses_tui_raw_output_mode()
```

**Purpose**: Checks that the raw output mode setting is carried into the final runtime config.

**Data flow**: It parses TOML enabling raw output mode, loads the full config, and checks that `tui_raw_output_mode` is true in the runtime config.

**Call relations**: The test runner calls it to verify the normal loader connects the parsed TUI setting to the runtime field.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, tempdir, from_str).


##### `config_toml_deserializes_permission_profiles`  (lines 778–898)

```
fn config_toml_deserializes_permission_profiles()
```

**Purpose**: Checks that a rich permission profile can be read from TOML. The profile includes workspace roots, filesystem rules, network rules, and network MITM hooks; MITM means a controlled proxy can inspect or modify matching traffic.

**Data flow**: It parses a detailed permissions TOML example and compares the resulting nested config structs with the expected profile, including ordered hooks and action definitions.

**Call relations**: The test runner calls it to verify the parser accepts the full permission-profile shape that later runtime loading depends on.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_rejects_empty_mitm_action_reference_list`  (lines 901–923)

```
fn config_toml_rejects_empty_mitm_action_reference_list()
```

**Purpose**: Ensures a network MITM hook cannot declare an empty action list. Failing closed is safer than silently doing nothing when traffic matches.

**Data flow**: It parses a TOML hook whose `action` array is empty, expects parsing to fail, and checks the error message points to the empty action list.

**Call relations**: The test runner calls it as a validation test for permission-profile TOML.

*Call graph*: 1 external calls (assert!).


##### `config_toml_rejects_empty_mitm_action_definition`  (lines 926–947)

```
fn config_toml_rejects_empty_mitm_action_definition()
```

**Purpose**: Ensures a named MITM action must actually do something, such as stripping or injecting a header.

**Data flow**: It parses TOML where a hook references an action, but the action definition is empty. It expects an error and checks that the message says at least one operation is required.

**Call relations**: The test runner calls it to make sure unsafe or meaningless MITM action definitions are rejected during parsing.

*Call graph*: 1 external calls (assert!).


##### `permissions_profile_network_to_proxy_config_preserves_mitm_hooks`  (lines 950–989)

```
fn permissions_profile_network_to_proxy_config_preserves_mitm_hooks()
```

**Purpose**: Checks that network permission TOML converts into proxy configuration without losing MITM hook details.

**Data flow**: It builds a network config in memory with one hook and one action, converts it to proxy config, and checks the mode, MITM flag, host, method, and header-stripping action.

**Call relations**: The test runner calls it to verify the conversion method used after parsing. It does not load a full app config.

*Call graph*: 7 external calls (from, new, assert!, assert_eq!, default, default, vec!).


##### `permissions_profile_network_to_proxy_config_preserves_mitm_hook_declaration_order`  (lines 992–1032)

```
fn permissions_profile_network_to_proxy_config_preserves_mitm_hook_declaration_order()
```

**Purpose**: Checks that MITM hooks keep the order users wrote them in. Order matters because earlier traffic rules may be more specific than later ones.

**Data flow**: It parses TOML with two hooks declared in a deliberate order, converts the network settings to proxy config, and checks the resulting hook list follows the same order.

**Call relations**: The test runner calls it to connect TOML parsing with proxy-config conversion behavior.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `permissions_profiles_proxy_policy_does_not_start_managed_network_proxy_without_feature`  (lines 1035–1083)

```
async fn permissions_profiles_proxy_policy_does_not_start_managed_network_proxy_without_feature() -> std::io::Result<()>
```

**Purpose**: Checks that simply enabling network access in a permission profile does not start the managed network proxy unless the feature is enabled.

**Data flow**: It creates temporary home and working directories, loads a config with network enabled in a permission profile, then verifies network sandboxing is enabled but no managed proxy config is present.

**Call relations**: The test runner calls it through the full config loader. It sets up a fake git workspace so project-root logic behaves like a real checkout.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, write).


##### `permissions_profiles_proxy_policy_starts_managed_network_proxy`  (lines 1086–1135)

```
async fn permissions_profiles_proxy_policy_starts_managed_network_proxy() -> std::io::Result<()>
```

**Purpose**: Despite its name, this test confirms that a profile containing proxy settings still does not start the managed proxy when the network-proxy feature is not enabled.

**Data flow**: It loads a permission profile with network access, a proxy URL, and SOCKS disabled. The final config keeps network access enabled but leaves the managed proxy absent.

**Call relations**: The test runner calls it as a full-loader regression test. It is paired with later tests that enable the feature and expect the proxy to appear.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, write).


##### `network_proxy_feature_is_no_op_without_sandbox_network`  (lines 1138–1163)

```
async fn network_proxy_feature_is_no_op_without_sandbox_network() -> std::io::Result<()>
```

**Purpose**: Checks that enabling the network-proxy feature alone does nothing if sandbox network access is still off.

**Data flow**: It loads config with `network_proxy = true` but no permission setting that allows network access, then verifies the network policy remains restricted and no proxy config is created.

**Call relations**: The test runner calls it to prove the feature flag does not override the more basic network-sandbox decision.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, from_str).


##### `network_proxy_feature_matrix_preserves_sandbox_network_semantics`  (lines 1166–1313)

```
async fn network_proxy_feature_matrix_preserves_sandbox_network_semantics() -> std::io::Result<()>
```

**Purpose**: Tests many combinations of old and new network settings to ensure the network-proxy feature does not change whether network access itself is allowed.

**Data flow**: It loops over cases covering permission profiles and legacy workspace-write sandbox settings, with network access on or off and proxy feature on or off. For each case it loads config and checks the network sandbox policy and whether managed proxy config appears.

**Call relations**: The test runner calls it as a broad matrix test. It uses the normal loader for each case so interactions between legacy sandboxing, permission profiles, and feature flags are tested together.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `network_proxy_cli_overrides_merge_toggle_with_proxy_config`  (lines 1316–1362)

```
async fn network_proxy_cli_overrides_merge_toggle_with_proxy_config() -> std::io::Result<()>
```

**Purpose**: Checks that command-line overrides can turn on the network proxy while also changing proxy details such as SOCKS support.

**Data flow**: It writes a real config file enabling workspace-write network access, builds config with CLI overrides for the network proxy feature and SOCKS setting, then checks that the proxy starts with the expected host and SOCKS disabled.

**Call relations**: The test runner calls it through `ConfigBuilder`, which simulates a more realistic config load from disk plus command-line overrides.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert!, assert_eq!, write, vec!).


##### `experimental_network_requirements_enable_proxy_without_feature`  (lines 1365–1392)

```
async fn experimental_network_requirements_enable_proxy_without_feature() -> std::io::Result<()>
```

**Purpose**: Checks that enterprise-style experimental network requirements can configure the managed proxy even when the user-facing network-proxy feature flag is off.

**Data flow**: It builds config using a cloud config bundle fixture that declares experimental network enabled. The final config should not report the normal feature flag as enabled, but should report managed network requirements and have an enabled proxy config.

**Call relations**: The test runner calls it through `ConfigBuilder` and a cloud-config fixture. This covers managed configuration, not ordinary user TOML.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `network_proxy_feature_uses_profile_network_proxy_settings`  (lines 1395–1447)

```
async fn network_proxy_feature_uses_profile_network_proxy_settings() -> std::io::Result<()>
```

**Purpose**: Checks that when the network-proxy feature is enabled, proxy settings from the active permission profile are used.

**Data flow**: It loads a config with `network_proxy = true`, network access enabled, a custom proxy URL, and SOCKS disabled. It checks the final network policy, proxy host and port, and SOCKS state.

**Call relations**: The test runner calls it as the positive version of the earlier no-feature proxy tests.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, from_str).


##### `disabled_network_proxy_feature_does_not_start_profile_proxy_policy`  (lines 1450–1505)

```
async fn disabled_network_proxy_feature_does_not_start_profile_proxy_policy() -> std::io::Result<()>
```

**Purpose**: Checks that explicitly disabling the network-proxy feature prevents the managed proxy from starting, even when a permission profile includes proxy settings.

**Data flow**: It loads a profile with network access and proxy details, but a feature config where network proxy is disabled. It verifies the feature is off and the runtime permissions contain no managed proxy.

**Call relations**: The test runner calls it to guard the off switch for proxy startup.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, from_str).


##### `permissions_profiles_network_disabled_by_default_does_not_start_proxy`  (lines 1508–1555)

```
async fn permissions_profiles_network_disabled_by_default_does_not_start_proxy() -> std::io::Result<()>
```

**Purpose**: Checks that network rules such as allowed domains do not imply network access is enabled. The user must explicitly enable network access before proxy-related behavior can start.

**Data flow**: It loads a permission profile with a domain allow rule but no `enabled = true`, then checks that no managed network proxy config exists.

**Call relations**: The test runner calls it through the full config loader, with a fake git workspace for realistic workspace-root behavior.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, write).


##### `default_permissions_profile_populates_runtime_sandbox_policy`  (lines 1558–1658)

```
async fn default_permissions_profile_populates_runtime_sandbox_policy() -> std::io::Result<()>
```

**Purpose**: Checks that selecting a default permission profile produces the expected runtime filesystem and network sandbox rules. A sandbox is a safety boundary that limits what files or network resources code can use.

**Data flow**: It creates a temporary workspace with a docs folder, loads a config whose default profile grants minimal read access, write access to the workspace root, and read access to docs. It then checks the runtime filesystem policy, legacy sandbox projection, write denial for `.git`, network restriction, and active profile ID.

**Call relations**: The test runner calls it as a core end-to-end permission-profile test. It verifies both the new runtime permission model and the older legacy sandbox view.

*Call graph*: 10 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, Scoped, create_dir_all, write).


##### `default_permissions_extended_profile_preserves_parent_metadata`  (lines 1661–1717)

```
async fn default_permissions_extended_profile_preserves_parent_metadata() -> std::io::Result<()>
```

**Purpose**: Checks that when a permission profile extends another profile, the final active-profile metadata still records that parent relationship.

**Data flow**: It loads a config with a base profile and a `dev` profile that extends it. The final config should show `dev` as active and `base` as its parent.

**Call relations**: The test runner calls it to protect profile inheritance metadata during full config loading.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `permission_profile_override_populates_runtime_permissions`  (lines 1720–1746)

```
async fn permission_profile_override_populates_runtime_permissions() -> std::io::Result<()>
```

**Purpose**: Checks that a direct permission-profile override wins and fills the runtime permissions. In this case, the override disables sandbox restrictions, resulting in full access.

**Data flow**: It loads default config with a harness override setting the permission profile to `Disabled`, then verifies the effective profile, absence of an active named profile, and legacy full-access sandbox.

**Call relations**: The test runner calls it through the config loader using overrides, similar to how a harness or command-line layer can force settings.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `permission_snapshot_setter_preserves_permission_constraints`  (lines 1749–1770)

```
fn permission_snapshot_setter_preserves_permission_constraints()
```

**Purpose**: Checks that restoring permissions from a session snapshot cannot violate existing permission constraints. A constraint is a rule saying which values are allowed.

**Data flow**: It creates permissions constrained to allow only a read-only profile, then tries to apply a workspace-write snapshot. The setter returns an error, and the original read-only profile remains unchanged.

**Call relations**: The test runner calls it directly on the permissions object. It exercises the snapshot setter rather than full config loading.

*Call graph*: calls 7 internal fn (new, allow_any, allow_only, from_approval_and_profile, active, read_only, workspace_write); 2 external calls (assert!, assert_eq!).


##### `permission_profile_override_preserves_managed_unrestricted_filesystem`  (lines 1773–1804)

```
async fn permission_profile_override_preserves_managed_unrestricted_filesystem() -> std::io::Result<()>
```

**Purpose**: Checks that a managed permission profile with unrestricted filesystem access is preserved, while network access remains restricted.

**Data flow**: It loads config with a managed override specifying unrestricted filesystem and restricted network. It then checks the effective profile and the legacy projection, which becomes an external sandbox with restricted network.

**Call relations**: The test runner calls it through the normal loader to verify managed-profile overrides survive config resolution.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `managed_unrestricted_permission_profile_still_enables_network_requirements`  (lines 1807–1859)

```
async fn managed_unrestricted_permission_profile_still_enables_network_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that managed network requirements can still be recognized even when the legacy sandbox view of a managed unrestricted profile is lossy.

**Data flow**: It loads a managed profile with unrestricted filesystem and enabled network, confirms the legacy projection is full access, then rebuilds the config layer stack with network requirements and checks that managed network requirements are considered enabled.

**Call relations**: The test runner calls it to cover a subtle interaction between permission profiles, legacy sandbox projection, and managed configuration requirements.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `permission_profile_override_keeps_memories_root_out_of_legacy_projection`  (lines 1862–1912)

```
async fn permission_profile_override_keeps_memories_root_out_of_legacy_projection() -> std::io::Result<()>
```

**Purpose**: Checks that a permission-profile override does not accidentally add the memories storage directory to the old legacy sandbox’s writable paths.

**Data flow**: It builds a permission profile from runtime filesystem rules that allow writing project roots but only reading the root. After loading config, it checks the memories directory is not writable and that the legacy sandbox projection has no writable roots.

**Call relations**: The test runner calls it to guard against leaking extra write access when converting newer permissions into the older sandbox format.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 7 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `permission_profile_override_preserves_configured_network_policy_without_starting_proxy`  (lines 1915–1973)

```
async fn permission_profile_override_preserves_configured_network_policy_without_starting_proxy() -> std::io::Result<()>
```

**Purpose**: Checks that a permission-profile override can replace the effective permission profile without accidentally starting a managed proxy from the configured profile.

**Data flow**: It loads a config containing a named profile with network and proxy settings, while also passing an override that disables permissions. The final config has no managed network proxy and uses the override profile.

**Call relations**: The test runner calls it through the full loader to verify override precedence and proxy-startup rules work together.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access).


##### `workspace_root_glob_none_compiles_to_filesystem_pattern_entry`  (lines 1976–2057)

```
async fn workspace_root_glob_none_compiles_to_filesystem_pattern_entry() -> std::io::Result<()>
```

**Purpose**: Checks that a glob pattern under workspace roots, such as `**/*.env`, becomes a real filesystem glob rule rather than a literal project-root entry. This matters because deny rules for matching files must actually match files across workspace roots.

**Data flow**: It creates temporary project roots, builds a custom permission profile with a scoped workspace rule, and loads that config. It then reads the produced filesystem sandbox policy and verifies that each workspace root has a deny glob entry for `.env` files, while no unexpanded special-path entry remains.

**Call relations**: The Rust test runner calls this test. Inside, it drives `Config::load_from_base_config_with_overrides`, then uses path resolution and policy inspection to confirm that config loading translated the user-facing rule into concrete sandbox entries.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Scoped, write, vec!).


##### `permissions_profiles_require_default_permissions`  (lines 2060–2102)

```
async fn permissions_profiles_require_default_permissions() -> std::io::Result<()>
```

**Purpose**: Ensures Codex rejects a config that defines custom permission profiles but does not say which one should be active. Without this, Codex would have to guess which access rules to use.

**Data flow**: It builds a config with a `permissions` table but no `default_permissions` value. Loading the config is expected to fail, and the test checks that the failure is an invalid-input error with a specific message.

**Call relations**: The test runner invokes this as a negative test. It calls the main config loader and confirms that the loader stops early instead of silently choosing a profile.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Access, write).


##### `default_permissions_can_select_builtin_profile_without_permissions_table`  (lines 2105–2143)

```
async fn default_permissions_can_select_builtin_profile_without_permissions_table() -> std::io::Result<()>
```

**Purpose**: Checks that a built-in permission profile can be selected directly, even when the config does not define any custom permission profiles. This lets users choose standard safe modes without writing a full permissions table.

**Data flow**: It loads a config whose `default_permissions` names the built-in workspace profile. The resulting config is inspected to confirm explicit profile mode is active, no custom profiles exist, the active profile is the workspace profile, the project root is writable, and `.git` metadata is protected.

**Call relations**: The test runner calls this test. The test relies on config loading to expand a built-in profile into a filesystem sandbox policy, then checks the policy’s write decisions.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `default_permissions_read_only_keeps_add_dir_read_only`  (lines 2146–2178)

```
async fn default_permissions_read_only_keeps_add_dir_read_only() -> std::io::Result<()>
```

**Purpose**: Verifies that selecting the built-in read-only profile stays read-only even when extra writable roots are supplied at runtime. This prevents a read-only choice from being weakened by separate command-line or runtime options.

**Data flow**: It creates a current directory and an additional root, loads config with the built-in read-only profile, and passes the additional root as an override. It then checks that the additional root cannot be written and that the active profile is read-only.

**Call relations**: The test runner calls this test during config tests. It exercises the interaction between `default_permissions` and `ConfigOverrides.additional_writable_roots` through the config loader.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, vec!).


##### `workspace_profile_applies_rules_to_runtime_and_profile_workspace_roots`  (lines 2181–2278)

```
async fn workspace_profile_applies_rules_to_runtime_and_profile_workspace_roots() -> std::io::Result<()>
```

**Purpose**: Checks that workspace-root rules apply both to runtime roots and roots declared inside a permission profile. This ensures all intended project areas get the same protection and access behavior.

**Data flow**: It creates three fake project roots: the current directory, a runtime extra root, and a profile-defined root. After loading a custom profile, it verifies which roots are stored as runtime workspace roots, which roots are effective overall, and whether the sandbox allows writing roots while blocking `.git` and `.codex` inside each one.

**Call relations**: The test runner calls this test. It sends both config-defined roots and override-defined roots into the config loader, then checks the resulting `permissions` object and filesystem policy.

*Call graph*: 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Scoped, create_dir_all, vec!).


##### `explicit_builtin_workspace_profile_ignores_legacy_workspace_write_settings`  (lines 2281–2320)

```
async fn explicit_builtin_workspace_profile_ignores_legacy_workspace_write_settings() -> std::io::Result<()>
```

**Purpose**: Ensures that explicitly choosing the built-in workspace profile does not accidentally inherit older `sandbox_workspace_write` settings. This avoids mixing two configuration systems in a way that grants unexpected access.

**Data flow**: It loads config with `default_permissions` set to the built-in workspace profile while also providing legacy writable roots and network access. It then confirms the network remains restricted and the legacy extra root is not added as a direct filesystem grant.

**Call relations**: The test runner invokes this test. It checks that the modern permission-profile path in `Config::load_from_base_config_with_overrides` takes precedence over legacy sandbox settings.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, vec!).


##### `default_permissions_profile_can_extend_builtin_workspace`  (lines 2323–2418)

```
async fn default_permissions_profile_can_extend_builtin_workspace() -> std::io::Result<()>
```

**Purpose**: Checks that a custom profile can extend the built-in workspace profile and selectively override parts of it. This lets users start from a safe default and make small changes.

**Data flow**: It defines a custom profile that extends workspace access, adds network access, and changes the temporary-directory rule from write to read. After loading, it checks that project-root writes and metadata protections are inherited, slash-temp write access remains, tmpdir write access is replaced by read access, network access is enabled, and the active profile records its parent.

**Call relations**: The test runner calls this test. The config loader combines the built-in parent profile with the custom child profile, and the test verifies the merged result.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access).


##### `default_permissions_profile_can_extend_builtin_read_only`  (lines 2421–2474)

```
async fn default_permissions_profile_can_extend_builtin_read_only() -> std::io::Result<()>
```

**Purpose**: Checks that a custom profile can extend the built-in read-only profile without losing its read-only filesystem behavior. It also confirms the child can enable network access.

**Data flow**: It loads a custom profile that extends read-only and turns on network access. The resulting policy is checked to ensure the current directory can be read but not written, while the network sandbox policy is enabled and the active profile records the extension.

**Call relations**: The test runner invokes this test. It exercises profile inheritance in the config loader for the read-only built-in profile.

*Call graph*: 6 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `empty_config_defaults_to_builtin_profile_for_trusted_project`  (lines 2477–2529)

```
async fn empty_config_defaults_to_builtin_profile_for_trusted_project() -> std::io::Result<()>
```

**Purpose**: Checks which built-in permission profile Codex chooses when there is no explicit permission config but the current project is trusted. This preserves the expected fallback behavior.

**Data flow**: It marks the temporary project as trusted, loads otherwise empty config, and inspects the chosen active profile and filesystem policy. On Windows it expects read-only behavior because sandbox support differs; on other systems it expects workspace-write behavior with metadata carveouts.

**Call relations**: The test runner calls this test. It feeds project trust information into the config loader and checks the fallback permission decision.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `empty_config_defaults_to_builtin_profile_for_untrusted_project`  (lines 2532–2588)

```
async fn empty_config_defaults_to_builtin_profile_for_untrusted_project() -> std::io::Result<()>
```

**Purpose**: Checks the default permission profile when the config is empty but the project is marked untrusted. The test documents the current fallback behavior while still checking that access is not broader than intended on Windows.

**Data flow**: It loads config for an untrusted temporary project, then checks the active built-in profile and whether the current directory can be read and, depending on the operating system, written. It also verifies metadata carveouts for the workspace behavior on non-Windows systems.

**Call relations**: The test runner invokes this test. The config loader combines project trust data with platform-specific sandbox behavior, and the test checks the resulting policy.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `implicit_builtin_workspace_profile_preserves_sandbox_workspace_write_settings`  (lines 2591–2657)

```
async fn implicit_builtin_workspace_profile_preserves_sandbox_workspace_write_settings() -> std::io::Result<()>
```

**Purpose**: Checks that when Codex implicitly falls back to workspace-write mode, older workspace-write settings are still honored. This keeps backward compatibility for users who have not moved to explicit permission profiles.

**Data flow**: It loads config for a trusted project with legacy writable roots, network access, and temp-directory exclusions. The resulting policy must allow writing the extra root, enable network access, report no clean active permission profile, and project back to the expected legacy sandbox policy.

**Call relations**: The test runner calls this test. It exercises the compatibility path where the config loader derives modern permissions from legacy sandbox settings.

*Call graph*: 8 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, panic!, vec!).


##### `implicit_builtin_workspace_profile_preserves_add_dir_metadata_carveouts`  (lines 2660–2707)

```
async fn implicit_builtin_workspace_profile_preserves_add_dir_metadata_carveouts() -> std::io::Result<()>
```

**Purpose**: Verifies that additional writable roots keep protective carveouts for metadata directories like `.git`, `.agents`, and `.codex` when workspace mode is chosen implicitly. This prevents extra roots from becoming too open.

**Data flow**: It creates an extra root with metadata subdirectories, loads config that falls back to workspace permissions, and passes the extra root as an additional writable root. The policy must allow writing the root itself but deny writing the sensitive metadata subdirectories.

**Call relations**: The test runner invokes this test. It checks the config loader’s legacy-compatible treatment of `additional_writable_roots`.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, create_dir_all, vec!).


##### `empty_config_defaults_to_builtin_read_only_without_trust_decision`  (lines 2710–2735)

```
async fn empty_config_defaults_to_builtin_read_only_without_trust_decision() -> std::io::Result<()>
```

**Purpose**: Checks that with no project trust decision and no explicit permission settings, Codex defaults to read-only access. This is the safer choice when Codex does not know whether the project should be trusted.

**Data flow**: It loads a completely default config in a temporary directory. The resulting policy is checked to ensure the current directory can be read but not written.

**Call relations**: The test runner calls this test. It exercises the config loader’s safest fallback path.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `default_permissions_can_select_builtin_full_access_profile`  (lines 2738–2768)

```
async fn default_permissions_can_select_builtin_full_access_profile() -> std::io::Result<()>
```

**Purpose**: Checks that the built-in full-access profile can be selected by its current supported name. This mode disables the sandbox, so the test makes sure it is represented clearly.

**Data flow**: It loads config with `default_permissions` set to the full-access built-in profile. The resulting permission profile is expected to be disabled, meaning no sandbox restriction, and the active profile ID must match the requested built-in name.

**Call relations**: The test runner invokes this test. It calls the config loader and checks the permission-profile object that comes out.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `legacy_danger_no_sandbox_is_rejected`  (lines 2771–2794)

```
async fn legacy_danger_no_sandbox_is_rejected() -> std::io::Result<()>
```

**Purpose**: Ensures an old full-access alias is no longer accepted as a built-in profile name. This avoids silently supporting stale or misleading configuration.

**Data flow**: It loads config with `default_permissions` set to `:danger-no-sandbox`. Loading must fail, and the test checks the exact error message explaining that the built-in profile is unknown.

**Call relations**: The test runner calls this negative test. It confirms that config loading validates built-in profile names rather than mapping old aliases.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `user_defined_permission_profile_names_cannot_use_builtin_prefix`  (lines 2797–2827)

```
async fn user_defined_permission_profile_names_cannot_use_builtin_prefix() -> std::io::Result<()>
```

**Purpose**: Checks that custom permission profiles cannot use names beginning with the reserved built-in prefix `:`. This prevents user-defined names from being confused with Codex’s built-in profiles.

**Data flow**: It defines a custom profile named `:custom` and tries to select it. The loader must reject the config with an invalid-input error and a clear message about the reserved prefix.

**Call relations**: The test runner invokes this test. It drives the config loader’s profile-name validation.

*Call graph*: 6 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `unknown_builtin_permission_profile_name_is_rejected`  (lines 2830–2854)

```
async fn unknown_builtin_permission_profile_name_is_rejected() -> std::io::Result<()>
```

**Purpose**: Ensures that a `default_permissions` value that looks like a built-in profile but is not recognized is rejected. This catches typos instead of falling back to a surprising mode.

**Data flow**: It loads config with `default_permissions = ':unknown'`. Loading must fail with an invalid-input error saying the built-in profile is unknown.

**Call relations**: The test runner calls this negative test. It verifies built-in profile lookup in the config loader.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `permissions_profiles_allow_direct_write_roots_outside_workspace_root`  (lines 2857–2920)

```
async fn permissions_profiles_allow_direct_write_roots_outside_workspace_root() -> std::io::Result<()>
```

**Purpose**: Checks that a custom permission profile can directly grant write access to an absolute path outside the project workspace. This supports deliberate access to external folders.

**Data flow**: It creates a project and a separate external directory, defines a profile granting write access to the external absolute path, and loads the config. It then checks the custom profile summary, confirms the path is writable, and verifies the legacy sandbox projection includes that path as a writable root.

**Call relations**: The test runner invokes this test. It exercises absolute-path entries in permission profiles and their conversion into both modern and legacy sandbox views.

*Call graph*: calls 1 internal fn (from_absolute_path); 9 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, Access, canonicalize, write).


##### `permissions_profiles_reject_nested_entries_for_non_workspace_roots`  (lines 2923–2970)

```
async fn permissions_profiles_reject_nested_entries_for_non_workspace_roots() -> std::io::Result<()>
```

**Purpose**: Ensures nested subpath rules are rejected for special entries that do not support them. This prevents configs that look precise but cannot be interpreted safely.

**Data flow**: It defines a scoped rule under `:minimal` with a nested `docs` entry. Loading is expected to fail with an invalid-input error explaining that `:minimal` does not support nested entries.

**Call relations**: The test runner calls this negative test. It checks validation inside the config loader before such rules become sandbox policies.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Scoped, write).


##### `load_workspace_permission_profile`  (lines 2972–2994)

```
async fn load_workspace_permission_profile(
    profile: PermissionProfileToml,
) -> std::io::Result<Config>
```

**Purpose**: Provides a small helper for tests that need to load a single custom permission profile named `dev`. It avoids repeating the same temporary project setup in several related tests.

**Data flow**: It receives a `PermissionProfileToml`, creates temporary Codex home and project directories, writes a fake `.git` marker, wraps the profile in a config with `default_permissions = 'dev'`, and returns the loaded `Config` or an I/O error.

**Call relations**: This helper is called by the tests for unknown special paths and missing or empty filesystem sections. It hands their supplied profile to `Config::load_from_base_config_with_overrides` and returns the full config for inspection.

*Call graph*: called by 4 (permissions_profiles_allow_empty_filesystem_with_warning, permissions_profiles_allow_missing_filesystem_with_warning, permissions_profiles_allow_unknown_special_paths, permissions_profiles_allow_unknown_special_paths_with_nested_entries); 5 external calls (from, default, new, load_from_base_config_with_overrides, write).


##### `permissions_profiles_allow_unknown_special_paths`  (lines 2997–3039)

```
async fn permissions_profiles_allow_unknown_special_paths() -> std::io::Result<()>
```

**Purpose**: Checks forward compatibility for unknown special filesystem paths. Older Codex versions should warn and ignore what they do not understand rather than crashing on future config keys.

**Data flow**: It uses `load_workspace_permission_profile` to load a profile containing `:future_special_path`. The resulting policy keeps an unknown special-path entry, the legacy sandbox view is read-only, and startup warnings mention that the path is not recognized.

**Call relations**: The test runner calls this test, which delegates setup to `load_workspace_permission_profile`. It then inspects both the modern policy and compatibility warnings.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 4 external calls (from, assert!, assert_eq!, Access).


##### `permissions_profiles_allow_unknown_special_paths_with_nested_entries`  (lines 3042–3079)

```
async fn permissions_profiles_allow_unknown_special_paths_with_nested_entries() -> std::io::Result<()>
```

**Purpose**: Checks that unknown future special paths with nested entries are also tolerated with a warning. This keeps configuration files usable across versions.

**Data flow**: It loads a profile containing `:future_special_path` with a nested `docs` rule. The policy records an unknown special path with that subpath, and startup warnings explain that the combination is not recognized and will be ignored.

**Call relations**: The test runner invokes this test. It uses `load_workspace_permission_profile` for setup, then checks the policy and warnings.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 4 external calls (from, assert!, assert_eq!, Scoped).


##### `permissions_profiles_allow_missing_filesystem_with_warning`  (lines 3082–3110)

```
async fn permissions_profiles_allow_missing_filesystem_with_warning() -> std::io::Result<()>
```

**Purpose**: Ensures a custom permission profile with no filesystem section is allowed but produces a warning. This is safer than failing immediately while still telling the user the profile grants no recognized file access.

**Data flow**: It loads a profile whose filesystem field is absent. The resulting filesystem sandbox policy is restricted with no entries, the legacy view is read-only, and startup warnings mention that the profile has no recognized filesystem entries.

**Call relations**: The test runner calls this test. It relies on `load_workspace_permission_profile` for the standard profile-loading setup.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 2 external calls (assert!, assert_eq!).


##### `permissions_profiles_allow_empty_filesystem_with_warning`  (lines 3113–3138)

```
async fn permissions_profiles_allow_empty_filesystem_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that an explicitly empty filesystem section is treated like no recognized filesystem access and produces a warning. This helps users notice a profile that may not do what they intended.

**Data flow**: It loads a profile with an empty filesystem entries map. The resulting policy is restricted with no entries, and startup warnings mention that profile `dev` defines no recognized filesystem entries.

**Call relations**: The test runner invokes this test. It uses `load_workspace_permission_profile` to load the test profile before checking the warning and policy.

*Call graph*: calls 1 internal fn (load_workspace_permission_profile); 3 external calls (new, assert!, assert_eq!).


##### `permissions_profiles_reject_workspace_root_parent_traversal`  (lines 3141–3187)

```
async fn permissions_profiles_reject_workspace_root_parent_traversal() -> std::io::Result<()>
```

**Purpose**: Ensures workspace-root scoped entries cannot use `..` to escape to a parent or sibling directory. This is an important safety check against granting access outside the intended project tree.

**Data flow**: It defines a scoped workspace-root rule for `../sibling` and tries to load the config. Loading must fail with an invalid-input error saying the subpath must be a descendant path without `.` or `..` components.

**Call relations**: The test runner calls this negative test. It verifies path validation inside the permission-profile loader.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, Scoped, write).


##### `permissions_profiles_allow_network_enablement`  (lines 3190–3235)

```
async fn permissions_profiles_allow_network_enablement() -> std::io::Result<()>
```

**Purpose**: Checks that a custom permission profile can explicitly enable network access. This confirms filesystem permissions and network permissions are combined correctly.

**Data flow**: It loads a `dev` profile with minimal read filesystem access and `network.enabled = true`. The resulting permissions must report enabled network access, and the legacy sandbox projection must also show full network access.

**Call relations**: The test runner invokes this test. It exercises the config loader’s network section and its conversion to the older sandbox-policy view.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, Access, write).


##### `tui_theme_deserializes_from_toml`  (lines 3238–3248)

```
fn tui_theme_deserializes_from_toml()
```

**Purpose**: Checks that the terminal UI theme setting can be read from TOML. This lets users choose a named visual theme.

**Data flow**: It parses a small TOML snippet with `[tui] theme = 'dracula'`. The parsed config is checked to ensure the TUI theme field contains `dracula`.

**Call relations**: The test runner calls this parser-focused test. It uses TOML deserialization directly rather than the full runtime config loader.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_theme_defaults_to_none`  (lines 3251–3257)

```
fn tui_theme_defaults_to_none()
```

**Purpose**: Checks that if a TUI section does not name a theme, the theme remains unset. This lets later code choose the normal default behavior.

**Data flow**: It parses a TOML snippet with an empty `[tui]` section. The parsed config is checked to confirm the theme field is `None`.

**Call relations**: The test runner invokes this direct TOML deserialization test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_session_picker_view_deserializes_from_toml`  (lines 3260–3270)

```
fn tui_session_picker_view_deserializes_from_toml()
```

**Purpose**: Checks that the TUI session picker view mode can be read from TOML. In this case, the text value `dense` must become the matching enum value.

**Data flow**: It parses `[tui] session_picker_view = 'dense'` and inspects the parsed TUI config. The output must contain `SessionPickerViewMode::Dense`.

**Call relations**: The test runner calls this test. It validates the TOML-to-typed-config conversion for this UI setting.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_deserializes_from_toml`  (lines 3273–3283)

```
fn tui_pet_deserializes_from_toml()
```

**Purpose**: Checks that the optional TUI pet name can be read from TOML. This is a simple parser test for a user-facing interface option.

**Data flow**: It parses `[tui] pet = 'chefito'`. The parsed config should contain the string `chefito` in the TUI pet field.

**Call relations**: The test runner invokes this direct TOML parsing test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_session_picker_view_defaults_to_none`  (lines 3286–3295)

```
fn tui_session_picker_view_defaults_to_none()
```

**Purpose**: Checks that the session picker view setting is unset when not provided. This separates raw parsed config from runtime defaults that may be applied later.

**Data flow**: It parses an empty `[tui]` section and checks that `session_picker_view` is `None`.

**Call relations**: The test runner calls this parser-default test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_defaults_to_none`  (lines 3298–3304)

```
fn tui_pet_defaults_to_none()
```

**Purpose**: Checks that no TUI pet is selected when the config does not provide one. This prevents accidental default pets at the raw TOML layer.

**Data flow**: It parses an empty `[tui]` section and verifies the `pet` field is `None`.

**Call relations**: The test runner invokes this TOML deserialization test.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_deserializes_from_toml`  (lines 3307–3317)

```
fn tui_pet_anchor_deserializes_from_toml()
```

**Purpose**: Checks that the TUI pet anchor position can be read from TOML. The value `screen-bottom` must map to the screen-bottom enum setting.

**Data flow**: It parses `[tui] pet_anchor = 'screen-bottom'` and verifies the parsed TUI config contains `TuiPetAnchor::ScreenBottom`.

**Call relations**: The test runner calls this parser test. It verifies accepted text values for the pet anchor option.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_defaults_to_composer`  (lines 3320–3329)

```
fn tui_pet_anchor_defaults_to_composer()
```

**Purpose**: Checks that an empty TUI section gives the pet anchor its default location, the composer. This means the default is applied during TUI config deserialization.

**Data flow**: It parses an empty `[tui]` section and checks that `pet_anchor` is `TuiPetAnchor::Composer`.

**Call relations**: The test runner invokes this default-value test for TOML parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tui_pet_anchor_rejects_unknown_value`  (lines 3332–3345)

```
fn tui_pet_anchor_rejects_unknown_value()
```

**Purpose**: Ensures unknown pet anchor values are rejected with a useful error. This helps users fix typos instead of getting a silently ignored setting.

**Data flow**: It parses TOML containing `pet_anchor = 'bottom'` and expects parsing to fail. The error text must mention the unknown value and the accepted alternatives.

**Call relations**: The test runner calls this negative parser test. It checks the TOML deserializer’s validation for enum values.

*Call graph*: 1 external calls (assert!).


##### `tui_config_missing_notifications_field_defaults_to_enabled`  (lines 3348–3378)

```
fn tui_config_missing_notifications_field_defaults_to_enabled()
```

**Purpose**: Checks the full default TUI config when the `[tui]` section exists but omits notification settings. This protects the expected defaults for many interface options.

**Data flow**: It parses an empty `[tui]` section, extracts the TUI config, and compares it to an explicit `Tui` value. The expected value includes default notifications, animations, tooltips, colors, pet anchor, keymap, and other UI defaults.

**Call relations**: The test runner invokes this deserialization test. It verifies that the `Tui` data model’s defaults are applied consistently.

*Call graph*: 1 external calls (assert_eq!).


##### `runtime_config_resolves_terminal_resize_reflow_defaults_and_overrides`  (lines 3381–3436)

```
async fn runtime_config_resolves_terminal_resize_reflow_defaults_and_overrides()
```

**Purpose**: Checks how the runtime config resolves terminal resize reflow row limits. This setting controls how much terminal content Codex may reflow after resize, including default, limited, and disabled modes.

**Data flow**: It loads default config and expects automatic row handling. It then loads config with `terminal_resize_reflow_max_rows = 9000` and expects a numeric limit, then loads config with `0` and expects limits to be disabled.

**Call relations**: The test runner calls this async test. Unlike raw TOML parser tests, it goes through `Config::load_from_base_config_with_overrides` to verify final runtime settings.

*Call graph*: 6 external calls (default, load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `forced_chatgpt_workspace_id_empty_values_disable_runtime_restriction`  (lines 3439–3485)

```
async fn forced_chatgpt_workspace_id_empty_values_disable_runtime_restriction() -> std::io::Result<()>
```

**Purpose**: Checks how empty or blank `forced_chatgpt_workspace_id` values are normalized. Empty values should mean no runtime workspace restriction, while real IDs should be trimmed and kept.

**Data flow**: It loops over several TOML snippets: unset, empty string, whitespace, empty list, blank list entries, and mixed blank plus real IDs. Each is parsed and loaded, then the final config field is compared to either `None` or the cleaned list of workspace IDs.

**Call relations**: The test runner invokes this async test. It combines TOML parsing with the full config loader to check final normalized runtime behavior.

*Call graph*: 6 external calls (load_from_base_config_with_overrides, assert_eq!, default, tempdir, from_str, vec!).


##### `legacy_remote_thread_store_endpoint_is_rejected`  (lines 3488–3506)

```
async fn legacy_remote_thread_store_endpoint_is_rejected()
```

**Purpose**: Ensures an old remote thread-store endpoint setting still parses but is rejected when the config is loaded. This gives users a clear message that the feature is no longer supported.

**Data flow**: It parses TOML containing `experimental_thread_store_endpoint`, then passes it to the config loader. Loading must fail, and the error text must mention the setting and say it is no longer supported.

**Call relations**: The test runner calls this test. It separates deserialization compatibility from runtime validation: old config can be read far enough to produce a helpful load-time error.

*Call graph*: 5 external calls (load_from_base_config_with_overrides, assert!, default, tempdir, from_str).


##### `profile_tui_rejects_unsupported_settings`  (lines 3509–3521)

```
fn profile_tui_rejects_unsupported_settings()
```

**Purpose**: Checks that profile-specific TUI config rejects unsupported fields such as `theme`. This prevents users from thinking a per-profile UI setting works when it does not.

**Data flow**: It parses TOML with `[profiles.work.tui] theme = 'dark'` and expects parsing to fail. The error must mention an unknown field and name `theme`.

**Call relations**: The test runner invokes this direct TOML parser test. It checks validation for profile-scoped TUI settings.

*Call graph*: 1 external calls (assert!).


##### `runtime_config_resolves_session_picker_view_default_and_override`  (lines 3524–3553)

```
async fn runtime_config_resolves_session_picker_view_default_and_override()
```

**Purpose**: Checks the final runtime default and override behavior for the TUI session picker view. The raw config can be unset, but runtime config should choose a concrete mode.

**Data flow**: It first loads default config and expects the runtime session picker view to be `Dense`. It then loads config with the root TUI setting set to `Comfortable` and expects the runtime value to match the override.

**Call relations**: The test runner calls this async test. It uses the full config loader to verify final runtime values, not just raw TOML fields.

*Call graph*: 6 external calls (default, load_from_base_config_with_overrides, assert_eq!, default, default, tempdir).


##### `test_sandbox_config_parsing`  (lines 3556–3677)

```
async fn test_sandbox_config_parsing()
```

**Purpose**: Checks legacy sandbox mode parsing for full access, read-only, and workspace-write modes. This protects backward-compatible sandbox behavior while accounting for platform differences.

**Data flow**: It parses several TOML snippets and passes each to a test helper that derives the legacy sandbox policy. It verifies that full-access ignores workspace-write network settings, read-only ignores workspace-write network settings, and workspace-write produces writable roots and temp exclusions on non-Windows while falling back to read-only on Windows.

**Call relations**: The test runner invokes this async test. It calls `derive_legacy_sandbox_policy_for_test`, uses test path helpers to build platform-safe absolute paths, and compares the derived policy to expected `SandboxPolicy` values.

*Call graph*: calls 1 internal fn (derive_legacy_sandbox_policy_for_test); 4 external calls (assert_eq!, cfg!, test_absolute_path, format!).


##### `legacy_sandbox_mode_builds_profiles_with_compatible_projection`  (lines 3680–3816)

```
async fn legacy_sandbox_mode_builds_profiles_with_compatible_projection() -> std::io::Result<()>
```

**Purpose**: Checks that old-style sandbox settings still produce the newer permission profile correctly. This protects users who still have legacy config files from getting different file or network access than they asked for.

**Data flow**: The test creates temporary Codex and working folders, then tries three legacy sandbox modes. Each config string is loaded into a Config, converted into the newer file-system and network policies, and compared back to the legacy policy. The result should be a round trip: old setting in, equivalent new permission policy out.

**Call relations**: The test runner calls this during configuration tests. It exercises Config::load_from_base_config_with_overrides and the conversion methods between legacy sandbox policies and the newer permissions model.

*Call graph*: 9 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!, test_absolute_path, unreachable!, vec!).


##### `filter_mcp_servers_by_allowlist_enforces_identity_rules`  (lines 3819–3899)

```
fn filter_mcp_servers_by_allowlist_enforces_identity_rules()
```

**Purpose**: Checks that MCP servers are only kept enabled when both their name and identity match an allowed requirement. Identity means the actual command or URL, not just the display name.

**Data flow**: The test starts with several fake MCP servers, some command-based and some URL-based. It supplies requirements that allow only exact command or URL matches. After filtering, matching servers remain enabled and mismatched or unlisted servers are disabled with a requirements reason.

**Call relations**: The test runner calls this to verify filter_mcp_servers_by_requirements. It protects the rule that an allowlist is not just a list of names; it must also confirm what the server actually connects to or runs.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `filter_mcp_servers_by_allowlist_allows_all_when_unset`  (lines 3902–3923)

```
fn filter_mcp_servers_by_allowlist_allows_all_when_unset()
```

**Purpose**: Checks that if no MCP requirements are provided, existing MCP servers are not blocked. This preserves the normal user-configured behavior when there is no managed allowlist.

**Data flow**: The test creates two fake servers and passes no requirements into the filter. The servers go in enabled and come out still enabled, with no disabled reason added.

**Call relations**: The test runner calls this around the same filtering helper as the stricter allowlist tests. It confirms that filter_mcp_servers_by_requirements only restricts servers when a requirements source exists.

*Call graph*: calls 2 internal fn (http_mcp, stdio_mcp); 2 external calls (from, assert_eq!).


##### `filter_mcp_servers_by_allowlist_blocks_all_when_empty`  (lines 3926–3950)

```
fn filter_mcp_servers_by_allowlist_blocks_all_when_empty()
```

**Purpose**: Checks that an explicitly empty MCP allowlist blocks every configured MCP server. An empty policy means nothing is approved, not that the policy is absent.

**Data flow**: The test creates two fake servers and passes an empty requirements map with a managed-policy source. The filter changes both servers to disabled and records that requirements caused the disablement.

**Call relations**: The test runner calls this to verify the difference between no requirements and empty requirements. It exercises filter_mcp_servers_by_requirements in the strict managed-policy case.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (new, from, assert_eq!).


##### `filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules`  (lines 3953–4012)

```
fn filter_plugin_mcp_servers_by_allowlist_enforces_plugin_and_identity_rules()
```

**Purpose**: Checks that MCP servers coming from a plugin must be allowed for that specific plugin and must match the required identity. This stops one plugin from getting approval meant for another or from changing the server command behind the same name.

**Data flow**: The test creates plugin-derived MCP servers, then supplies requirements for one plugin. One server name and command match, another has the right name but wrong command, and another is unlisted. After filtering, only the exact match remains enabled.

**Call relations**: The test runner calls this to exercise filter_plugin_mcp_servers_by_requirements. It connects plugin identity rules to the same allowlist safety model used for global MCP servers.

*Call graph*: calls 3 internal fn (new, http_mcp, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin`  (lines 4015–4053)

```
fn filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin()
```

**Purpose**: Checks that if requirements mention a different plugin, this plugin's MCP servers are disabled. This prevents requirements for one plugin from accidentally approving another plugin.

**Data flow**: The test creates one server for sample@test but supplies requirements only for other@test. Filtering marks the sample@test server disabled and records the requirements source.

**Call relations**: The test runner calls this as a plugin-specific allowlist edge case. It verifies that filter_plugin_mcp_servers_by_requirements checks the plugin key before looking at server names.

*Call graph*: calls 2 internal fn (new, stdio_mcp); 3 external calls (from, from, assert_eq!).


##### `rebuild_preserving_session_layers_refreshes_requirements`  (lines 4056–4262)

```
async fn rebuild_preserving_session_layers_refreshes_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that rebuilding configuration keeps session-level choices but refreshes managed requirements and non-session layers. This matters when a running conversation needs updated policy without losing temporary session overrides.

**Data flow**: The test builds one refreshed config stack with new user, project, and managed settings plus requirements. It builds another older thread config stack with session overrides. Rebuilding combines them: session overrides remain where allowed, managed requirements are refreshed, and disallowed session-only MCP servers become disabled.

**Call relations**: The test runner calls this to exercise Config::rebuild_preserving_session_layers. It also uses ConfigLayerStack and Config::load_config_with_layer_stack to model the same layered loading path used by the application.

*Call graph*: calls 3 internal fn (new, new, resolve_path_against_base); 6 external calls (from, default, new, load_config_with_layer_stack, assert_eq!, vec!).


##### `rebuild_preserving_session_layers_refreshes_plugin_derived_mcp_config`  (lines 4265–4370)

```
async fn rebuild_preserving_session_layers_refreshes_plugin_derived_mcp_config() -> anyhow::Result<()>
```

**Purpose**: Checks that rebuilding configuration can turn plugin-derived MCP servers on when the refreshed config enables plugins. Plugin MCP servers are servers declared by an installed plugin rather than directly by the user.

**Data flow**: The test writes fake plugin metadata and an .mcp.json file to a temporary plugin cache. It builds a refreshed config with plugins enabled and an older thread config with plugins disabled. After rebuilding, converting to MCP config includes the plugin's server and records which plugin supplied it.

**Call relations**: The test runner calls this around Config::rebuild_preserving_session_layers and Config::to_mcp_config. It verifies that plugin discovery is based on the refreshed effective config, not stale thread settings.

*Call graph*: calls 3 internal fn (new, new, resolve_path_against_base); 7 external calls (default, new, load_config_with_layer_stack, assert_eq!, create_dir_all, write, vec!).


##### `to_mcp_config_omits_plugin_id_when_user_server_shadows_plugin_mcp`  (lines 4373–4429)

```
async fn to_mcp_config_omits_plugin_id_when_user_server_shadows_plugin_mcp() -> anyhow::Result<()>
```

**Purpose**: Checks that a user-defined MCP server wins over a plugin-defined MCP server with the same name, and that the winning server is not falsely labeled as plugin-provided.

**Data flow**: The test writes a plugin server named sample and a user config server with the same name but a different URL. After loading config and converting to MCP config, the user URL is present and the plugin attribution map is empty.

**Call relations**: The test runner calls this to verify ConfigBuilder loading and Config::to_mcp_config. It protects the precedence rule that direct user config shadows plugin-provided MCP entries.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert!, assert_eq!, default, create_dir_all, write).


##### `selected_plugin_wins_after_discovered_plugin_requirements`  (lines 4432–4536)

```
async fn selected_plugin_wins_after_discovered_plugin_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that a server explicitly selected from a plugin can override a disabled discovered plugin server. This allows deliberate user selection while still enforcing enterprise requirements on automatically discovered servers.

**Data flow**: The test creates a plugin with two servers and an enterprise requirement that allows only one. The unlisted discovered server is disabled. Then the test converts to MCP config again with an explicit selected-plugin registration for that unlisted name, and the selected server appears as enabled with selected-plugin source information.

**Call relations**: The test runner calls this to exercise Config::to_mcp_config and Config::to_mcp_config_with_plugin_registrations. It checks the ordering between discovered plugin requirements and explicit plugin selections.

*Call graph*: calls 5 internal fn (new, from_selected_plugin, loader_with_enterprise_requirement, new, http_mcp); 5 external calls (new, assert_eq!, default, create_dir_all, write).


##### `to_mcp_config_empty_mcp_requirements_disable_plugin_mcps`  (lines 4539–4602)

```
async fn to_mcp_config_empty_mcp_requirements_disable_plugin_mcps() -> anyhow::Result<()>
```

**Purpose**: Checks that an enterprise policy with an empty MCP server allowlist disables MCP servers supplied by plugins. Empty means no plugin MCP server is approved.

**Data flow**: The test creates a plugin with one MCP server, enables the plugin, and loads an enterprise requirement containing an empty mcp_servers table. The resulting MCP config still knows about the server, but marks it disabled with the enterprise requirements reason.

**Call relations**: The test runner calls this through ConfigBuilder and Config::to_mcp_config. It complements the global MCP empty-allowlist test for plugin-derived servers.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, new); 5 external calls (new, assert_eq!, default, create_dir_all, write).


##### `add_dir_override_extends_workspace_writable_roots`  (lines 4605–4650)

```
async fn add_dir_override_extends_workspace_writable_roots() -> std::io::Result<()>
```

**Purpose**: Checks that command-line extra writable directories are added to workspace-write sandbox permissions without duplication. This lets a user work across nearby project folders without granting broader access.

**Data flow**: The test creates frontend and backend folders, starts in frontend, and passes backend twice in two forms: relative and absolute. The loaded config should include backend once as a writable root, except on Windows where this legacy sandbox mode downgrades to read-only.

**Call relations**: The test runner calls this to exercise Config::load_from_base_config_with_overrides. It verifies how sandbox overrides feed into the legacy sandbox policy.

*Call graph*: 9 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, cfg!, default, panic!, create_dir_all, vec!).


##### `default_zsh_path_sets_runtime_zsh_path`  (lines 4653–4669)

```
async fn default_zsh_path_sets_runtime_zsh_path() -> std::io::Result<()>
```

**Purpose**: Checks that a provided default zsh shell path is copied into the runtime config. This lets packaged builds tell Codex where their bundled zsh lives.

**Data flow**: The test creates a fake path named packaged-zsh and passes it as an override. Config loading returns a Config whose zsh_path field points to that path.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It confirms that loader overrides can set runtime-only values not necessarily written in the user TOML.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `sqlite_home_defaults_to_codex_home_for_workspace_write`  (lines 4672–4687)

```
async fn sqlite_home_defaults_to_codex_home_for_workspace_write() -> std::io::Result<()>
```

**Purpose**: Checks that SQLite data defaults to the Codex home folder when workspace-write sandbox mode is used. This keeps database files in a known writable place.

**Data flow**: The test loads default config with a workspace-write sandbox override. The resulting sqlite_home field should equal the temporary Codex home path.

**Call relations**: The test runner calls this to verify default path selection inside Config::load_from_base_config_with_overrides.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `workspace_write_includes_configured_writable_root_once_without_memories_root`  (lines 4690–4741)

```
async fn workspace_write_includes_configured_writable_root_once_without_memories_root() -> std::io::Result<()>
```

**Purpose**: Checks that configured writable roots are deduplicated and that the memories folder is not automatically created or made writable. This avoids both clutter and accidental write permission expansion.

**Data flow**: The test supplies the same writable root twice and enables workspace-write mode. On non-Windows systems, the final policy contains that root once and does not contain the memories root. The memories directory should not exist as a side effect of config loading.

**Call relations**: The test runner calls this around Config::load_from_base_config_with_overrides and legacy sandbox policy creation. It covers a subtle permission edge case for memory-related paths.

*Call graph*: 8 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!, panic!, vec!).


##### `memory_tool_makes_memories_root_readable_without_creating_or_widening_writes`  (lines 4744–4797)

```
async fn memory_tool_makes_memories_root_readable_without_creating_or_widening_writes() -> std::io::Result<()>
```

**Purpose**: Checks that enabling the memories feature makes the memories folder readable but not writable, and does not create it during config loading. Read access lets the tool inspect memories without granting unnecessary write access.

**Data flow**: The test enables the memories feature and workspace-write mode, then loads config. It verifies the memories directory was not created, the file-system policy can read that path, and it cannot write it. On non-Windows systems, the legacy writable-roots list also excludes it.

**Call relations**: The test runner calls this to verify the newer file-system permission policy and its legacy projection. It exercises Config::load_from_base_config_with_overrides and permission queries.

*Call graph*: calls 1 internal fn (from); 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, cfg!, panic!).


##### `config_defaults_to_file_cli_auth_store_mode`  (lines 4800–4817)

```
async fn config_defaults_to_file_cli_auth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that CLI authentication credentials default to file storage. This gives a predictable fallback when the user has not asked for keychain or ephemeral storage.

**Data flow**: The test loads an empty config. The resulting cli_auth_credentials_store_mode should be File.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It establishes the default used before any explicit credential-store setting is resolved.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `config_resolves_explicit_keyring_auth_store_mode`  (lines 4820–4843)

```
async fn config_resolves_explicit_keyring_auth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit keyring request for CLI credentials is passed through the resolver. The resolver may adjust the choice depending on the build version.

**Data flow**: The test loads config with cli_auth_credentials_store set to Keyring. It compares the final mode to resolve_cli_auth_credentials_store_mode for the current package version.

**Call relations**: The test runner calls this to connect TOML parsing, config loading, and credential-store resolution.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `config_resolves_default_oauth_store_mode`  (lines 4846–4866)

```
async fn config_resolves_default_oauth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that MCP OAuth credential storage defaults are resolved through the OAuth store resolver. OAuth credentials are tokens used to authorize MCP servers.

**Data flow**: The test loads empty config. The final mcp_oauth_credentials_store_mode should match resolving Auto for the current package version.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It verifies default OAuth storage behavior.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `local_dev_builds_force_file_cli_auth_store_modes`  (lines 4869–4895)

```
fn local_dev_builds_force_file_cli_auth_store_modes()
```

**Purpose**: Checks that local development builds force CLI credential storage to file for Auto and Keyring choices. This avoids using a real system keyring during local development, while still allowing ephemeral storage.

**Data flow**: The test calls the CLI credential-store resolver with a local development version string and several requested modes. Keyring and Auto become File, Ephemeral stays Ephemeral, and a normal version keeps Keyring.

**Call relations**: The test runner calls this directly against resolve_cli_auth_credentials_store_mode. It isolates the version-based rule from the rest of config loading.

*Call graph*: 1 external calls (assert_eq!).


##### `local_dev_builds_force_file_mcp_oauth_store_modes`  (lines 4898–4917)

```
fn local_dev_builds_force_file_mcp_oauth_store_modes()
```

**Purpose**: Checks that local development builds force MCP OAuth credential storage to file for Auto and Keyring choices. This keeps development runs from depending on the operating system keyring.

**Data flow**: The test calls the OAuth credential-store resolver with the local development version and with a normal release version. Local Auto and Keyring become File, while a normal release Keyring stays Keyring.

**Call relations**: The test runner calls this directly against resolve_mcp_oauth_credentials_store_mode. It mirrors the CLI credential-store test for MCP OAuth tokens.

*Call graph*: 1 external calls (assert_eq!).


##### `feedback_enabled_defaults_to_true`  (lines 4920–4937)

```
async fn feedback_enabled_defaults_to_true() -> std::io::Result<()>
```

**Purpose**: Checks that a present but otherwise default feedback config leaves feedback enabled. This prevents an empty feedback table from accidentally turning feedback off.

**Data flow**: The test loads config with a default feedback section. The final feedback_enabled field is true.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It verifies the defaulting rule for feedback settings.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `web_search_mode_defaults_to_none_if_unset`  (lines 4940–4945)

```
fn web_search_mode_defaults_to_none_if_unset()
```

**Purpose**: Checks that web search has no explicit mode when neither config nor legacy feature flags request it. None means the rest of the system can apply its normal fallback.

**Data flow**: The test creates empty config and default feature settings, then resolves web search mode. The result is None.

**Call relations**: The test runner calls this directly against resolve_web_search_mode. It establishes the baseline before override cases.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (assert_eq!, default).


##### `web_search_mode_prefers_config_over_legacy_flags`  (lines 4948–4960)

```
fn web_search_mode_prefers_config_over_legacy_flags()
```

**Purpose**: Checks that the newer web_search config field wins over older feature flags. This avoids conflicting settings producing surprising results.

**Data flow**: The test sets web_search to Live and also enables an older cached-search feature flag. Resolving the mode returns Live from the config field.

**Call relations**: The test runner calls this against resolve_web_search_mode. It documents precedence between modern config and legacy flags.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (default, assert_eq!).


##### `web_search_mode_disabled_overrides_legacy_request`  (lines 4963–4975)

```
fn web_search_mode_disabled_overrides_legacy_request()
```

**Purpose**: Checks that explicitly disabling web search wins even if an older flag requests web search. User or policy intent to disable should be respected.

**Data flow**: The test sets web_search to Disabled and enables a legacy request flag. Resolving returns Disabled.

**Call relations**: The test runner calls this against resolve_web_search_mode as another precedence case.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (default, assert_eq!).


##### `web_search_mode_for_turn_uses_preference_for_read_only`  (lines 4978–4984)

```
fn web_search_mode_for_turn_uses_preference_for_read_only()
```

**Purpose**: Checks that read-only permission mode does not change a cached web search preference. Read-only still permits the preferred cached search behavior.

**Data flow**: The test wraps Cached in a constrained setting and uses a read-only permission profile. The per-turn resolver returns Cached.

**Call relations**: The test runner calls this directly against resolve_web_search_mode_for_turn. It verifies interaction between web search and permission profiles.

*Call graph*: calls 2 internal fn (allow_any, read_only); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_prefers_live_for_disabled_permissions`  (lines 4987–4992)

```
fn web_search_mode_for_turn_prefers_live_for_disabled_permissions()
```

**Purpose**: Checks that when permissions are disabled, cached web search is promoted to live search if live search is allowed. This reflects the runtime's preferred behavior for that permission profile.

**Data flow**: The test starts with a constrained setting that allows any mode and prefers Cached. With PermissionProfile::Disabled, the resolver returns Live.

**Call relations**: The test runner calls this against resolve_web_search_mode_for_turn. It covers the special case for disabled permission profiles.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_respects_disabled_for_disabled_permissions`  (lines 4995–5000)

```
fn web_search_mode_for_turn_respects_disabled_for_disabled_permissions()
```

**Purpose**: Checks that an explicit Disabled web search preference remains disabled even when permissions are disabled. The resolver should not turn web search on against the setting.

**Data flow**: The test starts with Disabled as the allowed preference and a disabled permission profile. The per-turn mode remains Disabled.

**Call relations**: The test runner calls this against resolve_web_search_mode_for_turn. It guards against over-eager fallback to live search.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `web_search_mode_for_turn_falls_back_when_live_is_disallowed`  (lines 5003–5021)

```
fn web_search_mode_for_turn_falls_back_when_live_is_disallowed() -> anyhow::Result<()>
```

**Purpose**: Checks that if live web search is not allowed by a constraint, the resolver falls back to the configured cached mode. A constraint is a rule that rejects disallowed values.

**Data flow**: The test creates a constrained web search setting that allows only Disabled and Cached. With disabled permissions, the resolver would normally prefer Live, but Live is rejected, so it returns Cached.

**Call relations**: The test runner calls this against resolve_web_search_mode_for_turn. It verifies that policy constraints are honored during fallback.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `project_profiles_are_ignored`  (lines 5024–5072)

```
async fn project_profiles_are_ignored() -> std::io::Result<()>
```

**Purpose**: Checks that profile declarations inside project-local config are ignored and produce a warning. This stops a project folder from silently selecting a profile that should only be chosen from user-level config.

**Data flow**: The test writes a trusted project entry in user config and a project .codex config that names a profile and model. Loading config for that workspace leaves the model unset and records a startup warning telling the user to move those settings to user-level config if desired.

**Call relations**: The test runner calls this through ConfigBuilder. It verifies the project config loading path and warning behavior.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, write).


##### `feature_table_overrides_legacy_flags`  (lines 5075–5094)

```
async fn feature_table_overrides_legacy_flags() -> std::io::Result<()>
```

**Purpose**: Checks that the modern features table can turn off a feature even if older defaults or flags might say otherwise. This makes the feature table the clear source of truth.

**Data flow**: The test sets apply_patch_freeform to false in the features table. After loading config, the ApplyPatchFreeform feature is not enabled.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It checks feature resolution from TOML.

*Call graph*: calls 1 internal fn (from); 6 external calls (new, default, new, load_from_base_config_with_overrides, assert!, default).


##### `legacy_toggles_map_to_features`  (lines 5097–5116)

```
async fn legacy_toggles_map_to_features() -> std::io::Result<()>
```

**Purpose**: Checks that older experimental toggle fields still enable the corresponding new feature flag. This keeps old config files working after feature settings were reorganized.

**Data flow**: The test sets experimental_use_unified_exec_tool to true. The loaded config has the UnifiedExec feature enabled and also keeps the legacy boolean field true.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It verifies backward compatibility between old and new feature controls.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `responses_websocket_features_do_not_change_wire_api`  (lines 5119–5140)

```
async fn responses_websocket_features_do_not_change_wire_api() -> std::io::Result<()>
```

**Purpose**: Checks that enabling response websocket feature flags does not change the selected wire API. Wire API means the network protocol shape used to talk to the model provider.

**Data flow**: The test enables each websocket-related feature key in turn and loads config. In both cases, the model provider still uses the Responses wire API.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It protects against feature flags accidentally changing provider protocol selection.

*Call graph*: calls 1 internal fn (from); 6 external calls (new, default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `config_honors_explicit_file_oauth_store_mode`  (lines 5143–5163)

```
async fn config_honors_explicit_file_oauth_store_mode() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit request to store MCP OAuth credentials in files is honored. This gives users or policy a clear way to avoid keyring storage.

**Data flow**: The test loads config with mcp_oauth_credentials_store set to File. The final OAuth store mode is File.

**Call relations**: The test runner calls this through Config::load_from_base_config_with_overrides. It complements the default and keyring OAuth store tests.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `managed_config_overrides_oauth_store_mode`  (lines 5166–5212)

```
async fn managed_config_overrides_oauth_store_mode() -> anyhow::Result<()>
```

**Purpose**: Checks that managed configuration can override the user's OAuth credential storage choice. Managed config usually represents enterprise policy and must take precedence.

**Data flow**: The test writes user config requesting File and managed config requesting Keyring. It loads the layered config, confirms the effective TOML says Keyring, then builds the final Config and confirms the resolved OAuth store mode follows Keyring for the current version.

**Call relations**: The test runner calls this through load_config_layers_state, deserialize_config_toml_with_base, and Config::load_from_base_config_with_overrides. It verifies precedence across the full managed-config path.

*Call graph*: calls 1 internal fn (with_managed_config_path_for_tests); 6 external calls (new, new, load_from_base_config_with_overrides, assert_eq!, default, write).


##### `load_global_mcp_servers_returns_empty_if_missing`  (lines 5215–5222)

```
async fn load_global_mcp_servers_returns_empty_if_missing() -> anyhow::Result<()>
```

**Purpose**: Checks that asking for global MCP servers from a home folder with no config returns an empty set rather than an error. Missing config is a normal first-run state.

**Data flow**: The test creates an empty temporary Codex home and calls load_global_mcp_servers. The result is an empty map.

**Call relations**: The test runner calls this directly against load_global_mcp_servers. It verifies graceful behavior for absent config files.

*Call graph*: 2 external calls (new, assert!).


##### `replace_mcp_servers_round_trips_entries`  (lines 5225–5294)

```
async fn replace_mcp_servers_round_trips_entries() -> anyhow::Result<()>
```

**Purpose**: Checks that replacing the global MCP server list writes all important fields and can later read them back. It also checks that replacing with an empty list removes the servers.

**Data flow**: The test builds a docs MCP server with command, arguments, working directory, timeouts, environment id, and enabled status. It applies a ReplaceMcpServers edit, reloads global servers, and checks the fields survived. Then it applies an empty replacement and reloads to confirm the list is empty.

**Call relations**: The test runner calls this through apply_blocking and load_global_mcp_servers. It verifies the edit-and-read path for global MCP configuration.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (new, from_secs, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, vec!).


##### `managed_config_wins_over_cli_overrides`  (lines 5297–5329)

```
async fn managed_config_wins_over_cli_overrides() -> anyhow::Result<()>
```

**Purpose**: Checks that managed config has higher priority than command-line overrides. This is important because enterprise policy should not be bypassed by a local CLI flag.

**Data flow**: The test writes user config with model base, managed config with model managed_config, and passes a CLI override model cli. The layered effective config deserializes to model managed_config.

**Call relations**: The test runner calls this through load_config_layers_state and deserialize_config_toml_with_base. It focuses specifically on layer precedence.

*Call graph*: calls 1 internal fn (with_managed_config_path_for_tests); 4 external calls (new, String, assert_eq!, write).


##### `load_global_mcp_servers_accepts_legacy_ms_field`  (lines 5332–5351)

```
async fn load_global_mcp_servers_accepts_legacy_ms_field() -> anyhow::Result<()>
```

**Purpose**: Checks that the old startup_timeout_ms field is still accepted for MCP servers. This keeps older config files working even if the preferred representation changed.

**Data flow**: The test writes a docs MCP server using startup_timeout_ms equal to 2500. Loading global MCP servers returns a server whose startup timeout is 2500 milliseconds.

**Call relations**: The test runner calls this directly against load_global_mcp_servers. It verifies backward-compatible parsing.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `mcp_servers_toml_parses_per_tool_approval_overrides`  (lines 5354–5383)

```
fn mcp_servers_toml_parses_per_tool_approval_overrides()
```

**Purpose**: Checks that MCP TOML can set both a default tool approval mode and an approval override for a specific tool. Approval mode controls whether a tool can run automatically or must ask.

**Data flow**: The test parses TOML for a docs server with a default prompt mode and a search tool set to approve. The parsed ConfigToml contains both settings in the expected fields.

**Call relations**: The test runner calls this by deserializing ConfigToml directly. It verifies the shape of MCP server TOML parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_servers_toml_ignores_unknown_server_fields`  (lines 5386–5400)

```
fn mcp_servers_toml_ignores_unknown_server_fields()
```

**Purpose**: Checks that unknown fields inside an MCP server entry are ignored rather than failing parsing. This gives some tolerance for older or newer config fields.

**Data flow**: The test parses a docs MCP server containing an unrecognized trust_level field. Parsing succeeds and the server equals the expected command-based server.

**Call relations**: The test runner calls this through TOML deserialization of ConfigToml. It verifies forgiving parsing for MCP server entries.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_servers_toml_parses_tool_approval_override_for_reserved_name`  (lines 5403–5426)

```
fn mcp_servers_toml_parses_tool_approval_override_for_reserved_name()
```

**Purpose**: Checks that a tool named command can still have its approval override parsed. This matters because command is also a meaningful server field name, so the parser must not confuse the two.

**Data flow**: The test parses TOML with mcp_servers.docs.tools.command.approval_mode set to approve. The parsed server contains a tool config for the tool name command with approval mode Approve.

**Call relations**: The test runner calls this by deserializing ConfigToml. It guards against naming collisions in the nested MCP tools table.

*Call graph*: 1 external calls (assert_eq!).


##### `desktop_toml_round_trips_opaque_nested_values`  (lines 5429–5477)

```
fn desktop_toml_round_trips_opaque_nested_values() -> anyhow::Result<()>
```

**Purpose**: Checks that desktop-specific settings can store arbitrary nested values and survive serialization. Opaque here means the core config code does not need to understand every desktop setting.

**Data flow**: The test parses a desktop table with strings, arrays, and nested objects. It confirms the values are stored as JSON-like data, serializes the config back to TOML, reparses it, and confirms the desktop data is unchanged.

**Call relations**: The test runner calls this through ConfigToml TOML parse and serialization. It protects desktop settings from being lost or reshaped by core config code.

*Call graph*: 2 external calls (assert_eq!, to_string).


##### `to_mcp_config_preserves_apps_feature_from_config`  (lines 5480–5504)

```
async fn to_mcp_config_preserves_apps_feature_from_config() -> std::io::Result<()>
```

**Purpose**: Checks that app-related MCP settings flow from Config into the MCP runtime config. It also verifies that the Apps feature flag actually controls whether apps are enabled.

**Data flow**: The test loads default config, sets an apps product SKU, and converts to MCP config, which should enable apps and carry the SKU. Then it disables and re-enables the Apps feature and checks the MCP config follows the feature state.

**Call relations**: The test runner calls this around Config::to_mcp_config. It verifies the bridge from general config features into MCP runtime settings.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, load_from_base_config_with_overrides, assert!, assert_eq!, default, default).


##### `to_mcp_config_flows_mcp_tool_prefix_from_feature`  (lines 5507–5525)

```
async fn to_mcp_config_flows_mcp_tool_prefix_from_feature() -> std::io::Result<()>
```

**Purpose**: Checks that the feature controlling MCP tool name prefixes is reflected in MCP runtime config. Prefixing helps avoid tool-name collisions, while the feature can turn that off.

**Data flow**: The test converts default config to MCP config and sees prefix_mcp_tool_names enabled. After enabling the NonPrefixedMcpToolNames feature, converting again reports prefixing disabled.

**Call relations**: The test runner calls this through Config::to_mcp_config. It verifies feature-to-runtime translation for MCP tool naming.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, load_from_base_config_with_overrides, assert!, default, default).


##### `to_mcp_config_preserves_auth_elicitation_feature_from_config`  (lines 5528–5555)

```
async fn to_mcp_config_preserves_auth_elicitation_feature_from_config() -> std::io::Result<()>
```

**Purpose**: Checks that enabling the auth elicitation feature gives MCP clients form and URL elicitation capabilities. Elicitation means the server can ask the client to collect information from the user, such as an auth form or link.

**Data flow**: The test converts default config and sees the default client elicitation capability. After enabling AuthElicitation, converting again includes form and URL capabilities.

**Call relations**: The test runner calls this through Config::to_mcp_config. It verifies that an experimental feature flag reaches the MCP client capability settings.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, default).


##### `load_global_mcp_servers_rejects_inline_bearer_token`  (lines 5558–5580)

```
async fn load_global_mcp_servers_rejects_inline_bearer_token() -> anyhow::Result<()>
```

**Purpose**: Checks that MCP server config rejects an inline bearer token and tells users to use an environment-variable form instead. A bearer token is a secret credential, and storing it directly in config is unsafe.

**Data flow**: The test writes an MCP server with a URL and bearer_token value. Loading global MCP servers returns an InvalidData error whose message mentions bearer_token and bearer_token_env_var.

**Call relations**: The test runner calls this directly against load_global_mcp_servers. It enforces a security rule in config parsing.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `replace_mcp_servers_serializes_env_sorted`  (lines 5583–5659)

```
async fn replace_mcp_servers_serializes_env_sorted() -> anyhow::Result<()>
```

**Purpose**: Checks that environment variables for a command-based MCP server are written in a stable alphabetical order and can be loaded back. This matters because predictable config output is easier to review and avoids noisy file changes.

**Data flow**: It starts with a temporary Codex home and one MCP server named docs whose environment variables are deliberately out of order. It applies a replace-server edit, reads the generated config file, and expects ALPHA_VAR before ZIG_VAR. It then reloads the server config and confirms the command, arguments, environment variables, empty inherited-variable list, and missing working directory all survived.

**Call relations**: The test runner calls this test. Inside the test, apply_blocking performs the config edit, the filesystem read checks the exact TOML text, and load_global_mcp_servers proves the written file can be read back into the same server shape.

*Call graph*: calls 1 internal fn (apply_blocking); 11 external calls (from, from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string (+1 more)).


##### `replace_mcp_servers_serializes_env_vars`  (lines 5662–5714)

```
async fn replace_mcp_servers_serializes_env_vars() -> anyhow::Result<()>
```

**Purpose**: Checks that a command-based MCP server can record which environment variables should be inherited by name. These are not fixed values; they are names like ALPHA and BETA that Codex should pick up from the surrounding environment.

**Data flow**: It builds a temporary config with one docs server whose env_vars list contains ALPHA and BETA. After applying the replacement, it reads the config file and checks that the list appears. It then reloads the MCP servers and verifies the docs server still has the same env_vars list.

**Call relations**: The test runner invokes it as part of the config tests. It uses apply_blocking to write the server table and load_global_mcp_servers to confirm the serialized field is understood on the way back in.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string, vec!).


##### `replace_mcp_servers_serializes_sourced_env_vars`  (lines 5717–5770)

```
async fn replace_mcp_servers_serializes_sourced_env_vars() -> anyhow::Result<()>
```

**Purpose**: Checks that environment variable references can include a named source, not just a plain variable name. This supports cases where a value should come from a specific provider such as a remote source.

**Data flow**: It creates a docs MCP server with two inherited environment entries: a legacy plain name and a structured entry with name REMOTE_TOKEN and source remote. It writes the config, checks that the mixed list is serialized in TOML, then reloads everything and compares the loaded map with the original map.

**Call relations**: The test runner calls this. The test exercises apply_blocking for writing and load_global_mcp_servers for reading, making sure newer structured env-var syntax stays compatible with older plain-string syntax.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string, vec!).


##### `replace_mcp_servers_serializes_cwd`  (lines 5773–5826)

```
async fn replace_mcp_servers_serializes_cwd() -> anyhow::Result<()>
```

**Purpose**: Checks that a command-based MCP server can store its working directory. A working directory tells the server where it should behave as if it was started from.

**Data flow**: It prepares one docs server with cwd set to /tmp/codex-mcp. After applying the server replacement, it reads the config file and checks for the cwd field. It then reloads the server and confirms the path is present on the command-based transport.

**Call relations**: The test runner invokes it. The edit path goes through apply_blocking, and the verification path goes through the written TOML plus load_global_mcp_servers.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, new, from, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_serializes_bearer_token`  (lines 5829–5893)

```
async fn replace_mcp_servers_streamable_http_serializes_bearer_token() -> anyhow::Result<()>
```

**Purpose**: Checks that an HTTP-based MCP server can save a bearer-token environment variable name. A bearer token is a secret access token; the config stores the environment variable name, not the secret itself.

**Data flow**: It creates a docs server using a streamable HTTP URL, with bearer_token_env_var set to MCP_TOKEN and a startup timeout of two seconds. It writes the config and compares the exact TOML output. Then it reloads the server and confirms the URL, token variable name, absence of header maps, and timeout value.

**Call relations**: The test runner calls it. apply_blocking writes the server replacement, while load_global_mcp_servers confirms the HTTP transport settings and timeout survive a write-read cycle.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, from_secs, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_serializes_custom_headers`  (lines 5896–5973)

```
async fn replace_mcp_servers_streamable_http_serializes_custom_headers() -> anyhow::Result<()>
```

**Purpose**: Checks that an HTTP-based MCP server can save fixed HTTP headers and headers whose values come from environment variables. Headers are extra pieces of information sent with an HTTP request.

**Data flow**: It creates a docs HTTP MCP server with a URL, bearer-token variable, startup timeout, one fixed header, and one environment-backed header. It applies the config edit, reads the generated TOML, and expects separate sections for fixed and environment-backed headers. It reloads the config and confirms both header maps match.

**Call relations**: The test runner invokes it. The test uses apply_blocking to serialize nested HTTP options and load_global_mcp_servers to make sure those nested sections are parsed back into the HTTP transport.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, from_secs, from, new, new, ReplaceMcpServers, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_removes_optional_sections`  (lines 5976–6077)

```
async fn replace_mcp_servers_streamable_http_removes_optional_sections() -> anyhow::Result<()>
```

**Purpose**: Checks that optional HTTP MCP server settings are removed from the config file when they are no longer present. This prevents stale bearer tokens, headers, or timeout values from lingering after a user clears them.

**Data flow**: It first writes a docs HTTP server with optional token, header sections, and timeout, then verifies those items appear. It then replaces the same server with only a URL and no optional values. The final config is expected to contain only the URL, and the reloaded server should have no token, no headers, and no startup timeout.

**Call relations**: The test runner calls it. It runs apply_blocking twice to mimic updating an existing config, then uses a direct file check and load_global_mcp_servers to ensure old optional sections were actually deleted, not merely ignored.

*Call graph*: calls 1 internal fn (apply_blocking); 10 external calls (from, from_secs, from, new, new, ReplaceMcpServers, assert!, assert_eq!, panic!, read_to_string).


##### `replace_mcp_servers_streamable_http_isolates_headers_between_servers`  (lines 6080–6196)

```
async fn replace_mcp_servers_streamable_http_isolates_headers_between_servers() -> anyhow::Result<()>
```

**Purpose**: Checks that HTTP-specific header settings stay attached only to the HTTP server they belong to. This protects other MCP servers from accidentally receiving unrelated authentication or header configuration.

**Data flow**: It writes two MCP servers: docs uses streamable HTTP with custom headers, while logs uses a command-based server with no headers. It reads the config and checks that only docs has header sections. It reloads the config and confirms docs kept its headers while logs still has no environment map.

**Call relations**: The test runner invokes it. apply_blocking writes a multi-server replacement, and load_global_mcp_servers verifies that serialization did not smear HTTP options across neighboring server entries.

*Call graph*: calls 1 internal fn (apply_blocking); 12 external calls (from, from_secs, from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, panic! (+2 more)).


##### `replace_mcp_servers_serializes_disabled_flag`  (lines 6199–6246)

```
async fn replace_mcp_servers_serializes_disabled_flag() -> anyhow::Result<()>
```

**Purpose**: Checks that a disabled MCP server is written with enabled = false and loads back as disabled. This lets users keep a server definition without currently using it.

**Data flow**: It creates a docs command-based MCP server with enabled set to false. After applying the replacement, it reads the config text and checks for the disabled flag. It reloads the servers and confirms docs.enabled is false.

**Call relations**: The test runner calls this test. It relies on apply_blocking to write the edit and load_global_mcp_servers to prove the disabled state is not lost.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, new, ReplaceMcpServers, assert!, read_to_string).


##### `replace_mcp_servers_serializes_required_flag`  (lines 6249–6296)

```
async fn replace_mcp_servers_serializes_required_flag() -> anyhow::Result<()>
```

**Purpose**: Checks that an MCP server marked as required is saved and loaded correctly. A required server likely means Codex should treat that tool provider as important rather than optional.

**Data flow**: It creates a docs command-based server with required set to true, writes it to the config file, and checks that the TOML contains required = true. It then reloads the server map and confirms the required flag is true.

**Call relations**: The test runner invokes it. The test follows the standard write-read path: apply_blocking writes the replacement, and load_global_mcp_servers validates the result.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, new, ReplaceMcpServers, assert!, read_to_string).


##### `replace_mcp_servers_serializes_tool_filters`  (lines 6299–6351)

```
async fn replace_mcp_servers_serializes_tool_filters() -> anyhow::Result<()>
```

**Purpose**: Checks that per-server tool allow and block lists are saved and read back. These lists let a user say which tools from an MCP server may or may not be used.

**Data flow**: It creates a docs server with enabled_tools set to allowed and disabled_tools set to blocked. After writing the config, it checks that both lists appear in the TOML. It reloads the servers and verifies both lists are present on the docs server.

**Call relations**: The test runner calls it. apply_blocking serializes the tool filters, and load_global_mcp_servers confirms the filters remain attached to the server.

*Call graph*: calls 1 internal fn (apply_blocking); 9 external calls (from, new, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string, vec!).


##### `replace_mcp_servers_streamable_http_serializes_oauth_resource`  (lines 6354–6405)

```
async fn replace_mcp_servers_streamable_http_serializes_oauth_resource() -> anyhow::Result<()>
```

**Purpose**: Checks that an HTTP MCP server can store OAuth-related information. OAuth is a common login/permission system; here the test verifies both the client ID and the resource URL are preserved.

**Data flow**: It builds a docs HTTP server with an OAuth client ID and oauth_resource URL. It writes the config, checks that the OAuth section and resource field appear, reloads the server, and confirms the resource and client ID can be read from the loaded config.

**Call relations**: The test runner invokes it. apply_blocking writes the OAuth-related fields, and load_global_mcp_servers checks that those fields are parsed into the MCP server config correctly.

*Call graph*: calls 1 internal fn (apply_blocking); 7 external calls (from, new, new, ReplaceMcpServers, assert!, assert_eq!, read_to_string).


##### `set_model_updates_defaults`  (lines 6408–6423)

```
async fn set_model_updates_defaults() -> anyhow::Result<()>
```

**Purpose**: Checks that the config edit builder can set the default model and reasoning effort. Reasoning effort is the model’s requested depth of thinking, such as high.

**Data flow**: It starts with an empty temporary config area. The edit builder sets model to gpt-5.4 and reasoning effort to High, then applies the edit. The test reads the generated config file, parses it as TOML, and confirms both default fields were written.

**Call relations**: The test runner calls it. It exercises ConfigEditsBuilder::new, set_model, and apply, then uses TOML parsing to inspect the written result.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, read_to_string, from_str).


##### `for_config_writes_selected_user_config_file`  (lines 6426–6458)

```
async fn for_config_writes_selected_user_config_file() -> anyhow::Result<()>
```

**Purpose**: Checks that edits go to the user-selected config file, not always the base config file. This matters when a user is working with a named profile stored in a separate config file.

**Data flow**: It creates two config files: the base config with a provider setting and a selected work config with an old model. It builds a Config that points at the selected file, applies a model update through ConfigEditsBuilder::for_config, then reads both files. The selected file should contain the new model and effort, while the base file should be unchanged.

**Call relations**: The test runner invokes it. ConfigBuilder creates a loaded config with loader overrides, and ConfigEditsBuilder::for_config uses that loaded config to choose the correct write target.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, without_managed_config_for_tests); 6 external calls (new, assert_eq!, for_config, read_to_string, write, from_str).


##### `profile_v2_config_path_resolves_validated_names`  (lines 6461–6469)

```
fn profile_v2_config_path_resolves_validated_names() -> anyhow::Result<()>
```

**Purpose**: Checks that a validated profile name maps to the expected profile config filename. For example, profile work should live in work.config.toml.

**Data flow**: It creates a temporary Codex home, parses work as a ProfileV2Name, and asks the resolver for the config path. The output should be the absolute path to work.config.toml inside the Codex home.

**Call relations**: The normal test runner calls this synchronous test. It directly exercises resolve_profile_v2_config_path after ProfileV2Name parsing has already accepted the name.

*Call graph*: 2 external calls (new, assert_eq!).


##### `set_model_overwrites_existing_model`  (lines 6472–6507)

```
async fn set_model_overwrites_existing_model() -> anyhow::Result<()>
```

**Purpose**: Checks that changing the default model replaces existing default model fields without disturbing profile-specific model settings. Profiles are named sets of overrides.

**Data flow**: It writes a config with a default model, default reasoning effort, and a dev profile with its own model. It applies a new default model and high reasoning effort, then parses the file. The default values should change, while the dev profile model should remain gpt-4.1.

**Call relations**: The test runner invokes it. ConfigEditsBuilder updates the top-level defaults, and the final TOML parse verifies that nested profile data was left intact.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, read_to_string, write, from_str).


##### `PrecedenceTestFixture::cwd_path`  (lines 6516–6518)

```
fn cwd_path(&self) -> PathBuf
```

**Purpose**: Returns the temporary current-working-directory path stored in a precedence test fixture. It is a small convenience helper for tests that need a normal PathBuf.

**Data flow**: It reads the fixture’s cwd temporary directory and converts its path into an owned PathBuf. Nothing else is changed.

**Call relations**: Other precedence-related tests can call this helper when they need to pass the fixture’s working directory into config loading or override code.

*Call graph*: 1 external calls (path).


##### `PrecedenceTestFixture::codex_home`  (lines 6520–6522)

```
fn codex_home(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the fixture’s temporary Codex home as an absolute path. This helps tests avoid mistakes caused by relative paths.

**Data flow**: It reads the fixture’s codex_home temporary directory and converts it to an AbsolutePathBuf. The fixture itself is unchanged.

**Call relations**: Other precedence tests can call this helper when constructing config builders or loaders that require an absolute Codex home path.

*Call graph*: 1 external calls (abs).


##### `cli_override_sets_compact_prompt`  (lines 6526–6546)

```
async fn cli_override_sets_compact_prompt() -> std::io::Result<()>
```

**Purpose**: Checks that a command-line override can directly set the compact prompt. A compact prompt is the text used when summarizing or compressing context.

**Data flow**: It creates a temporary Codex home and a ConfigOverrides object containing compact_prompt text. It loads a config from default TOML plus the override. The resulting Config should expose the override text as its compact prompt.

**Call relations**: The test runner calls it. Config::load_from_base_config_with_overrides combines base config and overrides, and this test checks that the override wins.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, default).


##### `loads_compact_prompt_from_file`  (lines 6549–6576)

```
async fn loads_compact_prompt_from_file() -> std::io::Result<()>
```

**Purpose**: Checks that Codex can read the compact prompt from a file path in the config. It also verifies surrounding whitespace is trimmed.

**Data flow**: It creates a workspace, writes a compact_prompt.txt file with padded text, and puts that file path in ConfigToml. It loads config with the workspace as the current directory. The resulting compact_prompt should be summarize differently without the extra spaces.

**Call relations**: The test runner invokes it. Config::load_from_base_config_with_overrides reads the configured file and turns its contents into the final compact prompt.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, create_dir_all, write).


##### `load_config_uses_requirements_guardian_policy_config`  (lines 6579–6611)

```
async fn load_config_uses_requirements_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Checks that guardian policy text from managed requirements config is used. A guardian policy is instruction text for automatic safety or review behavior.

**Data flow**: It builds a config layer stack whose requirements layer contains policy text with extra spaces. It loads config with that layer stack. The resulting guardian_policy_config should contain the trimmed policy text.

**Call relations**: The test runner calls it. ConfigLayerStack carries the requirements data, and Config::load_config_with_layer_stack merges it into the final Config.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, new, load_config_with_layer_stack, assert_eq!, default).


##### `config_toml_deserializes_auto_review_policy`  (lines 6614–6629)

```
fn config_toml_deserializes_auto_review_policy()
```

**Purpose**: Checks that the [auto_review] policy field in TOML parses into ConfigToml. This protects the user-facing config syntax for review policy text.

**Data flow**: It parses a short TOML string containing an auto_review policy. It then looks inside the parsed ConfigToml and expects to find the same policy string.

**Call relations**: The test runner invokes this direct parsing test. It relies on TOML deserialization and does not load the full runtime Config.

*Call graph*: 1 external calls (assert_eq!).


##### `load_config_uses_auto_review_guardian_policy_config`  (lines 6632–6657)

```
async fn load_config_uses_auto_review_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Checks that user config under auto_review.policy becomes the final guardian policy when no higher-priority requirements policy is present.

**Data flow**: It builds a ConfigToml with auto_review.policy containing padded text. It loads config with a temporary working directory. The final Config should contain the trimmed policy text.

**Call relations**: The test runner calls it. Config::load_from_base_config_with_overrides performs the config merge and trimming behavior being checked.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `requirements_guardian_policy_beats_auto_review`  (lines 6660–6696)

```
async fn requirements_guardian_policy_beats_auto_review() -> std::io::Result<()>
```

**Purpose**: Checks precedence when both managed requirements and user auto-review policy provide guardian policy text. The managed requirements policy should win.

**Data flow**: It creates a layer stack with a managed guardian policy and also creates user ConfigToml with a different auto_review policy. After loading config with both sources, the final guardian_policy_config should be the managed policy.

**Call relations**: The test runner invokes it. Config::load_config_with_layer_stack combines the user config and layer stack, and this test verifies the intended priority order.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, new, load_config_with_layer_stack, assert_eq!).


##### `load_config_ignores_empty_auto_review_guardian_policy_config`  (lines 6699–6721)

```
async fn load_config_ignores_empty_auto_review_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Checks that an auto_review policy containing only spaces is treated as missing. This prevents blank settings from becoming meaningful policy text.

**Data flow**: It loads a ConfigToml where auto_review.policy is just whitespace. The final Config should have no guardian_policy_config.

**Call relations**: The test runner calls it. Config::load_from_base_config_with_overrides is expected to trim and discard empty policy values.

*Call graph*: 4 external calls (default, new, load_from_base_config_with_overrides, assert_eq!).


##### `load_config_ignores_empty_requirements_guardian_policy_config`  (lines 6724–6751)

```
async fn load_config_ignores_empty_requirements_guardian_policy_config() -> std::io::Result<()>
```

**Purpose**: Checks that a managed requirements guardian policy containing only spaces is ignored. Blank managed text should not override other behavior as if it were real policy.

**Data flow**: It creates a layer stack whose requirements policy is whitespace, then loads config. The final Config should have guardian_policy_config set to none.

**Call relations**: The test runner invokes it. Config::load_config_with_layer_stack receives the requirements layer and is expected to discard the empty value after trimming.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, new, load_config_with_layer_stack, assert_eq!, default).


##### `load_config_rejects_missing_agent_role_config_file`  (lines 6754–6788)

```
async fn load_config_rejects_missing_agent_role_config_file() -> std::io::Result<()>
```

**Purpose**: Checks that an agent role pointing to a missing config file is rejected with a clear error. Agent roles define specialized assistant personas or jobs, so broken file links should be caught early.

**Data flow**: It builds ConfigToml with an agents.researcher role whose config_file points to a file that does not exist. Loading the config should fail. The test checks that the error is InvalidInput and that the message names the bad field and says the file must exist.

**Call relations**: The test runner calls it. Config::load_from_base_config_with_overrides performs validation and returns the error that the test inspects.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `agent_role_relative_config_file_resolves_against_config_toml`  (lines 6791–6837)

```
async fn agent_role_relative_config_file_resolves_against_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that a relative agent role config_file path in config.toml is resolved relative to that config file’s location. This makes ./agents/researcher.toml mean the expected nearby file.

**Data flow**: It creates an agents/researcher.toml file, writes a main config.toml that references it with a relative path, and loads config. The resulting researcher role should point to the full role file path and keep the nickname candidates from config.toml.

**Call relations**: The test runner invokes it. ConfigBuilder loads the user config from the temporary Codex home and performs relative-path resolution during build.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_relative_config_file_resolves_from_config_layer`  (lines 6840–6895)

```
async fn agent_role_relative_config_file_resolves_from_config_layer() -> std::io::Result<()>
```

**Purpose**: Checks that relative agent role file paths also work when the role came from a config layer rather than directly from the base config. The path should still be based on the layer’s source file.

**Data flow**: It creates a role file and a config layer entry that acts as if it came from config.toml and references ./agents/researcher.toml. It loads config with the layer stack. The final researcher role should point to the actual role file path.

**Call relations**: The test runner calls it. ConfigLayerStack carries both the parsed layer and its source location, and Config::load_config_with_layer_stack uses that location to resolve the relative path.

*Call graph*: calls 1 internal fn (new); 10 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, default, create_dir_all, write, from_str, vec!).


##### `agent_role_file_metadata_overrides_config_toml_metadata`  (lines 6898–6946)

```
async fn agent_role_file_metadata_overrides_config_toml_metadata() -> std::io::Result<()>
```

**Purpose**: Checks that metadata inside an agent role file can override metadata from config.toml. This lets the role file be the main source of truth for its own description and nicknames.

**Data flow**: It writes a role file with description, nickname candidates, developer instructions, and model, while config.toml gives different description and nicknames plus the file path. After loading config, the role should use the file’s description and nickname list, while keeping the resolved config_file path.

**Call relations**: The test runner invokes it. ConfigBuilder loads the main config, reads the referenced role file, merges them, and the test verifies the file metadata wins.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_file_without_developer_instructions_is_dropped_with_warning`  (lines 6949–7014)

```
async fn agent_role_file_without_developer_instructions_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that a discovered standalone agent role file is ignored if it lacks developer_instructions. Developer instructions are the core behavior guidance for an agent role, so a discovered role without them is incomplete.

**Data flow**: It creates a trusted fake repository with two standalone role files under .codex/agents: researcher without developer_instructions and reviewer with them. After loading config from inside the repo, researcher should be absent, reviewer should load, and startup warnings should mention the missing developer_instructions requirement.

**Call relations**: The test runner calls it. ConfigBuilder discovers standalone agent files based on the current workspace and trust settings, validates them, and records warnings for invalid ones.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 8 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `legacy_agent_role_config_file_allows_missing_developer_instructions`  (lines 7017–7065)

```
async fn legacy_agent_role_config_file_allows_missing_developer_instructions() -> std::io::Result<()>
```

**Purpose**: Checks that older split agent-role configs referenced from config.toml may still omit developer_instructions. This preserves backward compatibility for legacy configurations.

**Data flow**: It writes a role config file containing model settings but no developer instructions, then references it from config.toml with a description. After loading config, the researcher role should still exist and point to the role file.

**Call relations**: The test runner invokes it. ConfigBuilder follows the legacy config_file reference and applies the older validation rules for roles declared through config.toml.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `agent_role_without_description_after_merge_is_dropped_with_warning`  (lines 7068–7118)

```
async fn agent_role_without_description_after_merge_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that an agent role is dropped if, after combining config.toml and its role file, it still has no description. A description is needed so users can understand what the role is for.

**Data flow**: It writes a researcher role file with developer instructions but no description, and config.toml references it without adding a description. A reviewer role in config.toml has a description. After loading, researcher should be absent, reviewer should remain, and warnings should mention that researcher needs a description.

**Call relations**: The test runner calls it. ConfigBuilder merges role metadata from config.toml and role files, then validates the merged result and stores startup warnings for invalid roles.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (new, assert!, assert_eq!, create_dir_all, write).


##### `discovered_agent_role_file_without_name_is_dropped_with_warning`  (lines 7121–7183)

```
async fn discovered_agent_role_file_without_name_is_dropped_with_warning() -> std::io::Result<()>
```

**Purpose**: Checks that a discovered standalone agent role file must define a non-empty name. The name decides how the role is addressed in the final agent role map.

**Data flow**: It creates a trusted repository with two standalone role files: researcher lacks name, reviewer has name, description, and developer instructions. After loading config, researcher should be absent, reviewer should load, and startup warnings should mention the missing non-empty name.

**Call relations**: The test runner invokes it. ConfigBuilder discovers role files under .codex/agents, validates standalone file requirements, and reports invalid files through startup_warnings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 8 external calls (default, new, assert!, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `agent_role_file_name_takes_precedence_over_config_key`  (lines 7186–7228)

```
async fn agent_role_file_name_takes_precedence_over_config_key() -> std::io::Result<()>
```

**Purpose**: Checks that when a referenced role file declares its own name, that file-provided name is used instead of the key from config.toml. This lets a role file rename the role it defines.

**Data flow**: It writes a role file referenced under agents.researcher, but the file itself says name = archivist. After loading config, there should be no researcher role; instead, an archivist role should exist with file-provided metadata and the resolved config file path.

**Call relations**: The test runner calls it. ConfigBuilder reads the role file during the config build and lets the role file’s name control the final map key.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `loads_legacy_split_agent_roles_from_config_toml`  (lines 7231–7318)

```
async fn loads_legacy_split_agent_roles_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that multiple legacy agent roles split across config.toml and separate role files still load correctly. This protects existing user setups with one file per role.

**Data flow**: It creates researcher and reviewer role files, then writes config.toml entries that describe each role, point to the files, and provide nickname candidates. After loading config, both roles should have the expected descriptions, resolved file paths, and nickname lists.

**Call relations**: The test runner invokes it. ConfigBuilder reads the main config, follows each legacy config_file reference, and assembles the final agent_roles map.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `discovers_multiple_standalone_agent_role_files`  (lines 7321–7448)

```
async fn discovers_multiple_standalone_agent_role_files() -> std::io::Result<()>
```

**Purpose**: Checks that Codex can discover several standalone agent role files across relevant .codex/agents folders in a trusted workspace. This lets projects ship role definitions near the code they apply to.

**Data flow**: It creates a fake trusted repository, then places role files at the repo root and in nested package-level .codex/agents folders. It loads config from a nested working directory. The final config should include researcher, reviewer, and writer roles with their descriptions and nickname candidates.

**Call relations**: The test runner calls it. ConfigBuilder uses the current workspace and project trust information to discover standalone role files, parse them, and add them to the final agent_roles map.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert_eq!, format!, create_dir_all, write).


##### `mixed_legacy_and_standalone_agent_role_sources_merge_with_precedence`  (lines 7451–7594)

```
async fn mixed_legacy_and_standalone_agent_role_sources_merge_with_precedence() -> std::io::Result<()>
```

**Purpose**: Checks that agent roles from older global config and newer standalone project files are merged correctly. It proves that a project-local agent file wins when it defines the same role, while roles found only in global config still remain available.

**Data flow**: It creates a fake Codex home, a fake Git project, global agent role entries, global agent files, and project-local agent files. Then it loads config from a nested working directory and inspects the final agent role map. The result should contain the project version of `researcher`, the global-only `critic`, and the project-only `writer`.

**Call relations**: The test runner calls this directly. Inside the test, setup is done with temporary directories and file writes, then `ConfigBuilder::without_managed_config_for_tests` builds the config so the assertions can verify the merge and precedence behavior.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `higher_precedence_agent_role_can_inherit_description_from_lower_layer`  (lines 7597–7677)

```
async fn higher_precedence_agent_role_can_inherit_description_from_lower_layer() -> std::io::Result<()>
```

**Purpose**: Checks that a higher-priority project agent file can still reuse a description from a lower-priority global config entry when the project file does not provide one. This keeps users from having to repeat metadata in every layer.

**Data flow**: It writes a global role description and a project-local agent file with the same role name but no description. After loading config, the role should point to the project-local file, use the project nickname, and keep the global description.

**Call relations**: The test runner invokes it as an async config test. It uses `ConfigBuilder::without_managed_config_for_tests` to load the temporary setup and then checks the resolved role fields.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, format!, create_dir_all, create_dir_all, write).


##### `load_config_resolves_agent_interrupt_message`  (lines 7680–7700)

```
async fn load_config_resolves_agent_interrupt_message() -> std::io::Result<()>
```

**Purpose**: Verifies that the `agents.interrupt_message` setting is read into the final runtime config. This matters because it controls whether agent interruption messages are enabled.

**Data flow**: It builds an in-memory config where `interrupt_message` is false. Loading turns that TOML-shaped input into a `Config`, and the final boolean should be false.

**Call relations**: The test runner calls this. It hands an in-memory `ConfigToml` to `Config::load_from_base_config_with_overrides`, then asserts the loaded field.

*Call graph*: 5 external calls (default, new, load_from_base_config_with_overrides, assert!, default).


##### `load_config_normalizes_agent_role_nickname_candidates`  (lines 7703–7743)

```
async fn load_config_normalizes_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Checks that agent nickname candidates are cleaned up by trimming extra spaces. This lets users write forgiving config while Codex stores tidy values.

**Data flow**: It passes nickname candidates like `  Hypatia  ` and `Noether` into config loading. The loaded role should contain `Hypatia` and `Noether` without surrounding whitespace.

**Call relations**: The test runner calls it. It uses `Config::load_from_base_config_with_overrides` and then inspects the normalized agent role data.

*Call graph*: 7 external calls (from, default, new, load_from_base_config_with_overrides, assert_eq!, default, vec!).


##### `load_config_rejects_empty_agent_role_nickname_candidates`  (lines 7746–7780)

```
async fn load_config_rejects_empty_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Makes sure an explicitly empty nickname candidate list is treated as invalid. An empty list would look intentional but provide no usable names.

**Data flow**: It loads a config with `nickname_candidates` set to an empty list. Loading should fail with an invalid-input error that names the bad field.

**Call relations**: The test runner invokes it. The test expects `Config::load_from_base_config_with_overrides` to return an error instead of a usable config.

*Call graph*: 8 external calls (from, default, new, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `load_config_rejects_duplicate_agent_role_nickname_candidates`  (lines 7783–7817)

```
async fn load_config_rejects_duplicate_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Checks that duplicate nickname candidates are rejected, even when spacing differs. This prevents ambiguous or repeated agent names.

**Data flow**: It provides `Hypatia` and ` Hypatia ` as candidates. Config loading trims them, sees they match, and returns an invalid-input error.

**Call relations**: The test runner calls it. It relies on the config loader's validation path and then checks the error kind and message.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `load_config_rejects_unsafe_agent_role_nickname_candidates`  (lines 7820–7853)

```
async fn load_config_rejects_unsafe_agent_role_nickname_candidates() -> std::io::Result<()>
```

**Purpose**: Verifies that nickname candidates may only contain safe simple characters. This avoids nicknames with symbols that could confuse display, parsing, or prompts.

**Data flow**: It supplies a nickname containing angle brackets. Config loading rejects it and returns an invalid-input error explaining the allowed characters.

**Call relations**: The test runner invokes it. The test calls the normal config loader and confirms validation fails in the intended way.

*Call graph*: 8 external calls (from, default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, vec!).


##### `model_catalog_json_loads_from_path`  (lines 7856–7881)

```
async fn model_catalog_json_loads_from_path() -> std::io::Result<()>
```

**Purpose**: Checks that Codex can load a custom model catalog from a JSON file path. This lets users or tests replace the built-in model list with a specific catalog.

**Data flow**: It writes a small valid catalog JSON file, points config at that file, and loads config. The final config should contain exactly that parsed catalog.

**Call relations**: The test runner calls it. It uses `bundled_models_response` to create valid sample data, writes it to disk, and asks `Config::load_from_base_config_with_overrides` to read it.

*Call graph*: 8 external calls (default, new, load_from_base_config_with_overrides, assert_eq!, bundled_models_response, default, to_string, write).


##### `model_catalog_json_rejects_empty_catalog`  (lines 7884–7908)

```
async fn model_catalog_json_rejects_empty_catalog() -> std::io::Result<()>
```

**Purpose**: Makes sure a custom model catalog cannot be empty. Codex needs at least one model entry to make model selection meaningful.

**Data flow**: It writes a JSON catalog with an empty `models` list and points config at it. Loading should fail with an invalid-data error mentioning that at least one model is required.

**Call relations**: The test runner invokes it. The test exercises the file-reading branch of config loading and checks that bad catalog data is rejected.

*Call graph*: 7 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default, write).


##### `create_test_fixture`  (lines 7910–7973)

```
fn create_test_fixture() -> std::io::Result<PrecedenceTestFixture>
```

**Purpose**: Builds a reusable test setup with a sample config, a temporary working directory, and a temporary Codex home. Many later tests use it so they can focus on one setting instead of rebuilding the same base config.

**Data flow**: It parses a TOML string into `ConfigToml`, creates a fake current directory, marks it like a Git repo so parent folders are not searched, creates a fake Codex home, and returns all of that in a fixture object.

**Call relations**: This helper is called by several service-tier, telemetry, and legacy-profile tests. It hands them a known baseline config that they can modify before calling the real config loader.

*Call graph*: called by 13 (config_toml_legacy_fast_service_tier_uses_priority_request_value, config_toml_priority_service_tier_uses_priority_request_value, config_toml_service_tier_accepts_arbitrary_string, default_service_tier_override_uses_default_request_value, explicit_null_service_tier_override_maps_to_default_service_tier, fast_default_opt_out_notice_config_is_respected, legacy_fast_service_tier_override_uses_priority_request_value, legacy_profile_selection_is_rejected, load_config_applies_otel_trace_metadata, load_config_drops_invalid_otel_trace_metadata_entries (+3 more)); 3 external calls (new, write, from_str).


##### `legacy_profile_selection_is_rejected`  (lines 7976–7998)

```
async fn legacy_profile_selection_is_rejected() -> std::io::Result<()>
```

**Purpose**: Checks that the old top-level `profile = "..."` setting is no longer accepted. This gives users a clear error instead of silently applying obsolete behavior.

**Data flow**: It starts from the shared fixture, sets the legacy `profile` field, and tries to load config. Loading should fail with an invalid-data error that explains the legacy setting is unsupported.

**Call relations**: The test runner calls it. It depends on `create_test_fixture` for setup and then verifies the config loader rejects the outdated field.

*Call graph*: calls 1 internal fn (create_test_fixture); 4 external calls (default, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `metrics_exporter_defaults_to_statsig_when_missing`  (lines 8001–8016)

```
async fn metrics_exporter_defaults_to_statsig_when_missing() -> std::io::Result<()>
```

**Purpose**: Verifies the default metrics exporter when no explicit metrics exporter is configured. The expected default is Statsig, a telemetry backend.

**Data flow**: It loads the shared fixture config without changing telemetry metrics settings. The final config should set `otel.metrics_exporter` to `Statsig`.

**Call relations**: The test runner invokes it. It uses `create_test_fixture`, then sends the fixture through `Config::load_from_base_config_with_overrides`.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `trace_exporter_defaults_to_none_when_log_exporter_is_set`  (lines 8019–8049)

```
async fn trace_exporter_defaults_to_none_when_log_exporter_is_set() -> std::io::Result<()>
```

**Purpose**: Checks that setting a log exporter does not automatically enable trace exporting. This avoids sending traces unless they are explicitly configured.

**Data flow**: It adds an OpenTelemetry log exporter to the fixture config and sets metrics exporting to none. After loading, the log exporter remains configured and the trace exporter is `None`.

**Call relations**: The test runner calls this. It builds on `create_test_fixture`, then checks how the loader fills in related OpenTelemetry defaults.

*Call graph*: calls 1 internal fn (create_test_fixture); 5 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!).


##### `load_config_applies_otel_trace_metadata`  (lines 8052–8091)

```
async fn load_config_applies_otel_trace_metadata() -> std::io::Result<()>
```

**Purpose**: Verifies that configured OpenTelemetry trace metadata is loaded. OpenTelemetry is a standard way to record logs, metrics, and traces for observability.

**Data flow**: It parses TOML containing span attributes and tracestate entries. Loading config should copy those key-value pairs into the final telemetry config.

**Call relations**: The test runner invokes it. The test uses `create_test_fixture` for paths and then checks the output of the normal config loader.

*Call graph*: calls 1 internal fn (create_test_fixture); 4 external calls (default, load_from_base_config_with_overrides, assert_eq!, from_str).


##### `load_config_drops_invalid_otel_trace_metadata_entries`  (lines 8094–8162)

```
async fn load_config_drops_invalid_otel_trace_metadata_entries() -> std::io::Result<()>
```

**Purpose**: Checks that invalid telemetry metadata entries are ignored with warnings rather than poisoning the whole config. Valid entries should still survive.

**Data flow**: It provides an empty span-attribute key and tracestate values with newlines, alongside valid entries. Loading keeps the valid metadata, drops invalid pieces, and records startup warnings.

**Call relations**: The test runner calls it. It exercises the config loader's validation and warning collection for OpenTelemetry metadata.

*Call graph*: calls 1 internal fn (create_test_fixture); 5 external calls (default, load_from_base_config_with_overrides, assert!, assert_eq!, from_str).


##### `explicit_null_service_tier_override_maps_to_default_service_tier`  (lines 8165–8185)

```
async fn explicit_null_service_tier_override_maps_to_default_service_tier() -> std::io::Result<()>
```

**Purpose**: Checks how an explicit null service-tier override is interpreted. It should mean the default request value, not an unknown or missing tier.

**Data flow**: It loads the fixture with an override shaped as `Some(None)`. The final `service_tier` becomes the default request value and no fast-default opt-out notice is set.

**Call relations**: The test runner invokes it. It uses `create_test_fixture` and then sends a specific override into the config loader.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `default_service_tier_override_uses_default_request_value`  (lines 8188–8207)

```
async fn default_service_tier_override_uses_default_request_value() -> std::io::Result<()>
```

**Purpose**: Verifies that an override string of `default` maps to the internal default service-tier request value. This keeps user-facing wording separate from the value sent downstream.

**Data flow**: It loads the fixture with `service_tier` override set to `default`. The resulting config stores the standard default request value.

**Call relations**: The test runner calls it. It relies on the shared fixture and config loader to test service-tier normalization.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `legacy_fast_service_tier_override_uses_priority_request_value`  (lines 8210–8229)

```
async fn legacy_fast_service_tier_override_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Checks backward compatibility for the old `fast` service-tier override. Codex should translate it to the newer priority request value.

**Data flow**: It loads the fixture with an override value of `fast`. The final config should contain the request value for `ServiceTier::Fast`.

**Call relations**: The test runner invokes it. It uses `create_test_fixture` and checks the loader's service-tier migration behavior.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_priority_service_tier_uses_priority_request_value`  (lines 8232–8253)

```
async fn config_toml_priority_service_tier_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Verifies that a priority service tier written in config TOML is preserved as the priority request value. This tests file-based configuration rather than an override.

**Data flow**: It modifies the fixture's TOML config to set the priority service tier. Loading returns a config with that same request value.

**Call relations**: The test runner calls it. It depends on `create_test_fixture`, then loads the edited fixture through the normal config path.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_service_tier_accepts_arbitrary_string`  (lines 8256–8277)

```
async fn config_toml_service_tier_accepts_arbitrary_string() -> std::io::Result<()>
```

**Purpose**: Checks that config TOML can contain an unknown service-tier string. This allows future or experimental tier IDs without requiring immediate code changes.

**Data flow**: It sets `service_tier` to `experimental-tier-id` in the fixture config. Loading preserves that exact string in the final config.

**Call relations**: The test runner invokes it. The test uses the shared fixture and confirms the loader does not over-restrict service-tier values.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `config_toml_legacy_fast_service_tier_uses_priority_request_value`  (lines 8280–8301)

```
async fn config_toml_legacy_fast_service_tier_uses_priority_request_value() -> std::io::Result<()>
```

**Purpose**: Checks that the old `fast` service tier is translated when it appears in the TOML config file. This protects users with older config files.

**Data flow**: It writes `fast` into the fixture config's service tier. Loading converts it to the modern priority request value.

**Call relations**: The test runner calls it. It uses `create_test_fixture` and checks the service-tier normalization inside config loading.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `fast_default_opt_out_notice_config_is_respected`  (lines 8304–8325)

```
async fn fast_default_opt_out_notice_config_is_respected() -> std::io::Result<()>
```

**Purpose**: Verifies that the notice flag for opting out of a fast default is respected. This controls whether Codex records that notice state instead of choosing a service tier.

**Data flow**: It adds a notice config with `fast_default_opt_out` set to true. Loading leaves `service_tier` unset and stores the notice flag as true.

**Call relations**: The test runner invokes it. It starts with `create_test_fixture`, edits the notice section, and checks the loaded config.

*Call graph*: calls 1 internal fn (create_test_fixture); 3 external calls (default, load_from_base_config_with_overrides, assert_eq!).


##### `test_requirements_web_search_mode_allowlist_does_not_warn_when_unset`  (lines 8328–8404)

```
async fn test_requirements_web_search_mode_allowlist_does_not_warn_when_unset() -> anyhow::Result<()>
```

**Purpose**: Checks that an enterprise web-search allowlist does not create a warning when the user has not configured a conflicting value. Requirements should guide defaults quietly when nothing needs correcting.

**Data flow**: It builds requirements allowing disabled or cached web search, with cached as the constrained value. Loading config with that layer stack should produce no startup warning about `web_search_mode`.

**Call relations**: The test runner calls it. It uses `create_test_fixture`, constructs a `ConfigLayerStack`, and hands that stack to `Config::load_config_with_layer_stack`.

*Call graph*: calls 4 internal fn (new, new, new, create_test_fixture); 5 external calls (default, new, load_config_with_layer_stack, assert!, vec!).


##### `test_set_project_trusted_writes_explicit_tables`  (lines 8407–8429)

```
fn test_set_project_trusted_writes_explicit_tables() -> anyhow::Result<()>
```

**Purpose**: Checks that setting a project as trusted writes the project entry as an explicit TOML table. This keeps the saved config clear and structured.

**Data flow**: It starts with an empty TOML document, asks the helper to mark `/some/path` trusted, converts the document to text, and compares it with the expected table form.

**Call relations**: The test runner invokes it. The test directly exercises `set_project_trust_level_inner`, the lower-level writer used when Codex records project trust.

*Call graph*: 4 external calls (new, new, assert_eq!, format!).


##### `test_set_project_trusted_converts_inline_to_explicit`  (lines 8432–8466)

```
fn test_set_project_trusted_converts_inline_to_explicit() -> anyhow::Result<()>
```

**Purpose**: Verifies that an old inline project entry is converted to an explicit table when trust is updated. This preserves meaning while moving the file toward the preferred layout.

**Data flow**: It starts with `[projects]` containing an inline entry marked untrusted. After updating, the output should contain an explicit per-project table marked trusted.

**Call relations**: The test runner calls it. It directly tests `set_project_trust_level_inner` against an older TOML shape.

*Call graph*: 3 external calls (new, assert_eq!, format!).


##### `test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries`  (lines 8469–8503)

```
fn test_set_project_trusted_migrates_top_level_inline_projects_preserving_entries() -> anyhow::Result<()>
```

**Purpose**: Checks that a top-level inline `projects = { ... }` table can be migrated without losing existing project entries or extra fields. This protects users' existing config during automatic updates.

**Data flow**: It parses a TOML document with top-level settings and inline projects, then adds a new trusted project. The output should keep top-level settings, preserve old project fields, and append the new project table.

**Call relations**: The test runner invokes it. It uses `project_trust_key` for the expected key and exercises `set_project_trust_level_inner` migration behavior.

*Call graph*: calls 1 internal fn (project_trust_key); 3 external calls (new, assert_eq!, format!).


##### `active_project_does_not_match_configured_alias_for_canonical_cwd`  (lines 8507–8530)

```
async fn active_project_does_not_match_configured_alias_for_canonical_cwd() -> anyhow::Result<()>
```

**Purpose**: Checks that a project configured through a symlink alias is not treated as matching the real canonical path. This avoids accidentally applying trust to a different path spelling.

**Data flow**: It creates a real project directory and a symlink alias, stores trust for the alias, then asks for the active project using the real path. The result should be no match.

**Call relations**: The test runner calls it on Unix-like systems where symlinks are available. It directly exercises `ConfigToml::get_active_project`.

*Call graph*: 6 external calls (default, from, assert_eq!, create_dir_all, symlink, tempdir).


##### `test_set_default_oss_provider`  (lines 8533–8565)

```
fn test_set_default_oss_provider() -> std::io::Result<()>
```

**Purpose**: Tests writing and updating the default open-source model provider setting. It also verifies invalid provider names are rejected.

**Data flow**: It creates a temporary config file, writes `ollama`, updates to `lmstudio` while preserving another setting, overwrites back to `ollama`, and then tries an invalid provider. Valid writes change the file; the invalid write returns an invalid-input error.

**Call relations**: The test runner invokes it. It directly exercises `set_default_oss_provider`, which edits the user's config file.

*Call graph*: 5 external calls (new, assert!, assert_eq!, read_to_string, write).


##### `test_set_default_oss_provider_rejects_legacy_ollama_chat_provider`  (lines 8568–8583)

```
fn test_set_default_oss_provider_rejects_legacy_ollama_chat_provider() -> std::io::Result<()>
```

**Purpose**: Checks that the removed legacy Ollama chat provider cannot be set as the default OSS provider. The error should point users toward the removal message.

**Data flow**: It calls the setter with the legacy provider ID. The function should return an invalid-input error containing the specific removal notice.

**Call relations**: The test runner calls it. It directly tests the validation branch in `set_default_oss_provider`.

*Call graph*: 3 external calls (new, assert!, assert_eq!).


##### `test_load_config_rejects_legacy_ollama_chat_provider_with_helpful_error`  (lines 8586–8610)

```
async fn test_load_config_rejects_legacy_ollama_chat_provider_with_helpful_error() -> std::io::Result<()>
```

**Purpose**: Verifies that loading config with the removed Ollama chat provider fails with a helpful error. This protects users from confusing provider-not-found behavior.

**Data flow**: It builds a config whose `model_provider` is the legacy provider ID. Loading should fail with a not-found error that includes the removal message.

**Call relations**: The test runner invokes it. It tests the normal config loading path rather than the config-writing helper.

*Call graph*: 6 external calls (default, new, load_from_base_config_with_overrides, assert!, assert_eq!, default).


##### `test_untrusted_project_gets_workspace_write_sandbox`  (lines 8613–8648)

```
async fn test_untrusted_project_gets_workspace_write_sandbox() -> anyhow::Result<()>
```

**Purpose**: Checks the legacy sandbox policy chosen for an untrusted project. On most platforms it should allow workspace writes; on Windows it may be downgraded to read-only.

**Data flow**: It creates config data marking a project untrusted and passes that active project into the sandbox derivation helper. The returned sandbox policy is checked against the platform-specific expectation.

**Call relations**: The test runner calls it. It exercises `derive_legacy_sandbox_policy_for_test`, a test helper around sandbox selection logic.

*Call graph*: calls 1 internal fn (derive_legacy_sandbox_policy_for_test); 2 external calls (assert!, cfg!).


##### `derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults`  (lines 8651–8692)

```
async fn derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults() -> anyhow::Result<()>
```

**Purpose**: Verifies that when requirements only allow read-only access, implicit default sandbox choices fall back to read-only. This keeps organization rules stronger than default behavior.

**Data flow**: It sets up a trusted project and a constraint that accepts only the read-only permission profile. Sandbox derivation should return a read-only policy.

**Call relations**: The test runner invokes it. It uses `Constrained::new` to model requirements, then calls `derive_legacy_sandbox_policy_for_test`.

*Call graph*: calls 3 internal fn (new, derive_legacy_sandbox_policy_for_test, read_only); 4 external calls (default, from, new, assert_eq!).


##### `derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback`  (lines 8695–8748)

```
async fn derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback() -> anyhow::Result<()>
```

**Purpose**: Checks that fallback sandbox behavior still respects Windows limitations. If workspace-write is required but unsupported on Windows, the result should be read-only there.

**Data flow**: It creates a trusted project and a constraint that allows a workspace-write-style profile. Sandbox derivation returns workspace-write on non-Windows platforms and read-only on Windows.

**Call relations**: The test runner calls it. It combines a permission constraint with `derive_legacy_sandbox_policy_for_test` and then checks platform-specific output.

*Call graph*: calls 3 internal fn (new, derive_legacy_sandbox_policy_for_test, workspace_write); 5 external calls (default, from, new, assert_eq!, cfg!).


##### `test_resolve_oss_provider_explicit_override`  (lines 8751–8755)

```
fn test_resolve_oss_provider_explicit_override()
```

**Purpose**: Checks that an explicitly supplied OSS provider is returned when present. Direct user input should win over missing config.

**Data flow**: It passes `custom-provider` as the explicit provider and an otherwise default config. The resolver returns `custom-provider`.

**Call relations**: The test runner invokes it. It directly tests `resolve_oss_provider` with the simplest override case.

*Call graph*: 2 external calls (assert_eq!, default).


##### `test_resolve_oss_provider_from_global_config`  (lines 8758–8766)

```
fn test_resolve_oss_provider_from_global_config()
```

**Purpose**: Checks that the OSS provider can come from global config when there is no explicit override. This supports persistent user defaults.

**Data flow**: It creates config with `oss_provider` set to `global-provider` and passes no explicit provider. The resolver returns the configured value.

**Call relations**: The test runner calls it. It directly exercises `resolve_oss_provider` for the global-config path.

*Call graph*: 2 external calls (default, assert_eq!).


##### `test_resolve_oss_provider_none_when_not_configured`  (lines 8769–8773)

```
fn test_resolve_oss_provider_none_when_not_configured()
```

**Purpose**: Verifies that no OSS provider is selected when neither an override nor a config value exists. This avoids inventing a provider unexpectedly.

**Data flow**: It passes no explicit provider and a default config. The resolver returns `None`.

**Call relations**: The test runner invokes it. It directly checks the empty-input branch of `resolve_oss_provider`.

*Call graph*: 2 external calls (assert_eq!, default).


##### `test_resolve_oss_provider_explicit_overrides_global`  (lines 8776–8784)

```
fn test_resolve_oss_provider_explicit_overrides_global()
```

**Purpose**: Checks that an explicit OSS provider beats the global config value. This matches normal precedence rules: a direct request wins over a saved default.

**Data flow**: It creates config with `global-provider` but passes `explicit-provider` as the override. The resolver returns `explicit-provider`.

**Call relations**: The test runner calls it. It directly tests precedence inside `resolve_oss_provider`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `config_toml_deserializes_mcp_oauth_callback_port`  (lines 8787–8792)

```
fn config_toml_deserializes_mcp_oauth_callback_port()
```

**Purpose**: Checks that the MCP OAuth callback port can be read from TOML. MCP is the Model Context Protocol, and OAuth callback settings support login flows.

**Data flow**: It parses TOML with `mcp_oauth_callback_port = 4321`. The resulting `ConfigToml` should store `Some(4321)`.

**Call relations**: The test runner invokes it. It tests TOML deserialization before full config loading is involved.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_toml_deserializes_mcp_oauth_callback_url`  (lines 8795–8803)

```
fn config_toml_deserializes_mcp_oauth_callback_url()
```

**Purpose**: Checks that the MCP OAuth callback URL can be read from TOML. This lets config specify where OAuth login should return.

**Data flow**: It parses TOML with a callback URL string. The resulting `ConfigToml` should contain that URL.

**Call relations**: The test runner calls it. It directly tests TOML parsing for this field.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_loads_mcp_oauth_callback_port_from_toml`  (lines 8806–8824)

```
async fn config_loads_mcp_oauth_callback_port_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies that the MCP OAuth callback port survives full config loading, not just TOML parsing. This ensures runtime code can use the value.

**Data flow**: It parses TOML with a port, loads it into `Config`, and checks that the final config contains `Some(5678)`.

**Call relations**: The test runner invokes it. It passes parsed `ConfigToml` into `Config::load_from_base_config_with_overrides`.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `config_loads_allow_login_shell_from_toml`  (lines 8827–8846)

```
async fn config_loads_allow_login_shell_from_toml() -> std::io::Result<()>
```

**Purpose**: Checks that the `allow_login_shell` setting is loaded into runtime permissions. This setting controls whether Codex may use a login shell.

**Data flow**: It parses TOML setting `allow_login_shell = false`, loads config, and verifies the final permission flag is false.

**Call relations**: The test runner calls it. It uses the normal config loader to confirm the parsed field reaches runtime permissions.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert!, default, from_str).


##### `config_loads_apps_mcp_product_sku_from_toml`  (lines 8849–8867)

```
async fn config_loads_apps_mcp_product_sku_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies that an apps MCP product SKU can be configured and loaded. A SKU is a product identifier used by integrations.

**Data flow**: It parses TOML with `apps_mcp_product_sku = "tpp"`, loads config, and checks that the final optional string is `tpp`.

**Call relations**: The test runner invokes it. It tests the field through the normal config loading path.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `config_loads_mcp_oauth_callback_url_from_toml`  (lines 8870–8891)

```
async fn config_loads_mcp_oauth_callback_url_from_toml() -> std::io::Result<()>
```

**Purpose**: Verifies that the MCP OAuth callback URL survives full config loading. This ensures the runtime config can use the URL, not just parse it.

**Data flow**: It parses TOML with a callback URL, loads config, and checks the final URL field.

**Call relations**: The test runner calls it. It uses `Config::load_from_base_config_with_overrides` to test end-to-end loading for this field.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `test_untrusted_project_gets_unless_trusted_approval_policy`  (lines 8894–8944)

```
async fn test_untrusted_project_gets_unless_trusted_approval_policy() -> anyhow::Result<()>
```

**Purpose**: Checks that untrusted projects use an approval policy that asks unless the action is trusted. This adds a safety gate for untrusted workspaces.

**Data flow**: It loads config with the current project marked untrusted. The final approval policy should be `UnlessTrusted`, and the sandbox should be workspace-write except for Windows downgrade to read-only.

**Call relations**: The test runner invokes it. It exercises full config loading and then checks both permissions and legacy sandbox output.

*Call graph*: 7 external calls (default, from, new, load_from_base_config_with_overrides, assert!, assert_eq!, cfg!).


##### `requirements_disallowing_default_sandbox_falls_back_to_required_default`  (lines 8947–8965)

```
async fn requirements_disallowing_default_sandbox_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Verifies that enterprise requirements can force the sandbox default to read-only. If the normal default is not allowed, Codex should choose the required safe fallback.

**Data flow**: It builds config with a cloud requirement allowing only read-only sandbox mode. The loaded config's legacy sandbox policy should be read-only.

**Call relations**: The test runner calls it. It uses `ConfigBuilder::without_managed_config_for_tests` plus `CloudConfigBundleFixture::loader_with_enterprise_requirement`.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `explicit_sandbox_mode_falls_back_when_disallowed_by_requirements`  (lines 8968–8991)

```
async fn explicit_sandbox_mode_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit dangerous sandbox setting is overridden when enterprise requirements disallow it. Organization safety rules should win over local config.

**Data flow**: It writes `sandbox_mode = "danger-full-access"` to config but supplies requirements allowing only read-only. Loading succeeds with a read-only sandbox policy.

**Call relations**: The test runner invokes it. It uses the builder and enterprise requirement fixture to test fallback from a local file setting.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `windows_sandbox_mode_falls_back_when_disallowed_by_requirements`  (lines 8994–9027)

```
async fn windows_sandbox_mode_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that Windows sandbox implementation settings fall back when disallowed by requirements. It also verifies that Codex records a warning explaining the correction.

**Data flow**: It writes `windows.sandbox = "unelevated"` locally and supplies requirements allowing only `elevated`. Loading changes the effective Windows sandbox mode to elevated and adds a startup warning.

**Call relations**: The test runner calls it. It uses the config builder with a cloud requirement bundle and then checks both the chosen value and warning list.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `danger_full_access_with_never_is_rejected_when_requirements_force_read_only`  (lines 9030–9058)

```
async fn danger_full_access_with_never_is_rejected_when_requirements_force_read_only() -> std::io::Result<()>
```

**Purpose**: Prevents an unsafe combination: approvals disabled while requirements force a fallback from full access to read-only. Codex rejects this because read-only with no approvals could block needed work without a way to ask.

**Data flow**: It writes `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`, then applies requirements allowing only read-only. Building config should fail with a clear invalid-input message.

**Call relations**: The test runner invokes it. It uses the builder and enterprise requirement fixture and expects the build step to return an error.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `named_full_access_profile_with_never_is_rejected_when_requirements_force_read_only`  (lines 9061–9092)

```
async fn named_full_access_profile_with_never_is_rejected_when_requirements_force_read_only() -> std::io::Result<()>
```

**Purpose**: Checks the same unsafe case as full-access sandbox mode, but through a named permission profile. A profile granting root write access with approvals disabled must be rejected if requirements force read-only.

**Data flow**: It writes a default permission profile named `dev` with root write access and `approval_policy = "never"`. Under read-only-only requirements, config building fails with the expected invalid-input message.

**Call relations**: The test runner calls it. It uses the same enterprise requirement path as the direct sandbox-mode test, but exercises named permission profile resolution.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `permission_profile_override_falls_back_when_disallowed_by_requirements`  (lines 9095–9120)

```
async fn permission_profile_override_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies that a permission profile override is replaced by a requirement-approved fallback when disallowed. This keeps command-line or harness overrides from bypassing policy.

**Data flow**: It passes a disabled permission profile override while requirements allow only read-only. The final config uses a read-only sandbox and an effective read-only permission profile.

**Call relations**: The test runner invokes it. It uses `ConfigBuilder` with harness overrides and an enterprise requirement fixture.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (default, new, new_read_only_policy, assert_eq!).


##### `active_profile_is_cleared_when_requirements_force_fallback`  (lines 9123–9152)

```
async fn active_profile_is_cleared_when_requirements_force_fallback() -> std::io::Result<()>
```

**Purpose**: Checks that when requirements force a fallback away from a named active profile, Codex clears the active profile name. This avoids pretending the requested profile is still in effect.

**Data flow**: It requests the built-in danger-full-access profile while requirements allow only read-only. Loading ends with an effective read-only profile, no active profile name, and a warning about the disallowed profile.

**Call relations**: The test runner calls it. It exercises the builder's requirement fallback path and warning generation.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (default, new, assert!, assert_eq!).


##### `bypass_hook_trust_adds_startup_warning`  (lines 9155–9175)

```
async fn bypass_hook_trust_adds_startup_warning() -> std::io::Result<()>
```

**Purpose**: Verifies that using the dangerous hook-trust bypass option adds a visible startup warning. Hooks are scripts or actions that may run automatically, so bypassing review should not be silent.

**Data flow**: It loads config with the `bypass_hook_trust` override set to true. The final config should contain the exact warning about hooks running without review.

**Call relations**: The test runner invokes it. It uses `ConfigBuilder::without_managed_config_for_tests` with harness overrides.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (default, new, assert!).


##### `permission_profile_override_preserves_split_write_roots`  (lines 9178–9231)

```
async fn permission_profile_override_preserves_split_write_roots() -> std::io::Result<()>
```

**Purpose**: Checks that a custom permission profile with a separate writable root is preserved. This matters for setups where the working directory is not the only place Codex may write.

**Data flow**: It creates a restricted filesystem policy that reads root but writes a separate outside directory, converts it to a permission profile, and loads config with that override. The final permissions can write the outside root, use a workspace-write legacy policy, and keep restricted networking.

**Call relations**: The test runner calls it. It builds a `PermissionProfile` from runtime sandbox policies and passes it through `ConfigBuilder` as an override.

*Call graph*: calls 4 internal fn (without_managed_config_for_tests, from_runtime_permissions_with_enforcement, restricted, from_absolute_path); 6 external calls (default, new, assert!, assert_eq!, create_dir_all, vec!).


##### `requirements_web_search_mode_overrides_danger_full_access_default`  (lines 9234–9263)

```
async fn requirements_web_search_mode_overrides_danger_full_access_default() -> std::io::Result<()>
```

**Purpose**: Verifies that enterprise web-search requirements can force cached search even when local config asks for full-access sandboxing. Web-search policy is resolved independently and should obey requirements.

**Data flow**: It writes dangerous full-access sandbox mode, then applies a requirement allowing cached web search. The final config's web search mode is cached, and per-turn resolution also returns cached.

**Call relations**: The test runner invokes it. It combines config building with `resolve_web_search_mode_for_turn` to check both stored and effective behavior.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `requirements_disallowing_default_approval_falls_back_to_required_default`  (lines 9266–9297)

```
async fn requirements_disallowing_default_approval_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Checks that approval policy defaults fall back to an allowed value when requirements disallow the normal default for an untrusted project. Enterprise policy should shape the default approval behavior.

**Data flow**: It marks a workspace untrusted and supplies requirements allowing only `on-request` approvals. Loading config should set the approval policy to `OnRequest`.

**Call relations**: The test runner calls it. It writes a temporary config file and uses the builder with an enterprise requirement bundle.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert_eq!, format!, write).


##### `explicit_approval_policy_falls_back_when_disallowed_by_requirements`  (lines 9300–9324)

```
async fn explicit_approval_policy_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Verifies that a local explicit approval policy is replaced when enterprise requirements disallow it. This prevents local config from weakening or changing required approval behavior.

**Data flow**: It writes `approval_policy = "untrusted"` and applies requirements allowing only `on-request`. The final approval policy should be `OnRequest`.

**Call relations**: The test runner invokes it. It uses `ConfigBuilder` with a local config file and a cloud requirement fixture.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `feature_requirements_normalize_effective_feature_values`  (lines 9327–9356)

```
async fn feature_requirements_normalize_effective_feature_values() -> std::io::Result<()>
```

**Purpose**: Checks that feature requirements become effective feature flags without producing unnecessary warnings. Feature flags are on/off switches for optional behavior.

**Data flow**: It supplies requirements enabling `personality` and disabling `shell_tool`. The final feature set reflects those values and contains no warning about configured feature values.

**Call relations**: The test runner calls it. It uses the builder with enterprise feature requirements and then inspects `config.features` and warnings.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `feature_requirements_auto_review_disables_guardian_approval`  (lines 9359–9378)

```
async fn feature_requirements_auto_review_disables_guardian_approval() -> std::io::Result<()>
```

**Purpose**: Verifies that disabling the auto-review feature through requirements also disables guardian approval. This checks a dependency between related safety features.

**Data flow**: It supplies a requirement setting `auto_review = false`. After config loading, the `GuardianApproval` feature should be disabled.

**Call relations**: The test runner invokes it. It uses the enterprise requirement fixture and checks the resolved feature flags.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `browser_feature_requirements_are_valid`  (lines 9381–9402)

```
async fn browser_feature_requirements_are_valid() -> std::io::Result<()>
```

**Purpose**: Checks that browser-related feature requirements are accepted and applied. This covers both in-app browser and browser-use feature switches.

**Data flow**: It supplies requirements disabling `in_app_browser` and `browser_use`. The loaded config should show both features disabled.

**Call relations**: The test runner calls it. It uses the config builder with enterprise requirements and inspects the resulting feature set.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `debug_config_lockfile_export_settings_load_from_nested_table`  (lines 9405–9433)

```
async fn debug_config_lockfile_export_settings_load_from_nested_table() -> std::io::Result<()>
```

**Purpose**: Verifies that debug config-lock export settings can be read from the nested `[debug.config_lockfile]` table. Config locks record resolved settings for debugging or reproducibility.

**Data flow**: It writes nested lockfile export settings into config TOML. Loading resolves the export directory relative to Codex home and reads the two boolean lockfile options.

**Call relations**: The test runner invokes it. It uses `ConfigBuilder::without_managed_config_for_tests` to read the temporary config file.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `debug_config_lockfile_load_path_loads_lock_from_nested_table`  (lines 9436–9473)

```
async fn debug_config_lockfile_load_path_loads_lock_from_nested_table() -> std::io::Result<()>
```

**Purpose**: Checks that a config lockfile path in the nested debug table is read and the lock file is loaded. It also verifies lockfile debug options in the same table.

**Data flow**: It writes a minimal lockfile and points `[debug.config_lockfile].load_path` at it, allowing version mismatch. Loading config should populate `config_lock_toml` and read the related booleans.

**Call relations**: The test runner calls it. It writes both the lock file and config file, then uses `ConfigBuilder` to exercise lockfile loading.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, format!, write).


##### `explicit_feature_config_is_normalized_by_requirements`  (lines 9476–9514)

```
async fn explicit_feature_config_is_normalized_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that enterprise feature requirements override explicit user feature choices without producing a misleading warning. This matters because required features must win over local preferences in a predictable way.

**Data flow**: The test creates a temporary config file where the user disables `personality` and enables `shell_tool`. It then loads config with an enterprise requirement that does the opposite. The final config has `personality` enabled, `shell_tool` disabled, and no warning saying the feature value was merely disallowed.

**Call relations**: The test runner invokes this test. Inside it, the test writes a config file, builds a config through `ConfigBuilder::without_managed_config_for_tests`, and supplies enterprise rules through `CloudConfigBundleFixture::loader_with_enterprise_requirement`; the assertions then confirm the builder normalized the feature set.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert!, write).


##### `approvals_reviewer_defaults_to_manual_only_without_guardian_feature`  (lines 9517–9529)

```
async fn approvals_reviewer_defaults_to_manual_only_without_guardian_feature() -> std::io::Result<()>
```

**Purpose**: Checks the default approval reviewer when no special guardian approval feature is configured. The expected safe default is that the user reviews approvals manually.

**Data flow**: The test starts with an empty temporary Codex home. It loads configuration with no managed config. The resulting config has `approvals_reviewer` set to `ApprovalsReviewer::User`.

**Call relations**: The test runner calls this test as part of config regression coverage. It relies on `ConfigBuilder::without_managed_config_for_tests` to load a normal local configuration path and then checks the default approval-review decision.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `prompt_instruction_blocks_can_be_disabled_from_config`  (lines 9532–9558)

```
async fn prompt_instruction_blocks_can_be_disabled_from_config() -> std::io::Result<()>
```

**Purpose**: Checks that several built-in prompt instruction blocks can be turned off from the config file. These blocks are pieces of guidance added to prompts, so users need reliable switches for them.

**Data flow**: The test writes a config file that sets permission, app, collaboration, skill, and environment-context instruction flags to false. It loads the config. The output config has all of those include flags turned off.

**Call relations**: The test runner invokes this test. The test uses `ConfigBuilder::default` to exercise the ordinary config-loading path, after writing the requested toggles to disk.

*Call graph*: 4 external calls (new, assert!, default, write).


##### `approvals_reviewer_stays_manual_only_when_guardian_feature_is_enabled`  (lines 9561–9579)

```
async fn approvals_reviewer_stays_manual_only_when_guardian_feature_is_enabled() -> std::io::Result<()>
```

**Purpose**: Checks that merely enabling the guardian approval feature does not automatically switch approval review away from the user. This prevents a feature flag from unexpectedly changing who reviews approvals.

**Data flow**: The test writes a config file with `guardian_approval = true`. It loads the config. The resulting approval reviewer remains `ApprovalsReviewer::User`.

**Call relations**: The test runner calls this test. It builds config with managed config disabled and verifies that feature parsing and approval-review defaults remain separate.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `approvals_reviewer_can_be_set_in_config_without_guardian_approval`  (lines 9582–9599)

```
async fn approvals_reviewer_can_be_set_in_config_without_guardian_approval() -> std::io::Result<()>
```

**Purpose**: Checks that the approval reviewer can be explicitly set in the root config even when guardian approval is not enabled. In this case, choosing `user` should be accepted.

**Data flow**: The test writes `approvals_reviewer = "user"` into a temporary config file. It loads that file. The final config records the reviewer as `ApprovalsReviewer::User`.

**Call relations**: The test runner invokes this test. The test passes the file through `ConfigBuilder::without_managed_config_for_tests` and checks that the root config value survives loading.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `requirements_disallowing_default_approvals_reviewer_falls_back_to_required_default`  (lines 9602–9618)

```
async fn requirements_disallowing_default_approvals_reviewer_falls_back_to_required_default() -> std::io::Result<()>
```

**Purpose**: Checks what happens when enterprise requirements disallow the normal default approval reviewer. The config should fall back to an allowed reviewer instead of keeping an invalid default.

**Data flow**: The test creates no local approval-review setting. It loads enterprise requirements allowing only `guardian_subagent`. The final config chooses `ApprovalsReviewer::AutoReview`, which represents the guardian-subagent review path.

**Call relations**: The test runner calls this test. The test feeds enterprise requirements through `CloudConfigBundleFixture::loader_with_enterprise_requirement` and lets `ConfigBuilder` choose a valid fallback.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert_eq!).


##### `root_approvals_reviewer_falls_back_when_disallowed_by_requirements`  (lines 9621–9651)

```
async fn root_approvals_reviewer_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that a user-set root approval reviewer is replaced when enterprise requirements do not allow it. It also checks that the user receives a startup warning.

**Data flow**: The test writes `approvals_reviewer = "user"` locally, then loads a requirement allowing only `guardian_subagent`. The final config switches to `ApprovalsReviewer::AutoReview` and includes a warning about the disallowed configured value.

**Call relations**: The test runner invokes this test. It combines a local config file with enterprise requirements through the config builder, then inspects both the final setting and startup warnings.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `profile_approvals_reviewer_falls_back_when_disallowed_by_requirements`  (lines 9654–9682)

```
async fn profile_approvals_reviewer_falls_back_when_disallowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks the same enterprise restriction behavior when the approval reviewer comes from a selected profile config file. Profiles are named config variants, so they need the same safety rules as the root config.

**Data flow**: The test writes a profile config setting `approvals_reviewer = "user"`. It points the loader overrides at that profile and adds a requirement allowing only `guardian_subagent`. The loaded config falls back to `ApprovalsReviewer::AutoReview`.

**Call relations**: The test runner calls this test. The test uses loader overrides to simulate profile selection, then relies on `ConfigBuilder` and the enterprise requirement fixture to verify that profile values are filtered too.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, loader_with_enterprise_requirement, without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements`  (lines 9685–9715)

```
async fn approvals_reviewer_preserves_valid_user_choice_when_allowed_by_requirements() -> std::io::Result<()>
```

**Purpose**: Checks that enterprise requirements do not overwrite a user choice when that choice is allowed. This prevents policy enforcement from being too aggressive.

**Data flow**: The test writes `approvals_reviewer = "guardian_subagent"`. It loads requirements that allow both `user` and `guardian_subagent`. The final config uses `ApprovalsReviewer::AutoReview` and produces no approval-review warning.

**Call relations**: The test runner invokes this test. It gives the config builder both a user choice and compatible enterprise requirements, then checks that the loader accepts the choice cleanly.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `smart_approvals_alias_is_ignored`  (lines 9718–9742)

```
async fn smart_approvals_alias_is_ignored() -> std::io::Result<()>
```

**Purpose**: Checks behavior for the old `smart_approvals` feature key. The alias should still turn on guardian approval behavior, but the config file should not be rewritten into newer keys.

**Data flow**: The test writes `[features] smart_approvals = true`. It loads config and sees guardian approval enabled while approvals still default to the user. It then reads the file back and confirms it still contains `smart_approvals` and does not contain newly written `guardian_approval` or `approvals_reviewer` lines.

**Call relations**: The test runner calls this test. The test uses `ConfigBuilder` for loading and `tokio::fs::read_to_string` to confirm the loader did not mutate the file in unwanted ways.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (new, assert!, assert_eq!, write, read_to_string).


##### `multi_agent_v2_config_from_feature_table`  (lines 9745–9804)

```
async fn multi_agent_v2_config_from_feature_table() -> std::io::Result<()>
```

**Purpose**: Checks that the full `features.multi_agent_v2` table is read into the runtime multi-agent configuration. Multi-agent v2 lets Codex run helper agents, so its limits and prompt hints must be loaded accurately.

**Data flow**: The test writes a multi-agent v2 config table with enablement, concurrency, timeout, hint text, namespace, and visibility flags. It loads config. The output config has the feature enabled and all of those fields set to the expected values, including the effective agent thread count.

**Call relations**: The test runner invokes this test. It exercises the regular config builder path and then checks both the feature flag store and the derived `multi_agent_v2` settings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert!, assert_eq!, write).


##### `multi_agent_v2_default_session_thread_cap_counts_root`  (lines 9807–9832)

```
async fn multi_agent_v2_default_session_thread_cap_counts_root() -> std::io::Result<()>
```

**Purpose**: Checks the default concurrency behavior for multi-agent v2. The important detail is that the root agent counts as one of the session threads.

**Data flow**: The test enables multi-agent v2 with no extra options. It loads config. The multi-agent v2 config equals its default, and the effective subagent capacity is lower than the total session cap because the root agent is included.

**Call relations**: The test runner calls this test. It uses the config builder to load a minimal feature table and then checks the derived thread-limit calculation.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_default_usage_hints_use_configured_thread_cap`  (lines 9835–9857)

```
fn multi_agent_v2_default_usage_hints_use_configured_thread_cap()
```

**Purpose**: Checks that generated usage-hint text mentions the configured concurrency limit. This helps agents receive accurate instructions about how many agents can run at once.

**Data flow**: The test parses a TOML snippet with multi-agent v2 enabled and a session cap of 17. It resolves the multi-agent config directly. The root and subagent hint text both end with guidance that says there are 17 concurrency slots.

**Call relations**: The test runner invokes this synchronous test. Instead of loading from disk, it parses TOML in memory and calls `resolve_multi_agent_v2_config` to focus on the hint-generation logic.

*Call graph*: 3 external calls (assert!, format!, from_str).


##### `multi_agent_v2_empty_usage_hint_overrides_clear_default_hints`  (lines 9860–9881)

```
async fn multi_agent_v2_empty_usage_hint_overrides_clear_default_hints() -> std::io::Result<()>
```

**Purpose**: Checks that an empty string can intentionally clear default multi-agent hint text. This gives config authors a way to remove built-in guidance rather than only replacing it.

**Data flow**: The test writes root and subagent usage hint text as empty strings. It loads config. The resulting config stores both hints as `None`, meaning no hint text should be used.

**Call relations**: The test runner calls this test. It routes the file through `ConfigBuilder` and checks that empty string values are treated as deliberate clearing instructions.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_feature_rejects_agents_max_threads`  (lines 9884–9916)

```
async fn multi_agent_v2_feature_rejects_agents_max_threads() -> std::io::Result<()>
```

**Purpose**: Checks that the old `agents.max_threads` setting conflicts with the new multi-agent v2 feature. This avoids two different settings trying to control the same limit.

**Data flow**: The test writes config with multi-agent v2 enabled and `[agents] max_threads = 3`. It loads config, then asks the config to validate multi-agent v2 settings. Validation returns an invalid-input error with the expected message, while the effective thread calculation still reports the configured value.

**Call relations**: The test runner invokes this test. It uses the builder to load the mixed settings, then calls `validate_multi_agent_v2_config` to confirm conflict detection happens during validation.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `catalog_v2_allows_agents_max_threads_when_feature_disabled`  (lines 9919–9944)

```
async fn catalog_v2_allows_agents_max_threads_when_feature_disabled() -> std::io::Result<()>
```

**Purpose**: Checks that `agents.max_threads` is still allowed when multi-agent v2 is disabled. The older setting should not be blocked unless the new feature is active.

**Data flow**: The test writes multi-agent v2 as disabled and sets `[agents] max_threads = 3`. It loads config and validates it successfully. The effective thread count for v2 calculations is still `Some(3)`.

**Call relations**: The test runner calls this test. It uses the same validation path as the conflict test, but with the feature disabled to confirm the conflict rule is conditional.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_rejects_invalid_wait_timeouts`  (lines 9947–10143)

```
async fn multi_agent_v2_rejects_invalid_wait_timeouts() -> std::io::Result<()>
```

**Purpose**: Checks that multi-agent v2 wait timeout values stay within allowed ranges and stay logically ordered. Bad timeout settings could cause instant failures, endless waits, or confusing timing behavior.

**Data flow**: The test first confirms zero timeout values are accepted. It then repeatedly rewrites the config with invalid values: negative numbers, values above the maximum, a minimum greater than the maximum, and defaults outside the min/max range. Each invalid load returns an invalid-input error with the expected message.

**Call relations**: The test runner invokes this test. The test repeatedly calls `ConfigBuilder::without_managed_config_for_tests` after changing the config file, so it checks errors produced during config loading itself.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `multi_agent_v2_rejects_invalid_tool_namespace`  (lines 10146–10179)

```
async fn multi_agent_v2_rejects_invalid_tool_namespace() -> std::io::Result<()>
```

**Purpose**: Checks that the tool namespace for multi-agent v2 is safe and not reserved. A namespace is the label under which tools are exposed, so invalid names can break tool routing or collide with built-in names.

**Data flow**: The test tries two bad namespaces: one with a space and one named `functions`, which is reserved. For each, it writes a config file and attempts to load it. Loading fails with an invalid-input error and the expected explanation.

**Call relations**: The test runner calls this test. The test loops through bad examples and relies on the config builder to reject each one during loading.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (new, assert_eq!, format!, write).


##### `multi_agent_v2_session_thread_cap_one_disallows_subagents`  (lines 10182–10208)

```
async fn multi_agent_v2_session_thread_cap_one_disallows_subagents() -> std::io::Result<()>
```

**Purpose**: Checks the edge case where the session thread cap is one. Because the root agent uses that one slot, no subagents should be allowed.

**Data flow**: The test writes multi-agent v2 enabled with `max_concurrent_threads_per_session = 1`. It loads config. The raw session cap is one, and the effective subagent thread count is zero.

**Call relations**: The test runner invokes this test. It uses normal config loading and then checks the derived calculation returned by `effective_agent_max_threads`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (new, assert_eq!, write).


##### `feature_requirements_normalize_runtime_feature_mutations`  (lines 10211–10242)

```
async fn feature_requirements_normalize_runtime_feature_mutations() -> std::io::Result<()>
```

**Purpose**: Checks that enterprise feature requirements also apply when code tries to change features at runtime. This prevents later feature changes from bypassing centrally required settings.

**Data flow**: The test loads config with requirements forcing `personality` on and `shell_tool` off. It clones the current feature set, changes the clone to request the opposite, and asks the feature system to apply it. The final config still has `personality` enabled and `shell_tool` disabled.

**Call relations**: The test runner calls this test. It uses `ConfigBuilder::default` with an enterprise requirement fixture, then exercises the runtime `can_set` and `set` path on the config's feature store.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 3 external calls (new, assert!, default).


##### `feature_requirements_warn_on_collab_legacy_alias`  (lines 10245–10272)

```
async fn feature_requirements_warn_on_collab_legacy_alias() -> std::io::Result<()>
```

**Purpose**: Checks that an old enterprise requirement key, `collab`, still works but produces a warning asking users to prefer the newer canonical key. This keeps old configs compatible while nudging them forward.

**Data flow**: The test loads enterprise requirements containing `[features] collab = true`. The final config has the collaboration feature enabled. Startup warnings include a message about the legacy key and the preferred `multi_agent` key.

**Call relations**: The test runner invokes this test. The requirement fixture supplies the legacy key, and `ConfigBuilder` turns it into both a feature setting and a startup warning.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `feature_requirements_warn_and_ignore_unknown_feature`  (lines 10275–10302)

```
async fn feature_requirements_warn_and_ignore_unknown_feature() -> std::io::Result<()>
```

**Purpose**: Checks that unknown enterprise feature requirement keys do not crash config loading, but do warn the user. This makes the system tolerant of mistakes while still visible.

**Data flow**: The test loads a requirement for `made_up_feature`. Config loading succeeds. The resulting startup warnings include a message saying the unknown feature requirement was ignored.

**Call relations**: The test runner calls this test. It passes the unknown feature through the enterprise requirement fixture and confirms the builder reports it through startup warnings.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, without_managed_config_for_tests); 2 external calls (new, assert!).


##### `tool_suggest_discoverables_load_from_config_toml`  (lines 10305–10364)

```
async fn tool_suggest_discoverables_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that tool suggestion discoverable entries are read from TOML and cleaned before becoming runtime config. Discoverables are tools or connectors the system may suggest to the user.

**Data flow**: The test parses a TOML snippet with two valid discoverables and one connector whose id is only spaces. Raw TOML deserialization preserves all three. Loading into full config removes the blank-id entry and keeps the valid connector and plugin entries.

**Call relations**: The test runner invokes this test. It first uses `toml::from_str` to check parsing into `ConfigToml`, then calls `Config::load_from_base_config_with_overrides` to check the normalization step.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `tool_suggest_disabled_tools_load_from_config_toml`  (lines 10367–10413)

```
async fn tool_suggest_disabled_tools_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that disabled tool entries are read, trimmed, deduplicated, and filtered. This keeps the runtime disabled-tool list clean even if the config file contains extra spaces or repeats.

**Data flow**: The test parses a TOML list with a spaced connector id, a duplicate connector id, a blank connector id, and a plugin id. Raw parsing keeps the entries as written. Full config loading trims ids, removes the blank one, removes the duplicate, and keeps one connector plus one plugin.

**Call relations**: The test runner calls this test. It compares the raw `ConfigToml` parse with the normalized result from `Config::load_from_base_config_with_overrides`.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `tool_suggest_disabled_tools_merge_across_config_layers`  (lines 10416–10470)

```
async fn tool_suggest_disabled_tools_merge_across_config_layers() -> std::io::Result<()>
```

**Purpose**: Checks that disabled tool lists from user-level and project-level config files merge in a stable order without duplicates. This matters because both a user and a project may want to hide suggested tools.

**Data flow**: The test writes a user config with disabled tools and a trusted project entry, then writes a project `.codex/config.toml` with more disabled tools. It loads config while setting the current working directory to that project. The final disabled-tool list contains trimmed entries from both layers, with duplicates removed and order preserved by first appearance.

**Call relations**: The test runner invokes this test. It creates both config layers on disk, passes the project directory through builder overrides, and lets `ConfigBuilder` perform the normal layered load.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (default, new, assert_eq!, format!, create_dir_all, write).


##### `experimental_realtime_start_instructions_load_from_config_toml`  (lines 10473–10499)

```
async fn experimental_realtime_start_instructions_load_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that experimental realtime start instructions can be set in the config file. These instructions are text used when starting a realtime session.

**Data flow**: The test parses a TOML value for `experimental_realtime_start_instructions`. Raw parsing stores the string. Full config loading carries the same string into the runtime config.

**Call relations**: The test runner calls this test. It uses `toml::from_str` for the raw config shape and `Config::load_from_base_config_with_overrides` for the final runtime config.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_thread_config_endpoint_loads_from_config_toml`  (lines 10502–10528)

```
async fn experimental_thread_config_endpoint_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that an experimental thread config endpoint URL is read from TOML. This lets tests or experimental deployments point thread configuration at a custom service.

**Data flow**: The test parses a TOML value containing `http://127.0.0.1:8061`. The raw config stores it. The loaded runtime config stores the same endpoint string.

**Call relations**: The test runner invokes this test. It verifies both TOML deserialization and the later conversion into `Config` through `Config::load_from_base_config_with_overrides`.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_base_url_loads_from_config_toml`  (lines 10531–10564)

```
async fn experimental_realtime_ws_base_url_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that experimental realtime websocket and WebRTC call base URLs are loaded from config. These URLs tell realtime features where to connect.

**Data flow**: The test parses TOML with `experimental_realtime_ws_base_url` and `experimental_realtime_webrtc_call_base_url`. Both strings appear in the raw config. After full config loading, both strings are still present in the runtime config.

**Call relations**: The test runner calls this test. It uses in-memory TOML parsing followed by `Config::load_from_base_config_with_overrides` to check both stages of config processing.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_backend_prompt_loads_from_config_toml`  (lines 10567–10593)

```
async fn experimental_realtime_ws_backend_prompt_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that an experimental backend prompt for realtime websocket sessions is read from config. This allows changing the backend prompt without changing code.

**Data flow**: The test parses a TOML string for `experimental_realtime_ws_backend_prompt`. The raw config contains it. The final loaded config contains the same prompt text.

**Call relations**: The test runner invokes this test. It verifies the value survives both TOML deserialization and conversion into the runtime `Config`.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_startup_context_loads_from_config_toml`  (lines 10596–10622)

```
async fn experimental_realtime_ws_startup_context_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that experimental realtime websocket startup context is loaded from config. Startup context is extra text or state supplied when a realtime session begins.

**Data flow**: The test parses a TOML value for `experimental_realtime_ws_startup_context`. It then loads full config from that parsed base config. The runtime config contains the same startup-context string.

**Call relations**: The test runner calls this test. It uses `toml::from_str` and `Config::load_from_base_config_with_overrides` to confirm the value passes through both config stages.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `experimental_realtime_ws_model_loads_from_config_toml`  (lines 10625–10651)

```
async fn experimental_realtime_ws_model_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that an experimental realtime websocket model name is loaded from config. This lets experimental sessions select a model through configuration.

**Data flow**: The test parses TOML with `experimental_realtime_ws_model = "realtime-test-model"`. The raw config and the final runtime config both contain that model name.

**Call relations**: The test runner invokes this test. It checks parsing first, then uses `Config::load_from_base_config_with_overrides` to check the final config field.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_config_partial_table_uses_realtime_defaults`  (lines 10654–10679)

```
async fn realtime_config_partial_table_uses_realtime_defaults() -> std::io::Result<()>
```

**Purpose**: Checks that a partial `[realtime]` table fills in unspecified fields with realtime defaults. This lets users set only the one realtime option they care about.

**Data flow**: The test parses TOML where only `voice = "marin"` is set under `[realtime]`. It loads config. The resulting realtime config has voice set to Marin and all other realtime fields set to their defaults.

**Call relations**: The test runner calls this test. It uses `Config::load_from_base_config_with_overrides` to verify default-filling during conversion from parsed TOML to runtime config.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_loads_from_config_toml`  (lines 10682–10725)

```
async fn realtime_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that the full realtime configuration table is parsed and applied. This covers architecture, protocol version, session type, transport, and voice.

**Data flow**: The test parses a `[realtime]` table with values like `avas`, `v2`, `transcription`, `webrtc`, and `cedar`. Raw parsing maps those strings into enum values. Full config loading produces a `RealtimeConfig` with the same selected options.

**Call relations**: The test runner invokes this test. It first validates TOML deserialization into `RealtimeToml`, then checks conversion into the runtime `RealtimeConfig`.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `realtime_audio_loads_from_config_toml`  (lines 10728–10759)

```
async fn realtime_audio_loads_from_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that audio device names for realtime features are loaded from config. These settings identify the microphone and speaker the app should use.

**Data flow**: The test parses an `[audio]` table with `microphone = "USB Mic"` and `speaker = "Desk Speakers"`. It verifies the parsed audio config, then loads full config. The runtime realtime-audio config contains the same device names.

**Call relations**: The test runner calls this test. It uses the raw parse to confirm the table shape and `Config::load_from_base_config_with_overrides` to confirm the final runtime fields.

*Call graph*: 5 external calls (new, load_from_base_config_with_overrides, assert_eq!, default, from_str).


##### `test_tui_notifications_true`  (lines 10773–10783)

```
fn test_tui_notifications_true()
```

**Purpose**: Checks that terminal user interface notifications can be enabled with a simple boolean. This supports the compact config form `notifications = true`.

**Data flow**: The test parses a small TOML snippet with `[tui] notifications = true`. The parsed test root stores notifications as `Notifications::Enabled(true)`.

**Call relations**: The test runner invokes this test. It uses `toml::from_str` directly and checks the parsed notification setting with `assert_matches!`.

*Call graph*: 2 external calls (assert_matches!, from_str).


##### `test_tui_notifications_custom_array`  (lines 10786–10796)

```
fn test_tui_notifications_custom_array()
```

**Purpose**: Checks that terminal notifications can also be configured as a custom list. This supports a richer config form than a simple on/off switch.

**Data flow**: The test parses TOML with `[tui] notifications = ["foo"]`. The parsed value becomes `Notifications::Custom` containing the string `foo`.

**Call relations**: The test runner calls this test. It focuses only on TOML deserialization into the test root structure and uses pattern matching to verify the custom-list variant.

*Call graph*: 2 external calls (assert_matches!, from_str).


##### `test_tui_notification_method`  (lines 10799–10807)

```
fn test_tui_notification_method()
```

**Purpose**: Checks that the terminal notification method string `bel` maps to the bell notification method. The bell is the terminal's audible or visual alert.

**Data flow**: The test parses TOML with `notification_method = "bel"`. The parsed notification settings contain `NotificationMethod::Bel`.

**Call relations**: The test runner invokes this test. It uses `toml::from_str` to exercise the deserializer for TUI notification method values.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_defaults_to_unfocused`  (lines 10810–10820)

```
fn test_tui_notification_condition_defaults_to_unfocused()
```

**Purpose**: Checks the default condition for terminal notifications. If the user does not say otherwise, notifications should happen when the interface is unfocused.

**Data flow**: The test parses a TOML snippet with only an empty `[tui]` table. The parsed notification condition is `NotificationCondition::Unfocused`.

**Call relations**: The test runner calls this test. It verifies default values created during TOML deserialization of the TUI notification settings.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_always`  (lines 10823–10834)

```
fn test_tui_notification_condition_always()
```

**Purpose**: Checks that users can configure terminal notifications to happen always. This confirms the `notification_condition = "always"` string is accepted.

**Data flow**: The test parses TOML with `notification_condition = "always"`. The parsed condition becomes `NotificationCondition::Always`.

**Call relations**: The test runner invokes this test. It uses `toml::from_str` to check that the condition enum accepts the documented string value.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `test_tui_notification_condition_rejects_unknown_value`  (lines 10837–10850)

```
fn test_tui_notification_condition_rejects_unknown_value()
```

**Purpose**: Checks that an unknown terminal notification condition is rejected with a useful error. This prevents misspelled config values from being silently ignored.

**Data flow**: The test tries to parse TOML with `notification_condition = "background"`. Parsing fails. The error text mentions the unknown value and lists the accepted values, including `unfocused` and `always`.

**Call relations**: The test runner calls this test. Unlike the successful parsing tests, this one expects `toml::from_str` to return an error and then inspects the message.

*Call graph*: 1 external calls (assert!).


### Configuration loading and managed policy resolution
These tests move from end-to-end config loading into the higher-level policy and feature decisions derived from layered config, managed requirements, and startup migrations or warnings.

### `core/src/config/config_loader_tests.rs`

`test` · `test run`

Codex gets its settings from many places: a user config file, project-local `.codex` folders, command-line overrides, managed enterprise files, macOS managed preferences, cloud-provided bundles, and policy requirement files. This test file makes sure those layers behave like a predictable stack of transparent sheets: higher sheets can cover lower ones, but only when they are allowed to. Without these tests, a small change in config loading could silently let an untrusted project change dangerous settings, ignore an enterprise restriction, report confusing errors, or resolve a relative path from the wrong folder.

The tests create temporary folders and tiny TOML files. TOML is the human-readable config format used here. They then call the real config loader and assert the final merged settings, the layer order, the warning messages, and the policy restrictions. Many tests focus on trust: project config should only affect Codex when the project has been marked trusted. Others check enterprise requirements, permission profiles, hooks, filesystem deny rules, cloud bundles, and execution policy rules. A few small helper functions reduce repeated setup, such as writing a trusted-project user config or building a fake Git worktree.

#### Function details

##### `config_error_from_io`  (lines 46–51)

```
fn config_error_from_io(err: &std::io::Error) -> &ConfigError
```

**Purpose**: Pulls the structured configuration error out of a general input/output error. Tests use it when the public loader reports failures through `std::io::Error`, but the test needs to compare the exact config error inside.

**Data flow**: It receives an I/O error, looks inside the wrapped error for a `ConfigLoadError`, then returns the contained `ConfigError`. If the expected error is not there, the test fails immediately.

**Call relations**: Several error-reporting tests call this after config loading fails, so they can compare the actual detailed error with the expected TOML or schema error.

*Call graph*: called by 5 (returns_config_error_for_invalid_managed_config_toml, returns_config_error_for_invalid_user_config_toml, returns_config_error_for_schema_error_in_user_config, strict_config_rejects_unknown_feature_user_config_key, strict_config_rejects_unknown_user_config_key); 1 external calls (get_ref).


##### `cloud_config_bundle_requirement_source`  (lines 53–58)

```
fn cloud_config_bundle_requirement_source() -> RequirementSource
```

**Purpose**: Creates the standard fake source label used for cloud-managed requirement tests. This lets tests compare not only the restriction value, but also who imposed it.

**Data flow**: It takes no input and returns a `RequirementSource::EnterpriseManaged` with fixed test id and name.

**Call relations**: Cloud requirement tests call this when checking that a rejected setting points back to the cloud bundle rather than some other policy layer.

*Call graph*: called by 1 (system_remote_sandbox_config_keeps_cloud_sandbox_modes).


##### `load_single_requirements_toml`  (lines 60–67)

```
async fn load_single_requirements_toml(
    requirements_file: &AbsolutePathBuf,
) -> anyhow::Result<ConfigRequirementsWithSources>
```

**Purpose**: Loads one `requirements.toml` file and composes it into the same combined requirement form used by the real loader. It keeps tests focused on requirement behavior without repeating boilerplate.

**Data flow**: It receives the absolute path to a requirements file, reads and parses it through the real loader, wraps it as a one-layer requirements stack, and returns the composed requirements with source information.

**Call relations**: Requirement parsing tests call this helper before checking approval policies, web search rules, residency rules, and filesystem deny path resolution.

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

**Purpose**: Writes a minimal user `config.toml` that marks a project with a chosen trust level. Many project-layer tests need this setup before project-local config is allowed to take effect.

**Data flow**: It receives a Codex home folder, a project path, a trust level, and optional project-root marker names. It serializes those values into TOML and writes the user config file. Its output is success or an I/O error.

**Call relations**: Project trust, project layer ordering, worktree, and MCP-server tests call this to create the user-side trust record that the loader later reads.

*Call graph*: called by 15 (cli_override_can_update_project_local_mcp_server_when_project_is_trusted, cli_overrides_with_relative_paths_do_not_break_trust_check, codex_home_within_project_tree_is_not_double_loaded, invalid_project_config_ignored_when_untrusted_or_unknown, linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml, nested_project_root_markers_do_not_redirect_regular_repo_hooks, project_layer_ignores_unsupported_config_keys, project_layer_is_added_when_dot_codex_exists_without_config_toml, project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown (+5 more)); 6 external calls (default, from, join, to_string_lossy, write, to_string).


##### `write_linked_worktree_pointer`  (lines 92–103)

```
async fn write_linked_worktree_pointer(
    repo_root: &Path,
    worktree_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Creates the small `.git` pointer file that makes a folder look like a linked Git worktree. This lets tests check Codex behavior in Git worktrees without needing a real Git command.

**Data flow**: It receives the main repository root and the worktree root, creates a fake `.git/worktrees/feature-x` directory in the repo, and writes a `gitdir:` pointer inside the worktree. It returns success or an I/O error.

**Call relations**: The linked-worktree tests call this before loading config, so the loader can discover the relationship between a worktree and its main repository.

*Call graph*: called by 2 (linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml); 4 external calls (join, format!, create_dir_all, write).


##### `write_project_hook_config`  (lines 105–129)

```
async fn write_project_hook_config(
    dot_codex_folder: &Path,
    foo: Option<&str>,
    command: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a project-local config file containing a simple hook command, plus an optional test marker field. Hooks are commands Codex may run around tool use, so tests must verify where they are loaded from.

**Data flow**: It receives a `.codex` folder, an optional `foo` value, and a hook command. It creates the folder and writes a TOML config with a `PreToolUse` hook. It returns success or an I/O error.

**Call relations**: Worktree and nested-project tests call this to set up competing hook configs, then inspect which hook command the loader chose.

*Call graph*: called by 3 (linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks, linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml, nested_project_root_markers_do_not_redirect_regular_repo_hooks); 4 external calls (join, format!, create_dir_all, write).


##### `cli_overrides_resolve_relative_paths_against_cwd`  (lines 132–153)

```
async fn cli_overrides_resolve_relative_paths_against_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that relative paths supplied by command-line config overrides are interpreted from the current working directory. This prevents a path like `run-logs` from accidentally being placed under Codex home.

**Data flow**: The test creates temporary Codex home and working directories, builds a config with a relative `log_dir` override, and verifies the final log directory equals that relative path resolved against the working directory.

**Call relations**: The async test runner invokes it directly; it exercises `ConfigBuilder` and `AbsolutePathBuf::resolve_path_against_base`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 5 external calls (default, assert_eq!, default, tempdir, vec!).


##### `returns_config_error_for_invalid_user_config_toml`  (lines 156–179)

```
async fn returns_config_error_for_invalid_user_config_toml()
```

**Purpose**: Checks that malformed user TOML produces the same detailed config error the TOML parser would produce. This matters because users need useful file and parse feedback.

**Data flow**: The test writes broken TOML to the user config file, calls the layer loader, extracts the inner config error, builds the expected parse error, and compares them.

**Call relations**: The test runner invokes it; it calls `load_config_layers_state` and then uses `config_error_from_io` to inspect the failure.

*Call graph*: calls 3 internal fn (load_config_layers_state, config_error_from_io, try_from); 5 external calls (assert_eq!, config_error_from_toml, default, write, tempdir).


##### `ignore_user_config_keeps_empty_user_layer`  (lines 182–215)

```
async fn ignore_user_config_keeps_empty_user_layer() -> std::io::Result<()>
```

**Purpose**: Verifies that asking the loader to ignore the user config still leaves an empty user layer in the layer stack. This preserves metadata while preventing bad user settings from affecting the result.

**Data flow**: It writes an invalid user config, loads with `ignore_user_config`, then checks that the user layer exists, contains an empty table, and does not contribute its `model` value.

**Call relations**: The test runner invokes it; it focuses on `load_config_layers_state` behavior under a loader override.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 4 external calls (default, assert_eq!, write, tempdir).


##### `ignore_rules_marks_config_stack_for_exec_policy_rule_skip`  (lines 218–237)

```
async fn ignore_rules_marks_config_stack_for_exec_policy_rule_skip() -> std::io::Result<()>
```

**Purpose**: Checks that a loader option to ignore user and project execution-policy rules is recorded in the final layer stack. Execution policy rules decide whether commands are allowed, forbidden, or need approval.

**Data flow**: It loads config with the ignore flag enabled and then reads the resulting stack flag to ensure it is set.

**Call relations**: The test runner invokes it; later execution-policy loading can use this flag to skip those rule sources.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 3 external calls (default, assert!, tempdir).


##### `returns_config_error_for_invalid_managed_config_toml`  (lines 240–266)

```
async fn returns_config_error_for_invalid_managed_config_toml()
```

**Purpose**: Checks that malformed managed configuration reports a precise config error. Managed config usually comes from an administrator, so failures must be clear and fail safely.

**Data flow**: It writes invalid TOML to a fake managed config path, loads with that managed path, extracts the config error, and compares it with the expected TOML parse error.

**Call relations**: The test runner invokes it; it uses `LoaderOverrides::with_managed_config_path_for_tests` and `config_error_from_io`.

*Call graph*: calls 4 internal fn (load_config_layers_state, with_managed_config_path_for_tests, config_error_from_io, try_from); 4 external calls (assert_eq!, config_error_from_toml, write, tempdir).


##### `returns_config_error_for_schema_error_in_user_config`  (lines 269–288)

```
async fn returns_config_error_for_schema_error_in_user_config()
```

**Purpose**: Checks that syntactically valid TOML with the wrong value type is reported as a structured schema error. For example, a number setting written as text should point to the bad field.

**Data flow**: It writes a user config where `model_context_window` is a string, builds config, extracts the inner config error, and compares it with the expected typed-TOML error.

**Call relations**: The test runner invokes it; it exercises `ConfigBuilder` and uses `config_error_from_io` to inspect the builder failure.

*Call graph*: calls 2 internal fn (config_error_from_io, new); 4 external calls (assert_eq!, default, write, tempdir).


##### `top_level_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy`  (lines 291–315)

```
async fn top_level_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy() -> std::io::Result<()>
```

**Purpose**: Ensures a user-level config key named `allow_managed_hooks_only` does not accidentally become an enterprise requirements policy. This prevents ordinary user config from imposing managed-hook restrictions.

**Data flow**: It writes the key at the top level of user config, loads layers, and checks that both raw and converted requirements have no `allow_managed_hooks_only` value.

**Call relations**: The test runner invokes it; it calls the layer loader and inspects the requirements portion of the result.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 5 external calls (assert!, assert_eq!, default, write, tempdir).


##### `hooks_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy`  (lines 318–356)

```
async fn hooks_allow_managed_hooks_only_in_user_config_does_not_enable_requirements_policy() -> std::io::Result<()>
```

**Purpose**: Ensures the same managed-hook-only flag inside a user `[hooks]` section remains just user hook config, not an enterprise requirement. This separates personal hook settings from enforceable policy.

**Data flow**: It writes a user hook config with `allow_managed_hooks_only`, loads layers, confirms the hook config is present, and confirms no requirements policy was enabled.

**Call relations**: The test runner invokes it; it verifies the boundary between normal config loading and requirements loading.

*Call graph*: calls 2 internal fn (load_config_layers_state, try_from); 5 external calls (assert!, assert_eq!, default, write, tempdir).


##### `strict_config_rejects_unknown_user_config_key`  (lines 359–380)

```
async fn strict_config_rejects_unknown_user_config_key()
```

**Purpose**: Checks that strict config mode rejects unknown keys in the user config file. Strict mode helps catch typos instead of silently ignoring them.

**Data flow**: It writes a config with `unknown_key`, builds with strict mode, expects failure, extracts the structured config error, and compares it with the expected unknown-field error.

**Call relations**: The test runner invokes it; it uses `ConfigBuilder` with managed config disabled and `config_error_from_io` for comparison.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, config_error_from_io); 4 external calls (assert_eq!, default, write, tempdir).


##### `strict_config_rejects_unknown_cli_override_key`  (lines 383–403)

```
async fn strict_config_rejects_unknown_cli_override_key()
```

**Purpose**: Checks that strict mode also rejects unknown command-line override keys. This catches mistakes in `-c/--config` arguments.

**Data flow**: It builds config with a CLI override named `foo`, expects an error, and checks the message names the bad override key.

**Call relations**: The test runner invokes it; it exercises `ConfigBuilder` validation for CLI-provided settings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `strict_config_rejects_unknown_cli_override_key_with_relative_path_override`  (lines 406–431)

```
async fn strict_config_rejects_unknown_cli_override_key_with_relative_path_override()
```

**Purpose**: Ensures strict-mode validation still reports an unknown CLI key even when another CLI override needs relative-path resolution. This guards against path preprocessing hiding validation errors.

**Data flow**: It creates an instructions file, supplies a valid relative-path override plus an invalid `foo` override, builds config in strict mode, and checks the reported error.

**Call relations**: The test runner invokes it; it verifies ordering between CLI path handling and strict key checking.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, default, write, tempdir, vec!).


##### `strict_config_rejects_unknown_feature_cli_override_key`  (lines 434–451)

```
async fn strict_config_rejects_unknown_feature_cli_override_key()
```

**Purpose**: Checks that strict mode rejects unknown nested feature overrides like `features.foo`. Feature flags are nested settings, so typo detection must work there too.

**Data flow**: It builds with a CLI override for `features.foo`, expects failure, and checks the error message includes the full nested key.

**Call relations**: The test runner invokes it; it exercises nested CLI override validation in `ConfigBuilder`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `strict_config_rejects_unknown_feature_user_config_key`  (lines 454–477)

```
async fn strict_config_rejects_unknown_feature_user_config_key()
```

**Purpose**: Checks that strict mode reports unknown feature keys from user config with a useful location. This helps users fix the exact line and column.

**Data flow**: It writes `[features] foo = true`, builds in strict mode, extracts the config error, and checks both the message and the reported source position.

**Call relations**: The test runner invokes it; it uses `config_error_from_io` after `ConfigBuilder` fails.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, config_error_from_io); 4 external calls (assert_eq!, default, write, tempdir).


##### `strict_config_points_to_unknown_nested_key`  (lines 480–497)

```
fn strict_config_points_to_unknown_nested_key()
```

**Purpose**: Verifies that unknown keys deep inside nested tables are reported with their full path. This avoids vague errors when a config has many sections.

**Data flow**: It writes an `mcp_servers.local` table with an extra key, asks the ignored-field checker for an error, and checks the message and position.

**Call relations**: The test runner invokes it; it directly tests the helper that builds unknown-field config errors.

*Call graph*: 3 external calls (assert_eq!, write, tempdir).


##### `schema_error_points_to_feature_value`  (lines 499–514)

```
fn schema_error_points_to_feature_value()
```

**Purpose**: Checks that a type error inside the `[features]` table points at the wrong value, not just the table. Good error locations make config fixes faster.

**Data flow**: It writes a feature value with the wrong type, asks the typed TOML checker for an error, computes where the bad string starts, and compares the reported position.

**Call relations**: The test runner invokes it; it directly tests typed TOML error location reporting.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, write, tempdir).


##### `merges_managed_config_layer_on_top`  (lines 517–567)

```
async fn merges_managed_config_layer_on_top()
```

**Purpose**: Checks that managed config overrides user config where they both set the same keys. This enforces administrator settings over local choices.

**Data flow**: It writes user and managed config files with overlapping nested values, loads the stack, and confirms the effective config uses the managed values while preserving managed-only extra values.

**Call relations**: The test runner invokes it; it calls `load_config_layers_state` with a fake managed config path.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 3 external calls (assert_eq!, write, tempdir).


##### `returns_empty_when_all_layers_missing`  (lines 570–629)

```
async fn returns_empty_when_all_layers_missing()
```

**Purpose**: Checks that missing config files produce an empty but well-formed config stack rather than an error. Codex should start cleanly with no config files.

**Data flow**: It points the loader at absent user and managed config files, then checks that the user layer is an empty table, the effective config is empty where expected, and a system layer still exists.

**Call relations**: The test runner invokes it; it verifies the loader’s default layer construction.

*Call graph*: calls 5 internal fn (load_config_layers_state, new, with_managed_config_path_for_tests, resolve_path_against_base, try_from); 5 external calls (Table, assert!, assert_eq!, tempdir, new).


##### `selected_user_config_file_layers_over_base_user_config`  (lines 632–700)

```
async fn selected_user_config_file_layers_over_base_user_config()
```

**Purpose**: Checks that a selected user config file can override the base user config while still inheriting lower-precedence values. This supports alternate user profiles.

**Data flow**: It writes a base config and a selected `work.config.toml`, loads with the selected path and profile name, then verifies the model comes from the selected file and another setting remains from the base file.

**Call relations**: The test runner invokes it; it inspects user-layer ordering returned by `load_config_layers_state`.

*Call graph*: calls 4 internal fn (load_config_layers_state, with_managed_config_path_for_tests, from_absolute_path, try_from); 3 external calls (assert_eq!, write, tempdir).


##### `includes_thread_config_layers_in_stack`  (lines 703–757)

```
async fn includes_thread_config_layers_in_stack() -> anyhow::Result<()>
```

**Purpose**: Checks that session or thread-specific config appears in the layer stack and can override command-line feature flags. A thread here means a running session context with its own settings.

**Data flow**: It loads config with a CLI feature override and a static session-thread config that sets the same feature differently, then checks layer sources and the final feature value.

**Call relations**: The test runner invokes it; it passes a `StaticThreadConfigLoader` into `load_config_layers_state`.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, new, from_absolute_path); 5 external calls (Boolean, assert_eq!, tempdir, create_dir_all, vec!).


##### `managed_preferences_take_highest_precedence`  (lines 761–827)

```
async fn managed_preferences_take_highest_precedence()
```

**Purpose**: On macOS, checks that managed preferences from device management override both user and managed config TOML. This supports enterprise controls delivered through macOS management.

**Data flow**: It writes user and managed files, supplies base64-encoded managed preferences, loads layers, and checks the managed-preferences values win and the raw TOML text is preserved.

**Call relations**: The macOS test runner invokes it; it exercises the highest-precedence managed-preferences layer.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `managed_preferences_expand_home_directory_in_workspace_write_roots`  (lines 831–876)

```
async fn managed_preferences_expand_home_directory_in_workspace_write_roots() -> anyhow::Result<()>
```

**Purpose**: On macOS, checks that `~` in managed writable-root paths expands to the user’s home directory. This makes administrator-provided workspace paths behave like shell paths.

**Data flow**: It supplies managed preferences for workspace-write mode with `~/code`, builds config, and checks the sandbox policy contains the absolute home-based path.

**Call relations**: The macOS test runner invokes it; it uses `ConfigBuilder` and then inspects the legacy sandbox policy.

*Call graph*: calls 2 internal fn (with_managed_config_path_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, home_dir, panic!, tempdir).


##### `managed_preferences_requirements_are_applied`  (lines 880–931)

```
async fn managed_preferences_requirements_are_applied() -> anyhow::Result<()>
```

**Purpose**: On macOS, checks that managed-preference requirements restrict approval policy and sandbox mode. These are enforceable rules, not just default settings.

**Data flow**: It supplies base64-encoded requirements allowing only `never` approval and read-only sandboxing, loads layers, and verifies other approval and sandbox choices are rejected.

**Call relations**: The macOS test runner invokes it; it inspects converted `ConfigRequirements` from `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `managed_preferences_requirements_take_precedence`  (lines 935–981)

```
async fn managed_preferences_requirements_take_precedence() -> anyhow::Result<()>
```

**Purpose**: On macOS, checks that managed-preference requirements override a managed config file that asks for a different approval policy. The stricter device-management rule should win.

**Data flow**: It writes a managed config requesting `on-request`, supplies managed requirements allowing only `never`, loads layers, and checks `never` is enforced.

**Call relations**: The macOS test runner invokes it; it compares managed config against managed requirements precedence.

*Call graph*: calls 3 internal fn (load_config_layers_state, with_managed_config_path_for_tests, try_from); 4 external calls (assert!, assert_eq!, tempdir, write).


##### `load_requirements_toml_produces_expected_constraints`  (lines 984–1073)

```
async fn load_requirements_toml_produces_expected_constraints() -> anyhow::Result<()>
```

**Purpose**: Checks that a requirements file turns into usable constraints for approval policy, web search mode, residency, and feature requirements. Constraints are rules that say which values are allowed.

**Data flow**: It writes a requirements file, loads it through the helper, checks the parsed raw fields, converts them to `ConfigRequirements`, and verifies allowed and disallowed values.

**Call relations**: The test runner invokes it; it relies on `load_single_requirements_toml` to exercise the real requirements loader.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert!, assert_eq!, tempdir, write).


##### `mdm_requirements_take_precedence_over_cloud_config_bundle`  (lines 1077–1127)

```
async fn mdm_requirements_take_precedence_over_cloud_config_bundle() -> anyhow::Result<()>
```

**Purpose**: On macOS, checks that mobile-device-management requirements override cloud-config-bundle requirements. Local enterprise device policy is treated as stronger.

**Data flow**: It supplies MDM requirements allowing `on-request` and a cloud bundle allowing `never`, loads layers, and verifies `never` is rejected with the MDM source named.

**Call relations**: The macOS test runner invokes it; it combines loader overrides with a cloud fixture.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_requirement, try_from); 3 external calls (default, assert_eq!, tempdir).


##### `cloud_config_bundle_are_not_overwritten_by_system_requirements`  (lines 1130–1172)

```
async fn cloud_config_bundle_are_not_overwritten_by_system_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that cloud-bundle requirements take precedence over system requirements when composed together. This protects centrally delivered enterprise policy from being weakened by lower layers.

**Data flow**: It loads a system requirements file allowing `on-request`, composes it with a cloud layer allowing `never`, and checks the final value and source are from the cloud layer.

**Call relations**: The test runner invokes it; it calls `load_requirements_toml` and `compose_requirements` directly.

*Call graph*: calls 2 internal fn (load_requirements_toml, try_from); 5 external calls (assert_eq!, compose_requirements, tempdir, write, vec!).


##### `system_remote_sandbox_config_keeps_cloud_sandbox_modes`  (lines 1175–1218)

```
async fn system_remote_sandbox_config_keeps_cloud_sandbox_modes() -> anyhow::Result<()>
```

**Purpose**: Checks that a system remote-sandbox rule does not broaden sandbox modes beyond cloud requirements. Remote sandbox config can match hosts, but cloud policy still controls allowed modes.

**Data flow**: It composes a system requirements layer containing remote sandbox modes with a cloud layer allowing only read-only, converts to runtime requirements, and confirms workspace-write is rejected with the cloud source.

**Call relations**: The test runner invokes it; it uses `cloud_config_bundle_requirement_source` for expected source comparison.

*Call graph*: calls 3 internal fn (load_requirements_toml, cloud_config_bundle_requirement_source, try_from); 5 external calls (assert_eq!, compose_requirements, tempdir, write, vec!).


##### `load_requirements_toml_resolves_deny_read_against_parent`  (lines 1221–1266)

```
async fn load_requirements_toml_resolves_deny_read_against_parent() -> anyhow::Result<()>
```

**Purpose**: Checks that relative filesystem deny-read paths in `requirements.toml` are resolved relative to the file’s folder. This keeps path restrictions anchored where the administrator wrote them.

**Data flow**: It writes deny-read entries such as `./sensitive` and `../shared/secret.txt`, loads the file, and compares the resulting absolute deny patterns and their source.

**Call relations**: The test runner invokes it; it uses `load_single_requirements_toml` for real parsing and path resolution.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `load_requirements_toml_resolves_deny_read_glob_against_parent`  (lines 1269–1315)

```
async fn load_requirements_toml_resolves_deny_read_glob_against_parent() -> anyhow::Result<()>
```

**Purpose**: Checks that relative glob patterns in deny-read rules are also resolved against the requirements file’s parent folder. A glob is a path pattern such as `**/*.txt`.

**Data flow**: It writes a deny-read glob, loads the requirements file, and checks the normalized pattern starts at the requirements directory.

**Call relations**: The test runner invokes it; it uses `load_single_requirements_toml` and compares the resulting `FilesystemDenyReadPattern`.

*Call graph*: calls 2 internal fn (load_single_requirements_toml, try_from); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `load_config_layers_includes_cloud_config_bundle`  (lines 1318–1360)

```
async fn load_config_layers_includes_cloud_config_bundle() -> anyhow::Result<()>
```

**Purpose**: Checks that cloud-provided requirements are included in the loaded config layers. This ensures enterprise cloud policy affects normal config loading.

**Data flow**: It creates a cloud fixture allowing only `never` approval, loads config layers, and verifies both the raw requirements and converted constraints reflect that cloud rule.

**Call relations**: The test runner invokes it; it passes a cloud bundle fixture into `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (default, assert_eq!, tempdir, create_dir_all, from_str).


##### `system_requirements_define_managed_permission_profiles`  (lines 1363–1414)

```
async fn system_requirements_define_managed_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Checks that system requirements can define named managed permission profiles and select one as the default. Permission profiles describe what filesystem and command access Codex may use.

**Data flow**: It writes user config choosing `managed-standard`, writes requirements defining and allowing that profile, builds config, and checks the active permission profile id.

**Call relations**: The test runner invokes it; it uses `ConfigBuilder` with a custom system requirements path.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_select_managed_default_without_local_default`  (lines 1417–1477)

```
async fn system_allowed_permission_profiles_select_managed_default_without_local_default() -> anyhow::Result<()>
```

**Purpose**: Checks that when requirements define a managed default permission profile, Codex selects it even if local config has no default. This is tested across trusted, untrusted, and unknown project trust states.

**Data flow**: For each trust case, it writes requirements with allowed managed profiles and a default, builds config, and verifies the active profile is `managed-standard` with no disallowed-profile warning.

**Call relations**: The test runner invokes it; it reuses `make_config_for_test` when a project trust entry is needed.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, make_config_for_test, from_absolute_path); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_require_managed_default`  (lines 1480–1514)

```
async fn system_allowed_permission_profiles_require_managed_default() -> anyhow::Result<()>
```

**Purpose**: Checks that requirements limiting allowed permission profiles must also provide a default unless both standard built-in choices are allowed. This prevents Codex from guessing an unsafe default.

**Data flow**: It writes requirements with one allowed managed profile but no default, builds config, expects failure, and checks the error explains the missing default.

**Call relations**: The test runner invokes it; it exercises validation inside `ConfigBuilder`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_standard_pair_defaults_to_workspace`  (lines 1517–1550)

```
async fn system_allowed_permission_profiles_standard_pair_defaults_to_workspace() -> anyhow::Result<()>
```

**Purpose**: Checks the special case where requirements allow both built-in read-only and workspace profiles without naming a default. In that case Codex should default to workspace permissions.

**Data flow**: It writes requirements allowing `:read-only` and `:workspace`, builds config, and checks the active profile is the built-in workspace profile.

**Call relations**: The test runner invokes it; it verifies default selection under system requirements.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_managed_default_must_be_allowed`  (lines 1553–1592)

```
async fn system_managed_default_must_be_allowed() -> anyhow::Result<()>
```

**Purpose**: Checks that a managed default permission profile must appear in the allowed profile list. A default outside the allowed list would contradict the policy.

**Data flow**: It writes requirements where `managed-build` is the default but only `managed-standard` is allowed, builds config, expects failure, and checks the error message.

**Call relations**: The test runner invokes it; it exercises permission-profile requirement validation.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_managed_default_requires_allowed_permission_profiles`  (lines 1595–1624)

```
async fn system_managed_default_requires_allowed_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Checks that setting `default_permissions` in requirements requires an accompanying allowed-profile list. This keeps managed defaults tied to an explicit policy boundary.

**Data flow**: It writes requirements with only `default_permissions`, builds config, expects failure, and checks the error mentions the missing allowed profiles.

**Call relations**: The test runner invokes it; it validates requirements consistency in `ConfigBuilder`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_fall_back_from_disallowed_danger_full_access`  (lines 1627–1680)

```
async fn system_allowed_permission_profiles_fall_back_from_disallowed_danger_full_access() -> anyhow::Result<()>
```

**Purpose**: Checks that if user config asks for dangerous full access but requirements disallow it, Codex falls back to the managed default and warns. This is a safety fallback.

**Data flow**: It writes user config requesting full access, writes requirements allowing only `managed-standard`, builds config, then checks the active profile and warning list.

**Call relations**: The test runner invokes it; it verifies user config is constrained by system requirements.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 7 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, write).


##### `system_allowed_permission_profiles_fall_back_from_disallowed_workspace`  (lines 1683–1734)

```
async fn system_allowed_permission_profiles_fall_back_from_disallowed_workspace() -> anyhow::Result<()>
```

**Purpose**: Checks the same fallback behavior when user config asks for the built-in workspace profile but policy allows only a managed profile.

**Data flow**: It writes user config requesting `:workspace`, writes requirements with managed default `managed-standard`, builds config, and checks Codex selects the managed default and warns.

**Call relations**: The test runner invokes it; it exercises disallowed local permission-profile handling.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `system_requirements_preserve_allowed_configured_permission_default`  (lines 1737–1786)

```
async fn system_requirements_preserve_allowed_configured_permission_default() -> anyhow::Result<()>
```

**Purpose**: Checks that if user config chooses a permission profile that requirements allow, Codex keeps that choice instead of replacing it with the managed default.

**Data flow**: It writes user config selecting `managed-build`, writes requirements allowing both `managed-build` and `managed-standard`, builds config, and checks the active profile remains `managed-build`.

**Call relations**: The test runner invokes it; it verifies requirements restrict choices without unnecessarily overriding valid local choices.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `system_requirements_warn_for_disallowed_explicit_permission_override`  (lines 1789–1837)

```
async fn system_requirements_warn_for_disallowed_explicit_permission_override() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicit harness override for a disallowed permission profile is replaced by the managed default and produces a warning. Harness overrides are test-time stand-ins for external runtime overrides.

**Data flow**: It writes requirements allowing only `managed-standard`, builds with an override requesting `managed-build`, and checks the active profile and warning.

**Call relations**: The test runner invokes it; it uses `ConfigBuilder` harness overrides plus system requirements.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, from_absolute_path); 7 external calls (assert!, assert_eq!, default, default, tempdir, create_dir_all, write).


##### `load_config_layers_inserts_cloud_config_between_system_and_user`  (lines 1840–1919)

```
async fn load_config_layers_inserts_cloud_config_between_system_and_user() -> anyhow::Result<()>
```

**Purpose**: Checks that enterprise cloud config sits above system config but below user config. This establishes who wins when multiple layers set the same key.

**Data flow**: It writes user and system config, supplies cloud config, loads layers, then checks merged values and the exact low-to-high layer order.

**Call relations**: The test runner invokes it; it calls `load_config_layers_state` with a cloud enterprise config fixture.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_config, from_absolute_path); 5 external calls (default, assert_eq!, tempdir, create_dir_all, write).


##### `load_config_layers_can_ignore_managed_requirements`  (lines 1922–1974)

```
async fn load_config_layers_can_ignore_managed_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that a testing override can ignore managed requirements while still loading other config. This is useful for tests or special modes that need to bypass enterprise constraints.

**Data flow**: It writes managed config and system requirements, supplies a cloud requirement, sets `ignore_managed_requirements`, builds config, and verifies an otherwise disallowed approval policy can be set.

**Call relations**: The test runner invokes it; it uses `ConfigBuilder` with both loader overrides and a cloud bundle.

*Call graph*: calls 3 internal fn (with_managed_config_path_for_tests, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (assert!, default, tempdir, create_dir_all, write).


##### `load_config_layers_includes_cloud_hook_requirements`  (lines 1977–2030)

```
async fn load_config_layers_includes_cloud_hook_requirements() -> anyhow::Result<()>
```

**Purpose**: Checks that hook requirements delivered by a cloud bundle are loaded and marked as managed. Managed hooks are administrator-supplied hook commands.

**Data flow**: It creates a managed hooks directory, builds cloud requirements containing a hook command and timeout, loads layers, and compares the raw hooks plus their requirement source.

**Call relations**: The test runner invokes it; it passes an enterprise requirement fixture into `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 6 external calls (default, assert_eq!, format!, tempdir, create_dir_all, from_str).


##### `load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home`  (lines 2033–2079)

```
async fn load_config_layers_resolves_relative_bundle_requirements_paths_against_codex_home() -> anyhow::Result<()>
```

**Purpose**: Checks that relative paths inside cloud-bundle requirements are resolved against Codex home. This gives remote policy a stable local base path.

**Data flow**: It supplies a cloud deny-read pattern `secrets/**`, loads layers with a specific Codex home, and verifies the pattern becomes an absolute path under that home.

**Call relations**: The test runner invokes it; it inspects the requirements TOML produced by `load_config_layers_state`.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_requirement, from_absolute_path); 4 external calls (default, assert_eq!, tempdir, create_dir_all).


##### `strict_config_rejects_unknown_cloud_config_key`  (lines 2082–2112)

```
async fn strict_config_rejects_unknown_cloud_config_key()
```

**Purpose**: Checks that strict mode also validates cloud config keys. Enterprise-delivered config should not contain silent typos either.

**Data flow**: It supplies cloud config with `unknown_key`, loads in strict mode, expects failure, and checks the error mentions the unknown field.

**Call relations**: The test runner invokes it; it calls `load_config_layers_state` with strict config enabled.

*Call graph*: calls 4 internal fn (load_config_layers_state, without_managed_config_for_tests, loader_with_enterprise_config, from_absolute_path); 3 external calls (assert!, tempdir, create_dir_all).


##### `load_config_layers_applies_matching_remote_sandbox_config`  (lines 2115–2159)

```
async fn load_config_layers_applies_matching_remote_sandbox_config() -> anyhow::Result<()>
```

**Purpose**: Checks that a matching remote sandbox configuration can loosen sandbox modes for remote environments as intended. The test uses a catch-all hostname pattern.

**Data flow**: It supplies cloud requirements with global read-only mode plus a remote sandbox override allowing workspace-write, loads layers, and confirms workspace-write is allowed in the final requirements.

**Call relations**: The test runner invokes it; it verifies remote-sandbox logic during requirements composition.

*Call graph*: calls 3 internal fn (load_config_layers_state, loader_with_enterprise_requirement, from_absolute_path); 5 external calls (default, assert!, assert_eq!, tempdir, create_dir_all).


##### `load_config_layers_fails_when_cloud_config_bundle_loader_fails`  (lines 2162–2192)

```
async fn load_config_layers_fails_when_cloud_config_bundle_loader_fails() -> anyhow::Result<()>
```

**Purpose**: Checks that if the cloud config bundle cannot be loaded, config loading fails closed instead of silently continuing. This avoids running without required enterprise policy.

**Data flow**: It supplies a cloud bundle loader that returns a request-failed error, calls the layer loader, and checks the resulting I/O error kind and message.

**Call relations**: The test runner invokes it; it uses a custom `CloudConfigBundleLoader` failure path.

*Call graph*: calls 4 internal fn (new, new, load_config_layers_state, from_absolute_path); 5 external calls (default, assert!, assert_eq!, tempdir, create_dir_all).


##### `project_layers_prefer_closest_cwd`  (lines 2195–2258)

```
async fn project_layers_prefer_closest_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that when both a project root and a nested folder have `.codex` configs, the config closest to the current working directory has higher precedence.

**Data flow**: It writes root and child project configs with different `foo` values, marks the project trusted, loads from the child directory, and checks layer order and final `foo` value.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 5 external calls (assert_eq!, default, tempdir, create_dir_all, write).


##### `linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks`  (lines 2261–2360)

```
async fn linked_worktree_project_layers_keep_worktree_config_but_use_root_repo_hooks() -> std::io::Result<()>
```

**Purpose**: Checks a subtle Git worktree behavior: config values come from the worktree’s `.codex` folders, while hook commands come from the main repository’s matching folders.

**Data flow**: It builds fake repo and worktree folder trees, writes different hook configs in each, marks the repo trusted, loads from the worktree child, and compares both config values and hook command folders.

**Call relations**: The test runner invokes it; it uses `write_linked_worktree_pointer`, `write_project_hook_config`, `make_config_for_test`, and `project_hook_command`.

*Call graph*: calls 5 internal fn (load_config_layers_state, make_config_for_test, write_linked_worktree_pointer, write_project_hook_config, from_absolute_path); 4 external calls (assert_eq!, default, tempdir, create_dir_all).


##### `linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml`  (lines 2363–2417)

```
async fn linked_worktree_project_layers_use_root_repo_hooks_without_worktree_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that a linked worktree can still use root-repository hooks even when the worktree `.codex` folder has no config file. This keeps hook discovery consistent for worktrees.

**Data flow**: It creates a fake worktree pointer, writes only a repo-root hook config, marks the repo trusted, loads from the worktree, and checks the project layer uses the repo hook command.

**Call relations**: The test runner invokes it; it uses the worktree and hook helper functions plus `project_hook_command`.

*Call graph*: calls 5 internal fn (load_config_layers_state, make_config_for_test, write_linked_worktree_pointer, write_project_hook_config, from_absolute_path); 4 external calls (assert_eq!, default, tempdir, create_dir_all).


##### `nested_project_root_markers_do_not_redirect_regular_repo_hooks`  (lines 2420–2495)

```
async fn nested_project_root_markers_do_not_redirect_regular_repo_hooks() -> std::io::Result<()>
```

**Purpose**: Checks that alternate project-root markers do not cause hooks from an outer regular Git repository to be used when a nested project root is intended. This prevents hook source confusion.

**Data flow**: It creates an outer Git repo, a nested `.hg` project root, and hook configs at several levels, marks the `.hg` project trusted, loads from a child folder, and verifies only nested/project hooks are used.

**Call relations**: The test runner invokes it; it uses `make_config_for_test`, `write_project_hook_config`, and `project_hook_command`.

*Call graph*: calls 4 internal fn (load_config_layers_state, make_config_for_test, write_project_hook_config, from_absolute_path); 6 external calls (assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `project_hook_command`  (lines 2497–2509)

```
fn project_hook_command(layer: &ConfigLayerEntry) -> Option<&str>
```

**Purpose**: Extracts the first project hook command from a config layer. It is a small test helper for checking which hook config actually won.

**Data flow**: It receives a config layer, walks through `hooks -> PreToolUse -> first hook -> command`, and returns the command string if every part exists.

**Call relations**: Worktree and nested-hook tests call this after loading layers to compare the selected hook command in plain string form.


##### `project_paths_resolve_relative_to_dot_codex_and_override_in_order`  (lines 2512–2565)

```
async fn project_paths_resolve_relative_to_dot_codex_and_override_in_order() -> std::io::Result<()>
```

**Purpose**: Checks that project-local relative paths are resolved from the `.codex` folder that declared them, and that closer project layers override farther ones.

**Data flow**: It writes root and child instruction files and configs pointing to them, marks the project trusted, builds config from the child, and verifies the child instructions are loaded.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `ConfigBuilder`.

*Call graph*: calls 1 internal fn (make_config_for_test); 6 external calls (assert_eq!, default, default, tempdir, create_dir_all, write).


##### `cli_override_model_instructions_file_sets_base_instructions`  (lines 2568–2601)

```
async fn cli_override_model_instructions_file_sets_base_instructions() -> std::io::Result<()>
```

**Purpose**: Checks that a command-line override for `model_instructions_file` is read and becomes the base instructions text. Base instructions are the starting guidance sent to the model.

**Data flow**: It writes an instruction file, passes its path as a CLI override, builds config, and checks `base_instructions` contains the file content.

**Call relations**: The test runner invokes it; it exercises CLI override handling in `ConfigBuilder`.

*Call graph*: 7 external calls (assert_eq!, default, default, tempdir, create_dir_all, write, vec!).


##### `inline_instructions_set_base_instructions`  (lines 2604–2625)

```
async fn inline_instructions_set_base_instructions() -> std::io::Result<()>
```

**Purpose**: Checks that inline `instructions` in user config directly become the base instructions. This is the simplest way to provide model guidance.

**Data flow**: It writes `instructions = "snapshot instructions"` to user config, builds config with managed config disabled, and checks `base_instructions` matches.

**Call relations**: The test runner invokes it; it exercises user config parsing through `ConfigBuilder`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, tempdir, create_dir_all, write).


##### `project_layer_is_added_when_dot_codex_exists_without_config_toml`  (lines 2628–2670)

```
async fn project_layer_is_added_when_dot_codex_exists_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that a project layer is still recorded when a `.codex` folder exists but has no config file. The folder itself is meaningful metadata.

**Data flow**: It creates a trusted project with an empty `.codex` folder, loads layers, and compares the project layer to an expected empty-table layer.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `load_config_layers_state`.

*Call graph*: calls 4 internal fn (load_config_layers_state, new, make_config_for_test, from_absolute_path); 7 external calls (Table, assert_eq!, default, tempdir, create_dir_all, write, new).


##### `codex_home_is_not_loaded_as_project_layer_from_home_dir`  (lines 2673–2712)

```
async fn codex_home_is_not_loaded_as_project_layer_from_home_dir() -> std::io::Result<()>
```

**Purpose**: Checks that the user’s Codex home `.codex` directory is not also treated as a project-local config when the working directory is the home directory. This avoids double-loading the same settings.

**Data flow**: It creates `home/.codex/config.toml`, loads with `home` as the current directory, confirms there are no project layers, and verifies the user config still applies.

**Call relations**: The test runner invokes it; it inspects both all layers and the effective config from `load_config_layers_state`.

*Call graph*: calls 2 internal fn (load_config_layers_state, from_absolute_path); 6 external calls (new, assert_eq!, default, tempdir, create_dir_all, write).


##### `codex_home_within_project_tree_is_not_double_loaded`  (lines 2715–2788)

```
async fn codex_home_within_project_tree_is_not_double_loaded() -> std::io::Result<()>
```

**Purpose**: Checks that if Codex home itself is inside a project tree, the user config is not also loaded as a project config. Only other project `.codex` folders should count.

**Data flow**: It creates a project root `.codex` used as Codex home and a nested `.codex` config, loads from the nested folder, and verifies only the nested project layer is present and wins.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and direct layer comparison.

*Call graph*: calls 4 internal fn (load_config_layers_state, new, make_config_for_test, from_absolute_path); 8 external calls (assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write, from_str).


##### `project_layers_disabled_when_untrusted_or_unknown`  (lines 2791–2909)

```
async fn project_layers_disabled_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Checks that project-local config is discovered but disabled when the project is untrusted or has unknown trust. This protects users from arbitrary repository settings.

**Data flow**: It creates a project config with a supported and unsupported key, loads once with untrusted project metadata and once with no trust metadata, then verifies the layer is disabled, unsupported keys are stripped, and user config wins.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` for the untrusted case and `load_config_layers_state` for both cases.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 8 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write).


##### `project_layer_ignores_unsupported_config_keys`  (lines 2912–3026)

```
async fn project_layer_ignores_unsupported_config_keys() -> std::io::Result<()>
```

**Purpose**: Checks that trusted project config can only set a safe subset of keys. Settings such as providers, notifications, profile selection, and telemetry are stripped and reported as warnings.

**Data flow**: It writes a project config with both supported and unsupported keys, marks the project trusted, loads layers, checks the warning text, confirms supported values remain, and confirms unsupported keys are absent.

**Call relations**: The test runner invokes it; it verifies project-config sanitization in `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 7 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `project_trust_does_not_match_configured_alias_for_canonical_cwd`  (lines 3030–3087)

```
async fn project_trust_does_not_match_configured_alias_for_canonical_cwd() -> std::io::Result<()>
```

**Purpose**: On Unix, checks that a trusted symlink alias does not automatically trust the canonical real project path. This prevents trust from being broadened by path normalization.

**Data flow**: It creates a project, symlinks an alias to it, stores trust for the alias, loads using the real path, and verifies the project layer is disabled and does not affect config.

**Call relations**: The Unix test runner invokes it; it uses filesystem symlinks and `load_config_layers_state`.

*Call graph*: calls 2 internal fn (load_config_layers_state, from_absolute_path); 10 external calls (default, from, assert!, assert_eq!, default, symlink, tempdir, create_dir_all, write, to_string).


##### `cli_override_can_update_project_local_mcp_server_when_project_is_trusted`  (lines 3090–3136)

```
async fn cli_override_can_update_project_local_mcp_server_when_project_is_trusted() -> std::io::Result<()>
```

**Purpose**: Checks that CLI overrides can modify an MCP server defined in trusted project config. MCP servers are external tool/service connections exposed to Codex.

**Data flow**: It writes a disabled project-local MCP server, marks the project trusted, passes a CLI override enabling it, builds config, and verifies the server is enabled.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `ConfigBuilder`.

*Call graph*: calls 1 internal fn (make_config_for_test); 6 external calls (assert!, default, tempdir, create_dir_all, write, vec!).


##### `cli_override_for_disabled_project_local_mcp_server_returns_invalid_transport`  (lines 3139–3178)

```
async fn cli_override_for_disabled_project_local_mcp_server_returns_invalid_transport() -> std::io::Result<()>
```

**Purpose**: Checks that the same CLI override fails when the project layer is not trusted, because the project-local MCP server transport details are not loaded. This prevents CLI overrides from reviving untrusted server definitions.

**Data flow**: It writes a disabled project-local MCP server but does not mark the project trusted, builds with an override enabling it, expects failure, and checks the error mentions invalid transport and the server key.

**Call relations**: The test runner invokes it; it exercises `ConfigBuilder` with an untrusted project layer.

*Call graph*: 6 external calls (assert!, default, tempdir, create_dir_all, write, vec!).


##### `invalid_project_config_ignored_when_untrusted_or_unknown`  (lines 3181–3263)

```
async fn invalid_project_config_ignored_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Checks that malformed project config does not fail startup when the project is untrusted or trust is unknown. Untrusted config should be ignored rather than allowed to break the user’s session.

**Data flow**: It writes invalid project TOML, then loads two cases: untrusted and unknown. In both, it checks the project layer is disabled and empty, while user config still applies.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` for the untrusted case and `load_config_layers_state` for both.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 8 external calls (assert!, assert_eq!, default, format!, tempdir, create_dir_all, read_to_string, write).


##### `project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown`  (lines 3266–3328)

```
async fn project_layer_without_config_toml_is_disabled_when_untrusted_or_unknown() -> std::io::Result<()>
```

**Purpose**: Checks that even an empty `.codex` project layer is marked disabled unless the project is trusted. Discovery and trust are tracked separately.

**Data flow**: It creates a project `.codex` folder with no config file, loops through untrusted, unknown, and trusted cases, and checks whether the resulting empty project layer is disabled as expected.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` when a trust level is configured.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 6 external calls (assert_eq!, default, format!, tempdir, create_dir_all, write).


##### `cli_overrides_with_relative_paths_do_not_break_trust_check`  (lines 3331–3365)

```
async fn cli_overrides_with_relative_paths_do_not_break_trust_check() -> std::io::Result<()>
```

**Purpose**: Checks that resolving relative paths from CLI overrides does not interfere with project trust detection. Path handling should not change whether a project is considered trusted.

**Data flow**: It creates a trusted project, supplies a relative `model_instructions_file` CLI override, loads layers, and expects success.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 5 external calls (default, tempdir, create_dir_all, write, vec!).


##### `project_root_markers_supports_alternate_markers`  (lines 3368–3432)

```
async fn project_root_markers_supports_alternate_markers() -> std::io::Result<()>
```

**Purpose**: Checks that users can configure project-root markers other than `.git`, such as `.hg`. This supports non-Git repositories or custom project layouts.

**Data flow**: It creates root and nested `.codex` configs under a `.hg` marker, writes user config naming `.hg` as a marker and trusting the root, loads from the child, and checks layer order and winning value.

**Call relations**: The test runner invokes it; it uses `make_config_for_test` and `load_config_layers_state`.

*Call graph*: calls 3 internal fn (load_config_layers_state, make_config_for_test, from_absolute_path); 6 external calls (assert_eq!, default, tempdir, create_dir_all, write, vec!).


##### `requirements_exec_policy_tests::tokens`  (lines 3458–3460)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Converts a short list of command token string slices into owned strings for execution-policy tests. A token is one part of a command, such as `git` or `push`.

**Data flow**: It receives a slice of string slices and returns a `Vec<String>` with the same words copied into owned strings.

**Call relations**: Execution-policy tests call this when building command inputs and expected matched prefixes.


##### `requirements_exec_policy_tests::panic_if_called`  (lines 3462–3464)

```
fn panic_if_called(_: &[String]) -> Decision
```

**Purpose**: Acts as a guard callback that fails the test if a policy falls back to its heuristic. The tests using it expect an explicit rule to match first.

**Data flow**: It receives command tokens but ignores them and panics immediately. It never returns normally.

**Call relations**: Execution-policy tests pass it into policy checks to prove the explicit rule path was used.

*Call graph*: 1 external calls (panic!).


##### `requirements_exec_policy_tests::config_stack_for_dot_codex_folder_with_requirements`  (lines 3466–3478)

```
fn config_stack_for_dot_codex_folder_with_requirements(
        dot_codex_folder: &Path,
        requirements: ConfigRequirements,
    ) -> ConfigLayerStack
```

**Purpose**: Builds a minimal config layer stack for execution-policy tests. It supplies a project `.codex` layer plus a prepared set of requirements.

**Data flow**: It receives a `.codex` folder path and requirements, converts the path to an absolute path, creates an empty project config layer, and returns a `ConfigLayerStack` containing that layer and those requirements.

**Call relations**: The async execution-policy loading tests call this before invoking `load_exec_policy`.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); 4 external calls (default, Table, default, vec!).


##### `requirements_exec_policy_tests::requirements_from_toml`  (lines 3480–3485)

```
fn requirements_from_toml(toml_str: &str) -> ConfigRequirements
```

**Purpose**: Parses requirement TOML text into runtime `ConfigRequirements` for execution-policy tests. It hides the source-wrapping step needed by the real requirements system.

**Data flow**: It receives TOML text, parses it into `ConfigRequirementsToml`, merges it into a source-aware requirements container with an unknown source, and converts it to runtime requirements.

**Call relations**: Execution-policy loading tests call this to create requirements that include inline command rules.

*Call graph*: 3 external calls (try_from, default, from_str).


##### `requirements_exec_policy_tests::parses_single_prefix_rule_from_raw_toml`  (lines 3488–3512)

```
fn parses_single_prefix_rule_from_raw_toml() -> anyhow::Result<()>
```

**Purpose**: Checks that a simple execution-policy prefix rule can be read from TOML. A prefix rule matches the beginning of a command, such as `rm`.

**Data flow**: It parses TOML containing one rule and compares the parsed structure with the expected rule object.

**Call relations**: The test runner invokes it; it tests TOML deserialization for `RequirementsExecPolicyToml`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::parses_multiple_prefix_rules_from_raw_toml`  (lines 3515–3556)

```
fn parses_multiple_prefix_rules_from_raw_toml() -> anyhow::Result<()>
```

**Purpose**: Checks that multiple execution-policy prefix rules, including an `any_of` token choice and a justification, parse correctly.

**Data flow**: It parses TOML with two rules and compares the result with the expected nested rule structures.

**Call relations**: The test runner invokes it; it exercises richer TOML deserialization for rule lists.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::converts_rules_toml_into_internal_policy_representation`  (lines 3559–3583)

```
fn converts_rules_toml_into_internal_policy_representation() -> anyhow::Result<()>
```

**Purpose**: Checks that parsed requirement rules become an executable policy that actually blocks a matching command.

**Data flow**: It parses a rule forbidding `rm`, converts it to a policy, checks the command `rm -rf /tmp`, and compares the resulting forbidden decision and matched rule.

**Call relations**: The test runner invokes it; it uses `tokens` and `panic_if_called` while testing `to_policy`.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::head_any_of_expands_into_multiple_program_rules`  (lines 3586–3621)

```
fn head_any_of_expands_into_multiple_program_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that an `any_of` choice in the first command position expands into separate program rules. This lets one rule match either `git status` or `hg status`.

**Data flow**: It parses a rule with `any_of = ["git", "hg"]`, converts it to a policy, checks both commands, and compares both results to prompt decisions.

**Call relations**: The test runner invokes it; it uses `tokens` and `panic_if_called` to verify both expanded matches.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `requirements_exec_policy_tests::missing_decision_is_rejected`  (lines 3624–3639)

```
fn missing_decision_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Checks that an execution-policy rule without a decision is invalid. Every rule must say whether it prompts or forbids.

**Data flow**: It parses TOML with a rule missing `decision`, tries to convert it to a policy, expects an error, and checks the error kind.

**Call relations**: The test runner invokes it; it tests validation in `RequirementsExecPolicyToml::to_policy`.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::allow_decision_is_rejected`  (lines 3642–3657)

```
fn allow_decision_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Checks that requirements execution-policy rules cannot use an `allow` decision. Requirements are meant to restrict or prompt, not grant new permission.

**Data flow**: It parses a rule with `decision = "allow"`, converts it, expects an error, and checks the specific rejection.

**Call relations**: The test runner invokes it; it tests policy conversion validation.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::empty_prefix_rules_is_rejected`  (lines 3660–3673)

```
fn empty_prefix_rules_is_rejected() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicit but empty prefix-rule list is invalid. An empty policy section would be ambiguous and likely a mistake.

**Data flow**: It parses TOML with `prefix_rules = []`, tries to convert it to a policy, expects an error, and checks the error type.

**Call relations**: The test runner invokes it; it tests execution-policy TOML validation.

*Call graph*: 2 external calls (assert!, from_str).


##### `requirements_exec_policy_tests::loads_requirements_exec_policy_without_rules_files`  (lines 3676–3705)

```
async fn loads_requirements_exec_policy_without_rules_files() -> anyhow::Result<()>
```

**Purpose**: Checks that inline execution-policy rules from requirements load even when there are no separate `.rules` files. Inline requirements should be enough to create a policy.

**Data flow**: It creates requirements with an inline rule forbidding `rm`, builds a minimal config stack, loads the execution policy, and verifies `rm` is forbidden.

**Call relations**: The async test runner invokes it; it uses `requirements_from_toml`, `config_stack_for_dot_codex_folder_with_requirements`, and `load_exec_policy`.

*Call graph*: calls 1 internal fn (load_exec_policy); 4 external calls (assert_eq!, config_stack_for_dot_codex_folder_with_requirements, requirements_from_toml, tempdir).


##### `requirements_exec_policy_tests::merges_requirements_exec_policy_with_file_rules`  (lines 3708–3759)

```
async fn merges_requirements_exec_policy_with_file_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that inline requirements rules and rules loaded from project rule files are combined. This lets policy come from both managed requirements and local rule files.

**Data flow**: It writes a `deny.rules` file forbidding `rm`, creates inline requirements prompting on `git push`, loads the execution policy, and verifies both commands match their expected decisions.

**Call relations**: The async test runner invokes it; it sets up rule files, builds a config stack, and calls `load_exec_policy`.

*Call graph*: calls 1 internal fn (load_exec_policy); 6 external calls (assert_eq!, config_stack_for_dot_codex_folder_with_requirements, requirements_from_toml, create_dir_all, write, tempdir).


### `core/src/config/auth_keyring_tests.rs`

`test` · `test run`

This is a small test file for a startup configuration decision: should authentication data be stored directly, or should it use a safer secrets backend such as the operating system’s keyring? Think of it like choosing whether to leave a spare key in a drawer or in a locked key safe. The choice is driven by the `secret_auth_storage` feature flag.

The main test builds fake configuration data instead of reading real files. First it turns `secret_auth_storage` on and confirms that the resolver chooses the `Secrets` backend. Then it turns the feature off and confirms that the resolver falls back to `Direct`. Finally, it adds a separate feature requirement saying that `secret_auth_storage` must be enabled, and confirms that this requirement overrides the plain config setting and again chooses `Secrets`.

The helper function `config_toml_load_result` wraps a plain `ConfigToml` value in the larger structure that the real resolver expects. That keeps the test focused on the decision being tested, while still giving the production function a realistic input shape.

#### Function details

##### `resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature`  (lines 14–61)

```
fn resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature() -> std::io::Result<()>
```

**Purpose**: This test proves that the authentication keyring backend follows the `secret_auth_storage` feature setting. It also checks that a feature requirement can force secret storage even when the user-facing config says the feature is off.

**Data flow**: It starts by creating in-memory configuration objects with `secret_auth_storage` set to true or false. Each config is wrapped into a load-result object, passed to the real backend resolver, and compared with the expected answer: `Secrets` when the feature is enabled or required, and `Direct` when it is disabled with no requirement.

**Call relations**: During the test, this function uses `config_toml_load_result` to build the same kind of input the production resolver expects. It then calls `resolve_bootstrap_auth_keyring_backend_kind`, the real decision-making function under test, and uses assertions to make sure the returned backend matches the intended startup behavior.

*Call graph*: calls 2 internal fn (new, from); 3 external calls (from, default, assert_eq!).


##### `config_toml_load_result`  (lines 63–79)

```
fn config_toml_load_result(
    config_toml: ConfigToml,
    feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<ConfigTomlLoadResult>
```

**Purpose**: This helper turns a simple test configuration into a realistic `ConfigTomlLoadResult`. It exists so the test can call the real resolver without having to load files from disk.

**Data flow**: It receives a `ConfigToml` object and optional feature requirements. It places those requirements into a `ConfigRequirements` value, builds a configuration layer stack around them, and returns a `ConfigTomlLoadResult` containing both the config and the stack. If building the stack fails, the error is returned to the test.

**Call relations**: The test calls this helper each time it wants to try a different configuration scenario. The helper does the setup work, then hands the finished load-result object back to the test so it can be passed into `resolve_bootstrap_auth_keyring_backend_kind`.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, new, default).


### `features/src/tests.rs`

`test` · `test suite`

A feature flag is a named switch that lets the project turn a capability on or off without deleting the code. This test file makes sure those switches behave predictably. That matters because a wrong default could quietly expose unfinished work, revive removed behavior, or ignore a user's configuration in a confusing way.

The tests read the feature definitions from the crate and compare them with the rules the project wants to enforce. For example, under-development features must be off by default, stable features may be on, and removed features should usually ignore configuration instead of coming back to life. The file also checks older names for features, called legacy aliases, so old config files keep mapping to the right modern feature or are safely ignored.

Several tests exercise how TOML configuration, the human-written config file format, is turned into feature settings. They verify that simple true-or-false entries and richer table-shaped entries both deserialize correctly where supported. Other tests check dependency normalization, such as enabling one feature automatically enabling another required feature. The last tests check warning messages for unstable features, so users get a clear notice only when they actually enabled incomplete features.

#### Function details

##### `under_development_features_are_disabled_by_default`  (lines 18–28)

```
fn under_development_features_are_disabled_by_default()
```

**Purpose**: Checks the project-wide rule that unfinished features must not start enabled. This prevents experimental work from surprising normal users.

**Data flow**: It reads every feature specification, looks for those marked under development, and compares each one's default setting with false. If any unfinished feature is enabled by default, the test fails with the feature key in the message.

**Call relations**: The Rust test runner calls this during the test suite. It relies on the central feature list and uses equality checks as its final gate.

*Call graph*: 2 external calls (assert_eq!, matches!).


##### `default_enabled_features_are_stable`  (lines 31–42)

```
fn default_enabled_features_are_stable()
```

**Purpose**: Checks that anything enabled by default is either stable or already removed for compatibility reasons. This keeps default behavior from depending on unfinished or risky features.

**Data flow**: It walks through all feature definitions, finds features whose default is on, and verifies their stage is stable or removed. A mismatch becomes a failed assertion.

**Call relations**: The test runner invokes it as an independent policy check over the shared feature registry.

*Call graph*: 1 external calls (assert!).


##### `use_legacy_landlock_is_deprecated_and_disabled_by_default`  (lines 45–48)

```
fn use_legacy_landlock_is_deprecated_and_disabled_by_default()
```

**Purpose**: Confirms that the old Landlock sandbox option is marked deprecated and does not turn on automatically.

**Data flow**: It reads the feature's stage and default state, then compares them with the expected deprecated and false values.

**Call relations**: This is a focused regression test called by the test runner to protect a known legacy feature's contract.

*Call graph*: 1 external calls (assert_eq!).


##### `use_linux_sandbox_bwrap_is_removed_and_disabled_by_default`  (lines 51–54)

```
fn use_linux_sandbox_bwrap_is_removed_and_disabled_by_default()
```

**Purpose**: Confirms that the old bubblewrap Linux sandbox feature is treated as removed and off by default.

**Data flow**: It reads the feature metadata and checks that the stage is removed and the default setting is false.

**Call relations**: The test runner uses this to ensure a removed feature cannot accidentally become active again.

*Call graph*: 1 external calls (assert_eq!).


##### `undo_is_removed_and_disabled_by_default`  (lines 57–60)

```
fn undo_is_removed_and_disabled_by_default()
```

**Purpose**: Checks that the old undo feature, represented by GhostCommit, remains removed and disabled.

**Data flow**: It asks the feature for its stage and default state, then asserts they match removed and false.

**Call relations**: This standalone test protects historical behavior from being unintentionally reintroduced.

*Call graph*: 1 external calls (assert_eq!).


##### `image_detail_original_is_removed_and_disabled_by_default`  (lines 63–66)

```
fn image_detail_original_is_removed_and_disabled_by_default()
```

**Purpose**: Verifies that the old original-image-detail feature is removed and not enabled by default.

**Data flow**: It reads the feature's metadata and checks for removed stage plus false default.

**Call relations**: The test runner calls it as one of several removed-feature checks.

*Call graph*: 1 external calls (assert_eq!).


##### `apply_patch_freeform_is_removed_and_disabled_by_default`  (lines 69–76)

```
fn apply_patch_freeform_is_removed_and_disabled_by_default()
```

**Purpose**: Ensures the freeform apply-patch feature is still recognized by name but remains removed and off.

**Data flow**: It checks the feature's stage, default state, and lookup from the text key apply_patch_freeform. The expected result is the removed feature, disabled by default.

**Call relations**: This combines metadata checking with key lookup, so the parser can still recognize old config names without enabling the removed behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_hooks_is_removed_and_disabled_by_default`  (lines 79–83)

```
fn plugin_hooks_is_removed_and_disabled_by_default()
```

**Purpose**: Checks that plugin hooks are a removed feature and are disabled by default while their old key is still known.

**Data flow**: It reads the feature metadata and asks the key lookup to resolve plugin_hooks. All results are compared with the expected removed, false, and matching feature values.

**Call relations**: The test runner uses this to guard both the feature table and the string-to-feature lookup.

*Call graph*: 1 external calls (assert_eq!).


##### `external_migration_is_removed_and_disabled_by_default`  (lines 86–93)

```
fn external_migration_is_removed_and_disabled_by_default()
```

**Purpose**: Verifies that external migration is removed, disabled, and still identifiable by its configuration key.

**Data flow**: It checks the feature's stage and default, then resolves external_migration through the key lookup. The assertions confirm the legacy key maps to the removed feature.

**Call relations**: This protects compatibility with old names while making sure the old feature cannot be enabled by default.

*Call graph*: 1 external calls (assert_eq!).


##### `removed_apps_mcp_path_override_shapes_are_ignored`  (lines 96–114)

```
fn removed_apps_mcp_path_override_shapes_are_ignored()
```

**Purpose**: Checks that old apps_mcp_path_override settings are accepted by the TOML reader but do not produce active feature entries.

**Data flow**: It parses two TOML snippets, one boolean-shaped and one table-shaped. Both become FeaturesToml values whose entry maps are expected to be empty.

**Call relations**: The test runner calls this to make sure old config files do not break parsing, while the removed option is ignored afterward.

*Call graph*: 1 external calls (assert_eq!).


##### `code_mode_only_requires_code_mode`  (lines 117–124)

```
fn code_mode_only_requires_code_mode()
```

**Purpose**: Confirms that turning on code_mode_only also turns on its required parent feature, code_mode.

**Data flow**: It starts from default features, enables CodeModeOnly, then normalizes dependencies. Afterward both CodeModeOnly and CodeMode should be enabled.

**Call relations**: This test exercises the dependency-normalization step that other feature-loading paths rely on after applying user settings.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `guardian_approval_is_stable_and_enabled_by_default`  (lines 127–132)

```
fn guardian_approval_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that guardian approval is considered stable and is on by default.

**Data flow**: It reads the feature information and compares its stage and default setting with stable and true.

**Call relations**: The test runner invokes this as a direct contract check for a named stable feature.

*Call graph*: 1 external calls (assert_eq!).


##### `request_permissions_is_under_development`  (lines 135–141)

```
fn request_permissions_is_under_development()
```

**Purpose**: Verifies that execution permission approvals are still under development and disabled by default.

**Data flow**: It reads the stage and default state for ExecPermissionApprovals and checks for under-development plus false.

**Call relations**: This supports the broader rule that incomplete permission features must stay opt-in.

*Call graph*: 1 external calls (assert_eq!).


##### `request_permissions_tool_is_under_development`  (lines 144–150)

```
fn request_permissions_tool_is_under_development()
```

**Purpose**: Verifies that the request-permissions tool feature is under development and off by default.

**Data flow**: It checks the feature metadata against the expected under-development stage and disabled default.

**Call relations**: The test runner uses it as a focused guard for this specific tool-related flag.

*Call graph*: 1 external calls (assert_eq!).


##### `terminal_resize_reflow_is_removed_and_enabled_by_default`  (lines 153–160)

```
fn terminal_resize_reflow_is_removed_and_enabled_by_default()
```

**Purpose**: Checks a special removed feature that still defaults to enabled. This preserves old behavior while marking the feature as no longer configurable in the usual way.

**Data flow**: It resolves the text key terminal_resize_reflow, then checks that the feature stage is removed and its default is true.

**Call relations**: This test documents an exception to the usual removed-and-disabled pattern and protects that compatibility decision.

*Call graph*: 1 external calls (assert_eq!).


##### `from_sources_ignores_removed_terminal_resize_reflow_feature_key`  (lines 163–180)

```
fn from_sources_ignores_removed_terminal_resize_reflow_feature_key()
```

**Purpose**: Ensures user config cannot disable the removed terminal resize reflow feature through its old key.

**Data flow**: It builds a TOML feature map setting terminal_resize_reflow to false, loads features from sources, and compares the result with defaults. The feature remains enabled because its default is true.

**Call relations**: This exercises the full feature-loading path, including source merging and defaulting, to confirm removed keys are ignored.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `tool_suggest_is_stable_and_enabled_by_default`  (lines 183–186)

```
fn tool_suggest_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that tool suggestions are stable and enabled for users by default.

**Data flow**: It reads ToolSuggest metadata and verifies stable stage and true default.

**Call relations**: The test runner calls it as a named guarantee for the tool suggestion feature.

*Call graph*: 1 external calls (assert_eq!).


##### `network_proxy_is_experimental_and_disabled_by_default`  (lines 189–199)

```
fn network_proxy_is_experimental_and_disabled_by_default()
```

**Purpose**: Verifies that the network proxy feature is recognized, experimental, and off unless explicitly enabled.

**Data flow**: It resolves the network_proxy key, checks that the stage is experimental, and confirms the default is false.

**Call relations**: This links key lookup with maturity metadata so config parsing and feature policy stay aligned.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tool_search_is_removed_and_disabled_by_default`  (lines 202–206)

```
fn tool_search_is_removed_and_disabled_by_default()
```

**Purpose**: Checks that the old tool search feature remains removed, disabled, and still recognizable by key.

**Data flow**: It reads the feature stage and default, then resolves tool_search from text. The expected values are removed, false, and the matching feature.

**Call relations**: The test runner uses this to guard old configuration compatibility without re-enabling removed behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `secret_auth_storage_defaults_to_windows_only`  (lines 209–216)

```
fn secret_auth_storage_defaults_to_windows_only()
```

**Purpose**: Checks that secret auth storage is stable and defaults on only when the code is running on Windows.

**Data flow**: It reads the feature stage, compares the default with the platform check for Windows, and verifies the config key maps to the feature.

**Call relations**: This protects a platform-specific default, where the expected result changes depending on the operating system running the tests.

*Call graph*: 1 external calls (assert_eq!).


##### `browser_controls_are_stable_and_enabled_by_default`  (lines 219–241)

```
fn browser_controls_are_stable_and_enabled_by_default()
```

**Purpose**: Confirms that several browser and computer-control features are stable, enabled, and mapped from their config keys.

**Data flow**: It checks InAppBrowser, BrowserUse, BrowserUseExternal, and ComputerUse. For each, it verifies the stage, default state, and text-key lookup.

**Call relations**: The test runner calls this grouped test to keep related browser-control feature definitions consistent.

*Call graph*: 1 external calls (assert_eq!).


##### `use_linux_sandbox_bwrap_is_a_removed_feature_key`  (lines 244–253)

```
fn use_linux_sandbox_bwrap_is_a_removed_feature_key()
```

**Purpose**: Confirms that old sandbox configuration keys still resolve to their corresponding legacy features.

**Data flow**: It resolves use_legacy_landlock and use_linux_sandbox_bwrap from text and expects the matching feature identifiers.

**Call relations**: This helps old config files remain understandable to the feature parser, even though the features themselves are deprecated or removed.

*Call graph*: 1 external calls (assert_eq!).


##### `image_generation_is_stable_and_enabled_by_default`  (lines 256–259)

```
fn image_generation_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that image generation is stable and enabled by default.

**Data flow**: It reads ImageGeneration metadata and compares it with stable and true.

**Call relations**: The test runner uses it as a simple guard for the default image-generation capability.

*Call graph*: 1 external calls (assert_eq!).


##### `image_generation_extension_is_under_development_and_disabled_by_default`  (lines 262–266)

```
fn image_generation_extension_is_under_development_and_disabled_by_default()
```

**Purpose**: Verifies that the image generation extension feature is unfinished, off by default, and recognized by its key.

**Data flow**: It checks ImageGenExt stage and default, then resolves imagegenext from text. The expected outcome is under-development, false, and the matching feature.

**Call relations**: This ties together the feature registry and key lookup for an under-development image feature.

*Call graph*: 1 external calls (assert_eq!).


##### `use_legacy_landlock_config_records_deprecation_notice`  (lines 269–288)

```
fn use_legacy_landlock_config_records_deprecation_notice()
```

**Purpose**: Checks that using the deprecated Landlock config records a warning-like usage note for later reporting.

**Data flow**: It builds a map with use_legacy_landlock set to true, applies it to default features, then collects legacy feature usages. The collected record must include the alias, feature, summary, and detailed advice.

**Call relations**: This exercises the configuration application path and the legacy-usage reporting path together, ensuring deprecated settings can be explained to users.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (new, assert_eq!).


##### `image_detail_original_is_a_removed_feature_key`  (lines 291–296)

```
fn image_detail_original_is_a_removed_feature_key()
```

**Purpose**: Confirms that the old image_detail_original key is still recognized as the removed ImageDetailOriginal feature.

**Data flow**: It sends the text key to the lookup function and checks that the result is the expected feature.

**Call relations**: This supports compatibility for old configuration names without making the removed feature active.

*Call graph*: 1 external calls (assert_eq!).


##### `js_repl_features_are_removed_feature_keys`  (lines 299–310)

```
fn js_repl_features_are_removed_feature_keys()
```

**Purpose**: Checks that both JavaScript REPL feature flags are removed, disabled, and still resolvable by their old keys.

**Data flow**: It verifies stage and default for JsRepl and JsReplToolsOnly, then checks js_repl and js_repl_tools_only key lookup results.

**Call relations**: The test runner uses this to protect a pair of related removed features and their old config names.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_call_mcp_elicitation_is_stable_and_enabled_by_default`  (lines 313–316)

```
fn tool_call_mcp_elicitation_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that tool-call MCP elicitation is stable and enabled by default.

**Data flow**: It reads the feature's stage and default setting and compares them with stable and true.

**Call relations**: This is a direct metadata check for a specific stable feature.

*Call graph*: 1 external calls (assert_eq!).


##### `auth_elicitation_is_under_development`  (lines 319–326)

```
fn auth_elicitation_is_under_development()
```

**Purpose**: Verifies that auth elicitation is under development, disabled by default, and available through its key.

**Data flow**: It checks the feature stage, default setting, and auth_elicitation key lookup. The expected result is under-development, false, and the matching feature.

**Call relations**: This keeps the feature registry and config-key parser in sync for an unfinished auth feature.

*Call graph*: 1 external calls (assert_eq!).


##### `mentions_v2_is_stable_and_enabled_by_default`  (lines 329–333)

```
fn mentions_v2_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that Mentions V2 is stable, on by default, and mapped from its config key.

**Data flow**: It reads metadata and resolves mentions_v2 from text, then asserts stable stage, true default, and matching lookup.

**Call relations**: The test runner calls it to guard the public behavior of the mentions feature.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_is_removed_and_disabled_by_default`  (lines 336–343)

```
fn remote_control_is_removed_and_disabled_by_default()
```

**Purpose**: Confirms that remote control is removed, disabled, and still recognized by its old key.

**Data flow**: It checks RemoteControl metadata and resolves remote_control from text. The expected values are removed, false, and the matching feature.

**Call relations**: This is one half of the remote-control removal tests; it checks metadata and lookup.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_config_is_ignored`  (lines 346–354)

```
fn remote_control_config_is_ignored()
```

**Purpose**: Ensures that setting remote_control in config does not enable the removed feature.

**Data flow**: It creates a config map with remote_control true, applies it to default features, and then checks that RemoteControl is still disabled.

**Call relations**: This complements the metadata test by exercising the actual apply-map path used when configuration is loaded.

*Call graph*: calls 1 internal fn (with_defaults); 2 external calls (new, assert_eq!).


##### `workspace_dependencies_is_stable_and_enabled_by_default`  (lines 357–364)

```
fn workspace_dependencies_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that workspace dependency support is stable, enabled, and recognized by its config key.

**Data flow**: It verifies the feature's stage and default, then resolves workspace_dependencies from text.

**Call relations**: The test runner uses it to protect a stable feature's registry entry and config spelling.

*Call graph*: 1 external calls (assert_eq!).


##### `telepathy_is_legacy_alias_for_chronicle`  (lines 367–372)

```
fn telepathy_is_legacy_alias_for_chronicle()
```

**Purpose**: Confirms that telepathy is an older name for the Chronicle feature.

**Data flow**: It checks Chronicle's stage and default, then resolves both chronicle and telepathy. Both names should point to Chronicle.

**Call relations**: This protects legacy alias behavior so older configs using telepathy still map to the modern feature.

*Call graph*: 1 external calls (assert_eq!).


##### `collab_is_legacy_alias_for_multi_agent`  (lines 375–378)

```
fn collab_is_legacy_alias_for_multi_agent()
```

**Purpose**: Confirms that collab and multi_agent are two names for the same collaboration feature.

**Data flow**: It resolves both text keys and expects both to return the Collab feature.

**Call relations**: This keeps old and new naming compatible in the feature lookup path.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_hooks_is_legacy_alias_for_hooks`  (lines 381–384)

```
fn codex_hooks_is_legacy_alias_for_hooks()
```

**Purpose**: Confirms that codex_hooks is an older alias for the hooks feature.

**Data flow**: It resolves hooks and codex_hooks from text and expects both to return CodexHooks.

**Call relations**: The test runner calls this to guard backward compatibility for hook-related configuration.

*Call graph*: 1 external calls (assert_eq!).


##### `multi_agent_is_stable_and_enabled_by_default`  (lines 387–390)

```
fn multi_agent_is_stable_and_enabled_by_default()
```

**Purpose**: Checks that the multi-agent collaboration feature is stable and enabled by default.

**Data flow**: It reads Collab metadata and verifies stable stage and true default.

**Call relations**: This is the status check that pairs with alias and dependency tests around multi-agent behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `enable_fanout_is_under_development`  (lines 393–396)

```
fn enable_fanout_is_under_development()
```

**Purpose**: Verifies that the fanout/spawn-CSV feature is still under development and off by default.

**Data flow**: It reads SpawnCsv stage and default and compares them with under-development and false.

**Call relations**: This sets the expected status for the later dependency test involving the same feature.

*Call graph*: 1 external calls (assert_eq!).


##### `enable_fanout_normalization_enables_multi_agent_one_way`  (lines 399–411)

```
fn enable_fanout_normalization_enables_multi_agent_one_way()
```

**Purpose**: Checks that enabling fanout automatically enables multi-agent support, but enabling multi-agent does not automatically enable fanout.

**Data flow**: It creates one default feature set, enables SpawnCsv, normalizes dependencies, and expects both SpawnCsv and Collab on. It creates another set, enables Collab, normalizes, and expects SpawnCsv to stay off.

**Call relations**: This exercises dependency normalization and proves the relationship is one-way, like needing a road to drive a bus but not needing a bus to have a road.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `apps_require_feature_flag_and_chatgpt_auth`  (lines 414–421)

```
fn apps_require_feature_flag_and_chatgpt_auth()
```

**Purpose**: Checks that apps are available only when both the Apps feature flag is enabled and ChatGPT authentication is present.

**Data flow**: It starts with default features and asks whether apps are enabled without auth. Then it enables Apps and checks the answer both without and with auth.

**Call relations**: This tests the combined decision function that gates apps on two conditions rather than the feature flag alone.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert!).


##### `from_sources_applies_base_profile_and_overrides`  (lines 424–458)

```
fn from_sources_applies_base_profile_and_overrides()
```

**Purpose**: Verifies that feature loading combines base config, profile config, dependencies, and explicit overrides in the right order.

**Data flow**: It builds base settings enabling plugins, profile settings enabling code_mode_only, and an override disabling web search requests. After loading from sources, it checks that plugins and code-mode-related features are enabled, removed features stay disabled, and the override wins for web search.

**Call relations**: This is a broad integration-style test for the main feature-loading pipeline.

*Call graph*: calls 1 internal fn (from_sources); 3 external calls (new, default, assert_eq!).


##### `from_sources_ignores_removed_image_detail_original_feature_key`  (lines 461–477)

```
fn from_sources_ignores_removed_image_detail_original_feature_key()
```

**Purpose**: Ensures that configuring the removed image_detail_original key has no effect.

**Data flow**: It builds FeaturesToml with image_detail_original set true, loads features from sources, and compares the result to defaults.

**Call relations**: This exercises the same loading path users rely on, confirming removed feature keys are ignored there.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_undo_feature_key`  (lines 480–493)

```
fn from_sources_ignores_removed_undo_feature_key()
```

**Purpose**: Ensures that the removed undo key does not change loaded feature settings.

**Data flow**: It creates a TOML feature map with undo true, loads from sources, and expects the final feature set to match defaults.

**Call relations**: The test runner uses this to prevent old undo configuration from reviving removed behavior.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_js_repl_feature_keys`  (lines 496–512)

```
fn from_sources_ignores_removed_js_repl_feature_keys()
```

**Purpose**: Ensures that old JavaScript REPL feature keys are ignored during feature loading.

**Data flow**: It builds a TOML map enabling js_repl and js_repl_tools_only, then loads features from sources. The final result must still equal default features.

**Call relations**: This confirms the full loader treats both removed JavaScript REPL keys as harmless old settings.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_apply_patch_freeform_feature_key`  (lines 515–529)

```
fn from_sources_ignores_removed_apply_patch_freeform_feature_key()
```

**Purpose**: Ensures that the removed apply_patch_freeform key cannot change the active feature set.

**Data flow**: It creates a TOML map setting apply_patch_freeform to true, runs the source loader, and expects the defaults unchanged.

**Call relations**: This connects the removed-feature policy to the actual configuration loading path.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `from_sources_ignores_removed_plugin_hooks_feature_key`  (lines 532–545)

```
fn from_sources_ignores_removed_plugin_hooks_feature_key()
```

**Purpose**: Ensures that the removed plugin_hooks key is ignored when loading features from config.

**Data flow**: It builds a TOML feature map with plugin_hooks true, loads features, and compares the final set with defaults.

**Call relations**: This protects users from old plugin hook settings changing runtime behavior.

*Call graph*: calls 2 internal fn (from_sources, from); 5 external calls (from, default, assert_eq!, default, default).


##### `multi_agent_v2_feature_config_deserializes_boolean_toggle`  (lines 548–561)

```
fn multi_agent_v2_feature_config_deserializes_boolean_toggle()
```

**Purpose**: Checks that multi_agent_v2 can be written as a simple true-or-false TOML setting.

**Data flow**: It parses a TOML snippet with multi_agent_v2 = true. The parsed object should report an entry enabling the feature and store the simple enabled form.

**Call relations**: This tests the TOML deserialization path for the compact configuration style.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `multi_agent_v2_feature_config_deserializes_table`  (lines 564–605)

```
fn multi_agent_v2_feature_config_deserializes_table()
```

**Purpose**: Checks that multi_agent_v2 can also be written as a detailed TOML table with extra settings.

**Data flow**: It parses a table containing enabled plus concurrency, timeout, usage-hint, naming, metadata, and mode options. The result should both mark the feature enabled and preserve each custom field.

**Call relations**: This tests the richer configuration shape that later feature loading and materialization need to preserve.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `multi_agent_v2_feature_config_usage_hint_enabled_does_not_enable_feature`  (lines 608–644)

```
fn multi_agent_v2_feature_config_usage_hint_enabled_does_not_enable_feature()
```

**Purpose**: Ensures that setting only a sub-option for multi_agent_v2 does not secretly turn on the whole feature.

**Data flow**: It parses a table with usage_hint_enabled but no enabled field, loads features from it, and checks that MultiAgentV2 remains disabled. The parsed config still preserves the sub-option.

**Call relations**: This protects against a common configuration mistake: treating any table presence as enabling the feature.

*Call graph*: calls 1 internal fn (from_sources); 5 external calls (default, assert_eq!, default, default, from_str).


##### `materialize_resolved_enabled_writes_all_features_and_preserves_custom_config`  (lines 647–704)

```
fn materialize_resolved_enabled_writes_all_features_and_preserves_custom_config()
```

**Purpose**: Checks that resolved feature states can be written back into a TOML object without losing custom settings.

**Data flow**: It enables several features in memory, prepares TOML config objects with custom multi-agent and network-proxy fields, then materializes the resolved enabled values. Every feature key should be written with its final enabled state, while custom fields like timeouts and proxy URL remain intact.

**Call relations**: This tests the round-trip path: calculate feature states, write them into config form, then load them again and confirm removed features still stay disabled.

*Call graph*: calls 2 internal fn (from_sources, with_defaults); 6 external calls (new, default, assert_eq!, default, default, Config).


##### `unstable_warning_event_only_mentions_enabled_under_development_features`  (lines 707–730)

```
fn unstable_warning_event_only_mentions_enabled_under_development_features()
```

**Purpose**: Checks that the unstable-feature warning mentions only configured under-development features that are actually enabled.

**Data flow**: It builds a simulated configured-features table containing an enabled under-development feature, a stable or irrelevant feature, and an unknown key. It enables ChildAgentsMd in the active feature set, asks for a warning event, and checks the message includes child_agents_md and the config path but not personality.

**Call relations**: This exercises the warning generator used to tell users about risky feature choices without cluttering the message with irrelevant keys.

*Call graph*: calls 1 internal fn (with_defaults); 5 external calls (new, Boolean, assert!, unstable_features_warning_event, panic!).


##### `unstable_warning_event_mentions_enabled_structured_under_development_feature`  (lines 733–761)

```
fn unstable_warning_event_mentions_enabled_structured_under_development_feature()
```

**Purpose**: Checks the exact warning text when under-development features are enabled using both structured and simple config forms.

**Data flow**: It parses a TOML table where multi_agent_v2 is enabled as a structured object and code_mode is enabled as a boolean. It enables both in the feature set, requests the warning event, and compares the full message with the expected wording.

**Call relations**: This protects the user-facing warning text and proves the warning logic understands structured TOML feature entries.

*Call graph*: calls 1 internal fn (with_defaults); 4 external calls (assert_eq!, unstable_features_warning_event, panic!, from_str).


### `tools/src/tool_config_tests.rs`

`test` · `test suite`

This is a test file for the tool configuration code. The project can run shell commands in different ways, and those choices depend on two things: what the selected model says it supports, and which feature flags are enabled. A feature flag is a switch that can turn a behavior on or off without changing the rest of the program. These tests act like a safety checklist: they build small fake inputs, flip the switches in different combinations, and check that the configuration code gives the expected answer.

The helper `model_with_shell_type` creates a realistic-looking model record with one chosen shell tool type. The helper `shell_features` starts from default features, then sets up a known shell-related baseline so each test begins from a predictable state.

The tests cover several important rules. Unified execution should only be used when its feature is enabled and the platform can support it. The older shell command backend should only use the zsh-fork path when both the shell tool and zsh-fork features are enabled. Unified execution has its own dependency rules when combined with zsh-fork. The file also checks which user-input modes are offered, and whether a session chooses the zsh-fork shell mode only when the operating system, user shell, executable paths, and feature mode all line up.

#### Function details

##### `model_with_shell_type`  (lines 12–53)

```
fn model_with_shell_type(shell_type: ConfigShellToolType) -> ModelInfo
```

**Purpose**: Creates a fake `ModelInfo` record for tests, with the shell tool type set to a chosen value. This lets the tests focus on shell-tool behavior without needing a real model downloaded from elsewhere.

**Data flow**: It takes one input: the shell tool type the test wants the model to advertise. It fills in the many other model fields with simple test values, defaults, or empty lists, including a token-based truncation policy and default input modalities. It returns a complete `ModelInfo` object ready to pass into the configuration logic under test.

**Call relations**: The shell-type test calls this helper before asking the real configuration function what shell type should be used. The helper delegates small pieces to existing constructors and defaults, such as token-limit setup and default input modalities, so the fake model still has the shape expected by production code.

*Call graph*: calls 2 internal fn (tokens, default_input_modalities); called by 1 (shell_type_is_derived_from_model_and_feature_gates); 3 external calls (default, new, new).


##### `shell_features`  (lines 55–62)

```
fn shell_features() -> Features
```

**Purpose**: Builds a predictable set of feature flags for shell-related tests. It starts with normal defaults, turns the basic shell tool on, and turns the zsh-fork and unified-exec variations off.

**Data flow**: It creates a `Features` object from the project defaults. Then it enables `ShellTool` and disables `ShellZshFork`, `UnifiedExec`, and `UnifiedExecZshFork`. It returns that prepared feature set so tests can flip one switch at a time and clearly see the effect.

**Call relations**: Several tests call this helper as their starting point. It relies on `Features::with_defaults` to match the project’s normal baseline, then narrows that baseline into a controlled setup for shell configuration tests.

*Call graph*: calls 1 internal fn (with_defaults); called by 3 (shell_command_backend_requires_both_shell_tool_and_zsh_fork, shell_type_is_derived_from_model_and_feature_gates, unified_exec_feature_mode_follows_composition_dependencies).


##### `shell_type_is_derived_from_model_and_feature_gates`  (lines 65–101)

```
fn shell_type_is_derived_from_model_and_feature_gates()
```

**Purpose**: Checks the rule that the final shell tool type comes from both the model’s advertised capability and the enabled feature flags. It protects against accidentally enabling a newer shell path when the needed feature gate is off.

**Data flow**: It creates a fake model that says it can use `UnifiedExec`, then creates baseline shell features. It asks the configuration code for the chosen shell type after changing feature flags in stages. The expected result changes from classic shell command, to unified execution when allowed and supported by the platform, back to classic in one zsh-fork combination, then finally to disabled when the main shell tool feature is turned off.

**Call relations**: This test calls `model_with_shell_type` and `shell_features` to prepare its inputs. It then repeatedly calls the production configuration function `shell_type_for_model_and_features` and compares the answers with `assert_eq!`. It also consults `codex_utils_pty::conpty_supported` because unified execution depends on platform support for the needed terminal behavior.

*Call graph*: calls 2 internal fn (model_with_shell_type, shell_features); 2 external calls (assert_eq!, conpty_supported).


##### `shell_command_backend_requires_both_shell_tool_and_zsh_fork`  (lines 104–122)

```
fn shell_command_backend_requires_both_shell_tool_and_zsh_fork()
```

**Purpose**: Checks that the shell command backend only switches to the zsh-fork version when both required switches are on. In plain terms, it should not use the special zsh path unless the shell tool itself is enabled too.

**Data flow**: It starts with baseline shell features and confirms the backend is the classic one. It then enables `ShellZshFork` and expects the backend to become `ZshFork`. Finally, it disables the main `ShellTool` feature and expects the backend to fall back to classic.

**Call relations**: This test uses `shell_features` for a clean starting point. It exercises the production function `shell_command_backend_for_features` and checks each result with equality assertions, showing the dependency between the main shell-tool feature and the zsh-fork option.

*Call graph*: calls 1 internal fn (shell_features); 1 external calls (assert_eq!).


##### `unified_exec_feature_mode_follows_composition_dependencies`  (lines 125–162)

```
fn unified_exec_feature_mode_follows_composition_dependencies()
```

**Purpose**: Checks the dependency rules for unified execution mode. It makes sure unified execution is direct by default when enabled, and only becomes the zsh-fork version when the surrounding zsh-fork features are also aligned.

**Data flow**: It begins with shell features where unified execution is off and expects the mode to be disabled. After enabling `UnifiedExec`, it expects direct mode. It then tries combinations of `UnifiedExecZshFork` and `ShellZshFork`, confirming that zsh-fork mode only appears when both the shell zsh-fork and unified-exec zsh-fork flags are enabled. If the main shell tool is disabled, the result becomes disabled again.

**Call relations**: This test is built from the `shell_features` helper and repeatedly calls `unified_exec_feature_mode_for_features`. The sequence of assertions documents how the configuration function should interpret combinations of feature flags, especially when one feature depends on another.

*Call graph*: calls 1 internal fn (shell_features); 1 external calls (assert_eq!).


##### `request_user_input_modes_follow_default_mode_feature`  (lines 165–178)

```
fn request_user_input_modes_follow_default_mode_feature()
```

**Purpose**: Checks which conversation modes can request user input based on a feature flag. It verifies that default mode is only included when the `DefaultModeRequestUserInput` feature is enabled.

**Data flow**: It starts with default features, disables the default-mode user-input feature, and expects only plan mode to be available. Then it enables that feature and expects both default mode and plan mode to be available. The output being checked is a list of `ModeKind` values.

**Call relations**: This test creates its feature set directly with `Features::with_defaults`. It then calls the production function `request_user_input_available_modes` after toggling one feature, using equality assertions to show how the available modes should change.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match`  (lines 181–206)

```
fn unified_exec_shell_mode_uses_zsh_fork_only_when_all_inputs_match()
```

**Purpose**: Checks the final per-session choice between direct unified execution and the zsh-fork version. It makes sure zsh-fork is chosen only when the feature mode asks for it, the user shell is zsh, the needed executable paths are present, and the operating system supports that path.

**Data flow**: It reads the current test executable path and uses it as both the shell path and executable path for a controlled test input. It asks `UnifiedExecShellMode::for_session` for a mode using zsh-fork feature mode and a zsh user shell. On Unix systems it expects a zsh-fork mode; on other systems it expects direct mode. It then repeats the call with direct feature mode and expects direct mode regardless of the zsh inputs.

**Call relations**: This test calls the production constructor-like function `UnifiedExecShellMode::for_session`, which makes the actual session-level decision. It uses `current_exe` to provide real existing paths, `cfg!` to account for operating-system differences, and assertions to confirm that feature mode and platform constraints are both respected.

*Call graph*: calls 1 internal fn (for_session); 4 external calls (assert!, assert_eq!, cfg!, current_exe).


### `connectors/src/app_tool_policy_tests.rs`

`test` · `test run`

Connectors expose tools, such as a calendar tool that can list or create events. This file tests the rulebook that decides whether each tool is allowed to run and what kind of approval it needs. That matters because a wrong decision could either block useful tools or allow risky actions without the right safeguard.

The tests build small fake configurations in memory. Some settings come from a user config, like enabling a calendar app or turning off destructive tools. Other settings come from managed requirements, which are policy rules supplied by the system or administrator. The tests then ask AppToolPolicyEvaluator what policy applies to a tool.

The main ideas being checked are priority and fallback. Global defaults apply when an app has no specific setting. App-level settings can override defaults. Tool-level settings can override app-level safety hints. Managed rules can disable apps and can override user approval choices, but they cannot force-enable an app the user has disabled. The tests also check name matching: user config may match a friendly tool title, while managed approval is expected to match the raw tool name.

The helper functions at the bottom act like a small test factory. They create fake configs, requirements, and policy inputs so each test can focus on one rule.

#### Function details

##### `evaluator_reuses_one_snapshot_across_tools`  (lines 25–85)

```
fn evaluator_reuses_one_snapshot_across_tools()
```

**Purpose**: Checks that one policy evaluator can answer several tool questions from the same saved view of configuration. It also shows how user settings, managed requirements, disabled default tools, and tool-title matching interact.

**Data flow**: It starts with a calendar app config where default tools are disabled but one tool is explicitly enabled. It adds a managed approval rule for that raw tool name. It builds one evaluator, asks for policies for three tool inputs, and compares the three answers with the expected enabled and approval states.

**Call relations**: The Rust test runner calls this as an independent test. Inside the test, configuration maps are built and passed into the evaluator constructor from the policy code under test; the test then calls the evaluator repeatedly to confirm the same snapshot is used for all answers.

*Call graph*: calls 1 internal fn (from_parts); 4 external calls (from, default, from, assert_eq!).


##### `evaluator_uses_global_defaults_for_destructive_hints`  (lines 88–112)

```
fn evaluator_uses_global_defaults_for_destructive_hints()
```

**Purpose**: Verifies that global defaults can disable tools that are marked as destructive. A destructive tool is one that may change or delete data, not just read it.

**Data flow**: It creates defaults where apps are generally enabled but destructive tools are not. It asks for a policy for a tool with a destructive hint set to true. The expected result is that the tool is disabled, with automatic approval left as the neutral default.

**Call relations**: The test runner calls this test. It uses the local defaults helper to build the default app settings, then exercises the policy evaluation path and checks the resulting policy.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_defaults_missing_destructive_hint_to_true`  (lines 115–139)

```
fn evaluator_defaults_missing_destructive_hint_to_true()
```

**Purpose**: Checks the safe fallback when a tool does not say whether it is destructive. The evaluator treats the missing hint as if the tool might be destructive.

**Data flow**: It builds global defaults that disallow destructive tools. It then asks for a policy without providing a destructive hint. Because missing means “assume yes” for safety, the resulting policy disables the tool.

**Call relations**: The test runner calls this test. It relies on the defaults helper for setup, then sends the incomplete hint information through the policy evaluation path to confirm the cautious behavior.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_defaults_missing_open_world_hint_to_true`  (lines 142–166)

```
fn evaluator_defaults_missing_open_world_hint_to_true()
```

**Purpose**: Checks the safe fallback when a tool does not say whether it can affect the outside world. Open-world means the tool may interact beyond local, contained data, such as contacting an external service.

**Data flow**: It creates defaults that allow apps and destructive tools but disallow open-world tools. It asks for a policy with no open-world hint. The evaluator treats the missing hint as true, so the tool is disabled.

**Call relations**: The test runner calls this test. The test builds defaults, evaluates one tool policy, and compares the answer to the expected disabled policy.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `app_enablement_uses_defaults_and_per_app_overrides`  (lines 169–192)

```
fn app_enablement_uses_defaults_and_per_app_overrides()
```

**Purpose**: Checks how the evaluator decides whether an app itself is enabled before considering individual tools. It confirms that a named app can override the global default.

**Data flow**: It creates defaults where apps are disabled, then explicitly enables the calendar app. It asks whether calendar, drive, and an unnamed connector are enabled. Calendar comes out enabled; the others follow the disabled default.

**Call relations**: The test runner calls this test. It builds a small app configuration using the defaults helper, then calls the app enablement function from the policy code under test.

*Call graph*: calls 1 internal fn (defaults); 3 external calls (default, from, assert_eq!).


##### `managed_disable_overrides_enabled_app`  (lines 195–223)

```
fn managed_disable_overrides_enabled_app()
```

**Purpose**: Verifies that a managed requirement can disable an app even when user configuration says the app is enabled. This protects administrator or system-level restrictions.

**Data flow**: It creates user config enabling a connector. It also creates a managed requirement saying the same connector is disabled. After evaluating a tool from that connector, the result is disabled.

**Call relations**: The test runner calls this test. It uses app_enabled_requirement to build the managed rule, then passes user and managed config into the policy path to make sure the managed disable wins.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 3 external calls (default, from, assert_eq!).


##### `managed_enable_does_not_override_disabled_app`  (lines 226–254)

```
fn managed_enable_does_not_override_disabled_app()
```

**Purpose**: Checks the opposite case: a managed requirement saying an app is enabled does not force-enable it when the user config disables it. This keeps user-side disabling effective.

**Data flow**: It starts with a connector explicitly disabled in user config. It adds a managed requirement that says the connector is enabled. The evaluated tool policy remains disabled.

**Call relations**: The test runner calls this test. It uses app_enabled_requirement to create the managed enable setting, then sends both configs through the policy evaluator to confirm user disablement still blocks the tool.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 3 external calls (default, from, assert_eq!).


##### `managed_disable_applies_without_apps_config`  (lines 257–275)

```
fn managed_disable_applies_without_apps_config()
```

**Purpose**: Confirms that managed disable rules work even when there is no user app configuration at all. A connector can still be blocked by policy alone.

**Data flow**: It creates only a managed requirement that disables a connector. It evaluates a tool for that connector with no apps config. The output policy disables the tool.

**Call relations**: The test runner calls this test. It builds the managed rule with app_enabled_requirement and uses the policy evaluation helper path without a user config.

*Call graph*: calls 1 internal fn (app_enabled_requirement); 1 external calls (assert_eq!).


##### `evaluator_honors_default_app_enabled_false`  (lines 278–302)

```
fn evaluator_honors_default_app_enabled_false()
```

**Purpose**: Checks that a global default of “apps disabled” actually disables a tool when there is no per-app override. This is the blanket-off setting.

**Data flow**: It creates defaults where apps are disabled, while destructive and open-world tools would otherwise be allowed. It evaluates a calendar tool and expects it to be disabled because the app itself is not enabled.

**Call relations**: The test runner calls this test. It uses the defaults helper, then asks the policy evaluator for one tool policy and checks that app enablement is considered first.

*Call graph*: calls 1 internal fn (defaults); 2 external calls (new, assert_eq!).


##### `evaluator_allows_per_app_enable_when_default_is_disabled`  (lines 305–332)

```
fn evaluator_allows_per_app_enable_when_default_is_disabled()
```

**Purpose**: Verifies that a specific app can be enabled even when the global default disables apps. This lets configuration say “off by default, but allow this one.”

**Data flow**: It creates disabled global defaults and then explicitly enables the calendar app. It evaluates a calendar tool with no special restrictions. The result is the default allowed policy.

**Call relations**: The test runner calls this test. It uses defaults for the global setting, adds a per-app override, and checks the evaluator result against the normal default policy.

*Call graph*: calls 1 internal fn (defaults); 3 external calls (default, from, assert_eq!).


##### `evaluator_uses_managed_approval_without_apps_config`  (lines 335–351)

```
fn evaluator_uses_managed_approval_without_apps_config()
```

**Purpose**: Checks that managed approval rules can set approval behavior even when the user has no app config. Approval behavior decides whether a tool runs automatically, prompts, or is approved by policy.

**Data flow**: It provides no apps config, but supplies a managed approval of Approve for a calendar tool. The resulting policy enables the tool and uses the managed approval mode.

**Call relations**: The test runner calls this test. The test goes through the policy evaluation path with managed approval data and no user configuration.

*Call graph*: 1 external calls (assert_eq!).


##### `managed_approval_uses_raw_tool_name`  (lines 354–390)

```
fn managed_approval_uses_raw_tool_name()
```

**Purpose**: Verifies that managed approval rules match the raw tool name, not a display title or alias. This prevents a renamed tool title from accidentally matching an administrator rule.

**Data flow**: It creates a managed approval rule for the raw name calendar/list_events. First it evaluates that exact raw name and gets Approve. Then it evaluates a different raw name that has calendar/list_events only as its title, and it gets the default policy instead.

**Call relations**: The test runner calls this test. It uses app_tool_requirements to build the managed rule, then compares two evaluations to show that only the raw tool name is used for managed approval matching.

*Call graph*: calls 1 internal fn (app_tool_requirements); 1 external calls (assert_eq!).


##### `managed_approval_overrides_user_tool_approval`  (lines 393–434)

```
fn managed_approval_overrides_user_tool_approval()
```

**Purpose**: Checks that managed approval has priority over a user's per-tool approval setting. If policy says Approve and the user setting says Prompt, policy wins.

**Data flow**: It creates user config where a specific tool would prompt for approval. It also creates a managed requirement for the same tool with Approve. The evaluated policy is enabled with Approve.

**Call relations**: The test runner calls this test. It gets managed tool requirements from app_tool_requirements, combines them with user config, and checks that the evaluator gives the managed answer.

*Call graph*: calls 1 internal fn (app_tool_requirements); 3 external calls (default, from, assert_eq!).


##### `per_tool_enable_overrides_app_level_hints`  (lines 437–472)

```
fn per_tool_enable_overrides_app_level_hints()
```

**Purpose**: Verifies that explicitly enabling one tool can override app-level safety filters for destructive and open-world hints. This lets a user allow a known tool even when the app’s general rule is stricter.

**Data flow**: It builds an enabled calendar app whose app-level settings disallow destructive and open-world tools. It then explicitly enables events/create. When that tool is evaluated with both hints set to true, the result is still allowed.

**Call relations**: The test runner calls this test. It builds the user app and tool configuration directly, then sends it through the policy evaluator to confirm tool-level enablement has higher priority.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `default_tools_enable_overrides_app_level_hints`  (lines 475–521)

```
fn default_tools_enable_overrides_app_level_hints()
```

**Purpose**: Checks that the app setting for default tool enablement can override app-level destructive and open-world filters. It also checks that disabling default tools still preserves the configured default approval mode.

**Data flow**: It first creates an app where default tools are enabled even though app-level hint filters are false, and the evaluated tool is allowed. Then it changes the app so default tools are disabled and default approval is Approve; the evaluated tool is disabled but carries the Approve approval mode.

**Call relations**: The test runner calls this test. It calls policy_from_apps_config for each scenario, using the helper to run the same evaluator setup with different app settings.

*Call graph*: calls 1 internal fn (policy_from_apps_config); 2 external calls (default, assert_eq!).


##### `evaluator_uses_default_tools_approval_mode`  (lines 524–555)

```
fn evaluator_uses_default_tools_approval_mode()
```

**Purpose**: Verifies that an app can set the approval mode for tools that do not have their own specific entry. This is the app’s fallback approval rule.

**Data flow**: It creates an enabled calendar app with a default tool approval mode of Prompt and no per-tool settings. It evaluates events/list. The result is enabled and asks for Prompt approval.

**Call relations**: The test runner calls this test. It builds a user app config and sends it through the policy evaluator to confirm the fallback approval setting is applied.

*Call graph*: 4 external calls (default, from, new, assert_eq!).


##### `evaluator_matches_tool_title_for_user_config`  (lines 558–598)

```
fn evaluator_matches_tool_title_for_user_config()
```

**Purpose**: Checks that user tool configuration can match a tool by its title when the raw tool name is different. This helps when the runtime name is machine-generated but the config uses a friendlier name.

**Data flow**: It creates a calendar app where default tools are disabled and the titled tool events/create is explicitly enabled with Approve. It evaluates a raw tool named calendar_events/create whose title is events/create. The result is enabled with Approve.

**Call relations**: The test runner calls this test. It builds the app config directly and exercises the evaluator to show that user configuration can use the supplied tool title for matching.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `input`  (lines 600–608)

```
fn input(tool_name: &'a str, tool_title: Option<&'a str>) -> AppToolPolicyInput<'a>
```

**Purpose**: Builds a standard policy input for tests that all use the calendar connector. It keeps repeated test setup short and consistent.

**Data flow**: It receives a tool name and an optional tool title. It returns an AppToolPolicyInput with connector_id set to calendar and both destructive and open-world hints set to true.

**Call relations**: This helper is used by tests that need several policy queries against the same calendar setup. It hands a ready-made input object to the evaluator’s policy method.


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

**Purpose**: Evaluates one tool policy from an optional user apps config, with an optional managed approval shortcut. It is a convenience wrapper for tests that do not need to build the full configuration stack themselves.

**Data flow**: It receives optional app config, connector and tool details, optional safety hints, and optional managed approval. If managed approval is present, it turns that into managed tool requirements. Then it passes everything to policy_from_config_parts and returns the resulting AppToolPolicy.

**Call relations**: Tests call this helper when they want a single policy answer. When managed approval is supplied, it creates requirements through the same shape used elsewhere, then hands off to policy_from_config_parts for the full evaluator setup.

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

**Purpose**: Builds the real configuration stack used by the policy evaluator and asks it for one tool policy. This is the main test bridge from simple in-memory structs to the production evaluator.

**Data flow**: It receives optional user apps config, optional managed requirements, connector and tool identifiers, and optional hints. It wraps managed requirements in a ConfigRequirementsToml, creates a ConfigLayerStack, optionally serializes the user apps config into a fake config table, attaches that as user config, then constructs AppToolPolicyEvaluator and returns its policy answer.

**Call relations**: policy_from_apps_config delegates to this helper. This helper calls into the production configuration and policy code, so the tests exercise the same merging path used outside the test suite rather than a separate mock version.

*Call graph*: calls 3 internal fn (new, new, try_from); called by 1 (policy_from_apps_config); 6 external calls (default, Table, try_from, new, default, temp_dir).


##### `app_enabled_requirement`  (lines 678–688)

```
fn app_enabled_requirement(app_id: &str, enabled: bool) -> AppsRequirementsToml
```

**Purpose**: Creates a managed requirement that says whether one app is enabled. Tests use it to express administrator-style allow or block rules for a connector.

**Data flow**: It receives an app id and a true-or-false enabled value. It returns an AppsRequirementsToml containing one app entry with that enabled setting and no tool-specific requirements.

**Call relations**: The managed enable and disable tests call this helper to build their policy input. Its output is then passed into the policy evaluation helpers as managed requirements.

*Call graph*: called by 3 (managed_disable_applies_without_apps_config, managed_disable_overrides_enabled_app, managed_enable_does_not_override_disabled_app); 1 external calls (from).


##### `app_tool_requirements`  (lines 690–711)

```
fn app_tool_requirements(
    app_id: &str,
    tool_name: &str,
    approval_mode: AppToolApproval,
) -> AppsRequirementsToml
```

**Purpose**: Creates a managed requirement for one tool’s approval mode inside one app. Tests use it to check how managed approval interacts with user configuration and tool names.

**Data flow**: It receives an app id, a raw tool name, and an approval mode. It returns an AppsRequirementsToml containing one app entry with one tool requirement whose approval_mode is set to that value.

**Call relations**: Managed approval tests call this helper before running the evaluator. The resulting requirements are combined with optional user config by the policy setup helpers.

*Call graph*: called by 2 (managed_approval_overrides_user_tool_approval, managed_approval_uses_raw_tool_name); 1 external calls (from).


##### `defaults`  (lines 713–724)

```
fn defaults(
    enabled: bool,
    destructive_enabled: bool,
    open_world_enabled: bool,
) -> AppsDefaultConfig
```

**Purpose**: Builds the global default app settings used in many tests. It lets each test state only the three important booleans instead of repeating the whole struct.

**Data flow**: It receives booleans for whether apps are enabled, destructive tools are enabled, and open-world tools are enabled. It returns an AppsDefaultConfig with those values and no approvals reviewer.

**Call relations**: Tests that focus on default behavior call this helper during setup. The returned defaults are inserted into AppsConfigToml before the policy evaluator is exercised.

*Call graph*: called by 6 (app_enablement_uses_defaults_and_per_app_overrides, evaluator_allows_per_app_enable_when_default_is_disabled, evaluator_defaults_missing_destructive_hint_to_true, evaluator_defaults_missing_open_world_hint_to_true, evaluator_honors_default_app_enabled_false, evaluator_uses_global_defaults_for_destructive_hints).


### `core/tests/common/test_environment_tests.rs`

`test` · `test run`

This is a set of automated tests for `parse_test_environment`, a helper that turns environment-variable values into a clear `TestEnvironment` choice. In plain terms, it verifies the rules for answering: “Should these tests run on this machine, inside a Docker container, or through Wine?” Docker is a container system, like running the test inside a labeled box with its own software setup. Wine is a compatibility layer used to run Windows programs on non-Windows systems.

The tests cover both the current configuration style and an older “legacy” setting that used to mean “remote environment” but is now treated as a Docker container name. This matters because old scripts or developer machines may still have the legacy variable set. The code must remain predictable instead of accidentally failing or running tests in the wrong place.

Each test calls `parse_test_environment` with different combinations of optional values. It then compares the result with the expected answer, including expected error messages. The important behavior is that no explicit setting defaults to local testing, Docker requires a non-empty container name, explicit local settings ignore stale Docker-related metadata, and unknown environment names are rejected with a clear message.

#### Function details

##### `defaults_to_local`  (lines 8–16)

```
fn defaults_to_local()
```

**Purpose**: This test proves that if no test environment is configured, the system chooses local testing. That is the safe default: run tests on the current machine unless told otherwise.

**Data flow**: It starts with three missing inputs: no configured environment, no legacy remote value, and no Docker container name. It passes those into `parse_test_environment`, then checks that the returned value is `Ok(TestEnvironment::Local)`. Nothing outside the test is changed.

**Call relations**: During the test run, the Rust test framework calls this function. The function asks `parse_test_environment` for an interpretation of empty configuration, then uses `assert_eq!` to confirm the answer matches the expected local setting.

*Call graph*: 1 external calls (assert_eq!).


##### `parses_each_explicit_environment`  (lines 19–46)

```
fn parses_each_explicit_environment()
```

**Purpose**: This test checks that each supported environment name is understood correctly. It verifies the main valid choices: `local`, `docker`, and `wine-exec`.

**Data flow**: It feeds `parse_test_environment` three different explicit environment values. For `local`, it expects a local test environment. For `docker`, it also supplies a container name and expects a Docker environment containing that name. For `wine-exec`, it expects the Wine execution mode. Each result is compared with the expected value.

**Call relations**: The test framework runs this as one of the environment parser checks. It exercises the normal happy paths of `parse_test_environment` and uses `assert_eq!` after each case to make sure each supported text value becomes the right structured result.

*Call graph*: 1 external calls (assert_eq!).


##### `treats_the_legacy_remote_value_as_a_docker_container`  (lines 49–60)

```
fn treats_the_legacy_remote_value_as_a_docker_container()
```

**Purpose**: This test confirms backward compatibility with an older configuration style. If only the old remote-environment value is present, the parser should treat it as the Docker container name.

**Data flow**: It begins with no current environment setting, a legacy value of `legacy-container`, and no current Docker container value. It sends those inputs to `parse_test_environment`. The expected output is a Docker test environment whose container name is `legacy-container`.

**Call relations**: The test runner calls this function to make sure older setups still work. The function relies on `parse_test_environment` to translate legacy input into the current Docker form, then uses `assert_eq!` to check that translation.

*Call graph*: 1 external calls (assert_eq!).


##### `explicit_docker_accepts_the_legacy_container_value`  (lines 63–82)

```
fn explicit_docker_accepts_the_legacy_container_value()
```

**Purpose**: This test verifies that when Docker is explicitly requested, the old legacy variable can still provide the container name. It also checks that an empty legacy value is rejected, because Docker cannot run without a real container name.

**Data flow**: First it passes an explicit `docker` setting plus a legacy container name and expects a successful Docker result. Then it passes `docker` plus an empty legacy value and expects an error saying the legacy variable must not be empty. The test does not modify shared state; it only compares returned results.

**Call relations**: The Rust test framework invokes this function as part of the parser’s compatibility checks. It calls `parse_test_environment` for both a valid and invalid legacy Docker setup, then hands each actual result to `assert_eq!` to confirm the intended behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `explicit_local_ignores_stale_remote_metadata`  (lines 85–94)

```
fn explicit_local_ignores_stale_remote_metadata()
```

**Purpose**: This test makes sure that an explicit request for local testing wins over leftover Docker or legacy settings. This prevents old environment variables from unexpectedly changing where tests run.

**Data flow**: It provides `local` as the configured environment while also supplying a legacy container name and a Docker container name. It passes all three values to `parse_test_environment`. The expected result is still `Ok(TestEnvironment::Local)`, showing that the extra metadata is ignored.

**Call relations**: The test runner calls this function to check precedence rules. The function asks `parse_test_environment` to interpret conflicting-looking inputs, then uses `assert_eq!` to verify that the explicit local choice takes priority.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_invalid_or_incomplete_configuration`  (lines 97–118)

```
fn rejects_invalid_or_incomplete_configuration()
```

**Purpose**: This test checks that bad configuration fails clearly instead of being guessed at. It covers two mistakes: asking for Docker without giving a container name, and using an unknown environment name.

**Data flow**: First it passes `docker` without either possible container-name source and expects an error explaining that the Docker container variable must be set. Then it passes `other` as the environment name and expects an error listing the valid choices. The output in both cases is an error string, and the test compares it exactly.

**Call relations**: The test framework runs this to confirm the parser’s guardrails. The function calls `parse_test_environment` with incomplete or invalid input, then uses `assert_eq!` to make sure the user-facing error messages are precise and helpful.

*Call graph*: 1 external calls (assert_eq!).


### `core/tests/suite/deprecation_notice.rs`

`test` · `test run`

This is a small test file for deprecation notices: messages that tell a user, “this old setting still works for now, but you should switch to the new one.” Each test starts a mock server, builds a test Codex instance with a deliberately old configuration option, then waits for Codex to emit a deprecation notice event. An event is a message produced by the running system to report something important that happened.

The tests check both parts of the notice: the short summary and the longer details. That matters because these messages are effectively user-facing instructions. If the wording is wrong, users may not know what to remove, what to replace it with, or where to find the new setting.

The file is disabled on Windows, because one of the tested areas relates to Linux sandbox behavior and the surrounding test setup is intended for non-Windows platforms. Each test also skips itself when networking is unavailable, since the Codex test harness uses a mock server as part of the run. In short, this file acts like a smoke alarm test for old configuration paths: it makes sure the alarm rings, and that the label on the alarm tells users exactly what to do next.

#### Function details

##### `emits_deprecation_notice_for_legacy_feature_flag`  (lines 16–54)

```
async fn emits_deprecation_notice_for_legacy_feature_flag() -> anyhow::Result<()>
```

**Purpose**: This test checks that using the old `use_experimental_unified_exec_tool` setting produces a clear warning. It makes sure users are told to use the newer `unified_exec` feature flag instead.

**Data flow**: The test starts with a test configuration, turns on the newer unified execution feature, and also records that the old legacy setting was used. It then builds a test Codex instance connected to a mock server. As Codex starts, the test waits for a deprecation notice event, reads its summary and details, and compares them with the exact user-facing text that should be shown.

**Call relations**: During the test, the mock server supplies the outside service Codex expects, and the test builder creates a controlled Codex run with the old setting present. The test then listens to Codex events until the deprecation notice appears, and finally uses assertions to confirm that the notice points users from the legacy setting to the replacement setting.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


##### `emits_deprecation_notice_for_web_search_feature_flag_values`  (lines 57–101)

```
async fn emits_deprecation_notice_for_web_search_feature_flag_values() -> anyhow::Result<()>
```

**Purpose**: This test checks that the old `web_search_request` feature flag produces a warning whether it is set to true or false. That matters because the setting is deprecated as a setting itself, not only because of one particular value.

**Data flow**: For each value, true and false, the test creates a feature map containing `web_search_request`, applies it to the test configuration, and builds a Codex instance with a mock server. It waits for a deprecation notice whose summary names that old feature flag. It then verifies that the summary says web search is now enabled by default, and that the details explain the newer top-level `web_search` configuration choices.

**Call relations**: The loop runs the same Codex startup path twice, once for each possible old flag value. The test setup feeds the deprecated feature entry into Codex, Codex emits events while starting, and the waiting helper filters those events until it finds the matching deprecation notice. The assertions then lock down the exact guidance users should receive.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


##### `emits_deprecation_notice_for_use_legacy_landlock`  (lines 104–143)

```
async fn emits_deprecation_notice_for_use_legacy_landlock() -> anyhow::Result<()>
```

**Purpose**: This test checks that using the old `use_legacy_landlock` feature flag produces a warning. Landlock is a Linux sandboxing system, so this warning helps users move away from older Linux sandbox behavior before it is removed.

**Data flow**: The test creates a feature map where `use_legacy_landlock` is set to true, applies it to the test configuration, and starts a test Codex instance against a mock server. It waits for a deprecation notice mentioning that old feature flag. The notice is then unpacked into its summary and details, and both are compared with the expected text.

**Call relations**: The test builder supplies Codex with the deprecated sandbox-related setting before startup. Once Codex runs, the event-waiting helper watches for the matching deprecation notice. The final checks confirm that Codex not only warns about removal, but also tells users to remove the setting to stop opting into legacy Linux sandbox behavior.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (Ok, assert_eq!, wait_for_event_match, skip_if_no_network!).


### `core/tests/suite/personality_migration.rs`

`test` · `test run`

This test file is a safety net for a configuration migration. The migration looks at a Codex home directory and decides whether to add `personality = "pragmatic"` to `config.toml`. In plain terms, it is trying to give existing users a sensible new default, but only if they have actually used the tool before and have not already chosen a global personality themselves.

The tests build small fake Codex home folders inside temporary directories. Some contain no sessions. Some contain a session log with an actual user message. Some contain only session metadata, which is like a blank envelope with no letter inside. The file also creates archived sessions to prove old stored conversations count too.

Each test calls `maybe_migrate_personality`, then checks three kinds of evidence: the returned migration status, whether the migration marker file was written, and whether `config.toml` was created or preserved correctly. The marker file matters because it prevents the migration from running again, like a sticky note saying “already done.” The tests also cover edge cases: existing config fields must survive, an explicit global personality must be respected, profile-level personalities should not block the global migration, and old or missing profile references should not crash the process.

#### Function details

##### `read_config_toml`  (lines 24–27)

```
async fn read_config_toml(codex_home: &Path) -> io::Result<ConfigToml>
```

**Purpose**: Reads the test `config.toml` file from a fake Codex home directory and turns it into a `ConfigToml` value. Tests use it to inspect what the migration actually wrote to disk.

**Data flow**: It receives the path to a temporary Codex home directory. It reads `config.toml` from that directory as text, parses the TOML text into the project’s config structure, and returns that structure or an input/output error if reading or parsing fails.

**Call relations**: After tests run the migration, several of them call this helper to verify the result. It hands parsed configuration data back to the test so assertions can check fields such as `model` and `personality`.

*Call graph*: called by 5 (applied_migration_is_idempotent_on_second_run, no_marker_archived_sessions_sets_personality, no_marker_profile_personality_does_not_skip_migration, no_marker_sessions_preserves_existing_config_fields, no_marker_sessions_sets_personality); 3 external calls (join, read_to_string, from_str).


##### `write_session_with_user_event`  (lines 29–37)

```
async fn write_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a fake active session that includes a real user message. This gives the migration evidence that the user has existing session history.

**Data flow**: It receives the temporary Codex home path, creates a fresh thread ID, builds the normal dated sessions directory path, and asks the lower-level rollout writer to create the JSON-lines session file there. Nothing is returned except success or failure.

**Call relations**: Tests that need a normal existing session call this helper before invoking `maybe_migrate_personality`. It delegates the actual file contents to `write_rollout_with_user_event` so multiple helpers can share the same session-log format.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 5 (applied_migration_is_idempotent_on_second_run, no_marker_explicit_global_personality_skips_migration, no_marker_profile_personality_does_not_skip_migration, no_marker_sessions_preserves_existing_config_fields, no_marker_sessions_sets_personality); 1 external calls (join).


##### `write_archived_session_with_user_event`  (lines 39–43)

```
async fn write_archived_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a fake archived session that includes a real user message. It proves the migration treats archived conversations as valid history too.

**Data flow**: It receives the temporary Codex home path, creates a fresh thread ID, chooses the archived sessions directory, and asks `write_rollout_with_user_event` to write the session log there. It returns only whether the setup succeeded.

**Call relations**: The archived-session test calls this before running the migration. Like the active-session helper, it relies on `write_rollout_with_user_event` for the exact JSON-lines file content.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (no_marker_archived_sessions_sets_personality); 1 external calls (join).


##### `write_session_with_meta_only`  (lines 45–53)

```
async fn write_session_with_meta_only(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a fake active session file that contains only metadata and no user message. This tests that an empty-looking session record does not count as real usage.

**Data flow**: It receives the temporary Codex home path, creates a fresh thread ID, builds the normal dated sessions directory path, and asks `write_rollout_with_meta_only` to write a metadata-only rollout file. It returns success or an input/output error.

**Call relations**: The metadata-only test calls this helper before invoking the migration. It passes the work to `write_rollout_with_meta_only`, which writes the minimal session file used to check the migration’s definition of a real session.

*Call graph*: calls 2 internal fn (write_rollout_with_meta_only, new); called by 1 (no_marker_meta_only_rollout_is_treated_as_no_sessions); 1 external calls (join).


##### `write_rollout_with_user_event`  (lines 55–103)

```
async fn write_rollout_with_user_event(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes the actual JSON-lines session log used by tests when they need a session with real user activity. A JSON-lines file stores one JSON object per line, which makes session events easy to append and read one at a time.

**Data flow**: It receives a target directory and a thread ID. It creates the directory, opens a rollout file with a test timestamp and the thread ID in its name, builds one session metadata line and one user-message event line, serializes both to JSON, and writes them to the file. The directory and file are changed on disk; the function returns whether writing succeeded.

**Call relations**: Both active-session and archived-session helpers call this function. Those helpers decide where the file belongs, while this function supplies the realistic contents that `maybe_migrate_personality` later scans.

*Call graph*: called by 2 (write_archived_session_with_user_event, write_session_with_user_event); 11 external calls (default, join, new, format!, UserMessage, EventMsg, SessionMeta, to_string, from, create (+1 more)).


##### `write_rollout_with_meta_only`  (lines 105–140)

```
async fn write_rollout_with_meta_only(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes a JSON-lines session log that has session metadata but no user message. This helps confirm that the migration does not mistake a bare session header for actual conversation history.

**Data flow**: It receives a target directory and thread ID. It creates the directory, opens a rollout file, builds a single session metadata line, serializes it to JSON, and writes it as the only line. The result is a file on disk with no user event, plus success or failure.

**Call relations**: The metadata-only session helper calls this setup function. The migration test then uses the file it creates to check that `maybe_migrate_personality` skips homes without meaningful session content.

*Call graph*: called by 1 (write_session_with_meta_only); 7 external calls (join, format!, SessionMeta, to_string, from, create, create_dir_all).


##### `parse_config_toml`  (lines 142–144)

```
fn parse_config_toml(contents: &str) -> io::Result<ConfigToml>
```

**Purpose**: Turns a small TOML configuration snippet written inside a test into a `ConfigToml` value. This lets tests describe starting configuration directly in the test code.

**Data flow**: It receives a string containing TOML text. It parses that text into the project’s config structure and returns it, or returns an invalid-data error if the snippet is not valid TOML.

**Call relations**: Tests call this when they need a specific starting config, such as an explicit personality or a legacy profile setting. The parsed config is then passed into `maybe_migrate_personality` as the migration’s view of the current configuration.

*Call graph*: called by 4 (marker_short_circuits_migration_with_legacy_profile, missing_legacy_profile_does_not_block_migration, no_marker_explicit_global_personality_skips_migration, no_marker_profile_personality_does_not_skip_migration); 1 external calls (from_str).


##### `migration_marker_exists_no_sessions_no_change`  (lines 147–161)

```
async fn migration_marker_exists_no_sessions_no_change() -> io::Result<()>
```

**Purpose**: Checks that if the migration marker already exists, the migration does nothing. This protects users from repeated or late changes after the migration has already been marked complete.

**Data flow**: It creates a temporary home directory, writes the migration marker file, and calls the migration with a default config and no state database. It expects a “skipped because marker exists” status and confirms no `config.toml` file was created.

**Call relations**: This test goes straight to `maybe_migrate_personality` after setting up the marker. It verifies the marker is a hard stop, even when there are no sessions to inspect.

*Call graph*: calls 1 internal fn (maybe_migrate_personality); 4 external calls (new, assert_eq!, default, write).


##### `no_marker_no_sessions_no_change`  (lines 164–180)

```
async fn no_marker_no_sessions_no_change() -> io::Result<()>
```

**Purpose**: Checks that a brand-new or unused home directory does not receive a default personality. The migration should not create user config when there is no real history to migrate.

**Data flow**: It creates an empty temporary home directory and calls the migration with a default config. It expects a “skipped because no sessions” status, confirms the marker file was created, and confirms `config.toml` was not created.

**Call relations**: This test calls `maybe_migrate_personality` with no setup beyond an empty directory. It proves the migration records that it checked the home, while leaving configuration untouched.

*Call graph*: calls 1 internal fn (maybe_migrate_personality); 3 external calls (new, assert_eq!, default).


##### `no_marker_sessions_sets_personality`  (lines 183–199)

```
async fn no_marker_sessions_sets_personality() -> io::Result<()>
```

**Purpose**: Checks the main successful path: when there is a real session and no marker, the migration writes the pragmatic personality. This is the core behavior the migration exists to provide.

**Data flow**: It creates a temporary home, writes a fake session with a user message, and calls the migration using a default config. It expects the migration to be applied, checks that the marker exists, reads back `config.toml`, and verifies the personality is `Pragmatic`.

**Call relations**: The test uses `write_session_with_user_event` for setup, then calls `maybe_migrate_personality`, then uses `read_config_toml` to inspect what was persisted. It ties together the helper-created session evidence and the migration’s config-writing result.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, default).


##### `no_marker_sessions_preserves_existing_config_fields`  (lines 202–215)

```
async fn no_marker_sessions_preserves_existing_config_fields() -> io::Result<()>
```

**Purpose**: Checks that the migration adds the new personality without deleting unrelated settings. This matters because a migration should behave like adding a note to an existing form, not replacing the whole form.

**Data flow**: It creates a temporary home, writes a session with a user message, writes an existing `config.toml` containing a model setting, reads that config, and passes it to the migration. After migration, it reads the file again and expects both the original model and the new pragmatic personality to be present.

**Call relations**: This test prepares both session history and an existing config file. It uses `read_config_toml` before the migration to provide the current config, and again afterward to verify that `maybe_migrate_personality` preserved existing data while adding the new field.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, write).


##### `no_marker_meta_only_rollout_is_treated_as_no_sessions`  (lines 218–235)

```
async fn no_marker_meta_only_rollout_is_treated_as_no_sessions() -> io::Result<()>
```

**Purpose**: Checks that a session file containing only metadata does not trigger the migration. The migration should look for real user activity, not just the presence of a file.

**Data flow**: It creates a temporary home, writes a metadata-only session rollout, and calls the migration with a default config. It expects a “no sessions” skip status, confirms the marker was written, and confirms `config.toml` was not created.

**Call relations**: The test relies on `write_session_with_meta_only` to create a session-shaped file with no user message. It then calls `maybe_migrate_personality` to prove that the migration’s session scan is not fooled by metadata alone.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, write_session_with_meta_only); 3 external calls (new, assert_eq!, default).


##### `no_marker_explicit_global_personality_skips_migration`  (lines 238–258)

```
async fn no_marker_explicit_global_personality_skips_migration() -> io::Result<()>
```

**Purpose**: Checks that the migration respects a user’s existing global personality choice. If the user already picked one, the migration must not replace it with `Pragmatic`.

**Data flow**: It creates a temporary home, writes a real session, parses a config snippet with `personality = "friendly"`, and calls the migration. It expects a “skipped explicit personality” status, confirms the marker exists, and confirms no config file was written by the migration.

**Call relations**: This test combines `write_session_with_user_event` and `parse_config_toml` to create the important conflict: session history exists, but the user has already made a global choice. It then checks that `maybe_migrate_personality` chooses respect for the user setting over applying the default.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, parse_config_toml, write_session_with_user_event); 2 external calls (new, assert_eq!).


##### `no_marker_profile_personality_does_not_skip_migration`  (lines 261–287)

```
async fn no_marker_profile_personality_does_not_skip_migration() -> io::Result<()>
```

**Purpose**: Checks that a personality inside a named profile does not count as a global personality choice. The migration should still add the global pragmatic personality in that case.

**Data flow**: It creates a temporary home, writes a real session, parses a config snippet with an active profile and a profile-specific friendly personality, and calls the migration. It expects the migration to be applied, confirms the marker and config file exist, reads back the config, and checks that the global personality is `Pragmatic`.

**Call relations**: This test uses `parse_config_toml` to model a profile-based setup and `write_session_with_user_event` to provide real history. After `maybe_migrate_personality` runs, `read_config_toml` confirms the migration added the global setting rather than treating the profile setting as a reason to skip.

*Call graph*: calls 4 internal fn (maybe_migrate_personality, parse_config_toml, read_config_toml, write_session_with_user_event); 2 external calls (new, assert_eq!).


##### `marker_short_circuits_migration_with_legacy_profile`  (lines 290–299)

```
async fn marker_short_circuits_migration_with_legacy_profile() -> io::Result<()>
```

**Purpose**: Checks that an existing migration marker stops the migration before legacy profile details matter. This prevents old or odd configuration shapes from causing trouble after the migration is already marked complete.

**Data flow**: It creates a temporary home, writes the migration marker, parses a config that points at a missing profile, and calls the migration. It expects the marker-based skip status.

**Call relations**: This test sets up both a marker and a potentially awkward legacy profile reference. It proves `maybe_migrate_personality` checks the marker first and returns without being blocked by the profile configuration.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, parse_config_toml); 3 external calls (new, assert_eq!, write).


##### `missing_legacy_profile_does_not_block_migration`  (lines 302–314)

```
async fn missing_legacy_profile_does_not_block_migration() -> io::Result<()>
```

**Purpose**: Checks that a config pointing to a missing legacy profile does not crash or prevent the no-session path. The migration should remain tolerant of older config files.

**Data flow**: It creates a temporary home, parses a config with `profile = "missing"`, and calls the migration with no sessions present. It expects a “no sessions” skip status and confirms the marker file was written.

**Call relations**: This test uses `parse_config_toml` to create the legacy-style config, then calls `maybe_migrate_personality`. It shows that the migration can still complete its normal check-and-mark behavior even when the selected profile cannot be found.

*Call graph*: calls 2 internal fn (maybe_migrate_personality, parse_config_toml); 2 external calls (new, assert_eq!).


##### `applied_migration_is_idempotent_on_second_run`  (lines 317–331)

```
async fn applied_migration_is_idempotent_on_second_run() -> io::Result<()>
```

**Purpose**: Checks that running the migration twice is safe. “Idempotent” means doing it again does not keep changing things after the first successful run.

**Data flow**: It creates a temporary home, writes a real session, runs the migration once, and runs it a second time. It expects the first run to apply the migration and the second run to skip because the marker now exists, then reads the config to confirm the pragmatic personality remains set.

**Call relations**: This test uses `write_session_with_user_event` to trigger the first migration. It then calls `maybe_migrate_personality` twice and uses `read_config_toml` at the end to prove the marker prevents repeat work while preserving the first result.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_session_with_user_event); 3 external calls (new, assert_eq!, default).


##### `no_marker_archived_sessions_sets_personality`  (lines 334–350)

```
async fn no_marker_archived_sessions_sets_personality() -> io::Result<()>
```

**Purpose**: Checks that archived session history also triggers the migration. This matters for users whose older conversations have been moved out of the active sessions folder.

**Data flow**: It creates a temporary home, writes an archived session containing a user message, and calls the migration with a default config. It expects the migration to be applied, confirms the marker exists, reads `config.toml`, and verifies the personality is `Pragmatic`.

**Call relations**: The test sets up history through `write_archived_session_with_user_event`, then calls `maybe_migrate_personality`. It finishes with `read_config_toml` to show that archived activity is enough for the migration to write the new global personality.

*Call graph*: calls 3 internal fn (maybe_migrate_personality, read_config_toml, write_archived_session_with_user_event); 3 external calls (new, assert_eq!, default).


### `core/tests/suite/unstable_features_warning.rs`

`test` · `test run`

This test file checks a small but important user experience rule: if someone enables an unstable feature in their configuration file, Codex should tell them clearly that they are using something still under development. Think of it like a construction sign on a road: the road may be open, but drivers should know conditions may change.

Each test creates a temporary home directory so it does not touch a real user's files. It then loads a normal test configuration, turns on the unstable feature named `child_agents_md`, and pretends that this setting came from the user's `config.toml` file. The tests start a new Codex conversation thread using test-only authentication and model-provider helpers, so no real login or external service is needed.

The first test waits for a warning event from the conversation and checks that the message names the unstable feature, explains that under-development features are enabled, and tells the user how to suppress the warning. The second test sets `suppress_unstable_features_warning` to true before starting the conversation. It then waits briefly and confirms that no warning arrives. Together, these tests verify both sides of the behavior: warn by default, but respect the user's choice to silence the warning.

#### Function details

##### `emits_warning_when_unstable_features_enabled_via_config`  (lines 19–61)

```
async fn emits_warning_when_unstable_features_enabled_via_config()
```

**Purpose**: This test proves that Codex emits a warning when an unstable feature is enabled through the user's configuration. It checks not only that a warning appears, but that the warning contains useful text the user can act on.

**Data flow**: The test starts with a fresh temporary home directory and loads a default test configuration. It enables the `child_agents_md` feature, records that setting as if it came from the user's config file, and starts a new conversation using fake test authentication. It then waits for the conversation to produce a warning event. The result is a set of assertions that the warning message mentions the feature, says under-development features are enabled, and explains the setting that can suppress the warning.

**Call relations**: During the test, helper code creates an API-key-style test login, builds a thread manager, and loads the default config. Once the conversation is resumed with new initial history, the test support helper waits for the first warning event. This function is the caller that brings those pieces together to confirm the warning path works from configuration all the way to the emitted conversation event.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, from_api_key, from_absolute_path); 6 external calls (new, assert!, load_default_config_for_test, wait_for_event, panic!, toml!).


##### `suppresses_warning_when_configured`  (lines 64–106)

```
async fn suppresses_warning_when_configured()
```

**Purpose**: This test proves that Codex does not emit the unstable-feature warning when the user has chosen to suppress it. It protects the user's preference from being ignored.

**Data flow**: The test creates a temporary home directory, loads a default test configuration, enables the same unstable `child_agents_md` feature, and then sets `suppress_unstable_features_warning` to true. It starts a new conversation with test authentication and waits only a short time for a warning event. The expected outcome is that the wait times out, which means no warning was sent.

**Call relations**: Like the companion test, this function calls helpers to create fake authentication, build a thread manager, and start a conversation from a test configuration. It then wraps the event-waiting helper in a short timeout. In the larger test story, this checks the opposite branch from the first test: the warning system is still active, but the suppression setting stops the warning from being delivered.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, from_api_key, from_absolute_path); 7 external calls (from_millis, new, assert!, load_default_config_for_test, wait_for_event, timeout, toml!).


### Cloud config and home environment providers
This group validates external configuration sources and environment-sensitive providers, from signed cloud-config caching and service refresh behavior to home-directory instructions and cloud task filtering.

### `cloud-config/src/cache_tests.rs`

`test` · `test run`

The cloud configuration cache is a small file stored under the user's Codex home directory. It lets the program reuse cloud-provided configuration and requirements without fetching them every time. Because those settings can affect important behavior, the cache must be treated carefully: it must belong to the current signed-in identity, it must not be too old, and it must not have been edited by hand.

This test file builds small fake cloud bundles, writes them into temporary directories, and then asks the cache code to save or load them. A temporary directory is like a disposable sandbox: each test gets a clean little filesystem and can freely create bad files without affecting a real user.

The tests cover the happy path first: saving a bundle writes a signed JSON file, and loading it back succeeds only for the matching ChatGPT user ID and account ID. The rest of the tests deliberately create failure cases. They check that loading stops early if the caller did not provide a complete identity, reports a missing or malformed cache file, rejects changed contents after signing, rejects a cache for the wrong or incomplete identity, rejects expired data, and rejects an unsupported cache format version.

Together, these tests protect the cache as if it were a sealed envelope with a name and expiry date on it. If the seal is broken, the name does not match, or the date has passed, the cache must not be trusted.

#### Function details

##### `test_bundle`  (lines 11–28)

```
fn test_bundle() -> CloudConfigBundle
```

**Purpose**: Creates a small sample cloud configuration bundle for tests. It includes one configuration fragment and one requirements fragment so tests have realistic data to save, sign, and reload.

**Data flow**: It takes no input. It builds fixed in-memory data: a config fragment with a model setting and a requirements fragment with an approval-policy setting. It returns that complete bundle for other test helpers and test cases to use.

**Call relations**: The main successful save/load test uses this helper to create the bundle it saves. The valid payload helper also uses it when building a signed cache payload, so the error-case tests all start from the same known-good bundle before changing one detail.

*Call graph*: called by 2 (save_writes_signed_payload_and_loads_for_matching_identity, valid_signed_payload); 1 external calls (vec!).


##### `signed_cache_file`  (lines 30–38)

```
fn signed_cache_file(
    signed_payload: CloudConfigBundleCacheSignedPayload,
) -> CloudConfigBundleCacheFile
```

**Purpose**: Wraps a cache payload in the same kind of signature the real cache file is expected to have. Tests use it to create cache files that are valid at first, and then sometimes deliberately corrupt the signed contents afterward.

**Data flow**: It receives a signed-payload object, converts that payload into the exact bytes that are supposed to be protected, signs those bytes, and returns a cache-file object containing both the signature and the payload. If the bytes or signature cannot be produced, the test fails immediately.

**Call relations**: The tests for tampering, identity mismatch, expiry, and unsupported versions use this helper to put a realistic signed cache file on disk. It relies on the cache signing helpers from the code being tested, so each test can focus on the one bad condition it wants to check.

*Call graph*: called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version).


##### `valid_signed_payload`  (lines 40–50)

```
fn valid_signed_payload() -> CloudConfigBundleCacheSignedPayload
```

**Purpose**: Creates a known-good cache payload with the current cache version, a fresh timestamp, matching user/account IDs, and the sample cloud bundle. It is the starting point for tests that then alter one field to simulate a bad cache.

**Data flow**: It takes no input. It reads the current time, sets an expiry about 30 minutes later, fills in fixed identity values, attaches the test bundle, and returns the completed payload.

**Call relations**: Several rejection tests call this first so they begin with a payload that should otherwise pass. They then change one thing, such as the expiry time or version number, before signing and writing it.

*Call graph*: calls 1 internal fn (test_bundle); called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version); 2 external calls (minutes, now).


##### `write_cache_file`  (lines 52–58)

```
fn write_cache_file(cache: &CloudConfigBundleCache, cache_file: &CloudConfigBundleCacheFile)
```

**Purpose**: Writes a prepared cache file to the test cache's expected path. It lets tests place exact cache contents on disk before calling the real load logic.

**Data flow**: It receives a cache object and a cache-file object. It asks the cache for its file path, turns the cache-file object into pretty JSON bytes, writes those bytes to disk, and does not return a value. If serialization or writing fails, the test fails.

**Call relations**: The rejection tests use this helper after building a signed cache file. Once the file is on disk, they call the cache load operation and check whether it reports the correct reason for refusing the file.

*Call graph*: calls 1 internal fn (path); called by 4 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_tampered_payload, load_rejects_unsupported_cache_version); 2 external calls (to_vec_pretty, write).


##### `create_test_cache`  (lines 60–62)

```
fn create_test_cache(codex_home: &Path) -> CloudConfigBundleCache
```

**Purpose**: Creates a cache object rooted in a temporary test directory. This keeps tests isolated from real user files and from each other.

**Data flow**: It receives the path to a temporary Codex home directory. It resolves that path into the absolute path type the cache expects, constructs a new cloud config bundle cache, and returns it.

**Call relations**: Every test that needs a cache calls this helper after creating a temporary directory. It hides the setup details so each test can concentrate on save/load behavior.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 7 (load_rejects_cache_for_incomplete_or_different_identity, load_rejects_expired_cache, load_rejects_missing_request_identity_before_reading_cache_file, load_rejects_tampered_payload, load_rejects_unsupported_cache_version, load_reports_missing_and_malformed_cache_files, save_writes_signed_payload_and_loads_for_matching_identity).


##### `save_writes_signed_payload_and_loads_for_matching_identity`  (lines 65–103)

```
async fn save_writes_signed_payload_and_loads_for_matching_identity()
```

**Purpose**: Tests the normal successful path: saving a cloud config bundle writes a signed cache file, and loading it back works for the same user and account. It also checks that the saved expiry time is in a sensible future range.

**Data flow**: It creates a temporary directory, builds a test cache and sample bundle, saves that bundle for a specific user and account, then reads the raw JSON cache file back from disk. It parses the file, checks the timestamp rules, rebuilds the expected signed file shape, and finally calls load with the matching identity. The expected result is the same signed payload that was saved.

**Call relations**: This is the main happy-path test. It uses the test cache and sample bundle helpers, then exercises the real cache save and load behavior to prove the cache file is both correctly written and accepted later.

*Call graph*: calls 2 internal fn (create_test_cache, test_bundle); 5 external calls (assert!, assert_eq!, from_slice, read, tempdir).


##### `load_rejects_missing_request_identity_before_reading_cache_file`  (lines 106–120)

```
async fn load_rejects_missing_request_identity_before_reading_cache_file()
```

**Purpose**: Tests that cache loading refuses to continue if the caller does not provide both parts of the current identity. This matters because a cache file should never be trusted unless it can be matched to a known user and account.

**Data flow**: It creates an empty test cache, then calls load once without a ChatGPT user ID and once without an account ID. In both cases, it expects an identity-incomplete error and does not need to create any cache file.

**Call relations**: This test uses the cache setup helper, then goes straight to the load operation. It checks the early safety gate: the cache code should reject the request before even looking at what may be on disk.

*Call graph*: calls 1 internal fn (create_test_cache); 2 external calls (assert_eq!, tempdir).


##### `load_reports_missing_and_malformed_cache_files`  (lines 123–137)

```
async fn load_reports_missing_and_malformed_cache_files()
```

**Purpose**: Tests two basic file problems: no cache file exists, and the cache file exists but is not valid JSON. These are common disk-state failures and should be reported clearly.

**Data flow**: It creates a fresh test cache and first tries to load from it without writing any file, expecting a file-not-found result. Then it writes a deliberately broken JSON string to the cache path and loads again, expecting a parse-failed result.

**Call relations**: This test focuses on the disk-reading part of cache loading. It sets up simple filesystem states and checks that the load operation turns them into the right cache status instead of crashing or pretending the cache is usable.

*Call graph*: calls 1 internal fn (create_test_cache); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `load_rejects_tampered_payload`  (lines 140–156)

```
async fn load_rejects_tampered_payload()
```

**Purpose**: Tests that changing the contents of a signed cache file makes it invalid. This protects against hand-edited or corrupted cached settings being accepted as trustworthy cloud settings.

**Data flow**: It creates a valid signed payload, then changes the requirements text inside the payload after the signature has already been made. It writes that mismatched signature-and-payload pair to disk and loads it with the correct identity. The expected result is a signature-invalid error.

**Call relations**: This test combines the valid-payload, signing, and file-writing helpers to create a realistic tampering case. It then asks the real loader to verify the signature and reject the file because the protected contents no longer match the signature.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


##### `load_rejects_cache_for_incomplete_or_different_identity`  (lines 159–178)

```
async fn load_rejects_cache_for_incomplete_or_different_identity()
```

**Purpose**: Tests that a cache file is accepted only for the exact identity it was saved for. It also checks that a cache payload missing its own stored identity is not trusted.

**Data flow**: It first writes a valid signed cache for user-12345/account-12345, then tries to load it as user-99999/account-12345 and expects an identity-mismatch error. Next it creates another payload where the stored user ID is missing, writes it, and expects an identity-incomplete error when loading.

**Call relations**: This test starts from a valid signed payload and changes either the requested identity or the identity stored in the cache. It checks the identity comparison step in the loader, after the file has been read and signature data is available.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


##### `load_rejects_expired_cache`  (lines 181–192)

```
async fn load_rejects_expired_cache()
```

**Purpose**: Tests that old cached cloud configuration is not reused after its expiry time. This prevents stale cloud policies from quietly staying in effect forever.

**Data flow**: It creates a valid payload, changes its expiry time to one second in the past, signs and writes it, then tries to load it for the matching identity. The expected output is a cache-expired error.

**Call relations**: This test uses the standard helpers to make a realistic cache file with only the time field made bad. It then relies on the loader's freshness check to refuse the file even though the identity and signature are otherwise valid.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 4 external calls (seconds, now, assert_eq!, tempdir).


##### `load_rejects_unsupported_cache_version`  (lines 195–206)

```
async fn load_rejects_unsupported_cache_version()
```

**Purpose**: Tests that the loader refuses cache files from an unsupported format version. This is important when the cache file shape changes, because older code should not guess how to read newer or incompatible data.

**Data flow**: It creates a valid payload, changes its version number to 2, signs and writes it, and loads it for the matching identity. The expected result says that version 2 is unsupported.

**Call relations**: This test follows the same pattern as the other rejection tests: start from a valid payload, alter one field, write it through the helper, and check the loader's specific refusal reason. Here it exercises the cache-version compatibility check.

*Call graph*: calls 4 internal fn (create_test_cache, signed_cache_file, valid_signed_payload, write_cache_file); 2 external calls (assert_eq!, tempdir).


### `cloud-config/src/service_tests.rs`

`test` · `test suite`

Cloud configuration is a sensitive startup feature: it can change which settings and requirements Codex uses for a managed workspace. This test file acts like a safety checklist for that feature. It builds fake authentication files, fake cloud bundles, and fake backend clients so the service can be tested without talking to the real network.

The tests cover the main decisions the service must make. If the user is using only an API key, or is on an individual plan, the service must not fetch organization config. If the user is on an eligible workspace plan, it should fetch the bundle, validate it, and write it to a cache file. The cache is like a labeled lunchbox: it is only safe to reuse when the user and account labels match the current login. Invalid cached bundles are ignored, and invalid fresh bundles are rejected before being saved.

The file also checks failure behavior. It verifies timeouts, retries, unauthorized responses, token reloads, and clear error messages. Small fake clients return fixed bundles, a sequence of successes and failures, never-ending requests, token-sensitive responses, or unauthorized errors. Together, these tests make sure startup cloud config is both useful and conservative: if the service cannot prove the bundle is valid and belongs to the current user, it fails closed instead of applying risky settings.

#### Function details

##### `write_auth_json`  (lines 29–32)

```
fn write_auth_json(codex_home: &Path, value: serde_json::Value) -> std::io::Result<()>
```

**Purpose**: Writes a test authentication file named `auth.json` into a temporary Codex home directory. Tests use it to pretend a user has logged in with certain credentials.

**Data flow**: It receives a directory path and a JSON value. It turns the JSON into text, writes that text to `auth.json` inside the directory, and returns success or a file-writing error.

**Call relations**: Authentication setup helpers and several unauthorized-recovery tests call this before creating or refreshing an `AuthManager`, so the rest of the test can observe how the service reacts to those credentials.

*Call graph*: called by 6 (auth_manager_with_api_key, auth_manager_with_plan_and_identity, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_surfaces_auth_recovery_message, get_bundle_unauthorized_without_recovery_uses_generic_message); 3 external calls (join, to_string, write).


##### `create_test_cache`  (lines 34–36)

```
fn create_test_cache(codex_home: &Path) -> CloudConfigBundleCache
```

**Purpose**: Creates a cloud config cache object rooted at a test directory. This lets tests read and write the same cache file the real service would use, but inside a temporary folder.

**Data flow**: It receives the temporary Codex home path, resolves it into the project’s absolute path type, and returns a `CloudConfigBundleCache` pointed there.

**Call relations**: Cache-focused tests call this when they need to pre-fill bad cache data, inspect the refreshed cache after an auth reload, or confirm that a remote refresh replaced old cached content.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 3 (get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, refresh_from_remote_updates_cached_bundle).


##### `auth_manager_with_api_key`  (lines 38–56)

```
async fn auth_manager_with_api_key() -> Arc<AuthManager>
```

**Purpose**: Builds a test authentication manager that represents a user authenticated with an OpenAI API key rather than ChatGPT login tokens. It is used to prove cloud workspace config is skipped for non-ChatGPT authentication.

**Data flow**: It creates a temporary directory, writes an `auth.json` containing an API key and no tokens, then constructs and returns a shared `AuthManager` that reads from that directory.

**Call relations**: The non-ChatGPT-auth test calls this before creating the cloud config service, and the service should then decide not to ask the bundle client for anything.

*Call graph*: calls 3 internal fn (write_auth_json, default, new); called by 1 (get_bundle_skips_non_chatgpt_auth); 3 external calls (new, json!, tempdir).


##### `auth_manager_with_plan_and_identity`  (lines 58–85)

```
async fn auth_manager_with_plan_and_identity(
    plan_type: &str,
    chatgpt_user_id: Option<&str>,
    account_id: Option<&str>,
) -> Arc<AuthManager>
```

**Purpose**: Builds a test authentication manager for a ChatGPT user with a chosen plan type and optional user/account identifiers. Tests use it to simulate different subscriptions and identity labels.

**Data flow**: It receives a plan name plus optional user and account IDs. It writes a fake ChatGPT token file with those values, creates an `AuthManager` from that file, and returns it in a shared pointer.

**Call relations**: This is the main login factory behind many tests. `auth_manager_with_plan` calls it for normal complete identities, while cache-identity tests call it directly to create mismatched or incomplete users.

*Call graph*: calls 4 internal fn (chatgpt_auth_json, write_auth_json, default, new); called by 3 (auth_manager_with_plan, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity); 2 external calls (new, tempdir).


##### `auth_manager_with_plan`  (lines 87–89)

```
async fn auth_manager_with_plan(plan_type: &str) -> Arc<AuthManager>
```

**Purpose**: Creates a normal test ChatGPT authentication manager for a given plan type, using standard fake user and account IDs. It keeps tests short when the exact identity is not the point.

**Data flow**: It takes a plan type string, fills in default fake user and account IDs, delegates to `auth_manager_with_plan_and_identity`, and returns the resulting shared `AuthManager`.

**Call relations**: Most service tests call this to set up eligible or ineligible plans before checking fetching, caching, retries, timeouts, and refresh behavior.

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

**Purpose**: Creates the JSON shape of a fake ChatGPT login file with a default last-refresh time. It is a convenience wrapper for tests that do not care about token freshness.

**Data flow**: It receives plan, identity, access token, and refresh token values. It passes them on with a fixed timestamp and returns the generated JSON value.

**Call relations**: Authentication manager helpers and auth-error tests use this to produce realistic-looking login data without repeating the lower-level token-building details.

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

**Purpose**: Creates fake ChatGPT authentication JSON while letting the test choose the `last_refresh` timestamp. This matters because token freshness affects whether the auth manager reloads from disk.

**Data flow**: It receives plan, identity, token values, and a timestamp. It passes them to the more general JSON builder without setting a special auth mode, then returns the JSON.

**Call relations**: Unauthorized-recovery tests use this to make a token appear fresh or stale at exactly the right moment, so they can test reload behavior precisely.

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

**Purpose**: Builds the full fake ChatGPT `auth.json` value, including a fake identity token and optional authentication mode. This gives tests realistic enough credentials for the auth code to parse.

**Data flow**: It receives plan, identity, token, timestamp, and optional mode values. It creates a fake JWT-style token by base64-encoding a header and payload, places it with access and refresh tokens into JSON, optionally adds `auth_mode`, and returns the JSON value.

**Call relations**: Higher-level auth JSON helpers call this for normal cases, and one unauthorized test calls it directly to simulate a specific auth mode where recovery should not happen.

*Call graph*: called by 2 (chatgpt_auth_json_with_last_refresh, get_bundle_unauthorized_without_recovery_uses_generic_message); 4 external calls (format!, json!, String, to_vec).


##### `test_bundle`  (lines 167–176)

```
fn test_bundle() -> CloudConfigBundle
```

**Purpose**: Creates a small valid cloud config bundle used throughout the tests. It includes one config fragment and one requirements fragment.

**Data flow**: It creates a `CloudConfigBundle` containing the standard test config and requirements fragments, then returns that bundle.

**Call relations**: Many tests and fake clients use this as the happy-path remote bundle, so assertions can focus on service behavior rather than bundle construction.

*Call graph*: called by 10 (get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_skips_individual_plan, get_bundle_skips_non_chatgpt_auth, get_bundle_skips_team_like_usage_based_plan, get_bundle_uses_cache_when_valid); 1 external calls (vec!).


##### `test_config_fragment`  (lines 178–184)

```
fn test_config_fragment() -> CloudConfigFragment
```

**Purpose**: Creates a valid sample config fragment that sets the model. It is the standard config piece used in test bundles.

**Data flow**: It constructs a `CloudConfigFragment` with a fixed ID, name, and TOML text, then returns it.

**Call relations**: The standard bundle and shape-tag test use this fragment when they need a bundle that contains enterprise-managed config.


##### `test_requirements_fragment`  (lines 186–192)

```
fn test_requirements_fragment() -> CloudRequirementsFragment
```

**Purpose**: Creates a valid sample requirements fragment that restricts approval policies. It is the standard requirements piece used in test bundles.

**Data flow**: It constructs a `CloudRequirementsFragment` with a fixed ID, name, and TOML text, then returns it.

**Call relations**: The standard bundle and shape-tag test use this fragment when they need a bundle that contains enterprise-managed requirements.


##### `invalid_config_bundle`  (lines 194–205)

```
fn invalid_config_bundle() -> CloudConfigBundle
```

**Purpose**: Creates a deliberately broken cloud config bundle. Tests use it to make sure the service does not apply or save invalid configuration text.

**Data flow**: It returns a bundle whose config fragment contains malformed TOML, while requirements are empty.

**Call relations**: Validation tests use this as either a bad remote response or a bad cached bundle, proving that the service rejects fresh bad data and replaces stale bad cache data.

*Call graph*: called by 2 (get_bundle_ignores_invalid_cache_and_refetches, get_bundle_rejects_invalid_remote_bundle_before_cache_write); 2 external calls (default, vec!).


##### `request_error`  (lines 207–209)

```
fn request_error() -> BundleRequestError
```

**Purpose**: Creates a retryable fake request failure. Tests use it to simulate a temporary backend or network problem.

**Data flow**: It builds and returns a `BundleRequestError` marked as retryable, with no specific HTTP status code.

**Call relations**: Sequence-based fake clients return this error in retry and max-attempt tests, so the service’s backoff and failure limits can be checked.

*Call graph*: 1 external calls (Retryable).


##### `StaticBundleClient::new`  (lines 217–222)

```
fn new(bundle: CloudConfigBundle) -> Self
```

**Purpose**: Creates a fake bundle client that always returns the same bundle. It also records how many times the service asked it for data.

**Data flow**: It receives a bundle, stores it, initializes the request counter to zero, and returns the fake client.

**Call relations**: Most tests use this client when they want a predictable backend response and need to verify whether the service did or did not contact the backend.

*Call graph*: called by 10 (get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_empty_response_is_success_and_cached, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_rejects_invalid_remote_bundle_before_cache_write, get_bundle_skips_individual_plan, get_bundle_skips_non_chatgpt_auth, get_bundle_skips_team_like_usage_based_plan, get_bundle_uses_cache_when_valid); 1 external calls (new).


##### `StaticBundleClient::get_bundle`  (lines 226–229)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Implements the fake backend call for `StaticBundleClient`. It always succeeds with the stored bundle.

**Data flow**: It ignores the auth input, increments the request counter, clones the stored bundle, and returns it as a successful result.

**Call relations**: The cloud config service calls this through the `BundleClient` interface during tests where the backend should return one fixed answer.

*Call graph*: 2 external calls (fetch_add, clone).


##### `PendingBundleClient::get_bundle`  (lines 235–238)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Simulates a backend request that never finishes. It is used to test timeout behavior.

**Data flow**: It receives auth but does not use it. It waits forever, so under normal execution it never produces a bundle; the fallback return is only there to satisfy the function shape.

**Call relations**: The timeout test gives this client to the service, then advances the test clock to confirm the service stops waiting and returns a timeout error.

*Call graph*: 1 external calls (default).


##### `SequenceBundleClient::new`  (lines 247–252)

```
fn new(responses: Vec<Result<CloudConfigBundle, BundleRequestError>>) -> Self
```

**Purpose**: Creates a fake bundle client that returns a planned sequence of results. This lets tests model retries, cache misses, and later refreshes.

**Data flow**: It receives a list of successful bundles or errors, stores them in a queue protected by a mutex, initializes a request counter, and returns the client.

**Call relations**: Tests use this when the first request should fail and the next succeed, when all attempts should fail, or when a refresh should return a newer bundle than startup did.

*Call graph*: called by 6 (get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_retries_until_success, get_bundle_stops_after_max_retries, get_bundle_uses_cache_when_valid, refresh_from_remote_updates_cached_bundle); 3 external calls (new, from, new).


##### `SequenceBundleClient::get_bundle`  (lines 256–262)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Returns the next planned response from a sequence fake client. If the planned responses run out, it returns an empty successful bundle.

**Data flow**: It increments the request counter, locks the response queue so only one async task can remove from it at a time, pops the first response, and returns that response or a default success.

**Call relations**: The service calls this during tests that need a story over time, such as retrying after a temporary error or updating the cache with a later remote bundle.

*Call graph*: 1 external calls (fetch_add).


##### `TokenBundleClient::get_bundle`  (lines 272–285)

```
async fn get_bundle(&self, auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Simulates a backend that only accepts one specific access token. It is used to test whether the service reloads credentials after an unauthorized response.

**Data flow**: It reads the token from the provided auth object, increments the request counter, and compares the token to the expected one. A match returns the test bundle; a mismatch returns a 401 unauthorized error.

**Call relations**: Unauthorized-recovery tests use this client so the first call with a stale token fails, the service reloads auth, and the second call with the fresh token succeeds.

*Call graph*: 3 external calls (fetch_add, clone, matches!).


##### `UnauthorizedBundleClient::get_bundle`  (lines 294–300)

```
async fn get_bundle(&self, _auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Simulates a backend that always rejects the request as unauthorized. It lets tests check the exact error message the service gives users.

**Data flow**: It ignores auth, increments the request counter, and returns a 401 unauthorized error with the configured message.

**Call relations**: Auth-error tests give this client to the service after arranging different login states, then verify whether the service reports a recovery message or a generic sign-in failure.

*Call graph*: 1 external calls (fetch_add).


##### `bundle_shape_tag_describes_sorted_enterprise_sources`  (lines 304–339)

```
fn bundle_shape_tag_describes_sorted_enterprise_sources()
```

**Purpose**: Checks that metric labeling for bundle shape is clear and stable. The service uses this label to describe whether a bundle has config, requirements, both, empty content, or no bundle.

**Data flow**: It builds several bundle shapes, passes each to `bundle_shape_tag`, and compares the returned string with the expected label.

**Call relations**: This test directly exercises the metrics helper rather than the service flow, ensuring later telemetry can group bundles consistently.

*Call graph*: 1 external calls (assert_eq!).


##### `get_bundle_skips_non_chatgpt_auth`  (lines 342–354)

```
async fn get_bundle_skips_non_chatgpt_auth()
```

**Purpose**: Verifies that API-key authentication does not trigger cloud bundle fetching. This prevents workspace-only remote config from being requested for the wrong kind of login.

**Data flow**: It creates an API-key auth manager, a fake backend with a valid bundle, and a service. After startup loading, it expects no bundle and confirms the backend was never called.

**Call relations**: This test combines `auth_manager_with_api_key`, `StaticBundleClient`, and the service startup method to prove the plan/auth gate runs before any network fetch.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_api_key, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_skips_individual_plan`  (lines 357–369)

```
async fn get_bundle_skips_individual_plan()
```

**Purpose**: Verifies that an individual ChatGPT plan does not receive cloud workspace config. This keeps organization-managed settings limited to workspace plans.

**Data flow**: It creates a `pro` plan auth manager, attaches a fake backend, runs startup loading, and expects no returned bundle and zero backend requests.

**Call relations**: This test uses the normal plan-auth helper and static client to show that the service checks plan eligibility before calling the backend.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_allows_eligible_workspace_plans_and_writes_cache`  (lines 372–409)

```
async fn get_bundle_allows_eligible_workspace_plans_and_writes_cache()
```

**Purpose**: Checks that recognized workspace plan types can fetch cloud config and save it locally. This proves the positive path works for business, enterprise, health care, and education-style plans.

**Data flow**: For each eligible plan string, it creates auth, a fake backend returning a valid bundle, and a fresh service. It expects the bundle back, one backend request, and a cache file on disk.

**Call relations**: This is the main happy-path startup test. It shows the service moving from eligible auth to remote fetch to successful cache write.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 4 external calls (new, assert!, assert_eq!, tempdir).


##### `get_bundle_skips_team_like_usage_based_plan`  (lines 412–424)

```
async fn get_bundle_skips_team_like_usage_based_plan()
```

**Purpose**: Verifies that a team-like usage-based plan is not treated as eligible enterprise cloud config. This guards a subtle plan-name boundary.

**Data flow**: It creates auth with `self_serve_business_usage_based`, runs startup loading with a fake backend, and expects no bundle and no backend call.

**Call relations**: This test sits beside the eligible-plan test and confirms that not every business-sounding plan string passes the service’s eligibility gate.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_rejects_invalid_remote_bundle_before_cache_write`  (lines 427–451)

```
async fn get_bundle_rejects_invalid_remote_bundle_before_cache_write()
```

**Purpose**: Checks that a malformed bundle from the backend is rejected and not cached. This is important because cached bad config could affect later runs.

**Data flow**: It sets up an eligible user and a fake backend returning invalid TOML. Startup loading returns an invalid-bundle error, the backend is called once, and no cache file is created.

**Call relations**: This test exercises the service’s validation step after remote fetch and before cache save, proving the service fails closed on bad remote content.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, invalid_config_bundle); 4 external calls (new, assert!, assert_eq!, tempdir).


##### `get_bundle_ignores_invalid_cache_and_refetches`  (lines 454–487)

```
async fn get_bundle_ignores_invalid_cache_and_refetches()
```

**Purpose**: Verifies that invalid cached config is not trusted. The service should replace it with a fresh valid bundle when possible.

**Data flow**: It first writes an invalid bundle into the cache for the current identity. Then it runs startup loading with a backend that returns a valid replacement and confirms the replacement is returned and saved.

**Call relations**: This test uses `create_test_cache` to seed bad state, then checks that the service falls through to the backend instead of applying the invalid cache.

*Call graph*: calls 6 internal fn (new, new, auth_manager_with_plan, create_test_cache, invalid_config_bundle, test_bundle); 3 external calls (new, assert_eq!, tempdir).


##### `get_bundle_empty_response_is_success_and_cached`  (lines 490–508)

```
async fn get_bundle_empty_response_is_success_and_cached()
```

**Purpose**: Checks that an empty cloud bundle is still a successful response. An empty bundle means the backend had nothing to apply, not that the request failed.

**Data flow**: It creates an eligible user and a fake backend returning the default empty bundle. Startup loading returns `None`, records one backend request, and still writes the cache file.

**Call relations**: This test confirms the service distinguishes between “no config to apply” and “could not load config,” while still caching the successful empty answer.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 5 external calls (new, assert!, assert_eq!, default, tempdir).


##### `get_bundle_uses_cache_when_valid`  (lines 511–532)

```
async fn get_bundle_uses_cache_when_valid()
```

**Purpose**: Verifies that a valid cache can satisfy startup loading without contacting the backend. This makes startup faster and more reliable when the saved bundle is safe to reuse.

**Data flow**: It first primes the cache with a valid bundle. Then it creates a new service with a backend that would fail if called, runs startup loading, and confirms the cached bundle is returned and the backend was not contacted.

**Call relations**: This test proves the cache check comes before remote fetching when the cache belongs to the current auth identity and validates successfully.

*Call graph*: calls 5 internal fn (new, new, new, auth_manager_with_plan, test_bundle); 4 external calls (new, assert_eq!, tempdir, vec!).


##### `get_bundle_ignores_cache_for_different_auth_identity`  (lines 535–572)

```
async fn get_bundle_ignores_cache_for_different_auth_identity()
```

**Purpose**: Checks that cached config for one user is not reused for another user. This prevents one account’s managed settings from leaking into another account’s session.

**Data flow**: It primes the cache under one user ID, then logs in as a different user on the same account and provides a replacement bundle from the backend. The service returns the replacement and calls the backend once.

**Call relations**: This test demonstrates the identity label on the cache: when the current user does not match the saved user, the service must fetch again.

*Call graph*: calls 5 internal fn (new, new, new, auth_manager_with_plan_and_identity, test_bundle); 5 external calls (new, assert_eq!, default, tempdir, vec!).


##### `get_bundle_times_out`  (lines 575–592)

```
async fn get_bundle_times_out()
```

**Purpose**: Verifies that startup loading stops waiting when the backend never responds. This prevents Codex startup from hanging forever on cloud config.

**Data flow**: It uses a pending fake client, starts loading in a task, advances the paused test clock past the timeout, and expects a timeout error message.

**Call relations**: This test drives `load_startup_bundle_with_timeout` with `PendingBundleClient`, proving the timeout wrapper around the fetch flow works.

*Call graph*: calls 2 internal fn (new, auth_manager_with_plan); 6 external calls (new, from_millis, assert!, tempdir, spawn, advance).


##### `get_bundle_retries_until_success`  (lines 595–614)

```
async fn get_bundle_retries_until_success()
```

**Purpose**: Checks that a temporary request failure is retried and can still succeed. This makes the service resilient to short-lived network or backend problems.

**Data flow**: It creates a sequence client that first returns a retryable error and then a valid bundle. After advancing test time for the retry delay, it expects the valid bundle and two total requests.

**Call relations**: This test shows the service’s retry loop: it receives a retryable error, waits, asks the client again, then returns success.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 8 external calls (new, from_secs, assert_eq!, tempdir, spawn, yield_now, advance, vec!).


##### `get_bundle_recovers_after_unauthorized_reload`  (lines 617–671)

```
async fn get_bundle_recovers_after_unauthorized_reload()
```

**Purpose**: Verifies that the service can recover from a stale access token by reloading auth from disk. This supports the case where credentials were refreshed after the auth manager first read them.

**Data flow**: It writes auth with a stale token, creates the auth manager, then overwrites the auth file with a fresh token. A token-checking backend rejects the first request and accepts the second, so loading succeeds after two requests.

**Call relations**: This test connects `write_auth_json`, `TokenBundleClient`, and the service’s unauthorized-retry path to prove a 401 can trigger a credential reload.

*Call graph*: calls 6 internal fn (new, chatgpt_auth_json_with_last_refresh, test_bundle, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_recovers_after_unauthorized_reload_updates_cache_identity`  (lines 674–735)

```
async fn get_bundle_recovers_after_unauthorized_reload_updates_cache_identity()
```

**Purpose**: Checks that when auth reload changes the user identity, the cache is written under the refreshed identity. This avoids storing the new bundle under stale user labels.

**Data flow**: It starts with stale auth for one user, then replaces the auth file with a fresh token for another user before loading. After successful recovery, it opens the cache and confirms the bundle is saved under the new user and same account.

**Call relations**: This extends the unauthorized-recovery scenario by inspecting the cache with `create_test_cache`, proving the service re-reads identity information before saving.

*Call graph*: calls 7 internal fn (new, chatgpt_auth_json_with_last_refresh, create_test_cache, test_bundle, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_surfaces_auth_recovery_message`  (lines 738–798)

```
async fn get_bundle_surfaces_auth_recovery_message()
```

**Purpose**: Verifies that the service gives a helpful sign-in message when token recovery fails because the account changed. Users need a clear instruction instead of a raw backend error.

**Data flow**: It creates auth for one account, then rewrites the auth file with a mismatched account and uses a backend that always returns 401. Startup loading returns an auth error with the expected recovery message and only one backend request.

**Call relations**: This test checks the failure branch of unauthorized recovery, where the service detects that reloading auth is unsafe because the signed-in account no longer matches.

*Call graph*: calls 5 internal fn (new, chatgpt_auth_json, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_unauthorized_without_recovery_uses_generic_message`  (lines 801–854)

```
async fn get_bundle_unauthorized_without_recovery_uses_generic_message()
```

**Purpose**: Checks that an unrecoverable unauthorized response is turned into a generic friendly error message. This avoids exposing noisy HTML or backend details to the user.

**Data flow**: It writes auth with a mode that should not use the recovery path, then uses a backend that returns a verbose 401 message. The service returns a standard auth failure message and records one backend request.

**Call relations**: This test uses `UnauthorizedBundleClient` to prove the service sanitizes unauthorized errors when recovery is not attempted or cannot help.

*Call graph*: calls 5 internal fn (new, chatgpt_auth_json_with_mode, write_auth_json, default, new); 4 external calls (new, new, assert_eq!, tempdir).


##### `get_bundle_does_not_use_cache_when_auth_identity_is_incomplete`  (lines 857–897)

```
async fn get_bundle_does_not_use_cache_when_auth_identity_is_incomplete()
```

**Purpose**: Verifies that the service does not trust the cache when the current auth identity is missing required labels. Without a full identity, the service cannot prove the cache belongs to the user.

**Data flow**: It first primes the cache with a normal identity. Then it loads with auth missing the user ID but keeping the account ID, and a backend returns a replacement bundle. The replacement is returned after one backend request.

**Call relations**: This test reinforces the cache safety rule: valid cached content is only usable when the current login has enough identity information to match it.

*Call graph*: calls 6 internal fn (new, new, new, auth_manager_with_plan, auth_manager_with_plan_and_identity, test_bundle); 5 external calls (new, assert_eq!, default, tempdir, vec!).


##### `get_bundle_stops_after_max_retries`  (lines 900–928)

```
async fn get_bundle_stops_after_max_retries()
```

**Purpose**: Checks that retrying has a hard limit. This prevents startup from spending too long on repeated temporary request failures.

**Data flow**: It builds a sequence client that returns retryable errors for every allowed attempt. After advancing test time, loading fails with the standard request-failed error and the request count equals the maximum attempt count.

**Call relations**: This test drives the retry loop to exhaustion, proving the service eventually fails closed instead of retrying forever.

*Call graph*: calls 3 internal fn (new, new, auth_manager_with_plan); 8 external calls (new, from_secs, assert_eq!, tempdir, spawn, yield_now, advance, vec!).


##### `refresh_from_remote_updates_cached_bundle`  (lines 931–963)

```
async fn refresh_from_remote_updates_cached_bundle()
```

**Purpose**: Verifies that an explicit cache refresh can replace the saved bundle with a newer remote bundle. This supports updating managed config after startup.

**Data flow**: It uses a sequence backend that returns an initial bundle for startup and a replacement bundle for refresh. After calling `refresh_cache_once`, it reads the cache and confirms the replacement bundle is stored.

**Call relations**: This test covers the refresh path after startup: the service first loads normally, then fetches again and writes the newer bundle into the same identity-scoped cache.

*Call graph*: calls 4 internal fn (new, new, auth_manager_with_plan, create_test_cache); 6 external calls (new, assert!, assert_eq!, default, tempdir, vec!).


##### `bundle_response_conversion_preserves_fragment_order`  (lines 966–1019)

```
fn bundle_response_conversion_preserves_fragment_order()
```

**Purpose**: Checks that converting a backend response into the internal bundle type keeps fragment order unchanged. Order can matter when multiple configuration fragments are applied.

**Data flow**: It builds a backend-style response with two config fragments and one requirements fragment, converts it with `bundle_from_response`, and compares the result to the expected internal bundle in the same order.

**Call relations**: This test directly exercises the response-conversion helper used by the backend layer before the service receives a `CloudConfigBundle`.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `bundle_response_conversion_treats_missing_sections_as_empty`  (lines 1022–1027)

```
fn bundle_response_conversion_treats_missing_sections_as_empty()
```

**Purpose**: Verifies that a backend response with missing sections becomes an empty bundle. Missing optional fields should not crash conversion or create fake content.

**Data flow**: It passes a newly created empty backend response into `bundle_from_response` and expects the default empty internal bundle.

**Call relations**: This complements the order-preservation conversion test by checking the no-data case that the service may receive from the backend.

*Call graph*: 1 external calls (assert_eq!).


### `cloud-tasks/tests/env_filter.rs`

`test` · `test run`

This is a small automated test for the cloud tasks mock client. In this project, a “backend” is the thing that answers requests such as “show me the tasks,” and the mock client is a fake version used in tests instead of a real cloud service. The important behavior checked here is environment filtering: asking for tasks with no environment, with environment “env-A,” and with environment “env-B” should produce different results.

The test creates a MockClient, then asks CloudBackend::list_tasks for the default task list by passing no environment name. It checks that this default list includes a task whose title mentions “Update README.” Then it asks for tasks in “env-A” and expects exactly one task named “A: First.” Finally, it asks for tasks in “env-B” and expects two tasks, with the first title starting with “B: ”.

An everyday analogy is checking that a library catalog shows different shelves when you pick different rooms. Without this test, the mock backend could accidentally ignore the requested environment, and other tests might pass while using unrealistic data.

#### Function details

##### `mock_backend_varies_by_env`  (lines 5–39)

```
async fn mock_backend_varies_by_env()
```

**Purpose**: This test proves that the mock cloud backend changes its task results based on the requested environment. It is used to catch mistakes where the mock client might return the same task list no matter which environment is requested.

**Data flow**: The test starts with a fresh MockClient. It sends three list-tasks requests through CloudBackend::list_tasks: one with no environment, one with “env-A,” and one with “env-B.” Each response is unwrapped as a successful result, and the returned task titles and counts are checked with assertions. Nothing is returned to the caller; the test passes if all checks are true and fails if any expected task list is wrong.

**Call relations**: During the test run, the test framework calls mock_backend_varies_by_env. The function then calls CloudBackend::list_tasks to ask the mock client for task lists, and uses assertion checks to confirm the answers match the expected environment-specific data.

*Call graph*: 3 external calls (assert!, assert_eq!, list_tasks).


### `codex-home/src/instructions/tests.rs`

`test` · `test run`

These tests protect a small but important user-facing behavior: Codex can read written instructions from files in its home folder, and those instructions affect how the system behaves. The tests create temporary home folders, place different versions of the instruction files inside them, and then ask the instruction provider what it loaded.

The main rule being checked is priority. A local override file should win over the default instruction file when it contains real text. But if the override is empty, unreadable in a recoverable way, or is a directory instead of a file, Codex should fall back to the default file. That is like checking a note on your desk first, but using the standard handbook if the note is blank or unusable.

The file also checks two edge cases. If no instruction files exist, Codex should return no instructions rather than fail. If a file contains bytes that are not valid UTF-8 text, Codex should still load it using replacement characters instead of crashing. Together, these tests make sure instruction loading is forgiving, predictable, and clear about warnings when something goes wrong.

#### Function details

##### `provider`  (lines 15–19)

```
fn provider(home: &TempDir) -> CodexHomeUserInstructionsProvider
```

**Purpose**: Builds a `CodexHomeUserInstructionsProvider` pointed at a temporary test home directory. Tests use it so they can exercise instruction loading without touching a real user's files.

**Data flow**: It receives a temporary directory, takes its filesystem path, converts that path into the absolute-path type expected by the production code, and returns a ready-to-use instruction provider.

**Call relations**: This is a small setup helper. In the call graph it is used by `invalid_utf8_is_lossy` when that test needs to load instructions from its temporary folder. It hands off to the provider constructor so the test can focus on behavior, not setup details.

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

**Purpose**: Builds the expected result object that tests compare against the provider's actual output. It keeps the assertions readable by packaging the expected instruction text, source file path, and warnings in one place.

**Data flow**: It receives the temporary home directory, the expected filename, the expected text, and any expected warning messages. It joins the directory and filename into an absolute source path, wraps the text and path as loaded user instructions, and returns the complete expected result.

**Call relations**: This helper supports the test assertions. The tests use its returned value as the benchmark for what `load_user_instructions` should produce after reading files from the temporary home directory.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (path).


##### `create_symlink_loop`  (lines 47–53)

```
fn create_symlink_loop(path: &Path)
```

**Purpose**: Creates a deliberately broken symbolic link so a test can simulate a file that exists but cannot be read. A symbolic link is a filesystem shortcut; here it points back to itself, forming a loop.

**Data flow**: It receives the path where the fake override file should be. It takes that path's filename and creates a symlink at that path that points to the same name, producing a loop. It does not return a value, but it changes the temporary filesystem.

**Call relations**: `recoverable_override_read_error_warns_and_falls_back_to_default` calls this helper to create a controlled read failure. The helper uses the Unix or Windows symlink API depending on the operating system, so the same test idea works across platforms.

*Call graph*: called by 1 (recoverable_override_read_error_warns_and_falls_back_to_default); 3 external calls (file_name, symlink, symlink_file).


##### `missing_files_return_no_instructions`  (lines 56–63)

```
async fn missing_files_return_no_instructions()
```

**Purpose**: Checks that Codex behaves calmly when no instruction files are present. The expected result is an empty/default loaded-instructions value, not an error.

**Data flow**: It creates a fresh temporary directory with no instruction files. It asks the provider to load instructions from that directory, then compares the result with the default empty result.

**Call relations**: This is one of the baseline behavior tests. It drives the instruction provider directly and verifies that the provider's first decision point, 'are there any files to read?', produces a safe empty answer.

*Call graph*: 2 external calls (new, assert_eq!).


##### `override_takes_precedence_over_default`  (lines 66–75)

```
async fn override_takes_precedence_over_default()
```

**Purpose**: Checks that the local override instruction file wins when both the default and override files exist. This confirms the user's more specific instructions are preferred.

**Data flow**: It creates a temporary home directory, writes a default instruction file containing `default`, and writes an override file containing `override`. It loads instructions and expects the returned text and source path to come from the override file, with no warnings.

**Call relations**: This test exercises the provider's priority rule. After setting up both files, it asks the provider to load instructions and compares the outcome with the expected override-based result.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `empty_override_falls_back_to_trimmed_default`  (lines 78–96)

```
async fn empty_override_falls_back_to_trimmed_default()
```

**Purpose**: Checks that a blank override file does not hide useful default instructions. It also confirms that surrounding whitespace is trimmed from the loaded instruction text.

**Data flow**: It writes an override file containing only spaces, a newline, and a tab. It writes a default file with extra whitespace around the real words. After loading, it expects Codex to ignore the blank override, use the default file, trim the default text, and return no warnings.

**Call relations**: This test sits between priority and cleanup behavior. It verifies that the provider first rejects an override with no meaningful content, then falls back to the default file and normalizes its text before returning it.

*Call graph*: 3 external calls (new, assert_eq!, write).


##### `directory_override_falls_back_to_default`  (lines 99–108)

```
async fn directory_override_falls_back_to_default()
```

**Purpose**: Checks that if the override path is a directory instead of a readable file, Codex still uses the default instructions. This protects against odd filesystem states causing instruction loading to fail completely.

**Data flow**: It creates a temporary home directory, makes a directory where the override file would normally be, and writes a default instruction file. It loads instructions and expects the default text and default source path, with no warnings.

**Call relations**: This test drives the provider through a filesystem edge case. It sets up an unusable override location, then verifies the provider continues to the default file rather than stopping.

*Call graph*: 4 external calls (new, assert_eq!, create_dir, write).


##### `recoverable_override_read_error_warns_and_falls_back_to_default`  (lines 111–126)

```
async fn recoverable_override_read_error_warns_and_falls_back_to_default()
```

**Purpose**: Checks that a recoverable read error in the override file produces a warning and does not prevent default instructions from loading. This makes failures visible without making them fatal.

**Data flow**: It creates a temporary home directory, uses `create_symlink_loop` to make the override path unreadable, writes a default file, and reads the broken path once to capture the operating system's exact error message. It builds the warning text Codex should return, then loads instructions and expects the default instructions plus that warning.

**Call relations**: This test calls `create_symlink_loop` to prepare the bad override file. It then drives the provider through the error path and checks that the provider both reports the problem and hands back usable default instructions.

*Call graph*: calls 1 internal fn (create_symlink_loop); 5 external calls (new, assert_eq!, format!, read, write).


##### `invalid_utf8_is_lossy`  (lines 129–147)

```
async fn invalid_utf8_is_lossy()
```

**Purpose**: Checks that Codex can still load an instruction file containing bytes that are not valid UTF-8 text. Instead of failing, the invalid byte is replaced with the standard replacement character.

**Data flow**: It creates a temporary home directory and writes a default instruction file as raw bytes: normal text, one invalid byte, then more normal text. It loads instructions through `provider`, and expects the returned text to contain `global� doc`, with no warnings.

**Call relations**: This test uses the `provider` helper to create the instruction provider for its temporary directory. It then verifies the provider's text-decoding behavior, making sure bad bytes are converted into readable placeholder characters instead of breaking instruction loading.

*Call graph*: calls 1 internal fn (provider); 3 external calls (new, assert_eq!, write).


### Permissions, sandbox, and network policy
These tests define how permission profiles, proxy and network rules, sandbox transforms, Windows sandbox behavior, and execution environments are interpreted and enforced.

### `core/src/config/permissions_tests.rs`

`test` · `test run`

This is a test file, not production code. Its job is to act like a safety checklist for the permission system. Permissions are the rules that decide what Codex may read, write, or connect to while working in a project. If these tests failed or disappeared, subtle mistakes could let Codex read the wrong files, block needed helper programs, misunderstand Windows paths, or apply network rules incorrectly.

The tests build small example configurations, often written as TOML, which is a human-readable configuration format. They then ask the real configuration code to parse, merge, and compile those examples into sandbox policies. A sandbox policy is like a set of guardrails: it says which paths or network destinations are inside the safe area and which are outside.

The file covers several important edges. It checks that Windows verbatim paths such as `\\?\D:\...` are treated as normal paths, not as glob patterns. A glob is a wildcard pattern like `**/*.env`. It checks that restricted filesystem access still allows Codex's own helper executables, but not unrelated neighboring helper folders. It also checks network permission overlays, permission profile inheritance, invalid inheritance, workspace roots, and warnings for unsupported glob rules.

Overall, this file matters because permission code is security-sensitive. These tests make sure convenience features and configuration merging do not accidentally weaken the sandbox.

#### Function details

##### `normalize_absolute_path_for_platform_simplifies_windows_verbatim_paths`  (lines 26–32)

```
fn normalize_absolute_path_for_platform_simplifies_windows_verbatim_paths()
```

**Purpose**: This test checks that a Windows verbatim path prefix is cleaned up into an ordinary Windows path. That matters because later permission checks should compare normal-looking paths, not two different spellings of the same location.

**Data flow**: It starts with a Windows path string that begins with `\\?\`, which is a Windows marker for a special long-path form. It passes that string into the path-normalizing code with Windows behavior turned on. The expected result is a simpler `D:\...` path, and the test compares the two.

**Call relations**: During the test run, this directly exercises the platform-aware path normalization helper from the permissions code. It does not hand work to other project functions beyond that check; it simply proves that the helper produces the path shape the rest of the permission system expects.

*Call graph*: 1 external calls (assert_eq!).


##### `windows_verbatim_path_prefix_does_not_count_as_glob_syntax`  (lines 35–44)

```
fn windows_verbatim_path_prefix_does_not_count_as_glob_syntax()
```

**Purpose**: This test makes sure the `?` character in a Windows verbatim path prefix is not mistaken for wildcard syntax. Without this, a perfectly normal Windows path could be treated as a glob pattern and rejected or warned about incorrectly.

**Data flow**: It feeds two Windows-style strings into the glob-detection code. The first has only the `\\?\` prefix and should not count as a glob. The second contains real wildcard pieces, `**` and `*`, and should count as a glob.

**Call relations**: This test calls the platform-aware glob detection helper exactly where permission parsing would depend on it. It checks the helper's yes-or-no answers before any later permission compilation would use those answers.

*Call graph*: 1 external calls (assert!).


##### `restricted_read_implicitly_allows_helper_executables`  (lines 47–112)

```
async fn restricted_read_implicitly_allows_helper_executables() -> std::io::Result<()>
```

**Purpose**: This test verifies that a restricted workspace permission profile still allows Codex to read its own required helper executables. It also checks that this allowance is narrow and does not accidentally include a sibling helper directory from another session.

**Data flow**: It creates a temporary fake workspace, a fake Codex home directory, a fake `zsh` helper, and a fake exec wrapper directory. It loads a configuration with restricted workspace permissions and these helper paths supplied as overrides. Then it asks the compiled filesystem sandbox whether it can read the helper paths and an unrelated sibling path. The helpers should be readable; the sibling should not.

**Call relations**: This is a fuller integration-style test for configuration loading. It calls the real configuration loader, which compiles permissions into a filesystem sandbox policy. After that, the test queries the policy directly to confirm the loader added the special helper allowances needed for normal operation.

*Call graph*: calls 2 internal fn (from_absolute_path, try_from); 8 external calls (from, new, default, new, load_from_base_config_with_overrides, assert!, create_dir_all, write).


##### `network_toml_ignores_legacy_network_list_keys`  (lines 115–124)

```
fn network_toml_ignores_legacy_network_list_keys()
```

**Purpose**: This test checks that an old-style network configuration key is ignored rather than misread. That keeps older or stray config fields from silently changing the active network policy.

**Data flow**: It parses a small TOML snippet containing `allowed_domains`, a legacy list-style key. The parsed result should be the same as an empty default network configuration.

**Call relations**: This test exercises the TOML deserialization path for network settings. It confirms that unknown or legacy list keys do not feed into the newer network permission structures.

*Call graph*: 1 external calls (assert_eq!).


##### `network_permission_containers_project_allowed_and_denied_entries`  (lines 127–182)

```
fn network_permission_containers_project_allowed_and_denied_entries()
```

**Purpose**: This test checks that network permission containers can separate allowed entries from denied ones. It covers both domain names, such as `api.example.com`, and Unix socket paths, which are local file-like communication endpoints on Unix systems.

**Data flow**: It builds domain and Unix socket permission maps with a mix of allow and deny values. It then asks the containers for their allowed domains, denied domains, and allowed socket paths. The returned lists should include only the entries of the requested kind.

**Call relations**: This test sits close to the data model for network permissions. It verifies the projection helpers that later configuration code uses when converting human-written TOML into network proxy rules.

*Call graph*: 2 external calls (from, assert_eq!).


##### `network_toml_overlays_unix_socket_permissions_by_path`  (lines 185–241)

```
fn network_toml_overlays_unix_socket_permissions_by_path()
```

**Purpose**: This test verifies that applying network Unix socket settings more than once merges them by socket path. If a later configuration mentions the same path, it should replace the earlier permission for that path while keeping unrelated paths.

**Data flow**: It starts with an empty network proxy configuration. It applies one TOML network section with two allowed socket paths. Then it applies another section with a new socket and an override that denies a previously allowed socket. The final proxy config should contain the base path, the extra path, and the overridden denied path.

**Call relations**: This test exercises the method that copies network TOML settings into the runtime network proxy configuration. It reflects how layered configuration works: base settings are applied first, then later settings refine or replace individual entries.

*Call graph*: 4 external calls (from, default, assert_eq!, default).


##### `permissions_profiles_resolve_extends_parent_first_with_child_overrides`  (lines 244–330)

```
fn permissions_profiles_resolve_extends_parent_first_with_child_overrides()
```

**Purpose**: This test checks permission profile inheritance. A child profile should start with its parent's filesystem and network rules, then override or add its own entries.

**Data flow**: It parses TOML with a `base` profile and a `child` profile that extends it. The base and child both define filesystem paths, project-root scoped paths, network switches, domains, and Unix sockets. The test resolves the child profile and compares it with the exact merged profile expected: parent entries first, child replacements where names overlap, and child additions included.

**Call relations**: This test drives the profile resolver, the part of the configuration system that turns inherited permission profiles into one concrete profile. Later permission compilation depends on this resolved profile, so this test confirms the merge rules before sandbox policies are built.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_undefined_extends_parent`  (lines 333–350)

```
fn permissions_profiles_reject_undefined_extends_parent()
```

**Purpose**: This test makes sure a profile cannot extend a parent profile that does not exist. That prevents a typo from silently producing a weaker or incomplete permission setup.

**Data flow**: It parses TOML where `child` says it extends `base`, but no `base` profile is defined. It then tries to resolve `child`. The expected output is an error message explaining that the parent profile is undefined.

**Call relations**: This test calls the same profile resolution step used during configuration loading. It focuses on the failure path, confirming that bad inheritance stops early instead of being passed on to later permission compilation.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_unsupported_builtin_extends_parent`  (lines 353–370)

```
fn permissions_profiles_reject_unsupported_builtin_extends_parent()
```

**Purpose**: This test verifies that a profile cannot extend an unsupported built-in profile name. Built-in names beginning with `:` have special meaning, so accepting the wrong one could create confusing or unsafe behavior.

**Data flow**: It parses a profile that extends `:danger-full-access`. It asks the resolver to resolve that profile. The result should be an error saying this built-in parent is not supported for extension.

**Call relations**: This test exercises a guard inside profile resolution. It ensures special built-in permission profiles are only accepted where the resolver explicitly supports them.

*Call graph*: 1 external calls (assert_eq!).


##### `permissions_profiles_reject_extends_cycles`  (lines 373–393)

```
fn permissions_profiles_reject_extends_cycles()
```

**Purpose**: This test checks that permission profiles cannot inherit from each other in a loop. A loop such as `alpha` extending `beta` and `beta` extending `alpha` would otherwise make resolution impossible.

**Data flow**: It parses two profiles that point at each other through `extends`. It tries to resolve `alpha`. The expected output is an error that spells out the cycle: `alpha -> beta -> alpha`.

**Call relations**: This test exercises the cycle detection in the profile resolver. It confirms the resolver stops with a clear error instead of recursing forever or producing a partial profile.

*Call graph*: 1 external calls (assert_eq!).


##### `profile_network_proxy_config_keeps_proxy_disabled_for_bare_network_access`  (lines 396–403)

```
fn profile_network_proxy_config_keeps_proxy_disabled_for_bare_network_access()
```

**Purpose**: This test checks that simply enabling network access in a permission profile does not automatically turn on the network proxy. The proxy is a separate enforcement tool, so bare network access should not be treated as a full proxy policy.

**Data flow**: It creates a profile network section with `enabled` set to true and no other proxy-specific settings. It converts that section into a network proxy configuration. The resulting proxy configuration should still have the proxy disabled.

**Call relations**: This test calls the conversion helper that prepares network proxy settings from a profile. It confirms that higher-level permission intent is not confused with actually starting or enabling proxy enforcement.

*Call graph*: 2 external calls (default, assert!).


##### `profile_network_proxy_config_keeps_proxy_disabled_for_proxy_policy`  (lines 406–432)

```
fn profile_network_proxy_config_keeps_proxy_disabled_for_proxy_policy()
```

**Purpose**: This test verifies that proxy-related settings can be copied into the proxy configuration without turning the proxy on. It separates storing proxy policy details from enabling the proxy itself.

**Data flow**: It builds a network TOML section with network enabled, a proxy URL, SOCKS5 disabled, and one allowed domain. It converts that into proxy configuration. The output should preserve the URL, SOCKS5 setting, and domain permission, while still leaving the proxy disabled.

**Call relations**: This test exercises the profile-to-proxy conversion path. It shows that the conversion can prepare policy data for later use, but does not itself decide that the proxy should run.

*Call graph*: 4 external calls (from, default, assert!, assert_eq!).


##### `compile_permission_profile_workspace_roots_resolves_enabled_entries`  (lines 435–467)

```
fn compile_permission_profile_workspace_roots_resolves_enabled_entries() -> std::io::Result<()>
```

**Purpose**: This test checks that configured workspace roots are turned into absolute paths, but only when they are enabled. Workspace roots are project directories Codex should treat as part of the working area.

**Data flow**: It creates a temporary current directory and a permission profile with two workspace root entries: `backend` enabled and `disabled` turned off. It compiles workspace roots for that profile. The result should contain only the absolute path to `backend` resolved relative to the temporary current directory.

**Call relations**: This test calls the workspace-root compilation helper directly. That helper feeds later filesystem permission compilation, where these roots become special project locations inside sandbox rules.

*Call graph*: 3 external calls (from, new, assert_eq!).


##### `read_write_glob_warnings_skip_supported_deny_read_globs_and_trailing_subpaths`  (lines 470–501)

```
fn read_write_glob_warnings_skip_supported_deny_read_globs_and_trailing_subpaths()
```

**Purpose**: This test checks which filesystem glob patterns should produce warnings. Deny-read glob patterns are supported, and trailing subtree forms like `docs/**` are treated specially, but read or write glob patterns in the middle of a path are not supported.

**Data flow**: It builds a filesystem permission section with several patterns: read and write globs, a supported deny glob, and a trailing subtree pattern. It asks for unsupported read/write glob paths. The result should include only the read/write patterns that are real unsupported globs, not the deny glob or the trailing subtree form.

**Call relations**: This test exercises the warning helper used during configuration checks. It helps ensure users are warned about rules that will not work as broad read/write globs, while avoiding false alarms for supported deny rules.

*Call graph*: 4 external calls (from, assert_eq!, Access, Scoped).


##### `unreadable_globstar_warning_is_suppressed_when_scan_depth_is_configured`  (lines 504–529)

```
fn unreadable_globstar_warning_is_suppressed_when_scan_depth_is_configured()
```

**Purpose**: This test checks warning behavior for deny-read patterns that use `**`, often called a globstar, meaning it can match across folders. Such patterns may require scanning many directories, so they should warn unless a scan depth limit is configured.

**Data flow**: It creates filesystem permissions with deny patterns under workspace roots, including `**/*.env`. First, with no scan depth set, it asks for unbounded globstar paths and expects the `**/*.env` path to be reported. Then it sets `glob_scan_max_depth` to 2 and asks again. This time the result should be empty.

**Call relations**: This test calls the helper that finds deny-read globstar rules that could scan without a bound. It confirms that the presence of a configured depth limit changes the warning outcome.

*Call graph*: 3 external calls (from, assert_eq!, Scoped).


##### `glob_scan_max_depth_must_be_positive`  (lines 532–542)

```
fn glob_scan_max_depth_must_be_positive()
```

**Purpose**: This test ensures the configured glob scan depth cannot be zero. A zero depth would look valid but would silently prevent deny-read glob expansion from finding files.

**Data flow**: It validates a scan depth of zero and expects an invalid-input error with a clear message. It then validates a depth of two and expects that value to be accepted and returned.

**Call relations**: This test exercises the validation helper for glob scanning limits. That validation protects later permission compilation from receiving a setting that would make deny-read glob behavior misleading.

*Call graph*: 1 external calls (assert_eq!).


##### `read_write_trailing_glob_suffix_compiles_as_subpath`  (lines 545–586)

```
fn read_write_trailing_glob_suffix_compiles_as_subpath() -> std::io::Result<()>
```

**Purpose**: This test checks that a read or write rule ending in `/**` is treated as access to a whole subtree, not as a general wildcard glob. For example, `docs/**` should mean “the docs folder and everything under it.”

**Data flow**: It creates a temporary current directory and a permission profile with a workspace-root scoped read rule for `docs/**`. It compiles the profile into a filesystem sandbox policy. The expected policy contains a special project-root path for the `docs` subpath with read access.

**Call relations**: This test calls the full permission profile compiler. It verifies that the compiler turns a user-friendly trailing subtree pattern into the structured sandbox entry used by runtime filesystem checks.

*Call graph*: 5 external calls (from, new, new, assert_eq!, Scoped).


##### `read_write_glob_patterns_still_reject_non_subpath_globs`  (lines 589–599)

```
fn read_write_glob_patterns_still_reject_non_subpath_globs()
```

**Purpose**: This test makes sure normal read/write permissions cannot use broad glob patterns such as `src/**/*.rs`. Only deny rules support that kind of pattern, while read/write rules must point to concrete paths or simple subtrees.

**Data flow**: It passes `src/**/*.rs` with read access into the read/write glob compilation helper. The expected result is an invalid-input error saying that this filesystem glob path only supports deny access.

**Call relations**: This test checks the rejection path of the read/write glob compiler. It complements the subtree test by showing that only trailing subtree syntax is accepted for read/write, while deeper wildcard matching is blocked.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `core/src/config/network_proxy_spec_tests.rs`

`test` · `test run`

This is a test file for the network proxy configuration. The network proxy is the part of the system that acts like a gatekeeper for outbound network access: some domain names may be allowed, some may be denied, and some rules may come from a managed policy rather than the user. These tests check that the gatekeeper is built correctly in many edge cases.

The main idea is that there can be two sources of truth. A user may choose allow or deny rules, but an organization or managed environment may also provide required rules. This file verifies how those two sets combine. For example, a managed allowlist can become a baseline that user entries are added to, but user deny rules should not be silently erased. In stricter modes, managed rules can replace user choices entirely, like a building security desk ignoring a personal guest list and using only the company-approved list.

The tests also cover permission profiles, including normal restricted modes and full-access mode. Full access does not always mean managed network policy disappears; some managed allow or deny entries still stay fixed. Finally, the file checks that audit metadata, such as conversation ID and app version, is carried into the built proxy state so later logging can explain where network decisions came from.

#### Function details

##### `domain_permissions`  (lines 10–19)

```
fn domain_permissions(
    entries: impl IntoIterator<Item = (&'static str, NetworkDomainPermissionToml)>,
) -> NetworkDomainPermissionsToml
```

**Purpose**: This helper builds a managed domain-permission table for the tests. It lets each test write a small list like “this pattern is allowed” or “this domain is denied” without repeating the setup code.

**Data flow**: It receives pairs of domain patterns and permissions. It turns each pattern into an owned string, collects the pairs into the TOML-style permissions structure used by configuration loading, and returns that structure for a test to place inside network constraints.

**Call relations**: Many tests call this helper before calling `from_config_and_constraints`. It prepares the managed requirements that those tests then use to check whether allow and deny rules are merged, fixed, ignored, or expanded correctly.

*Call graph*: called by 11 (allow_only_requirements_do_not_create_deny_constraints_in_full_access, danger_full_access_keeps_managed_allowlist_and_denylist_fixed, deny_only_requirements_do_not_create_allow_constraints_in_full_access, managed_allowed_domains_only_disables_default_mode_allowlist_expansion, managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses, managed_unrestricted_profile_allows_domain_expansion, requirements_allowed_domains_are_a_baseline_for_user_allowlist, requirements_allowed_domains_do_not_override_user_denies_for_same_pattern, requirements_allowlist_expansion_keeps_user_entries_mutable, requirements_denied_domains_are_a_baseline_for_default_mode (+1 more)); 1 external calls (into_iter).


##### `build_state_with_audit_metadata_threads_metadata_to_state`  (lines 22–41)

```
fn build_state_with_audit_metadata_threads_metadata_to_state()
```

**Purpose**: This test checks that audit details are not lost when a network proxy state is built. Audit metadata is extra information, such as conversation ID or app version, that helps explain later why a network decision happened.

**Data flow**: It starts with a default network proxy specification and a metadata object containing sample audit fields. It builds a proxy state from that specification and metadata, then checks that the resulting state contains exactly the same metadata.

**Call relations**: This test focuses on the state-building path rather than rule merging. It calls the spec’s state-building method and uses equality checks to confirm the metadata was threaded through unchanged.

*Call graph*: 4 external calls (assert_eq!, default, default, default).


##### `requirements_allowed_domains_are_a_baseline_for_user_allowlist`  (lines 44–76)

```
fn requirements_allowed_domains_are_a_baseline_for_user_allowlist()
```

**Purpose**: This test verifies that managed allowed domains become a baseline, while user allowed domains can still be added in the normal restricted setup. In plain terms, the company-approved list is kept, and the user’s extra allowed domain is added beside it.

**Data flow**: It starts with user configuration allowing `api.example.com` and managed requirements allowing `*.example.com`. It builds a network proxy spec using a read-only permission profile, then checks that the final allowlist contains both entries and that the managed constraint records only the managed pattern.

**Call relations**: The test uses `domain_permissions` to create the managed allow rule, then calls `from_config_and_constraints` to combine requirements with user config. The assertions confirm the combined policy and the stored constraints match the expected baseline-plus-user behavior.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, read_only); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_allowed_domains_do_not_override_user_denies_for_same_pattern`  (lines 79–108)

```
fn requirements_allowed_domains_do_not_override_user_denies_for_same_pattern()
```

**Purpose**: This test checks that a managed allow rule does not erase a user’s explicit deny rule for the same domain. A user block should remain visible and effective instead of being quietly converted into an allow.

**Data flow**: It starts with user configuration denying `api.example.com` and managed requirements allowing that same domain. It builds a spec under a workspace-write profile, then verifies that the user deny remains in the config, no user allow is created, and the managed allowed domain is still recorded as a constraint.

**Call relations**: The test prepares managed requirements with `domain_permissions`, then sends both user config and requirements into `from_config_and_constraints`. Its assertions guard the conflict behavior between managed allow rules and user deny rules.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_allowlist_expansion_keeps_user_entries_mutable`  (lines 111–148)

```
fn requirements_allowlist_expansion_keeps_user_entries_mutable()
```

**Purpose**: This test makes sure user-added allowlist entries are still editable after managed allowlist rules are applied. The managed baseline should be protected, but user additions should not become locked rules by accident.

**Data flow**: It begins with a user allow entry and a managed wildcard allow entry. After building the spec, it copies the resulting config and changes the user domain from allowed to denied. It then checks that the managed allow remains, the user domain moves to the denylist, and validation still accepts the policy because only the managed entry is fixed.

**Call relations**: The test uses `domain_permissions` and `from_config_and_constraints` to create a policy with allowlist expansion enabled. It then exercises later policy validation with `validate_policy_against_constraints` to prove that user-owned entries remain movable.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_unrestricted_profile_allows_domain_expansion`  (lines 151–183)

```
fn managed_unrestricted_profile_allows_domain_expansion()
```

**Purpose**: This test checks a managed profile where the file system is unrestricted but the network is still restricted. It confirms that loose file access does not disable managed network constraints.

**Data flow**: It starts with a user allow entry, a managed wildcard allow rule, and a managed permission profile whose file-system setting is unrestricted while network access remains restricted. It builds the spec and checks that both managed and user allowed domains are present, with allowlist expansion turned on.

**Call relations**: The test feeds prepared managed domain requirements into `from_config_and_constraints` along with a custom managed permission profile. It proves that network policy is decided from the network part of the profile, not from the unrelated file-system freedom.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `danger_full_access_keeps_managed_allowlist_and_denylist_fixed`  (lines 186–219)

```
fn danger_full_access_keeps_managed_allowlist_and_denylist_fixed()
```

**Purpose**: This test checks full-access mode when managed allow and deny rules are present. Even in the most permissive profile, managed network rules can pin the final policy to the managed baseline.

**Data flow**: It starts with user allow and deny entries, plus managed requirements that allow one pattern and deny another domain. It builds a spec with the disabled permission profile, then checks that the final config keeps only the managed allow and managed deny entries, with both allowlist and denylist expansion disabled.

**Call relations**: The test uses `domain_permissions` to create both allow and deny managed rules, then calls `from_config_and_constraints` in full-access mode. Its assertions document that managed policy can override user network choices and prevent later expansion.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_disables_default_mode_allowlist_expansion`  (lines 222–248)

```
fn managed_allowed_domains_only_disables_default_mode_allowlist_expansion()
```

**Purpose**: This test verifies that the `managed_allowed_domains_only` setting stops users from expanding the allowlist in the default restricted mode. When this switch is on, only managed allowed domains should remain allowed.

**Data flow**: It starts with a user allow entry, a managed wildcard allow entry, and the managed-only flag set. It builds the spec under a workspace-write profile, then checks that the user allow entry is removed and allowlist expansion is disabled.

**Call relations**: The test builds managed requirements with `domain_permissions` and passes them into `from_config_and_constraints`. It confirms that the managed-only flag changes the normal baseline-plus-user behavior into a managed-list-only behavior.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses`  (lines 251–282)

```
fn managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses()
```

**Purpose**: This test checks that managed-only allowlist mode ignores user allowed domains and treats anything not on the managed list as firmly blocked. This matters because otherwise a user allowlist could weaken a managed security policy.

**Data flow**: It starts with a user allow entry and a managed allow entry, with `managed_allowed_domains_only` enabled. It builds the spec, then checks that only the managed domain is allowed, the constraints contain that same managed domain, expansion is disabled, and unmatched allowlist misses are hard-denied.

**Call relations**: The test uses `domain_permissions` to create the managed allowlist and `from_config_and_constraints` to apply it. The assertions check both the visible config and the stricter internal flag that makes non-managed domains fail closed.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains`  (lines 285–306)

```
fn managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains()
```

**Purpose**: This test covers the case where managed-only allowlist mode is enabled but no managed allowlist is provided. The expected safe behavior is to allow no user domains at all.

**Data flow**: It starts with a user allow entry and requirements that only say managed allowed domains are required, without listing any domains. It builds the spec under a workspace-write profile, then checks that the final allowlist is empty or absent, the constraints store an empty managed allowlist, expansion is disabled, and misses are hard-denied.

**Call relations**: Unlike many neighboring tests, this one does not need `domain_permissions` because there are no managed domain entries. It calls `from_config_and_constraints` to show that a missing managed list is treated as an empty locked list, not as permission to keep user entries.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list`  (lines 309–330)

```
fn managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list()
```

**Purpose**: This test repeats the missing-managed-allowlist case in full-access mode. It confirms that full access still does not bypass the managed-only network rule.

**Data flow**: It starts with a user allow entry and requirements that enable managed-only allowed domains but provide no actual managed domains. It builds the spec using the disabled permission profile, then checks that no user domains remain allowed, the constraint allowlist is an empty list, expansion is disabled, and allowlist misses are hard-denied.

**Call relations**: The test calls `from_config_and_constraints` without creating managed domain entries. It protects the rule that managed-only network policy still applies even when the broad permission profile would otherwise sound permissive.

*Call graph*: calls 1 internal fn (from_config_and_constraints); 5 external calls (default, assert!, assert_eq!, default, vec!).


##### `deny_only_requirements_do_not_create_allow_constraints_in_full_access`  (lines 333–363)

```
fn deny_only_requirements_do_not_create_allow_constraints_in_full_access()
```

**Purpose**: This test checks that managed deny-only requirements do not accidentally create allowlist restrictions in full-access mode. A rule saying “block this domain” should not also mean “only allow these other domains.”

**Data flow**: It starts with a user allow entry and a managed deny entry. It builds the spec in full-access mode, then checks that the user allow entry remains, no allow constraints are created, allowlist expansion remains unset, and the managed denied domain appears in the final denylist.

**Call relations**: The test uses `domain_permissions` for the managed deny rule and passes the setup to `from_config_and_constraints`. Its assertions make sure allow and deny sides of the policy stay separate when only denies are managed.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `allow_only_requirements_do_not_create_deny_constraints_in_full_access`  (lines 366–396)

```
fn allow_only_requirements_do_not_create_deny_constraints_in_full_access()
```

**Purpose**: This test checks the mirror case: managed allow-only requirements should not accidentally create denylist restrictions in full-access mode. Saying “these domains are allowed” should not lock down which domains may be denied.

**Data flow**: It starts with a user deny entry and a managed allow entry. It builds the spec in full-access mode, then checks that the managed allow entry becomes the allowlist, the user deny entry remains, and no managed deny constraints or denylist expansion settings are created.

**Call relations**: The test prepares the managed allow rule with `domain_permissions` and calls `from_config_and_constraints`. It documents that the allow side of managed policy does not invent deny-side constraints.

*Call graph*: calls 2 internal fn (from_config_and_constraints, domain_permissions); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_denied_domains_are_a_baseline_for_default_mode`  (lines 399–431)

```
fn requirements_denied_domains_are_a_baseline_for_default_mode()
```

**Purpose**: This test verifies that managed denied domains become a baseline in the default restricted mode, while user denied domains can be added too. It is the denylist version of the baseline-plus-user behavior.

**Data flow**: It starts with a user denied domain and a managed denied domain. It builds the spec under a workspace-write profile, then checks that the final denylist contains both entries, the constraints record only the managed denied domain, and denylist expansion is enabled.

**Call relations**: The test creates managed deny requirements with `domain_permissions`, then calls `from_config_and_constraints`. The assertions ensure that managed denies are protected while still allowing user-specific blocks.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


##### `requirements_denylist_expansion_keeps_user_entries_mutable`  (lines 434–471)

```
fn requirements_denylist_expansion_keeps_user_entries_mutable()
```

**Purpose**: This test makes sure user denylist entries stay editable after a managed denylist baseline is applied. A user block should be removable or changeable without being mistaken for a required managed block.

**Data flow**: It starts with a user denied domain and a managed denied domain. After building the spec, it copies the config and changes the user domain from denied to allowed. It checks that the user domain appears in the allowlist, the managed denied domain remains denied, and validation succeeds because the user deny was not treated as a fixed constraint.

**Call relations**: The test uses `domain_permissions` and `from_config_and_constraints` to create a policy with denylist expansion. It then calls validation on a modified candidate config to prove only the managed deny entry is locked by constraints.

*Call graph*: calls 3 internal fn (from_config_and_constraints, domain_permissions, workspace_write); 4 external calls (default, assert_eq!, default, vec!).


### `core/src/network_proxy_loader_tests.rs`

`test` · `test run`

This is a test file for the code that builds network proxy configuration. The network proxy decides which web domains, local sockets, and special request-modifying rules are allowed. That is security-sensitive, so the project needs careful tests for how settings are combined.

The main idea tested here is layering. Configuration can come from several places, such as system files, managed files, or session flags. A later or higher-priority layer can add to earlier settings or override them. Think of it like editing a shared checklist: adding a new allowed site should not erase unrelated entries, but changing the rule for the same site should replace the older rule.

The tests also cover permission profiles. A profile can inherit from another profile, including built-in profiles such as `:workspace`. The file checks that inherited network settings are resolved correctly, and that if the final selected profile is a built-in profile with no custom network table, old custom settings are not accidentally kept.

Another important area is normalization: domain names like `EXAMPLE.COM` and `example.com` must be treated as the same domain before layers are merged. The file also checks trusted network constraints, which are restrictions from trusted config sources, and execution policy rules, which can add allow or deny decisions on top of config.

#### Function details

##### `higher_precedence_profile_network_overlays_domain_entries`  (lines 17–65)

```
fn higher_precedence_profile_network_overlays_domain_entries()
```

**Purpose**: Checks that a higher-priority permission profile can add new network domain rules without deleting unrelated rules from a lower-priority profile. This protects users from losing earlier allow or deny entries just because another layer adds more domains.

**Data flow**: The test starts with two TOML snippets: a lower layer with one allowed domain and one denied domain, and a higher layer with another allowed domain. It parses both snippets, applies them to a fresh network proxy config in order, then checks the finished config. The result should contain both allowed domains and still keep the denied domain from the lower layer.

**Call relations**: During the test run, Rust's test harness calls this function. Inside, it uses TOML parsing, default config creation, the network table extraction and applying code from the surrounding module, and equality checks to confirm that layered domain entries are combined correctly.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `higher_precedence_profile_network_overrides_matching_domain_entries`  (lines 68–113)

```
fn higher_precedence_profile_network_overrides_matching_domain_entries()
```

**Purpose**: Checks that when two layers mention the same domain, the higher-priority layer wins. This matters because a later config must be able to correct or intentionally replace an earlier network decision.

**Data flow**: The test feeds in a lower TOML layer where `shared.example.com` is denied and `other.example.com` is allowed, then a higher layer where `shared.example.com` is allowed. After parsing and applying both layers, the final config should allow both `other.example.com` and `shared.example.com`, and it should have no denied domains left.

**Call relations**: The test harness calls this as an independent test. It relies on TOML parsing and the network table application path, then uses assertions to prove that matching domain entries are overwritten rather than duplicated or left in conflict.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `higher_precedence_profile_network_overrides_named_mitm_actions`  (lines 116–183)

```
fn higher_precedence_profile_network_overrides_named_mitm_actions()
```

**Purpose**: Checks that named MITM actions can be overridden by a higher-priority layer while hooks that refer to that action still use the updated definition. MITM here means “man-in-the-middle,” a proxy feature that can inspect or alter matching network requests.

**Data flow**: The lower TOML layer defines full network mode, an allowed domain, a MITM hook for GitHub write requests, and a named action that strips the `authorization` header. The higher layer adds another allowed domain and redefines that same action to strip `x-api-key` instead. The accumulator merges both layers and builds a config. The test expects full mode, MITM enabled, both allowed domains present, one hook still present, and that hook using the newer header-stripping action.

**Call relations**: The test harness calls this function. It exercises the accumulator-based loading path rather than directly applying to a finished config, then checks the produced network proxy config with equality and truth assertions.

*Call graph*: 4 external calls (assert!, assert_eq!, default, from_str).


##### `execpolicy_network_rules_overlay_network_lists`  (lines 186–226)

```
fn execpolicy_network_rules_overlay_network_lists()
```

**Purpose**: Checks that execution policy network rules can add to the proxy's allow and deny domain lists. An execution policy is a separate ruleset that says whether certain actions are allowed or forbidden.

**Data flow**: The test begins with a config that already allows `config.example.com` and denies `blocked.example.com`. It then creates an empty policy and adds a rule allowing HTTPS access to `blocked.example.com`, plus a rule forbidding HTTP access to `api.example.com`. After applying the policy to the config, `blocked.example.com` appears in the allowed list as well, and `api.example.com` appears in the denied list.

**Call relations**: The test harness runs this function to cover the bridge between execution policy and proxy config. It uses policy creation and rule insertion, hands that policy to the network-rule overlay function, and then asserts that the proxy lists changed as expected.

*Call graph*: 4 external calls (assert_eq!, empty, default, vec!).


##### `apply_network_constraints_includes_allow_all_unix_sockets_flag`  (lines 229–249)

```
fn apply_network_constraints_includes_allow_all_unix_sockets_flag()
```

**Purpose**: Checks that the special flag allowing all Unix sockets is copied into trusted network constraints. Unix sockets are local machine communication endpoints, not internet domains, so this flag needs explicit handling.

**Data flow**: The test parses a TOML profile where `dangerously_allow_all_unix_sockets` is set to true. It selects that profile's network table, creates empty constraints, applies the network table to those constraints, and then checks that the constraint now records `Some(true)` for that flag.

**Call relations**: The test harness calls this function. It follows the same selection-and-application path used by trusted constraint loading, then uses an equality assertion to make sure this non-domain setting is not dropped.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `selected_network_from_tables_ignores_builtin_profile_without_permissions_table`  (lines 252–266)

```
fn selected_network_from_tables_ignores_builtin_profile_without_permissions_table()
```

**Purpose**: Checks that selecting a known built-in profile does not require a custom permissions table. This lets a config choose a built-in profile such as `:workspace` without having to repeat its network settings in TOML.

**Data flow**: The test parses TOML containing only `default_permissions = ":workspace"`. It turns that into network tables and asks for the selected network table. The expected output is `None`, meaning there is no custom network table to apply and that is acceptable.

**Call relations**: The test harness invokes this test. It exercises TOML parsing and profile selection, then confirms that a valid built-in profile is quietly accepted when no local permissions section exists.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_rejects_unknown_builtin_profile_without_permissions_table`  (lines 269–286)

```
fn selected_network_from_tables_rejects_unknown_builtin_profile_without_permissions_table()
```

**Purpose**: Checks that an unknown built-in profile name is rejected. This prevents a misspelled or unsupported profile like `:unknown` from being silently treated as safe.

**Data flow**: The test parses TOML with `default_permissions = ":unknown"`. It asks the selection code to resolve the network table and expects an error instead of a network config. It then checks that the error message clearly names the unknown built-in profile.

**Call relations**: The test harness calls this function. It uses the normal parsing and selection route, but deliberately expects failure and verifies the exact user-facing error text.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_resolves_builtin_workspace_parent`  (lines 289–325)

```
fn selected_network_from_tables_resolves_builtin_workspace_parent()
```

**Purpose**: Checks that a custom profile can extend the built-in `:workspace` profile and still expose its own network settings. This supports small custom profiles that build on a standard baseline.

**Data flow**: The test parses TOML where `dev` extends `:workspace`, enables networking, and allows `child.example.com`. It selects the network table for `dev`. The output should be a network table containing the child profile's explicit settings, including `enabled = true` and the allowed child domain.

**Call relations**: The test harness runs this as a profile inheritance test. It uses TOML parsing and network table selection, then compares the selected network table to the exact expected `NetworkToml` structure.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `selected_network_from_tables_resolves_permission_profile_inheritance`  (lines 328–385)

```
fn selected_network_from_tables_resolves_permission_profile_inheritance()
```

**Purpose**: Checks inheritance between two user-defined permission profiles. A child profile should inherit network settings from its parent and override only the entries it changes.

**Data flow**: The test parses TOML with a `base` profile that enables networking, allows all Unix sockets, and defines domain rules. A `dev` profile extends `base`, adds local binding permission, adds a child domain, and changes `shared.example.com` from deny to allow. The selected network table should contain inherited flags, the child flag, all relevant domains, and the child's replacement for the shared domain.

**Call relations**: The test harness calls this function. It exercises the profile inheritance resolver and confirms through equality checking that inherited and overridden fields are merged in the intended order.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `config_from_layers_resolves_inherited_profiles_across_layers`  (lines 388–427)

```
fn config_from_layers_resolves_inherited_profiles_across_layers()
```

**Purpose**: Checks that profile inheritance works even when the parent profile and child profile are defined in different configuration layers. This matters because real configuration often comes from several files or sources.

**Data flow**: The test builds a lower config layer containing `base` domain rules and a higher layer where `dev` extends `base` and adds a child domain. It creates a layer stack, builds the final network proxy config with an empty execution policy, and expects both the inherited base domain and the child domain to be allowed.

**Call relations**: The test harness invokes this test. It uses config layer objects and a layer stack to drive the same high-level `config_from_layers` path used by the application, then checks the resulting allowed domain list.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `config_from_layers_normalizes_profile_network_domains_before_merging_layers`  (lines 430–464)

```
fn config_from_layers_normalizes_profile_network_domains_before_merging_layers()
```

**Purpose**: Checks that domain names are normalized before layer precedence is applied. Without this, `EXAMPLE.COM` and `example.com` could be treated as different sites, leaving contradictory allow and deny rules.

**Data flow**: The lower layer denies `example.com`; the higher layer allows `EXAMPLE.COM`. The test builds a layer stack and final config. Because names are normalized first, the higher allow rule should replace the lower deny rule, leaving `example.com` allowed and no denied domains.

**Call relations**: The test harness runs this function. It exercises the full layered config builder with an empty policy and verifies that normalization happens early enough to make precedence work correctly.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `config_from_layers_uses_only_the_final_selected_profile_network`  (lines 467–497)

```
fn config_from_layers_uses_only_the_final_selected_profile_network()
```

**Purpose**: Checks that only the final selected default permission profile contributes network settings. If a higher layer changes the selected profile to a built-in one, earlier custom profile network rules should not leak through.

**Data flow**: The lower layer selects `dev` and gives it an allowed domain. The higher layer changes `default_permissions` to `:workspace`. After building the final config, the expected allowed and denied domain lists are both empty, because the final selection is the built-in profile and no custom `dev` network table should remain active.

**Call relations**: The test harness calls this function. It runs through layer stack creation and `config_from_layers`, then uses assertions to catch accidental carry-over from a previously selected profile.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (default, assert_eq!, default, empty, toml!, vec!).


##### `trusted_constraints_use_only_the_final_selected_profile_network`  (lines 500–536)

```
fn trusted_constraints_use_only_the_final_selected_profile_network()
```

**Purpose**: Checks the same “final selected profile only” rule for trusted network constraints. Trusted constraints are limits loaded from trusted configuration sources, so stale lower-layer settings must not remain after a higher trusted layer changes the selected profile.

**Data flow**: The lower trusted layer selects `dev` and allows `managed.example.com`. The higher trusted layer switches the default profile to `:workspace`. The test loads trusted network constraints from those layers and expects no allowed or denied domains in the result.

**Call relations**: The test harness runs this function. It constructs trusted-source layer entries, including absolute file paths, passes them to `network_constraints_from_trusted_layers`, and asserts that older selected-profile domains are not kept.

*Call graph*: calls 3 internal fn (new, new, try_from); 6 external calls (default, assert_eq!, default, from, toml!, vec!).


##### `trusted_constraints_normalize_profile_network_domains_before_merging_layers`  (lines 539–579)

```
fn trusted_constraints_normalize_profile_network_domains_before_merging_layers()
```

**Purpose**: Checks that trusted network constraints also normalize domain names before merging layers. This keeps trusted allow and deny lists from disagreeing just because one source used uppercase letters.

**Data flow**: The lower trusted layer denies `example.com`; the higher trusted layer allows `EXAMPLE.COM`. The test builds the trusted layer stack, loads constraints, and expects the final constraints to allow lowercase `example.com` with no denied domains.

**Call relations**: The test harness calls this test. It uses the trusted constraint loading path rather than the normal runtime config path, proving both paths follow the same domain normalization and precedence behavior.

*Call graph*: calls 3 internal fn (new, new, try_from); 6 external calls (default, assert_eq!, default, from, toml!, vec!).


##### `apply_network_constraints_skips_empty_domain_sides`  (lines 582–608)

```
fn apply_network_constraints_skips_empty_domain_sides()
```

**Purpose**: Checks that applying constraints does not create empty allow or deny lists unnecessarily. This keeps the final constraints clear: a missing list means no entries were supplied for that side.

**Data flow**: The test parses a profile with one allowed domain and no denied domains. It selects the network table, applies it to empty constraints, and expects the allowed list to contain `managed.example.com` while the denied list remains `None` rather than an empty list.

**Call relations**: The test harness runs this function. It focuses on the lower-level `apply_network_constraints` step and verifies that it preserves the distinction between “not set” and “set but empty.”

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `apply_network_constraints_overlay_domain_entries`  (lines 611–658)

```
fn apply_network_constraints_overlay_domain_entries()
```

**Purpose**: Checks that trusted constraints can accumulate allow and deny entries across multiple applied network tables. This mirrors layered configuration, where one trusted source may deny a domain and another may allow a different one.

**Data flow**: The test parses two separate network tables: the lower one denies `blocked.example.com`, and the higher one allows `api.example.com`. It selects each table, applies both to the same empty constraints object, and expects the final constraints to contain one allowed domain and one denied domain.

**Call relations**: The test harness invokes this function. It exercises repeated calls to `apply_network_constraints` and confirms that adding an allowed domain later does not erase an unrelated denied domain from earlier.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


### `core/src/network_policy_decision_tests.rs`

`test` · `test run`

This is a test file for the network policy decision code. In plain terms, that code decides what to do when something tries to reach the internet: allow it, deny it, or ask the user. These tests make sure the surrounding details are interpreted correctly, such as which host was contacted, which protocol was used, and whether the decision came from the part of the system that is allowed to request user approval.

The tests build small example network-decision records and compare the result against what the system should produce. One group checks that an approval prompt is only created for an “ask” decision from the decider, not for a denial. Another checks that common network protocols like HTTP, HTTPS, and SOCKS are preserved correctly in approval context. A separate test checks that older or proxy-specific protocol names, such as “https_connect”, still read as HTTPS when JSON is loaded.

The file also verifies how a user’s network-policy amendment becomes an execution-policy rule, including the protocol, deny/allow decision, and explanation text. Finally, it tests messages for blocked network requests, making sure only true deny decisions produce deny messages and that denylist blocks clearly say they cannot be approved from the prompt.

#### Function details

##### `network_approval_context_requires_ask_from_decider`  (lines 9–20)

```
fn network_approval_context_requires_ask_from_decider()
```

**Purpose**: This test checks that the system does not create an approval prompt when the decision is already “deny.” It matters because a denied request should not accidentally be presented to the user as something they can approve.

**Data flow**: The test starts with a sample network decision payload for HTTPS to example.com, marked as a denial from the decider. It passes that payload into the approval-context conversion code. The expected result is no approval context at all, and the test compares the actual result with that expectation.

**Call relations**: During the test run, Rust’s test harness runs this function as one independent check. The function exercises the approval-context conversion path and then uses an equality assertion to confirm that the path refuses to produce a prompt for a deny decision.

*Call graph*: 1 external calls (assert_eq!).


##### `network_approval_context_maps_http_https_and_socks_protocols`  (lines 23–103)

```
fn network_approval_context_maps_http_https_and_socks_protocols()
```

**Purpose**: This test checks that approval prompts keep the correct network protocol. It covers regular web traffic and SOCKS proxy traffic, so the user sees and approves the right kind of access.

**Data flow**: The test creates several sample payloads that all ask for approval from the decider, but with different protocols: HTTP, HTTPS, SOCKS5 over TCP, and SOCKS5 over UDP. Each payload goes into the approval-context conversion code. The expected output is a small context containing the same host and the matching protocol, and each case is compared against that expected value.

**Call relations**: The test harness calls this function as part of the suite. Inside it, each example follows the same story: make a payload, convert it into approval context, and use equality assertions to prove the conversion kept the important host and protocol information.

*Call graph*: 1 external calls (assert_eq!).


##### `network_policy_decision_payload_deserializes_proxy_protocol_aliases`  (lines 106–132)

```
fn network_policy_decision_payload_deserializes_proxy_protocol_aliases()
```

**Purpose**: This test checks that JSON input can use older or alternate names for HTTPS proxy connections and still be understood. That prevents compatibility breaks when the network proxy reports protocol names in slightly different spellings.

**Data flow**: The test starts with two JSON strings that describe an approval request for example.com. One uses the protocol name “https_connect” and the other uses “http-connect.” Each JSON string is parsed into a network decision payload. After parsing, the test checks that both spellings become the same internal HTTPS protocol value.

**Call relations**: The test harness runs this as a compatibility check for incoming JSON data. The function hands JSON text to the JSON parser, receives structured payloads back, and uses equality assertions to verify that the protocol alias mapping worked.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `execpolicy_network_rule_amendment_maps_protocol_action_and_justification`  (lines 135–153)

```
fn execpolicy_network_rule_amendment_maps_protocol_action_and_justification()
```

**Purpose**: This test checks how a user-facing network policy amendment becomes a lower-level execution policy rule. It makes sure the protocol, deny decision, and explanation text are all translated consistently.

**Data flow**: The test begins with a policy amendment saying to deny example.com and an approval context saying the request used SOCKS5 over UDP. It passes those into the rule-amendment conversion code, along with the host name. The output should be an execution-policy amendment that uses the SOCKS5 UDP protocol, marks the decision as forbidden, and includes a clear justification sentence.

**Call relations**: When the test suite reaches this function, it checks the bridge between approval decisions and execution policy rules. The conversion result is handed to an equality assertion, which confirms that the lower-level rule would say exactly what the higher-level amendment intended.

*Call graph*: 1 external calls (assert_eq!).


##### `denied_network_policy_message_requires_deny_decision`  (lines 156–170)

```
fn denied_network_policy_message_requires_deny_decision()
```

**Purpose**: This test checks that the system does not show a denial message for a request whose decision is only “ask.” It prevents confusing the user by calling something blocked when it is actually waiting for approval.

**Data flow**: The test creates a sample blocked-request record for an HTTP GET to example.com, but the decision field says “ask” rather than “deny.” It passes that record into the denied-message builder. The expected result is no message, and the test confirms that result.

**Call relations**: The test harness runs this as a guard around user-facing messaging. The function feeds a non-deny blocked request into the message-producing code and uses an equality assertion to verify that no denial text is produced.

*Call graph*: 1 external calls (assert_eq!).


##### `denied_network_policy_message_for_denylist_block_is_explicit`  (lines 173–192)

```
fn denied_network_policy_message_for_denylist_block_is_explicit()
```

**Purpose**: This test checks that a request blocked by an explicit deny policy gets a clear explanation. It matters because the user should know this kind of block cannot simply be approved from the prompt.

**Data flow**: The test builds a blocked-request record for example.com with a deny decision, a baseline-policy source, and a reason saying it was denied. It sends that record to the denied-message builder. The expected output is a specific sentence explaining that the domain is explicitly denied by policy and cannot be approved there.

**Call relations**: During the test run, this function verifies the wording for strict policy blocks. It gives the message-building code a denylist-style request and then uses an equality assertion to make sure the returned text is explicit and user-friendly.

*Call graph*: 1 external calls (assert_eq!).


### `sandboxing/src/policy_transforms_tests.rs`

`test` · `test run`

Sandbox permissions are like a guest pass: they say which folders and network features a task may use, and which places must stay blocked. This test file makes sure those guest passes are rewritten safely before they reach the real operating-system sandbox. Without these tests, a small mistake could accidentally give write access to too much of the disk, forget a deny rule for secrets, or skip the stronger platform sandbox when it is still needed.

The tests cover several important transformations. Some check when the platform sandbox, meaning the operating system’s own enforcement layer, can be skipped and when it must still be used. Others check normalization, which cleans up user-provided extra permissions: empty permission blocks are removed, network settings are kept, symbolic-link paths are not silently changed, and unsafe glob rules are rejected. A glob is a path pattern such as `**/*.env` that can match many files.

A large part of the file checks intersection: if one side requests permissions and another side grants permissions, the result must be only what both sides allow. These tests pay special attention to current-working-directory shortcuts, deny rules, duplicate paths, and reusable grants. The final tests check merging extra file permissions into a base sandbox policy while preserving existing blocks.

#### Function details

##### `symlink_dir`  (lines 23–25)

```
fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()>
```

**Purpose**: Creates a directory symbolic link on Unix systems for tests that need to check how permissions behave through a link. A symbolic link is like a shortcut that points to another folder.

**Data flow**: It receives the real directory path and the link path to create. It asks the operating system to create the link. It returns success or an input/output error if the link cannot be made.

**Call relations**: The symlink preservation test calls this helper while setting up its temporary directory. The helper delegates the actual work to the Unix file-system link operation, then hands control back to the test.

*Call graph*: called by 1 (normalize_additional_permissions_preserves_symlinked_write_paths); 1 external calls (symlink).


##### `full_access_restricted_policy_skips_platform_sandbox_when_network_is_enabled`  (lines 28–44)

```
fn full_access_restricted_policy_skips_platform_sandbox_when_network_is_enabled()
```

**Purpose**: Checks that a policy which already allows writing everywhere does not ask for the operating-system sandbox when unrestricted network access is also enabled. In that situation, the platform sandbox would not add meaningful protection for file access.

**Data flow**: The test builds a restricted-style policy whose only rule gives write access to the root of the file system. It asks whether a platform sandbox is required with network enabled and no separately managed network rules. The expected answer is `false`.

**Call relations**: The Rust test runner calls this test. The test constructs a sandbox policy and sends it to the platform-sandbox decision function, then verifies the result with an equality check.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert_eq!, vec!).


##### `root_write_policy_with_carveouts_still_uses_platform_sandbox`  (lines 47–73)

```
fn root_write_policy_with_carveouts_still_uses_platform_sandbox()
```

**Purpose**: Checks that broad write access still needs the platform sandbox if there is a carveout, meaning a specific path that must remain denied. The operating system layer is needed to enforce that exception.

**Data flow**: The test resolves a concrete `blocked` path under the current directory, then builds a policy that allows writing to root but denies that one path. It asks whether the platform sandbox is required. The expected answer is `true`.

**Call relations**: The test runner calls this test. During setup it uses the current directory and path resolution helper, then passes the policy into the sandbox requirement check.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 3 external calls (assert_eq!, current_dir, vec!).


##### `full_access_restricted_policy_still_uses_platform_sandbox_for_restricted_network`  (lines 76–92)

```
fn full_access_restricted_policy_still_uses_platform_sandbox_for_restricted_network()
```

**Purpose**: Checks that even if file-system access is effectively wide open, restricted network rules still require the platform sandbox. Network limits are another reason to keep the operating-system enforcement layer active.

**Data flow**: The test builds a policy allowing write access to root. It combines that with a restricted network policy and asks whether a platform sandbox is required. The expected result is `true`.

**Call relations**: The test runner calls this test. It feeds the constructed file and network policies into the sandbox decision function and checks the returned boolean.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert_eq!, vec!).


##### `normalize_additional_permissions_preserves_network`  (lines 95–125)

```
fn normalize_additional_permissions_preserves_network()
```

**Purpose**: Checks that cleaning up an additional permission profile does not lose an explicit network setting. It also confirms that valid read and write roots remain intact.

**Data flow**: The test creates a temporary directory, turns it into a canonical absolute path, and builds a permission profile with network enabled plus read and write access to that path. It normalizes the profile. The result should still contain the same network setting and the same file-system roots.

**Call relations**: The test runner calls this test. It uses temporary-directory and path helpers for setup, then hands the profile to `normalize_additional_permissions` and compares the cleaned profile to the expected one.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_preserves_symlinked_write_paths`  (lines 129–158)

```
fn normalize_additional_permissions_preserves_symlinked_write_paths()
```

**Purpose**: Checks that normalization keeps a write path exactly as the user gave it when that path goes through a symbolic link. This matters because changing a linked path to its real target could make later permission comparisons behave differently.

**Data flow**: The test creates a real directory, a symbolic link to it, and a write directory reached through that link. It builds additional file permissions for the linked path and normalizes them. The output should still name the linked path, not the resolved real path.

**Call relations**: The Unix test runner calls this test only on Unix platforms. It uses `symlink_dir` to create the shortcut, then calls the normalization function and checks that the path was preserved.

*Call graph*: calls 3 internal fn (from_read_write_roots, symlink_dir, from_absolute_path); 6 external calls (default, new, assert_eq!, create_dir_all, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_rejects_glob_read_grants`  (lines 161–180)

```
fn normalize_additional_permissions_rejects_glob_read_grants()
```

**Purpose**: Checks that glob patterns cannot be used to grant read access. The system only supports glob patterns for denying reads, because broad pattern-based grants are harder to reason about safely.

**Data flow**: The test builds a permission profile with a glob pattern like `**/*.env` marked as readable. It tries to normalize the profile. Instead of a cleaned profile, it should receive a specific error message.

**Call relations**: The test runner calls this test. It passes the invalid profile to `normalize_additional_permissions` and verifies that the function rejects it with the expected text.

*Call graph*: 4 external calls (default, assert_eq!, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_preserves_deny_globs`  (lines 183–213)

```
fn normalize_additional_permissions_preserves_deny_globs()
```

**Purpose**: Checks that glob patterns are accepted when they deny access. This lets the sandbox keep patterns such as “do not read environment files” while still rejecting unsafe grant patterns.

**Data flow**: The test builds a profile containing a deny rule for `**/*.env` and a scan-depth limit. It normalizes the profile. The output should contain the same deny pattern and the same depth setting.

**Call relations**: The test runner calls this test. It sends a valid deny-glob profile through the normalization function and compares the result to the original expected profile.

*Call graph*: 5 external calls (default, assert_eq!, new, normalize_additional_permissions, vec!).


##### `normalize_additional_permissions_drops_empty_nested_profiles`  (lines 216–224)

```
fn normalize_additional_permissions_drops_empty_nested_profiles()
```

**Purpose**: Checks that normalization removes empty inner permission blocks. This keeps later code from treating “nothing was requested” as if it were a meaningful permission request.

**Data flow**: The test creates a profile whose network section has no setting and whose file-system section is empty. After normalization, the whole profile should become the default empty profile.

**Call relations**: The test runner calls this test. It calls the normalization function with an intentionally empty-looking profile and checks that it is simplified away.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, normalize_additional_permissions).


##### `intersect_permission_profiles_preserves_explicit_empty_requested_reads`  (lines 227–246)

```
fn intersect_permission_profiles_preserves_explicit_empty_requested_reads()
```

**Purpose**: Checks that an explicit empty read list is preserved when the grant matches the request. An empty read list can be meaningful because it says, “grant no read roots,” rather than leaving the field unspecified.

**Data flow**: The test creates a profile with no read roots and one write root, then uses the same profile as both requested and granted permissions. The intersection should return that same profile unchanged.

**Call relations**: The test runner calls this test. It builds matching permission profiles and uses the intersection logic to confirm that explicitly empty read permissions survive when they are granted.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_drops_ungranted_nonempty_path_requests`  (lines 249–267)

```
fn intersect_permission_profiles_drops_ungranted_nonempty_path_requests()
```

**Purpose**: Checks that a requested concrete path is removed when it was not granted. This prevents a request from becoming permission by itself.

**Data flow**: The test creates a request for read access to a temporary directory. It intersects that request with an empty granted profile. The result should be an empty permission profile.

**Call relations**: The test runner calls this test. It sets up a real absolute path, sends requested and granted profiles to the intersection logic, and checks that ungranted access disappears.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_drops_explicit_empty_reads_without_grant`  (lines 270–288)

```
fn intersect_permission_profiles_drops_explicit_empty_reads_without_grant()
```

**Purpose**: Checks that even an explicitly empty read section is dropped if no file-system grant exists at all. This keeps the result from carrying file-system permission structure that was not actually granted.

**Data flow**: The test builds a request with an empty read list and a write root. It intersects that with a completely empty grant. The result should be the default empty profile.

**Call relations**: The test runner calls this test. It exercises the intersection function with a missing grant and confirms the result has no remaining file-system permissions.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_accepts_child_path_granted_for_requested_cwd`  (lines 291–322)

```
fn intersect_permission_profiles_accepts_child_path_granted_for_requested_cwd()
```

**Purpose**: Checks that a request for writing in the project root can be narrowed to a granted child path. The result should keep only the smaller, safer grant.

**Data flow**: The test treats a temporary directory as the current working directory and creates a child path below it. The request asks for write access to the project root shortcut, while the grant allows writing only to the child. The intersection should return the child-path grant.

**Call relations**: The test runner calls this test. It builds a special current-directory-style request and a concrete child-path grant, then uses the intersection logic to ensure the narrower permission is accepted.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_materializes_cwd_grant_for_reuse`  (lines 325–374)

```
fn intersect_permission_profiles_materializes_cwd_grant_for_reuse()
```

**Purpose**: Checks that a current-working-directory shortcut is turned into the actual directory path when permissions are intersected. This prevents the same grant from later applying to a different working directory by accident.

**Data flow**: The test creates one path for the original request directory and another for a later directory. It intersects matching permissions that refer to the project-root shortcut. The first result should contain the concrete original path; a later attempt to reuse it for another directory should produce no permission.

**Call relations**: The test runner calls this test. It calls `intersect_permission_profiles` once to materialize the shortcut, then calls it again to prove that the materialized grant cannot float to a different directory.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (default, new, assert_eq!, intersect_permission_profiles, vec!).


##### `intersect_permission_profiles_deduplicates_materialized_grants`  (lines 377–410)

```
fn intersect_permission_profiles_deduplicates_materialized_grants()
```

**Purpose**: Checks that when a shortcut and a concrete path point to the same directory, the intersection result contains only one copy. This avoids noisy or confusing duplicate rules.

**Data flow**: The test builds permissions with both a project-root shortcut and the matching concrete current-directory path. After intersection, the result should contain a single write entry for that concrete path.

**Call relations**: The test runner calls this test. It uses the intersection logic to combine overlapping entries and verifies that duplicates are collapsed.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (default, new, assert_eq!, vec!).


##### `intersect_permission_profiles_materializes_cwd_deny_entries`  (lines 413–459)

```
fn intersect_permission_profiles_materializes_cwd_deny_entries()
```

**Purpose**: Checks that deny rules using the current project-root shortcut are also turned into concrete paths. This is important because a deny rule must stay attached to the directory where it was originally approved.

**Data flow**: The test builds permissions that allow writing to root but deny access to the project root shortcut. It intersects the permissions against a request current directory. The output should still allow root writing but should deny the concrete request directory.

**Call relations**: The test runner calls this test. It sends matching requested and granted permissions through the intersection logic and checks that the special deny entry becomes a real path.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (default, new, assert_eq!, vec!).


##### `intersect_permission_profiles_drops_deny_entries_without_filesystem_grants`  (lines 462–500)

```
fn intersect_permission_profiles_drops_deny_entries_without_filesystem_grants()
```

**Purpose**: Checks that file-system deny entries are not kept when there are no file-system grants to go with them. A deny rule alone does not grant anything, so carrying it would be misleading in the resulting profile.

**Data flow**: The test requests network access plus file-system write access with a denied secret path. The grant allows only network access. The intersection should return only the network grant and drop the file-system deny details.

**Call relations**: The test runner calls this test. It combines a mixed network-and-file request with a network-only grant and verifies that the intersection output keeps only what was actually granted.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_rejects_concrete_grants_matched_by_requested_deny_globs`  (lines 503–542)

```
fn intersect_permission_profiles_rejects_concrete_grants_matched_by_requested_deny_globs()
```

**Purpose**: Checks that a concrete granted path is rejected if the request also contains a deny glob that matches it. For example, a request that says “deny `.env` files” must not end up granting a specific `.env` file.

**Data flow**: The test creates a current directory, a `.env` file path inside it, a request with project-root write access plus a deny glob for `.env` files, and a grant for writing that concrete `.env` path. The intersection should return no permissions.

**Call relations**: The test runner calls this test. It uses the intersection logic to prove that deny patterns are applied before concrete grants are accepted.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize, new, vec!).


##### `intersect_permission_profiles_materializes_relative_deny_globs_for_reuse`  (lines 545–611)

```
fn intersect_permission_profiles_materializes_relative_deny_globs_for_reuse()
```

**Purpose**: Checks that relative deny glob patterns are anchored to the request directory before being stored for later use. This prevents a pattern like `**/*.env` from unexpectedly applying relative to a future directory.

**Data flow**: The test creates an original request directory and a later directory. It intersects permissions that allow writing to the project root while denying `**/*.env`. The output should contain a concrete write path and an absolute glob rooted at the original request directory; trying to reuse that result for a `.env` file under the later directory should grant nothing.

**Call relations**: The test runner calls this test. It calls the intersection function once to turn relative rules into concrete reusable rules, then calls it again to confirm those rules do not drift to a later working directory.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (default, new, project_roots, assert_eq!, new, intersect_permission_profiles, vec!).


##### `intersect_permission_profiles_drops_broader_cwd_grant_for_requested_child_path`  (lines 614–645)

```
fn intersect_permission_profiles_drops_broader_cwd_grant_for_requested_child_path()
```

**Purpose**: Checks that a broad grant for the whole current directory is not used to satisfy a request for a narrower child path in this direction. The intersection keeps permissions only when the requested shape is allowed by the grant rules being compared.

**Data flow**: The test requests write access to a concrete child directory. The grant is expressed as write access to the project-root shortcut. The intersection should return an empty profile.

**Call relations**: The test runner calls this test. It compares a concrete child-path request with a broader special-path grant and verifies that this broader grant is dropped rather than expanded.

*Call graph*: calls 2 internal fn (from_read_write_roots, from_absolute_path); 5 external calls (default, new, assert_eq!, canonicalize, vec!).


##### `intersect_permission_profiles_uses_granted_bounded_glob_scan_depth`  (lines 648–700)

```
fn intersect_permission_profiles_uses_granted_bounded_glob_scan_depth()
```

**Purpose**: Checks that when both request and grant contain a deny glob, the resulting glob scan depth comes from the grant if the grant gives a bounded depth. Scan depth limits how far the system searches when applying a pattern.

**Data flow**: The test creates matching root-write and deny-`.env` permissions. The request has scan depth 2, while the grant has scan depth 4. The intersection should keep the rules, anchor the glob against the current directory, and use depth 4.

**Call relations**: The test runner calls this test. It feeds requested and granted glob permissions into the intersection logic and checks that the grant’s bounded depth controls the result.

*Call graph*: 5 external calls (default, assert_eq!, current_dir, new, vec!).


##### `intersect_permission_profiles_uses_granted_unbounded_glob_scan_depth`  (lines 703–755)

```
fn intersect_permission_profiles_uses_granted_unbounded_glob_scan_depth()
```

**Purpose**: Checks that an unbounded granted glob scan depth stays unbounded in the intersection result. Unbounded here means there is no fixed maximum depth for scanning matching paths.

**Data flow**: The test builds matching root-write and deny-`.env` rules. The request has a bounded scan depth, but the grant has no depth limit. The intersection should keep the rules, anchor the glob to the current directory, and leave the depth unlimited.

**Call relations**: The test runner calls this test. It uses the intersection function to confirm that granted scan-depth settings, including no limit, are preserved.

*Call graph*: 5 external calls (default, assert_eq!, current_dir, new, vec!).


##### `merge_file_system_policy_with_additional_permissions_preserves_unreadable_roots`  (lines 758–801)

```
fn merge_file_system_policy_with_additional_permissions_preserves_unreadable_roots()
```

**Purpose**: Checks that merging extra readable paths into a base policy does not erase existing deny rules. This matters because adding one allowed folder should not accidentally reopen a blocked folder.

**Data flow**: The test builds a base policy that allows reading from root but denies one concrete path. It then adds read permission for a different allowed path. The merged policy should contain both the old deny entry and the new read entry.

**Call relations**: The test runner calls this test. It constructs a base sandbox policy and additional file-system permissions, passes both into the merge function, and checks for the two important entries.

*Call graph*: calls 3 internal fn (from_read_write_roots, restricted, from_absolute_path); 6 external calls (new, new, assert_eq!, canonicalize, merge_file_system_policy_with_additional_permissions, vec!).


##### `merge_file_system_policy_with_additional_permissions_carries_bounded_glob_scan_depth`  (lines 804–837)

```
fn merge_file_system_policy_with_additional_permissions_carries_bounded_glob_scan_depth()
```

**Purpose**: Checks that merging additional permissions also carries over the glob scan-depth setting. Otherwise deny patterns might be kept but applied with the wrong search limit.

**Data flow**: The test starts with a base policy that allows writing to root. It adds a deny glob for `.env` files with scan depth 2. The merged policy should contain both entries and should record a maximum glob scan depth of 2.

**Call relations**: The test runner calls this test. It hands the base policy and additional glob permissions to the merge function, then compares the whole merged policy to the expected result.

*Call graph*: calls 1 internal fn (restricted); 4 external calls (assert_eq!, new, merge_file_system_policy_with_additional_permissions, vec!).


##### `effective_file_system_sandbox_policy_returns_base_policy_without_additional_permissions`  (lines 840–864)

```
fn effective_file_system_sandbox_policy_returns_base_policy_without_additional_permissions()
```

**Purpose**: Checks that the effective policy is exactly the base policy when no extra permissions are supplied. This protects the simple case from accidental changes.

**Data flow**: The test builds a base policy with read access to root and a denied path. It asks for the effective policy with no additional permissions. The output should be identical to the base policy.

**Call relations**: The test runner calls this test. It passes the base policy and `None` for additional permissions into the effective-policy function and checks for equality.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, effective_file_system_sandbox_policy, vec!).


##### `effective_file_system_sandbox_policy_merges_additional_write_roots`  (lines 867–914)

```
fn effective_file_system_sandbox_policy_merges_additional_write_roots()
```

**Purpose**: Checks that the effective file-system policy includes extra write roots while preserving existing denies. This is the final combined behavior callers rely on before the sandbox is applied.

**Data flow**: The test builds a base policy that allows reading from root but denies one path. It supplies additional permissions that allow writing to another path. The effective policy should include the original denied path and the new writable path.

**Call relations**: The test runner calls this test. It exercises the higher-level effective-policy function, which combines the base policy with additional permissions, and then verifies the key entries in the result.

*Call graph*: calls 3 internal fn (from_read_write_roots, restricted, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize, effective_file_system_sandbox_policy, vec!).


### `sandboxing/src/bwrap_tests.rs`

`test` · `test run`

Bubblewrap, usually run as `bwrap`, is an external tool that can create a sandbox, a restricted space where a process has limited access to the rest of the system. This test file checks the project’s safety checks around that tool. Without these tests, the system might warn users for the wrong reason, miss a real setup problem, hang while probing Bubblewrap, or accidentally trust a `bwrap` program found in the current workspace instead of a system-installed one.

The tests build tiny fake `bwrap` shell scripts and put them in temporary locations. This is like using stage props instead of the real tool: each fake script prints a chosen error, sleeps, exits successfully, or exits with failure so the surrounding code can be tested predictably. The file checks several important behaviors: missing `bwrap` should produce a missing-tool warning; known “user namespace” failures should produce a sandbox support warning; unrelated errors should not be turned into misleading warnings; and slow or awkward child processes should not make the probe wait too long.

It also tests detection of WSL1, the first Windows Subsystem for Linux version, by looking at Linux version strings. Finally, it tests search-path behavior: the code should find the first executable system `bwrap`, skip non-executable files, avoid workspace-local `bwrap` programs, and not treat the root directory as a workspace that hides all candidates.

#### Function details

##### `system_bwrap_warning_reports_missing_system_bwrap`  (lines 10–15)

```
fn system_bwrap_warning_reports_missing_system_bwrap()
```

**Purpose**: This test confirms that when no system `bwrap` path is available, the sandboxing code returns the standard warning that Bubblewrap is missing. It protects the user-facing message for a common setup problem.

**Data flow**: It gives the warning function no path at all. The function is expected to turn that absence into the predefined missing-`bwrap` warning text. The test passes if the returned value is exactly that warning.

**Call relations**: This is a direct check of the warning logic. It does not create fake files; it simply asks the production warning function what it would say when no Bubblewrap program was found, then compares the answer with the expected message.

*Call graph*: 1 external calls (assert_eq!).


##### `system_bwrap_warning_reports_user_namespace_failures`  (lines 18–34)

```
fn system_bwrap_warning_reports_user_namespace_failures()
```

**Purpose**: This test checks that several known Bubblewrap error messages about user namespaces all produce the same helpful warning. A user namespace is a Linux feature that lets a process have isolated user and permission information inside a sandbox.

**Data flow**: For each known failure message, the test writes a fake executable `bwrap` script that prints that message to standard error and exits with failure. It then passes that fake program’s path to the warning function. The expected result is the predefined warning explaining that user namespace support is not available.

**Call relations**: The test uses `write_fake_bwrap` to create each pretend Bubblewrap program. It then calls into the real warning path, exercising the same kind of probe the application would use when deciding whether to warn a user about sandbox support.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (assert_eq!, format!).


##### `system_bwrap_warning_skips_unrelated_bwrap_failures`  (lines 37–47)

```
fn system_bwrap_warning_skips_unrelated_bwrap_failures()
```

**Purpose**: This test makes sure the code does not blame every Bubblewrap failure on missing sandbox support. If `bwrap` fails for an unrelated reason, the warning function should stay quiet instead of misleading the user.

**Data flow**: It creates a fake `bwrap` that prints an unrelated error about an unknown option and exits with failure. That path goes into the warning function. The expected output is no warning at all.

**Call relations**: The test relies on `write_fake_bwrap` to stage the fake executable. It then checks the production warning function’s filtering behavior: only recognized user-namespace failures should become the special user-namespace warning.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 1 external calls (assert_eq!).


##### `system_bwrap_probe_times_out_without_reporting_a_warning`  (lines 50–65)

```
fn system_bwrap_probe_times_out_without_reporting_a_warning()
```

**Purpose**: This test verifies that a slow Bubblewrap probe does not hang the program. If the probe takes too long, the code treats it as not enough evidence to warn and moves on quickly.

**Data flow**: It creates a fake `bwrap` script that sleeps for one second and then exits successfully. The test records the current time, calls the user-namespace probe with a very short timeout, and expects the probe to return a successful-looking result before half a second has passed.

**Call relations**: The fake executable comes from `write_fake_bwrap`. The test then drives `system_bwrap_has_user_namespace_access`, checking an important timing promise: the probe must respect its timeout rather than waiting for the fake command to finish naturally.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (now, assert!).


##### `system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open`  (lines 68–84)

```
fn system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open()
```

**Purpose**: This test checks a subtle process-handling problem: the probe should not wait for background child processes just because they keep the error output pipe open. This prevents a short failure check from turning into a long delay.

**Data flow**: It creates a fake `bwrap` that prints a known permission error, starts a background sleep process, and exits with failure. The probe receives that fake path and a short timeout. The test expects the probe to report lack of access, but also expects it to finish quickly.

**Call relations**: The test uses `write_fake_bwrap` to create a controlled process tree. It then calls `system_bwrap_has_user_namespace_access` to confirm the production code reads the needed error and stops promptly instead of being trapped by a descendant process still holding standard error open.

*Call graph*: calls 1 internal fn (write_fake_bwrap); 2 external calls (now, assert!).


##### `detects_wsl1_proc_version_formats`  (lines 87–97)

```
fn detects_wsl1_proc_version_formats()
```

**Purpose**: This test confirms that the WSL1 detector recognizes several Linux version string formats used by Windows Subsystem for Linux 1. WSL1 matters because its Linux feature support differs from native Linux and WSL2.

**Data flow**: It feeds several sample `/proc/version` strings into the detector. Each string contains a WSL1-style marker. The expected output is `true` for all of them.

**Call relations**: This directly checks `proc_version_indicates_wsl1`, the production helper that interprets kernel version text. The test covers old and newer naming patterns so future changes do not accidentally narrow the detection too much.

*Call graph*: 1 external calls (assert!).


##### `does_not_treat_wsl2_or_native_linux_as_wsl1`  (lines 100–114)

```
fn does_not_treat_wsl2_or_native_linux_as_wsl1()
```

**Purpose**: This test makes sure the WSL1 detector does not mistake WSL2, native Linux, or unknown future-looking strings for WSL1. That avoids applying WSL1-specific behavior on systems where it does not belong.

**Data flow**: It passes several non-WSL1 version strings into the detector: WSL2 examples, a Microsoft-flavored string without the WSL1 marker, a made-up WSL3 marker, and a normal Linux version. Each should produce `false`.

**Call relations**: This is the negative partner to the WSL1 detection test. Together, the two tests define the boundary for `proc_version_indicates_wsl1`: it should recognize known WSL1 strings without being overly broad.

*Call graph*: 1 external calls (assert!).


##### `finds_first_executable_bwrap_in_joined_search_path`  (lines 117–133)

```
fn finds_first_executable_bwrap_in_joined_search_path()
```

**Purpose**: This test checks that the search logic finds the first executable `bwrap` in a search path and skips a file named `bwrap` that cannot be run. A search path is the ordered list of folders used to look for commands.

**Data flow**: It creates temporary `cwd`, `first`, and `second` directories. The first directory gets a non-executable file named `bwrap`; the second gets an executable fake `bwrap`. The joined search path is split and passed to the finder, which should return the executable file from the second directory.

**Call relations**: The test uses filesystem setup helpers and `write_named_fake_bwrap_in` to prepare realistic search-path entries. It then calls `find_system_bwrap_in_search_paths`, checking that the production finder follows command-search rules while requiring the candidate to be executable.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 5 external calls (assert_eq!, join_paths, create_dir_all, write, tempdir).


##### `skips_workspace_local_bwrap_in_joined_search_path`  (lines 136–150)

```
fn skips_workspace_local_bwrap_in_joined_search_path()
```

**Purpose**: This test ensures the finder does not trust a `bwrap` program located in the current workspace directory. That matters because a project checkout could contain a fake or accidental `bwrap`, and sandbox setup should prefer a trusted system tool.

**Data flow**: It creates a temporary current working directory and a separate trusted directory. Both contain executable fake `bwrap` files, and the search path lists the workspace directory first. The finder should skip the workspace-local one and return the trusted one.

**Call relations**: The test builds both candidates with `write_named_fake_bwrap_in`, then calls `find_system_bwrap_in_search_paths`. It verifies the production search logic includes a safety filter, not just a simple “first match wins” lookup.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 4 external calls (assert_eq!, join_paths, create_dir_all, tempdir).


##### `root_cwd_does_not_hide_system_bwrap_candidates`  (lines 153–164)

```
fn root_cwd_does_not_hide_system_bwrap_candidates()
```

**Purpose**: This test checks an edge case: when the current directory is `/`, the root of the filesystem, the finder should not treat every possible path as workspace-local and skip all candidates. System `bwrap` programs must still be findable.

**Data flow**: It creates a temporary bin directory containing an executable fake `bwrap`, builds a search path containing that directory, and tells the finder that the current directory is `/`. The expected result is still the fake `bwrap` in the bin directory.

**Call relations**: The test uses `write_named_fake_bwrap_in` to create the candidate and then calls `find_system_bwrap_in_search_paths`. It protects the search logic from an overzealous “skip things under the current directory” rule when the current directory is the filesystem root.

*Call graph*: calls 1 internal fn (write_named_fake_bwrap_in); 4 external calls (assert_eq!, join_paths, create_dir_all, tempdir).


##### `write_fake_bwrap`  (lines 166–171)

```
fn write_fake_bwrap(contents: &str) -> tempfile::TempPath
```

**Purpose**: This helper creates a temporary executable file containing a caller-provided shell script. The tests use it to impersonate Bubblewrap with controlled behavior.

**Data flow**: It receives script text as input. It chooses the current directory as the preferred place to create the temporary executable, falling back inside the deeper helper if needed. It returns a temporary path to the fake program, which will be cleaned up when the temp path is dropped.

**Call relations**: Several warning and probe tests call this helper when they need a fake `bwrap` that prints certain messages, sleeps, or exits with a chosen status. It delegates the actual file creation and permission setting to `write_fake_bwrap_in`.

*Call graph*: calls 1 internal fn (write_fake_bwrap_in); called by 4 (system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open, system_bwrap_probe_times_out_without_reporting_a_warning, system_bwrap_warning_reports_user_namespace_failures, system_bwrap_warning_skips_unrelated_bwrap_failures); 1 external calls (current_dir).


##### `write_fake_bwrap_in`  (lines 173–190)

```
fn write_fake_bwrap_in(dir: &Path, contents: &str) -> tempfile::TempPath
```

**Purpose**: This helper does the real work of writing a temporary executable script in a chosen directory. It exists so tests can make fake command-line programs without depending on the real Bubblewrap installation.

**Data flow**: It takes a directory and script contents. It creates a temporary file there if possible, writes the script text into it, changes its permissions so it can be executed, and returns the temporary path. If creating the file in the requested directory fails, it falls back to the system temporary directory.

**Call relations**: It is called by `write_fake_bwrap`, which supplies the directory choice. The tests indirectly rely on it whenever they need a fake Bubblewrap command that can actually be launched by the production probing code.

*Call graph*: called by 1 (write_fake_bwrap); 4 external calls (new_in, from_mode, set_permissions, write).


##### `write_named_fake_bwrap_in`  (lines 192–201)

```
fn write_named_fake_bwrap_in(dir: &Path) -> PathBuf
```

**Purpose**: This helper creates an executable file specifically named `bwrap` inside a given directory. The search-path tests need that exact name because the production code is looking for a command called `bwrap`.

**Data flow**: It receives a directory path. It writes a minimal shell script to `dir/bwrap`, marks the file executable, converts the path to its canonical absolute form, and returns that path for comparison in assertions.

**Call relations**: The search-path tests call this helper to place realistic `bwrap` candidates in temporary directories. Those paths are then compared with the result from `find_system_bwrap_in_search_paths` to prove the finder chose the intended executable.

*Call graph*: called by 3 (finds_first_executable_bwrap_in_joined_search_path, root_cwd_does_not_hide_system_bwrap_candidates, skips_workspace_local_bwrap_in_joined_search_path); 5 external calls (join, from_mode, canonicalize, set_permissions, write).


### `core/src/windows_sandbox_read_grants_tests.rs`

`test` · `test run`

This is a test file for a Windows sandbox helper called `grant_read_root_non_elevated`. That helper is meant to add a directory to the set of places a non-admin sandboxed process may read. Because this affects file access permissions, it must be strict about what it accepts. A loose check here could accidentally grant access to the wrong place, or fail later in a confusing way.

The tests create temporary folders so they can safely try different path shapes without touching the real project files. They build a small fake workspace root, use a normal workspace-write permission profile, and then call the grant function with deliberately invalid inputs.

The three cases cover common mistakes: a relative path instead of a full absolute path, a path that does not exist, and a path that points to a file instead of a directory. Each test expects the grant function to fail, then checks that the error message explains the reason. In everyday terms, this file is like checking that a security guard refuses vague directions, nonexistent rooms, and individual papers when the rule says only real rooms may be added to the access list.

#### Function details

##### `workspace_roots_for`  (lines 8–10)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: This helper turns one temporary folder path into the workspace-root format expected by the sandbox grant code. It keeps the tests short and makes clear that each test is using the temporary directory as its workspace.

**Data flow**: It receives a filesystem path that should already be absolute. It converts that path into an `AbsolutePathBuf`, which is a path type that promises it is a full path rather than a relative one, then puts it into a one-item list. The result is handed back as the workspace roots list used by the tests.

**Call relations**: Each test calls this helper after creating its temporary directory. The returned list is then passed into `grant_read_root_non_elevated` so the function under test sees a realistic workspace setup.

*Call graph*: called by 3 (rejects_file_path, rejects_missing_path, rejects_relative_path); 1 external calls (vec!).


##### `rejects_relative_path`  (lines 13–26)

```
fn rejects_relative_path()
```

**Purpose**: This test proves that the sandbox grant function refuses a relative path. A relative path is unsafe here because its meaning changes depending on the current directory, so the grant code requires a full absolute path.

**Data flow**: The test creates a temporary directory and turns it into a workspace root. It then asks `grant_read_root_non_elevated` to grant read access to `relative`, which is intentionally not a full path. The expected result is an error, and the test checks that the error text says the path must be absolute.

**Call relations**: This test uses `workspace_roots_for` to prepare the workspace input, then calls the real grant function with a bad path. It does not hand off to any later work because success would be wrong; the important outcome is that the grant function stops immediately with a clear error.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 5 external calls (new, new, new, assert!, grant_read_root_non_elevated).


##### `rejects_missing_path`  (lines 29–43)

```
fn rejects_missing_path()
```

**Purpose**: This test proves that the sandbox grant function refuses a path that does not exist. Granting access to a nonexistent location would be ambiguous and could hide configuration mistakes.

**Data flow**: The test creates a temporary directory, then forms a child path named `does-not-exist` without creating it on disk. It builds the workspace roots and calls `grant_read_root_non_elevated` with that missing path. The function should return an error, and the test confirms the message says the path does not exist.

**Call relations**: Like the other tests, it uses `workspace_roots_for` to create the expected workspace-root input. It then exercises the grant function directly and verifies that validation fails before any read permission is granted.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 4 external calls (new, new, assert!, grant_read_root_non_elevated).


##### `rejects_file_path`  (lines 46–61)

```
fn rejects_file_path()
```

**Purpose**: This test proves that the sandbox grant function accepts only directories, not individual files. The read grant is meant to add a readable root folder, so a file path is the wrong kind of input.

**Data flow**: The test creates a temporary directory, writes a real file named `file.txt` inside it, and prepares the temporary directory as the workspace root. It then passes the file path to `grant_read_root_non_elevated`. The expected output is an error, and the test checks that the message says the path must be a directory.

**Call relations**: This test prepares both the workspace input through `workspace_roots_for` and an actual file on disk. It then calls the grant function to make sure the function distinguishes a file from a directory and refuses to continue.

*Call graph*: calls 2 internal fn (workspace_roots_for, workspace_write); 5 external calls (new, new, assert!, write, grant_read_root_non_elevated).


### `core/src/windows_sandbox_tests.rs`

`test` · `test run`

Windows sandboxing is a safety feature: it limits what a process can do on Windows, much like putting a messy project inside a contained workspace instead of letting it spread across the whole room. This test file checks the small but important decision logic that chooses the sandbox level from configuration.

The tests cover two sources of input. First, they check modern feature flags: one flag means an elevated sandbox, another means a restricted-token sandbox, no flag means no sandbox, and if both are set the elevated choice wins. Second, they check older configuration names that the project still accepts for backwards compatibility. That matters because users may have existing config files using old key names, and those should keep working.

The file also tests the private desktop setting. A private desktop is a separate Windows desktop environment used to isolate sandboxed work more strongly. The default is tested as true, while an explicit user setting of false must be respected. Without these tests, a small refactor could silently weaken sandboxing, break old configs, or ignore a user’s chosen Windows setting.

#### Function details

##### `elevated_flag_works_by_itself`  (lines 9–17)

```
fn elevated_flag_works_by_itself()
```

**Purpose**: This test proves that turning on only the elevated Windows sandbox feature selects the elevated sandbox level. It checks the simplest case for the elevated mode.

**Data flow**: It starts with the normal default feature set, turns on the WindowsSandboxElevated feature, then asks the sandbox-selection code what level that means. The expected result is WindowsSandboxLevel::Elevated, and the test fails if anything else comes back.

**Call relations**: During the test run, this function calls Features::with_defaults to build a starting feature set, changes that set locally, then checks the result with assert_eq!. It exercises WindowsSandboxLevel::from_features indirectly through the comparison.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `restricted_token_flag_works_by_itself`  (lines 20–28)

```
fn restricted_token_flag_works_by_itself()
```

**Purpose**: This test proves that turning on only the regular Windows sandbox feature selects the restricted-token sandbox level. A restricted token is a Windows safety mechanism that runs code with fewer permissions.

**Data flow**: It creates a default feature set, enables the WindowsSandbox feature, then converts those features into a sandbox level. The expected output is WindowsSandboxLevel::RestrictedToken.

**Call relations**: The test setup comes from Features::with_defaults, and the final behavior is checked with assert_eq!. It is one of the basic guardrails for WindowsSandboxLevel::from_features.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `no_flags_means_no_sandbox`  (lines 31–38)

```
fn no_flags_means_no_sandbox()
```

**Purpose**: This test confirms that Windows sandboxing stays disabled when no sandbox feature flags are enabled. It protects the default behavior.

**Data flow**: It creates a default feature set and does not add any sandbox-related feature. It then asks for the Windows sandbox level and expects WindowsSandboxLevel::Disabled.

**Call relations**: This test calls Features::with_defaults to get the baseline state and assert_eq! to compare the actual sandbox decision with the expected disabled state.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `elevated_wins_when_both_flags_are_enabled`  (lines 41–50)

```
fn elevated_wins_when_both_flags_are_enabled()
```

**Purpose**: This test checks the tie-breaking rule when both Windows sandbox flags are enabled. The intended rule is that elevated mode takes priority over restricted-token mode.

**Data flow**: It begins with default features, enables both WindowsSandbox and WindowsSandboxElevated, then asks the selection logic for the final sandbox level. The expected result is WindowsSandboxLevel::Elevated.

**Call relations**: This function uses Features::with_defaults for setup and assert_eq! for the check. It protects the priority rule inside WindowsSandboxLevel::from_features.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (assert_eq!).


##### `legacy_mode_prefers_elevated`  (lines 53–65)

```
fn legacy_mode_prefers_elevated()
```

**Purpose**: This test checks how old configuration keys are interpreted when both old unelevated and elevated sandbox settings are present. It confirms that elevated mode wins.

**Data flow**: It builds a map of old feature names to boolean values, setting both experimental_windows_sandbox and elevated_windows_sandbox to true. It passes that map into the legacy-mode reader and expects Some(WindowsSandboxModeToml::Elevated).

**Call relations**: The function creates the input map with BTreeMap::new and verifies the output with assert_eq!. It focuses on legacy_windows_sandbox_mode_from_entries, which reads old-style config entries.

*Call graph*: 2 external calls (new, assert_eq!).


##### `legacy_mode_supports_alias_key`  (lines 68–79)

```
fn legacy_mode_supports_alias_key()
```

**Purpose**: This test makes sure an older alias key for enabling the experimental Windows sandbox still works. That helps users with existing config files avoid unexpected breakage.

**Data flow**: It creates a map containing enable_experimental_windows_sandbox set to true. The legacy parser reads that map and should return Some(WindowsSandboxModeToml::Unelevated).

**Call relations**: The test builds its input with BTreeMap::new and checks the result with assert_eq!. It specifically guards the backwards-compatible alias path in legacy_windows_sandbox_mode_from_entries.

*Call graph*: 2 external calls (new, assert_eq!).


##### `resolve_windows_sandbox_mode_falls_back_to_legacy_keys`  (lines 82–97)

```
fn resolve_windows_sandbox_mode_falls_back_to_legacy_keys()
```

**Purpose**: This test confirms that the main sandbox-mode resolver still looks at legacy feature keys when no newer setting overrides them. It protects backwards compatibility at the full configuration level.

**Data flow**: It creates a map with the old experimental_windows_sandbox key set to true, wraps that map into a FeaturesToml value, and places it inside a ConfigToml built from defaults. It then resolves the Windows sandbox mode and expects Some(WindowsSandboxModeToml::Unelevated).

**Call relations**: This function uses BTreeMap::new to build old-style entries, FeaturesToml::from to convert them into config form, Default::default for the rest of the config, and assert_eq! for the check. It tests resolve_windows_sandbox_mode as the higher-level path that falls back to the legacy parser.

*Call graph*: calls 1 internal fn (from); 3 external calls (new, default, assert_eq!).


##### `resolve_windows_sandbox_private_desktop_defaults_to_true`  (lines 100–104)

```
fn resolve_windows_sandbox_private_desktop_defaults_to_true()
```

**Purpose**: This test verifies that the Windows sandbox private-desktop setting is enabled by default. That default favors stronger isolation unless the user says otherwise.

**Data flow**: It passes a default ConfigToml into resolve_windows_sandbox_private_desktop. With no explicit user setting present, the function should return true.

**Call relations**: The test uses assert! to require a true result. It checks the default branch of resolve_windows_sandbox_private_desktop.

*Call graph*: 1 external calls (assert!).


##### `resolve_windows_sandbox_private_desktop_respects_explicit_cfg_value`  (lines 107–117)

```
fn resolve_windows_sandbox_private_desktop_respects_explicit_cfg_value()
```

**Purpose**: This test confirms that an explicit user setting can turn off the private desktop. It makes sure the default does not override a clear configuration choice.

**Data flow**: It builds a ConfigToml whose Windows section sets sandbox_private_desktop to Some(false), leaving other fields at their defaults. It passes that config to the resolver and expects the result to be false.

**Call relations**: The function uses Default::default to fill in unused configuration fields and assert! to check the negated result. It tests the explicit-setting path of resolve_windows_sandbox_private_desktop.

*Call graph*: 2 external calls (default, assert!).


### `core/src/exec_env_tests.rs`

`test` · `test run`

When this project runs a shell command, it must decide which environment variables the command can see. That matters because environment variables can contain useful basics like PATH, but also private values like API keys. This test file acts like a safety checklist for that decision-making code.

The tests create small fake environments, apply a ShellEnvironmentPolicy, and compare the produced environment against an exact expected map. A policy says things like “inherit all variables,” “inherit only core variables,” “inherit none,” “remove variables whose names look secret,” “only include names matching this pattern,” or “set this variable to this value no matter what.” The tests also check whether a Codex thread ID is added when one is supplied. That ID is like a label on a package: it helps later code know which conversation or task the shell command belongs to.

A few tests only run on Windows. They check that variable names such as Path and PATHEXT are treated case-insensitively, because Windows environment variable names do not care about letter case. They also confirm PATHEXT is present when needed, so Windows can recognize executable file extensions. Without these tests, small policy changes could accidentally leak secrets, drop needed variables, or break command execution on Windows.

#### Function details

##### `make_vars`  (lines 6–11)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: This helper turns a short list of borrowed text pairs into owned String pairs. The tests use it so each fake environment is easy to read and write.

**Data flow**: It receives pairs like ("PATH", "/usr/bin"). It copies each name and value into owned strings. It returns a vector of environment-variable pairs that can be passed into the environment-building functions under test.

**Call relations**: The individual tests call this first to prepare their sample input. After that, they pass the result into populate_env or create_env_from_vars so each test can focus on the policy behavior instead of string setup.

*Call graph*: called by 12 (create_env_inserts_pathext_on_windows_when_missing, create_env_preserves_existing_pathext_case_insensitively_on_windows, populate_env_inserts_thread_id, populate_env_omits_thread_id_when_missing, test_core_inherit_defaults_keep_sensitive_vars, test_core_inherit_respects_case_insensitive_names_on_windows, test_core_inherit_with_default_excludes_enabled, test_include_only, test_inherit_all, test_inherit_all_with_default_excludes (+2 more)).


##### `test_core_inherit_defaults_keep_sensitive_vars`  (lines 14–35)

```
fn test_core_inherit_defaults_keep_sensitive_vars()
```

**Purpose**: This test confirms the default shell environment policy keeps all inherited variables, including names that look sensitive. It documents that the default setting ignores the built-in secret-name filter.

**Data flow**: It starts with PATH, HOME, API_KEY, and SECRET_TOKEN. It applies the default policy and supplies a new thread ID. The expected result keeps all four original variables and adds the Codex thread ID variable.

**Call relations**: During the test run, this uses make_vars to build the fake environment, then asks populate_env from the surrounding module to apply the default policy. It finishes by comparing the actual map with the expected one.

*Call graph*: calls 3 internal fn (make_vars, default, new); 2 external calls (assert_eq!, hashmap!).


##### `test_core_inherit_with_default_excludes_enabled`  (lines 38–60)

```
fn test_core_inherit_with_default_excludes_enabled()
```

**Purpose**: This test checks that the built-in secret filter works when it is turned on. Variables whose names suggest keys, secrets, or tokens should be removed.

**Data flow**: It begins with normal variables and sensitive-looking variables. It builds a policy that does not ignore the default excludes. After populate_env runs, only PATH, HOME, and the thread ID should remain.

**Call relations**: The test prepares input with make_vars, creates a policy variation, and then relies on populate_env to do the filtering. The final assertion protects the intended behavior of the default exclude rules.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `test_include_only`  (lines 63–82)

```
fn test_include_only()
```

**Purpose**: This test verifies that an include-only pattern can narrow the environment down to selected variable names. Here, only names matching a PATH-style pattern are allowed through.

**Data flow**: It starts with PATH and FOO. The policy says to ignore default secret filtering and include only variables matching the case-insensitive pattern *PATH. The result should contain PATH and the added thread ID, but not FOO.

**Call relations**: The test builds its sample variables with make_vars, creates an EnvironmentVariablePattern, and passes everything to populate_env. It confirms that include-only filtering happens before the final environment is returned.

*Call graph*: calls 2 internal fn (make_vars, new); 4 external calls (default, assert_eq!, hashmap!, vec!).


##### `test_set_overrides`  (lines 85–104)

```
fn test_set_overrides()
```

**Purpose**: This test confirms that policy-provided variables are added to the final environment. It shows that the policy can inject values even if they were not inherited from the original environment.

**Data flow**: It begins with PATH. The policy is modified to set NEW_VAR to 42. After populate_env runs, the output contains PATH, NEW_VAR, and the thread ID.

**Call relations**: The test uses make_vars for setup, then edits the policy's set map before calling populate_env. The assertion checks that explicit policy settings are carried into the final environment.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `populate_env_inserts_thread_id`  (lines 107–119)

```
fn populate_env_inserts_thread_id()
```

**Purpose**: This test checks that a provided thread ID is added to the environment. That ID lets later command execution know which Codex thread the command belongs to.

**Data flow**: It starts with a PATH variable and a default policy. It creates a thread ID and passes it to populate_env. The result should be the original PATH plus the special Codex thread ID environment variable.

**Call relations**: The test prepares a minimal environment with make_vars and calls populate_env with a real thread ID. It then compares the output against the exact expected map.

*Call graph*: calls 3 internal fn (make_vars, default, new); 2 external calls (assert_eq!, hashmap!).


##### `populate_env_omits_thread_id_when_missing`  (lines 122–132)

```
fn populate_env_omits_thread_id_when_missing()
```

**Purpose**: This test verifies the opposite case: if no thread ID is supplied, no thread ID variable is added. That prevents the environment from containing a misleading or made-up identifier.

**Data flow**: It starts with only PATH and passes no thread ID. populate_env applies the default policy and returns an environment that still contains only PATH.

**Call relations**: The test uses make_vars to build the input and calls populate_env with None for the optional thread ID. The assertion confirms that the function leaves out the special variable when there is nothing real to put there.

*Call graph*: calls 2 internal fn (make_vars, default); 2 external calls (assert_eq!, hashmap!).


##### `test_inherit_all`  (lines 135–149)

```
fn test_inherit_all()
```

**Purpose**: This test confirms that the “inherit all” policy really keeps every incoming variable when default excludes are disabled. It is the broadest inheritance mode.

**Data flow**: It starts with PATH and FOO. The policy says to inherit all variables and ignore the default secret filters. The output should match the original variables and also include the thread ID.

**Call relations**: The test gets sample variables from make_vars, passes a clone into populate_env, and builds the expected map from the same source data. This ties the expected answer directly to the meaning of “all.”

*Call graph*: calls 2 internal fn (make_vars, new); 2 external calls (default, assert_eq!).


##### `test_inherit_all_with_default_excludes`  (lines 152–168)

```
fn test_inherit_all_with_default_excludes()
```

**Purpose**: This test checks that even the “inherit all” mode can still remove sensitive-looking variables when default excludes are enabled. “All” does not mean “ignore the safety filter” in this configuration.

**Data flow**: It starts with PATH and API_KEY. The policy inherits all variables but enables the default excludes. The result keeps PATH, removes API_KEY, and adds the thread ID.

**Call relations**: The test prepares the environment with make_vars and sends it through populate_env. The expected result proves that inheritance and secret filtering are separate policy steps that combine.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `test_core_inherit_respects_case_insensitive_names_on_windows`  (lines 172–196)

```
fn test_core_inherit_respects_case_insensitive_names_on_windows()
```

**Purpose**: This Windows-only test confirms that core environment variable selection treats names case-insensitively. That matches how Windows itself treats environment variable names.

**Data flow**: It starts with Path, PathExt, TEMP, and FOO. The policy inherits only core variables and disables default excludes. The result should keep the core variables Path, PathExt, and TEMP, drop FOO, and add the thread ID.

**Call relations**: When the test suite runs on Windows, this test uses make_vars and then calls populate_env. It protects Windows behavior where Path and PathExt must be recognized even when their casing differs from the usual spelling.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


##### `create_env_inserts_pathext_on_windows_when_missing`  (lines 200–215)

```
fn create_env_inserts_pathext_on_windows_when_missing()
```

**Purpose**: This Windows-only test checks that PATHEXT is added when building an environment without one. PATHEXT tells Windows which file extensions can be run as commands.

**Data flow**: It starts with no variables. The policy inherits none and disables default excludes. create_env_from_vars returns an environment containing the default PATHEXT value.

**Call relations**: On Windows, the test calls make_vars for an empty input and then uses create_env_from_vars rather than populate_env. The assertion confirms that Windows command-running support is added even when nothing is inherited.

*Call graph*: calls 1 internal fn (make_vars); 3 external calls (default, assert_eq!, hashmap!).


##### `create_env_preserves_existing_pathext_case_insensitively_on_windows`  (lines 219–237)

```
fn create_env_preserves_existing_pathext_case_insensitively_on_windows()
```

**Purpose**: This Windows-only test ensures an existing PATHEXT value is preserved even if its name uses mixed case, such as PathExt. It prevents the code from adding a duplicate or overwriting the user's value.

**Data flow**: It starts with PathExt set to a value that includes .PS1. The policy inherits core variables. create_env_from_vars returns an environment with exactly one PATHEXT-like entry, and that entry keeps the original value.

**Call relations**: The test prepares the mixed-case variable with make_vars and sends it through create_env_from_vars. It then searches the result case-insensitively, mirroring Windows rules, to prove there is only one preserved entry.

*Call graph*: calls 1 internal fn (make_vars); 2 external calls (default, assert_eq!).


##### `test_inherit_none`  (lines 240–259)

```
fn test_inherit_none()
```

**Purpose**: This test verifies that the “inherit none” policy drops all incoming environment variables but still allows explicitly set policy variables. It checks the most locked-down inheritance mode.

**Data flow**: It starts with PATH and HOME. The policy says to inherit none, then explicitly sets ONLY_VAR to yes. After populate_env runs, the output contains ONLY_VAR and the thread ID, but not PATH or HOME.

**Call relations**: The test uses make_vars to create variables that should be ignored, then calls populate_env with a policy that adds one replacement variable. The assertion confirms that explicit settings still work when inheritance is disabled.

*Call graph*: calls 2 internal fn (make_vars, new); 3 external calls (default, assert_eq!, hashmap!).


### `utils/path-utils/src/path_utils_tests.rs`

`test` · `test run`

File paths are not as simple as they look. A path can pass through a symbolic link, which is like a shortcut to another file or folder. On Windows, a path can have a special long-path prefix like `\\?\`. In Windows Subsystem for Linux, often called WSL, Windows drives appear under `/mnt/c`, and letter case can matter in surprising ways. This test file checks that the path utility code smooths over those differences safely.

The tests are grouped by topic. The Unix-only symlink test creates two shortcuts that point at each other, like two signs that each say “go ask the other sign.” It verifies that resolving write paths does not get trapped forever and instead keeps the original write path. The Linux WSL tests check that real WSL drive paths such as `/mnt/C/...` are lowercased, while similar-looking paths that are not drive mounts stay untouched. The native workdir tests check that Windows-only path cleanup removes the special verbatim prefix only when Windows behavior is requested. The path comparison tests confirm that two paths can still be judged equal after normalization, and that if normalization is impossible because files do not exist, the code falls back to simple text equality.

Without these tests, cross-platform file handling could quietly break, especially for developers using WSL, Windows, or symlink-heavy workspaces.

#### Function details

##### `symlinks::symlink_cycles_fall_back_to_root_write_path`  (lines 8–21)

```
fn symlink_cycles_fall_back_to_root_write_path() -> std::io::Result<()>
```

**Purpose**: This Unix-only test checks that a cycle of symbolic links does not make path resolution loop forever. If two symlinks point at each other, the utility should give up safely and use the original path for writing.

**Data flow**: The test starts by creating a temporary folder, then makes two symlinks inside it: `a` points to `b`, and `b` points back to `a`. It passes `a` into `resolve_symlink_write_paths`. The expected result is that there is no separate read path, and the write path remains the original `a` path.

**Call relations**: During the test suite, this function sets up a deliberately broken symlink situation, calls the real path resolver, and then uses assertions to prove the resolver chose the safe fallback instead of chasing links forever.

*Call graph*: 4 external calls (assert_eq!, symlink, resolve_symlink_write_paths, tempdir).


##### `wsl::wsl_mnt_drive_paths_lowercase`  (lines 31–36)

```
fn wsl_mnt_drive_paths_lowercase()
```

**Purpose**: This Linux-only test checks the WSL-specific rule for Windows drive paths. When WSL mode is enabled, a path like `/mnt/C/Users/Dev` should be normalized to lowercase.

**Data flow**: The test builds a path with an uppercase drive letter and mixed-case folders, then sends it to `normalize_for_wsl_with_flag` with the WSL flag set to true. It expects the output path to become `/mnt/c/users/dev`.

**Call relations**: This test exercises the WSL normalization helper directly. It represents the case where the caller has detected a WSL environment and needs the helper to make mounted Windows drive paths consistent.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `wsl::wsl_non_drive_paths_unchanged`  (lines 39–44)

```
fn wsl_non_drive_paths_unchanged()
```

**Purpose**: This Linux-only test makes sure the WSL path cleanup does not overreach. A path under `/mnt` is only treated as a Windows drive mount when the next part is a single drive letter.

**Data flow**: The test creates `/mnt/cc/Users/Dev`, where `cc` is not a one-letter drive name. It passes that path to `normalize_for_wsl_with_flag` with WSL mode turned on. The expected output is exactly the same path that went in.

**Call relations**: This test calls the WSL normalizer in a near-miss case. It guards against changing ordinary Unix paths just because they happen to live below `/mnt`.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `wsl::wsl_non_mnt_paths_unchanged`  (lines 47–52)

```
fn wsl_non_mnt_paths_unchanged()
```

**Purpose**: This Linux-only test checks that WSL normalization leaves normal Linux paths alone. Only mounted Windows drive paths should be lowercased.

**Data flow**: The test starts with `/home/Dev`, passes it to `normalize_for_wsl_with_flag` with WSL mode enabled, and checks that the returned path is unchanged.

**Call relations**: This test covers the ordinary Linux path case. It proves that the WSL helper is selective and does not change unrelated paths during normalization.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_wsl_with_flag).


##### `native_workdir::windows_verbatim_paths_are_simplified`  (lines 62–70)

```
fn windows_verbatim_paths_are_simplified()
```

**Purpose**: This Windows-only test checks that native working-directory normalization removes the special Windows verbatim prefix `\\?\`. That prefix is useful internally to Windows, but it can make paths look different even when they mean the same thing.

**Data flow**: The test creates a Windows-style path beginning with `\\?\D:\...`, then passes it to `normalize_for_native_workdir_with_flag` with the Windows flag set to true. The returned path should be the same path without the `\\?\` prefix.

**Call relations**: This test directly exercises the native workdir normalizer in Windows mode. It protects callers that compare or display paths from being tripped up by Windows’ special path spelling.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_native_workdir_with_flag).


##### `native_workdir::non_windows_paths_are_unchanged`  (lines 73–79)

```
fn non_windows_paths_are_unchanged()
```

**Purpose**: This test checks that Windows-specific cleanup is not applied when Windows behavior is not requested. It prevents the utility from rewriting paths on the wrong platform.

**Data flow**: The test creates a string that looks like a Windows verbatim path, then calls `normalize_for_native_workdir_with_flag` with the Windows flag set to false. The expected output is the exact same path object it started with.

**Call relations**: This test uses the same normalizer as the Windows-specific test, but with the platform flag turned off. It confirms that the helper follows the caller’s platform information instead of blindly editing path text.

*Call graph*: 3 external calls (from, assert_eq!, normalize_for_native_workdir_with_flag).


##### `path_comparison::matches_identical_existing_paths`  (lines 87–92)

```
fn matches_identical_existing_paths() -> std::io::Result<()>
```

**Purpose**: This test checks the simplest successful path comparison case: an existing path should match itself after normalization. It gives confidence that normalization does not break ordinary equality.

**Data flow**: The test creates a temporary directory, then passes that same directory path as both sides of the comparison. `paths_match_after_normalization` should return true, and the test asserts that it does.

**Call relations**: This function calls the path comparison helper in a normal, healthy case where the path exists and can be normalized. It acts as a baseline for the more unusual comparison tests.

*Call graph*: 2 external calls (assert!, tempdir).


##### `path_comparison::falls_back_to_raw_equality_when_paths_cannot_be_normalized`  (lines 95–104)

```
fn falls_back_to_raw_equality_when_paths_cannot_be_normalized()
```

**Purpose**: This test checks what happens when paths cannot be normalized, usually because they do not exist. In that situation, the comparison helper should still make a sensible decision using the raw path text.

**Data flow**: The test compares `missing` with `missing` and expects true, because the raw text is identical. It then compares `missing-a` with `missing-b` and expects false, because the raw text differs.

**Call relations**: This test exercises the fallback branch of the path comparison helper. It matters because callers may compare paths before files or folders have actually been created.

*Call graph*: 1 external calls (assert!).


##### `path_comparison::matches_windows_verbatim_paths`  (lines 108–114)

```
fn matches_windows_verbatim_paths() -> std::io::Result<()>
```

**Purpose**: This Windows-only test checks that a normal path and the same path written with the Windows verbatim prefix are treated as matching. It catches bugs where two spellings of the same folder would be mistaken for different folders.

**Data flow**: The test creates a temporary directory, builds a second path by adding `\\?\` in front of it, and compares the two paths with `paths_match_after_normalization`. The expected result is true.

**Call relations**: This test runs the comparison helper in a Windows-specific scenario. It connects the Windows path simplification behavior to the higher-level question callers care about: do these two paths refer to the same place?

*Call graph*: 4 external calls (from, assert!, format!, tempdir).


### `git-utils/src/fsmonitor_tests.rs`

`test` · `test run`

Git has a feature called fsmonitor, short for filesystem monitor, which helps Git notice file changes faster. But different Git versions and configurations describe this feature in different ways: it may be missing, turned off, set to a helper program path, or enabled with a value like "true". This test file checks that the project interprets those cases correctly.

The file builds a small fake Git command runner, `FakeRunner`. Instead of starting Git, it keeps a queue of expected command calls and fake byte output. When the real detection function asks a question, the fake runner checks that the exact expected question was asked, then returns the prepared answer. This is like rehearsing a phone call with cue cards: each question must come in the right order, and each answer is already written down.

The main test tries several real-world-looking `core.fsmonitor` configurations. It confirms that helper paths, missing values, false values, and unsupported Git versions lead to fsmonitor being disabled, while supported true-like values lead to the built-in monitor being selected. It also checks that every fake response was consumed, which proves the detection code asked no extra questions and skipped no needed ones.

#### Function details

##### `FakeRunner::run_probe`  (lines 20–24)

```
fn run_probe(&mut self, args: &[&str]) -> impl Future<Output = Option<Vec<u8>>> + Send
```

**Purpose**: This is the fake version of “run a Git probe command.” It lets the test control what the detection code sees, while also proving that the detection code asked exactly the expected command.

**Data flow**: It receives the command arguments that the detection code wants to run. It takes the next prepared `ProbeResponse` from its queue, compares the received arguments with the expected ones, and then returns the prepared output bytes, or no output, as an already-finished asynchronous result.

**Call relations**: During the test, `detect_fsmonitor_override` calls this method whenever it would normally ask Git a question. `FakeRunner::run_probe` supplies the staged answer and enforces the expected order, so the test can check both the final decision and the path taken to reach it.

*Call graph*: 3 external calls (pop_front, assert_eq!, ready).


##### `detects_supported_builtin_fsmonitor_values`  (lines 28–108)

```
async fn detects_supported_builtin_fsmonitor_values()
```

**Purpose**: This is the main test. It checks that the fsmonitor detection logic makes the right choice for several important Git configuration situations.

**Data flow**: It starts with a table of named cases. Each case contains fake Git responses and the expected fsmonitor result. For each case, it creates a `FakeRunner`, calls `detect_fsmonitor_override`, and compares the returned decision plus the number of unused fake responses against what the case expects.

**Call relations**: This function drives the whole test scenario. It uses the helper functions to build expected Git command arguments and fake outputs, hands those to `FakeRunner`, then calls the production detection function to see whether the real logic behaves correctly.

*Call graph*: 3 external calls (assert_eq!, detect_fsmonitor_override, vec!).


##### `response`  (lines 110–115)

```
fn response(args: Vec<&'static str>, output: Option<&[u8]>) -> ProbeResponse
```

**Purpose**: This helper builds one fake answer for the fake Git runner. It keeps the test cases short and easy to read.

**Data flow**: It takes the expected command arguments and an optional byte slice that represents Git's output. It packages the arguments together with a copied version of the output bytes into a `ProbeResponse`.

**Call relations**: The main test calls this helper while assembling each case. The resulting `ProbeResponse` values are later consumed one by one by `FakeRunner::run_probe`.


##### `config_args`  (lines 117–119)

```
fn config_args() -> Vec<&'static str>
```

**Purpose**: This helper returns the Git command arguments used to read the raw `core.fsmonitor` setting. It avoids repeating the same argument list in every test case.

**Data flow**: It takes no input. It returns a list of strings representing `git config --null --get core.fsmonitor`, which asks Git for the configured fsmonitor value using null-terminated output.

**Call relations**: The main test uses this helper when it expects the detection code to first ask Git for the plain `core.fsmonitor` value. Those arguments are then checked by `FakeRunner::run_probe`.

*Call graph*: 1 external calls (vec!).


##### `typed_config_args`  (lines 121–131)

```
fn typed_config_args(value: &'static str) -> Vec<&'static str>
```

**Purpose**: This helper returns the Git command arguments used to ask Git to interpret a specific `core.fsmonitor` value as a boolean, meaning true or false. This matters for values whose meaning is not obvious just from the raw text.

**Data flow**: It receives the raw configuration value to check. It returns a list of strings representing a `git config` command that asks Git, with boolean typing enabled, whether that exact value should count as true or false.

**Call relations**: The main test uses this helper for cases like an unusual value or an empty value. The fake runner then verifies that the detection code asked Git to classify that value before making its final decision.

*Call graph*: 1 external calls (vec!).


##### `capability_args`  (lines 133–135)

```
fn capability_args() -> Vec<&'static str>
```

**Purpose**: This helper returns the Git command arguments used to ask whether the installed Git build supports the built-in fsmonitor daemon. The setting alone is not enough; the feature must also exist in that Git version.

**Data flow**: It takes no input. It returns a list of strings representing `git version --build-options`, which is where the detection code looks for build features.

**Call relations**: The main test uses this helper in cases where fsmonitor appears to be enabled. The fake runner uses these arguments to confirm that the detection code checks Git's capabilities before choosing the built-in monitor.

*Call graph*: 1 external calls (vec!).


##### `fsmonitor_capability`  (lines 137–139)

```
fn fsmonitor_capability() -> &'static [u8]
```

**Purpose**: This helper returns a small fake Git build-options output that says the fsmonitor daemon feature is available.

**Data flow**: It takes no input. It returns fixed bytes containing the line `feature: fsmonitor--daemon`, which represents a Git build that supports the built-in filesystem monitor.

**Call relations**: The main test uses this output in cases where enabled configuration should lead to `FsmonitorOverride::BuiltIn`. It is paired with `capability_args` so the detection code sees both an enabled setting and a supported Git build.


### Hooks, prompts, and runtime guards
The final group exercises runtime-facing policy presentation and enforcement, including hook engine behavior, rendered permission instructions, and a memory-write rate-limit guard.

### `hooks/src/engine/mod_tests.rs`

`test` · `test suite`

Hooks are small commands that the app can run at certain moments, such as before a Bash tool runs. This test file acts like a safety checklist for that behavior. It builds temporary config files, fake managed-hook folders, fake plugin hook sources, and small scripts, then checks that the hooks engine treats each source correctly.

A major theme is trust and control. Some hooks are “managed,” meaning they come from an administrator or system policy. Those should stay active even if a user tries to disable them. Ordinary user or plugin hooks may need trust records before they run, and some policy settings can skip unmanaged hooks entirely. The tests make sure those rules are not accidentally weakened.

The file also checks practical behavior: hooks from TOML config and hooks.json can both be discovered, malformed hooks.json files become clear startup warnings, plugin hooks receive the right environment variables, and Windows-specific command overrides are used on Windows. Temporary directories are used like a sandbox kitchen: each test creates only the files it needs, runs the engine, and then verifies the result without touching a real user setup.

#### Function details

##### `cwd`  (lines 35–37)

```
fn cwd() -> AbsolutePathBuf
```

**Purpose**: Gets the current working directory as the project’s absolute-path type. Tests use it when they need to build a realistic hook request.

**Data flow**: It reads the process’s current directory from the operating system, converts it into an AbsolutePathBuf, and returns it. If the directory cannot be read, the test fails immediately.

**Call relations**: Several tests call this helper while building a PreToolUseRequest. It keeps those tests focused on hook behavior instead of repeating path setup.

*Call graph*: calls 1 internal fn (current_dir); called by 6 (discovers_hooks_from_json_and_toml_in_the_same_layer, plugin_hook_sources_run_with_plugin_env_and_plugin_source, profile_user_layers_load_shared_hooks_json_once, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing).


##### `managed_hooks_for_current_platform`  (lines 39–57)

```
fn managed_hooks_for_current_platform(
    managed_dir: impl AsRef<Path>,
    hooks: HookEventsToml,
) -> ManagedHooksRequirementsToml
```

**Purpose**: Builds a managed-hooks configuration using the correct directory field for the operating system. This matters because Windows and non-Windows platforms store the managed hook path in different config fields.

**Data flow**: It receives a managed-hook directory and a set of hook definitions. It copies the directory into either the Windows-specific field or the non-Windows field, then returns a ManagedHooksRequirementsToml value containing those hooks.

**Call relations**: Tests that need administrator-style hooks call this helper before creating a ConfigLayerStack. It feeds managed hook settings into the hooks engine so the tests can check discovery, trust, and execution rules.

*Call graph*: called by 6 (allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing, unknown_requirement_source_hooks_stay_managed, user_disablement_filters_non_managed_hooks_but_not_managed_hooks); 3 external calls (as_ref, clone, cfg!).


##### `pre_tool_use_hook_events`  (lines 59–73)

```
fn pre_tool_use_hook_events(command: impl Into<String>) -> HookEventsToml
```

**Purpose**: Creates a simple hook configuration for the PreToolUse event, limited to Bash tool use. It is a compact way for tests to say, “run this command before Bash.”

**Data flow**: It receives a command string, wraps it in a command hook with a Bash matcher, timeout, synchronous execution, and a status message, then returns a HookEventsToml structure.

**Call relations**: The managed-hooks policy test uses this helper to create repeatable hook definitions. It hands those definitions into managed_hooks_for_current_platform and then into the config stack.

*Call graph*: called by 1 (allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks); 2 external calls (default, vec!).


##### `config_toml_with_pre_tool_use`  (lines 75–113)

```
fn config_toml_with_pre_tool_use(command: &str) -> TomlValue
```

**Purpose**: Builds an in-memory TOML-shaped config containing one PreToolUse command hook. Tests use it instead of writing a full config file by hand.

**Data flow**: It starts with an empty TOML table, inserts a hooks section, adds a PreToolUse group matching Bash, and places one command handler inside it. The output is a TomlValue ready to put into a config layer.

**Call relations**: Tests that need a user, system, or managed config layer call this helper before creating ConfigLayerStack. The hooks engine later reads that stack during discovery.

*Call graph*: called by 1 (allow_managed_hooks_only_in_config_toml_does_not_enable_policy); 7 external calls (default, Array, Integer, String, Table, unreachable!, vec!).


##### `requirements_with_managed_hooks_only`  (lines 115–139)

```
fn requirements_with_managed_hooks_only(
    allow_managed_hooks_only: bool,
    managed_hooks: Option<ManagedHooksRequirementsToml>,
) -> (ConfigRequirements, ConfigRequirementsToml)
```

**Purpose**: Creates matching runtime and TOML representations of the “allow managed hooks only” policy. This lets tests check how the engine behaves when policy allows or rejects unmanaged hooks.

**Data flow**: It receives a boolean policy flag and optional managed hooks. It builds two parallel config requirement objects: one used by code directly and one representing the original TOML form. It returns both together.

**Call relations**: Policy-focused tests call this helper before building the config stack. The resulting requirements are then read by hook discovery and engine creation.

*Call graph*: calls 1 internal fn (new); called by 4 (allow_managed_hooks_only_false_keeps_unmanaged_hooks, allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks, allow_managed_hooks_only_skips_unmanaged_plugin_hooks); 2 external calls (default, default).


##### `requirements_managed_hooks_execute_from_managed_dir`  (lines 142–262)

```
async fn requirements_managed_hooks_execute_from_managed_dir()
```

**Purpose**: Checks that managed hooks from requirements are loaded, shown as managed, previewed with the managed directory as their source path, and actually executed.

**Data flow**: The test creates a temporary managed-hooks folder, writes a Python hook that logs its input, builds a managed config stack, creates the engine, previews the matching Bash hook, runs it, and reads the log file. The expected result is one managed hook that runs successfully and receives a PreToolUse payload.

**Call relations**: It uses managed_hooks_for_current_platform and cwd to prepare the scenario, then calls ClaudeHooksEngine creation, preview, run, and list_hooks. This verifies the full path from config requirements to visible hook entry to command execution.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new, try_from); 15 external calls (default, new, new, default, assert!, assert_eq!, default, list_hooks, format!, create_dir_all (+5 more)).


##### `requirements_managed_hooks_execute_windows_command_override`  (lines 265–342)

```
async fn requirements_managed_hooks_execute_windows_command_override()
```

**Purpose**: Checks that a managed hook uses its Windows-specific command on Windows and its normal command elsewhere. This prevents the same hook config from failing on one platform because shell syntax differs.

**Data flow**: The test creates a managed hook with two commands: one normal and one Windows override. It runs the PreToolUse hook and expects the hook to fail with the platform-specific exit code, proving the correct command was chosen.

**Call relations**: It builds managed hook requirements with managed_hooks_for_current_platform, creates the engine, then runs run_pre_tool_use. The outcome is inspected to confirm the engine’s command selection behavior.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new, try_from); 12 external calls (default, new, new, default, assert!, assert_eq!, cfg!, default, create_dir_all, json! (+2 more)).


##### `unknown_requirement_source_hooks_stay_managed`  (lines 345–410)

```
fn unknown_requirement_source_hooks_stay_managed()
```

**Purpose**: Checks that hooks from requirement data remain treated as managed even when their requirement source is unknown. This keeps policy-provided hooks protected instead of accidentally treating them like normal user hooks.

**Data flow**: The test creates managed hooks whose source is marked Unknown, builds the engine, and also calls discovery directly. It expects the hook to be enabled, marked managed, and given a managed trust status, while preserving the Unknown source label.

**Call relations**: It uses managed_hooks_for_current_platform for setup and then checks both ClaudeHooksEngine and discovery::discover_handlers. This ties engine behavior to the lower-level discovery result.

*Call graph*: calls 7 internal fn (new, allow_any, new, new, discover_handlers, managed_hooks_for_current_platform, try_from); 9 external calls (default, new, new, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `user_disablement_filters_non_managed_hooks_but_not_managed_hooks`  (lines 413–498)

```
fn user_disablement_filters_non_managed_hooks_but_not_managed_hooks()
```

**Purpose**: Checks that a user’s disabled-hook state can turn off an ordinary hook but cannot turn off a managed hook. This protects administrator-controlled hooks from local user changes.

**Data flow**: The test creates one managed hook and one user hook, then creates state entries that mark both keys disabled. After engine setup and discovery, only the managed hook is active, while the user hook is listed as disabled.

**Call relations**: It uses config_with_pre_tool_use_hook_and_states to create the user config and managed_hooks_for_current_platform for the managed config. It then compares engine-loaded handlers with discovery entries.

*Call graph*: calls 8 internal fn (new, allow_any, new, new, discover_handlers, config_with_pre_tool_use_hook_and_states, managed_hooks_for_current_platform, try_from); 11 external calls (default, new, new, default, assert!, assert_eq!, default, format!, create_dir_all, tempdir (+1 more)).


##### `user_disablement_does_not_filter_managed_layer_hooks`  (lines 501–561)

```
fn user_disablement_does_not_filter_managed_layer_hooks()
```

**Purpose**: Checks that hooks coming from a managed config layer cannot be disabled by user hook state. This covers managed hooks that come from config files, not only from requirements.

**Data flow**: The test creates a user config layer that marks a managed-layer hook key as disabled, then adds a managed config layer containing that hook. The engine still loads the hook, and discovery reports it as enabled and managed.

**Call relations**: It uses config_with_hook_state for the user state and config_with_pre_tool_use_hook for the managed hook layer. It then checks both engine creation and discover_handlers.

*Call graph*: calls 4 internal fn (new, new, discover_handlers, try_from); 9 external calls (new, new, default, assert!, assert_eq!, default, format!, tempdir, vec!).


##### `config_with_hook_state`  (lines 563–574)

```
fn config_with_hook_state(key: &str, enabled: bool) -> TomlValue
```

**Purpose**: Builds a small config object containing only one hook state entry. Tests use it to say whether a particular hook key is enabled or disabled.

**Data flow**: It receives a hook key and a boolean enabled flag, places them under hooks.state in a JSON-like value, converts that into the project’s TOML value type, and returns it.

**Call relations**: This helper supports tests that simulate saved user preferences. Those preferences are later read by ConfigLayerStack and hook discovery.

*Call graph*: 2 external calls (from_value, json!).


##### `config_with_pre_tool_use_hook_and_states`  (lines 576–596)

```
fn config_with_pre_tool_use_hook_and_states(
    command: &str,
    disabled_keys: [&str; N],
) -> TomlValue
```

**Purpose**: Builds a config containing one PreToolUse command hook plus disabled-state entries for several hook keys. It is useful for testing how saved disabled settings affect discovery.

**Data flow**: It receives a command and a fixed-size list of disabled keys. It turns each key into a state entry with enabled set to false, adds a PreToolUse command hook, converts the whole value to TomlValue, and returns it.

**Call relations**: The user-disablement test calls this helper to create a user config layer. Discovery then uses that layer to decide which hooks are enabled.

*Call graph*: called by 1 (user_disablement_filters_non_managed_hooks_but_not_managed_hooks); 2 external calls (from_value, json!).


##### `config_with_pre_tool_use_hook`  (lines 598–610)

```
fn config_with_pre_tool_use_hook(command: &str) -> TomlValue
```

**Purpose**: Builds a minimal config containing one PreToolUse command hook. It keeps tests short when they only care that a hook exists.

**Data flow**: It receives a command string, places it under hooks.PreToolUse as a command handler, converts the structure into TomlValue, and returns it.

**Call relations**: Several managed-layer and policy tests use this helper while creating ConfigLayerEntry values. The engine later reads those entries during hook discovery.

*Call graph*: 2 external calls (from_value, json!).


##### `trusted_plugin_hook_stack`  (lines 612–653)

```
fn trusted_plugin_hook_stack(
    config_path: AbsolutePathBuf,
    plugin_hook_sources: &[PluginHookSource],
) -> ConfigLayerStack
```

**Purpose**: Creates a user config stack that trusts the current hashes of plugin hooks. Plugin hooks need this trust record so the engine can run them without bypassing trust checks.

**Data flow**: It receives a config path and plugin hook sources. It first discovers the plugin hooks to learn their keys and current hashes, writes those hashes into hooks.state as trusted_hash entries, and returns a ConfigLayerStack containing that trust state.

**Call relations**: Plugin tests call this helper before creating the hooks engine. It relies on discover_handlers to compute the trust data, then feeds the resulting config stack back into engine setup.

*Call graph*: calls 2 internal fn (new, discover_handlers); called by 2 (plugin_hook_sources_expand_plugin_placeholders, plugin_hook_sources_run_with_plugin_env_and_plugin_source); 7 external calls (new, default, default, to_vec, from_value, json!, vec!).


##### `requirements_managed_hooks_load_when_managed_dir_is_missing`  (lines 656–724)

```
fn requirements_managed_hooks_load_when_managed_dir_is_missing()
```

**Purpose**: Checks that managed hooks still load even if the declared managed directory does not exist on disk. This matters because the directory may be a source label rather than something the engine needs to scan.

**Data flow**: The test creates a path but does not create the folder, builds managed requirements pointing to it, creates the engine, and previews a matching Bash hook. The hook is still present, with the missing path recorded as its source path.

**Call relations**: It uses managed_hooks_for_current_platform and cwd, then exercises engine construction and preview_pre_tool_use. This confirms discovery does not wrongly reject requirement-provided hooks just because the directory is absent.

*Call graph*: calls 7 internal fn (new, allow_any, new, new, cwd, managed_hooks_for_current_platform, new); 10 external calls (default, new, new, default, assert!, assert_eq!, default, json!, tempdir, vec!).


##### `allow_managed_hooks_only_false_keeps_unmanaged_hooks`  (lines 727–773)

```
fn allow_managed_hooks_only_false_keeps_unmanaged_hooks()
```

**Purpose**: Checks the behavior when the managed-only policy is explicitly false. The unmanaged hook should still be discoverable, though it may not be loaded into the engine if trust rules stop it.

**Data flow**: The test creates a user config with one unmanaged hook and requirements saying managed-only is false. Discovery finds the hook and marks it unmanaged, while the engine has no runnable handlers because the hook is not trusted.

**Call relations**: It uses requirements_with_managed_hooks_only and config_toml_with_pre_tool_use, then compares ClaudeHooksEngine setup with discover_handlers output.

*Call graph*: calls 5 internal fn (new, new, discover_handlers, requirements_with_managed_hooks_only, try_from); 6 external calls (new, new, assert!, assert_eq!, tempdir, vec!).


##### `allow_managed_hooks_only_in_config_toml_does_not_enable_policy`  (lines 776–827)

```
fn allow_managed_hooks_only_in_config_toml_does_not_enable_policy()
```

**Purpose**: Checks that putting allow_managed_hooks_only inside ordinary config TOML does not activate the managed-only policy. The policy must come from requirements, not a user-editable config field.

**Data flow**: The test creates a user config with a PreToolUse hook and manually inserts allow_managed_hooks_only = true. Discovery still finds the unmanaged hook, proving that this ordinary config field did not enforce the policy.

**Call relations**: It calls config_toml_with_pre_tool_use, edits the returned TOML value, then creates the engine and calls discover_handlers. This guards against accidentally letting local config impersonate policy.

*Call graph*: calls 5 internal fn (new, new, discover_handlers, config_toml_with_pre_tool_use, try_from); 10 external calls (new, Boolean, new, default, assert!, assert_eq!, default, tempdir, unreachable!, vec!).


##### `allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks`  (lines 830–885)

```
fn allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks()
```

**Purpose**: Checks that when managed-only policy is true, unmanaged hooks from both hooks.json and TOML config are skipped. This enforces the policy across both supported config formats.

**Data flow**: The test writes a hooks.json file with one hook and creates TOML config with another hook. It enables managed-only requirements and builds the engine. The result is no loaded handlers and no warnings.

**Call relations**: It uses requirements_with_managed_hooks_only and config_toml_with_pre_tool_use to set up policy and config. Engine construction is the behavior under test.

*Call graph*: calls 4 internal fn (new, new, requirements_with_managed_hooks_only, try_from); 6 external calls (new, new, assert!, write, tempdir, vec!).


##### `allow_managed_hooks_only_skips_unmanaged_plugin_hooks`  (lines 888–924)

```
fn allow_managed_hooks_only_skips_unmanaged_plugin_hooks()
```

**Purpose**: Checks that managed-only policy also skips plugin-provided hooks. This prevents plugins from bypassing a policy that allows only administrator-controlled hooks.

**Data flow**: The test creates a fake plugin hook source, enables managed-only requirements, and builds the engine. The engine loads no handlers and reports no warnings.

**Call relations**: It uses requirements_with_managed_hooks_only for the policy and passes plugin hook sources into ClaudeHooksEngine::new. This connects plugin discovery to the same managed-only rule used for config hooks.

*Call graph*: calls 5 internal fn (new, new, requirements_with_managed_hooks_only, parse, try_from); 5 external calls (new, new, assert!, tempdir, vec!).


##### `allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks`  (lines 927–1016)

```
fn allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks()
```

**Purpose**: Checks that managed-only policy still allows all managed hook sources. The policy should remove ordinary hooks, not block administrator or system hooks.

**Data flow**: The test creates managed hooks from requirements and several managed config layers: MDM, system, legacy managed file, and legacy managed MDM. With managed-only policy enabled, the engine loads all expected commands, and discovery marks every entry as managed.

**Call relations**: It combines managed_hooks_for_current_platform, pre_tool_use_hook_events, requirements_with_managed_hooks_only, and config_toml_with_pre_tool_use. Then it checks both engine handlers and discover_handlers output.

*Call graph*: calls 7 internal fn (new, new, discover_handlers, managed_hooks_for_current_platform, pre_tool_use_hook_events, requirements_with_managed_hooks_only, try_from); 7 external calls (new, new, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `discovers_hooks_from_json_and_toml_in_the_same_layer`  (lines 1019–1135)

```
fn discovers_hooks_from_json_and_toml_in_the_same_layer()
```

**Purpose**: Checks that the engine can discover hooks from both hooks.json and TOML in the same config layer, while warning that both sources are being used. This helps users understand why multiple hooks appeared.

**Data flow**: The test writes a hooks.json hook next to a system config TOML hook, creates the engine, and checks for a warning mentioning both files. A preview for Bash shows two hooks, one from each source path.

**Call relations**: It builds the config stack directly, calls ClaudeHooksEngine::new, then uses preview_pre_tool_use. It verifies how file discovery, warnings, and preview output line up.

*Call graph*: calls 5 internal fn (new, new, cwd, new, try_from); 15 external calls (default, new, Array, String, Table, new, default, assert!, assert_eq!, default (+5 more)).


##### `profile_user_layers_load_shared_hooks_json_once`  (lines 1138–1226)

```
fn profile_user_layers_load_shared_hooks_json_once()
```

**Purpose**: Checks that a shared hooks.json file is loaded only once when both a base user config and a profile-specific user config exist. This avoids duplicate hooks in profile setups.

**Data flow**: The test writes one hooks.json file and creates two user config layers in the same folder. With trust bypass enabled, the engine loads exactly one handler, preview shows one hook, and list_hooks also reports one hook.

**Call relations**: It creates a ConfigLayerStack with two user layers, then checks both ClaudeHooksEngine and crate::list_hooks. The cwd helper supplies the request path for preview.

*Call graph*: calls 5 internal fn (new, new, cwd, new, try_from); 12 external calls (default, new, new, default, assert!, assert_eq!, default, list_hooks, write, json! (+2 more)).


##### `malformed_hooks_json_is_reported_as_startup_warning`  (lines 1229–1282)

```
fn malformed_hooks_json_is_reported_as_startup_warning()
```

**Purpose**: Checks that a badly shaped hooks.json file becomes a clear startup warning instead of silently disappearing or crashing. This makes configuration mistakes visible.

**Data flow**: The test writes a hooks.json file with an unexpected top-level field, creates the engine, and expects no handlers plus one warning. The warning must mention parse failure, the bad file path, and the unknown field.

**Call relations**: It sets up a system config layer so the nearby hooks.json is considered during engine startup. ClaudeHooksEngine::new collects the warning that the test then inspects.

*Call graph*: calls 3 internal fn (new, new, try_from); 9 external calls (new, new, default, assert!, assert_eq!, default, write, tempdir, vec!).


##### `plugin_hook_sources_run_with_plugin_env_and_plugin_source`  (lines 1285–1414)

```
async fn plugin_hook_sources_run_with_plugin_env_and_plugin_source()
```

**Purpose**: Checks that plugin hooks run as plugin-sourced hooks and receive plugin path environment variables. This lets plugin hook scripts find their own files and data reliably.

**Data flow**: The test creates a fake plugin root, writes a Python script that prints selected environment variables, trusts the plugin hook, previews it, lists it, then runs it. The completed hook output must show PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT pointing at the plugin root.

**Call relations**: It uses trusted_plugin_hook_stack to prepare trust state, then exercises preview_pre_tool_use, list_hooks, and run_pre_tool_use. This covers plugin metadata from discovery through execution output.

*Call graph*: calls 6 internal fn (new, cwd, trusted_plugin_hook_stack, parse, new, try_from); 10 external calls (new, new, assert_eq!, list_hooks, create_dir_all, write, from_str, json!, tempdir, vec!).


##### `plugin_hook_sources_expand_plugin_placeholders`  (lines 1417–1491)

```
fn plugin_hook_sources_expand_plugin_placeholders()
```

**Purpose**: Checks that plugin hook command strings can use placeholders for plugin directories. The engine should replace those placeholders with real paths before running the hook.

**Data flow**: The test creates a fake plugin hook command containing PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, PLUGIN_DATA, and CLAUDE_PLUGIN_DATA placeholders. After engine creation, the handler command contains real paths, and its environment map contains the same path values.

**Call relations**: It uses trusted_plugin_hook_stack to mark the plugin hook trusted, then inspects the handler built by ClaudeHooksEngine::new. This confirms placeholder expansion happens during engine setup.

*Call graph*: calls 4 internal fn (new, trusted_plugin_hook_stack, parse, try_from); 5 external calls (new, new, assert_eq!, tempdir, vec!).


##### `plugin_hook_load_warnings_are_startup_warnings`  (lines 1494–1508)

```
fn plugin_hook_load_warnings_are_startup_warnings()
```

**Purpose**: Checks that warnings produced while loading plugin hooks are exposed as engine startup warnings. This keeps plugin hook loading problems visible to the caller.

**Data flow**: The test creates an engine with no config or plugin hooks but with one plugin load warning string. Calling engine.warnings returns that same warning.

**Call relations**: It directly exercises ClaudeHooksEngine::new with plugin_hook_load_warnings. No discovery helper is needed because the test only checks warning propagation.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, assert_eq!, vec!).


### `prompts/src/permissions_instructions_tests.rs`

`test` · `test suite`

The project builds prompt text that tells the model what it may do: which files it can read or edit, whether network access is allowed, and when it should ask for approval. This test file acts like a checklist for that wording. Without these tests, a small code change could silently remove important safety instructions, tell the model the wrong sandbox mode, or forget to mention how to request extra permissions.

The tests create different permission setups, then check the generated instruction text. Some setups are simple, such as read-only filesystem access or full network access. Others are more detailed, such as a writable project folder plus denied read locations. The file also checks approval behavior: whether approvals are requested from a user, automatically reviewed, never requested, or split into granular categories.

A useful way to think about this file is as a proofreader with a safety checklist. It does not enforce the sandbox itself. Instead, it verifies that the written instructions accurately describe the sandbox and approval process, so the model receives the right “rules of the room” before it acts.

#### Function details

##### `renders_sandbox_mode_text`  (lines 14–29)

```
fn renders_sandbox_mode_text()
```

**Purpose**: This test checks that each main sandbox mode is described with the correct plain-language message. It covers workspace-write, read-only, and danger-full-access, along with whether network access is restricted or enabled.

**Data flow**: It starts with specific sandbox and network settings, passes them to the sandbox text builder, and compares the returned sentence to the exact expected wording. Nothing is changed outside the test; the output is simply a pass or fail result.

**Call relations**: The test calls the sandbox text-producing code directly and uses equality checks to catch wording changes. It is one of the basic guardrails for the larger permission prompt tests that follow.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_permissions_with_network_access_override`  (lines 32–55)

```
fn builds_permissions_with_network_access_override()
```

**Purpose**: This test confirms that permission instructions can explicitly say network access is enabled, even when other sandbox details are also present. It also checks that approval guidance is included when approvals are allowed on request.

**Data flow**: It builds a permissions instruction object from a workspace-write sandbox, enabled network access, and an on-request approval policy. It then reads the generated body text and checks that it contains both the network message and the escalation guidance.

**Call relations**: The test calls the main constructor for permission instructions from direct settings. It verifies that the constructor combines sandbox, network, and approval information into one prompt body.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `builds_permissions_from_profile`  (lines 58–85)

```
fn builds_permissions_from_profile()
```

**Purpose**: This test checks that a runtime permission profile is translated into the right prompt text. It makes sure a writable root folder and enabled network access appear correctly.

**Data flow**: It creates a current directory, creates an absolute writable project path, builds a restricted filesystem policy with write access to that path, and combines it with enabled network access. That profile is fed into the permission instruction builder, whose body text is checked for workspace-write mode, enabled network access, and the writable path.

**Call relations**: This test exercises the path from low-level runtime permission objects into user-facing prompt instructions. It shows that permission profiles are not just stored internally; they are turned into readable guidance.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); 4 external calls (from, assert!, empty, vec!).


##### `builds_permissions_from_profile_with_denied_reads`  (lines 88–131)

```
fn builds_permissions_from_profile_with_denied_reads()
```

**Purpose**: This test checks that denied filesystem reads are clearly called out in the generated instructions. Denied reads are important because the model should not ask for escalation to read locations that are explicitly blocked.

**Data flow**: It creates a permission profile that allows reading from the root area but denies access to one exact path and one glob pattern, which is a wildcard-style path rule. The instruction builder turns this profile into text, and the test checks that the denied-read section, the no-escalation warning, the denied path, and the denied glob all appear.

**Call relations**: This test uses the profile-based instruction builder and focuses on a special safety case: blocked reads. It ensures that the generated prompt tells the model not to treat those blocks as ordinary approval problems.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert!, test_path_buf, empty, vec!).


##### `includes_request_rule_instructions_for_on_request`  (lines 134–156)

```
fn includes_request_rule_instructions_for_on_request()
```

**Purpose**: This test checks that approved command-prefix rules are included when approval is set to on-request. A command prefix rule means a command starting with certain words, such as `git pull`, is already allowed.

**Data flow**: It creates an empty execution policy, adds an allow rule for the command prefix `git pull`, builds permission instructions, and reads the generated body text. The test then checks that the text mentions prefix rules, approved command prefixes, and the specific command prefix.

**Call relations**: The test connects execution policy rules to the final prompt text. It makes sure the instruction builder does not hide pre-approved command information from the model.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled`  (lines 159–176)

```
fn includes_request_permissions_tool_instructions_for_unless_trusted_when_enabled()
```

**Purpose**: This test checks that the built-in request-permissions tool is explained when the approval policy is unless-trusted and the tool is enabled. Unless-trusted means some actions may proceed only if they are considered trusted; otherwise approval may be needed.

**Data flow**: It builds permission instructions with workspace-write access, enabled network access, the unless-trusted approval policy, and the request-permissions tool turned on. It then checks the body text for the policy name and the tool section.

**Call relations**: The test calls the permission instruction constructor and verifies that enabling the tool affects the prompt. It covers one approval mode where the tool should be advertised.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_on_failure_when_enabled`  (lines 179–196)

```
fn includes_request_permissions_tool_instructions_for_on_failure_when_enabled()
```

**Purpose**: This test checks that request-permissions tool guidance appears when approval is set to on-failure and the tool is enabled. On-failure means the model usually tries first, then asks if a sandbox or permission issue stops it.

**Data flow**: It creates permission instructions with on-failure approval and the request-permissions tool enabled. It reads the generated body and checks that both the policy name and the tool section are present.

**Call relations**: The test uses the same instruction-building path as other approval tests, but with a different policy. It confirms the tool guidance is not limited to just one approval mode.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permission_rule_instructions_for_on_request_when_enabled`  (lines 199–216)

```
fn includes_request_permission_rule_instructions_for_on_request_when_enabled()
```

**Purpose**: This test checks that inline command permission request guidance appears when on-request approval is active and that feature is enabled. Inline guidance tells the model how to ask for extra permissions as part of a command request.

**Data flow**: It builds permission instructions using on-request approval, with execution permission approvals enabled and the separate request-permissions tool disabled. The generated text is checked for phrases related to additional permissions.

**Call relations**: The test verifies the branch where permission requests are made through command execution metadata instead of through the separate tool. It complements the tests that check the tool-based path.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled`  (lines 219–236)

```
fn includes_request_permissions_tool_instructions_for_on_request_when_tool_is_enabled()
```

**Purpose**: This test checks that the request-permissions tool section appears for on-request approval when the tool is enabled. It also confirms the text explicitly says the built-in tool is available.

**Data flow**: It builds permission instructions with on-request approval and turns on the request-permissions tool. It then reads the body text and checks for the tool heading and the availability sentence.

**Call relations**: The test calls the direct permission instruction constructor and focuses on the tool-specific part of the generated prompt. It proves the on-request policy can use the tool guidance when configured that way.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist`  (lines 239–256)

```
fn on_request_includes_tool_guidance_alongside_inline_permission_guidance_when_both_exist()
```

**Purpose**: This test checks that two kinds of permission-request guidance can appear together. If both inline permission requests and the request-permissions tool are enabled, the prompt should mention both rather than choosing only one.

**Data flow**: It builds instructions with on-request approval, inline execution permission approvals enabled, and the request-permissions tool enabled. The resulting text is checked for both the inline additional-permissions wording and the tool section heading.

**Call relations**: This test covers the combined case created by two feature switches. It ensures the instruction builder appends both pieces of guidance instead of letting one overwrite the other.

*Call graph*: calls 1 internal fn (from_permissions_with_network); 2 external calls (assert!, empty).


##### `auto_review_approvals_append_auto_review_specific_guidance`  (lines 259–271)

```
fn auto_review_approvals_append_auto_review_specific_guidance()
```

**Purpose**: This test checks that auto-review approvals add guidance specific to automatic review. Auto-review means requests are judged by an automated reviewer rather than directly by a person.

**Data flow**: It asks the approval text builder for on-request approval with the auto-review reviewer. The returned text is checked for the auto-review label, checked to ensure it does not mention a different reviewer type, and checked for wording about choosing a materially safer alternative.

**Call relations**: The test exercises the approval-text path directly rather than building a whole permissions prompt. It verifies that reviewer-specific advice is added only for the matching reviewer.

*Call graph*: 2 external calls (assert!, empty).


##### `auto_review_approvals_omit_auto_review_specific_guidance_when_approval_is_never`  (lines 274–285)

```
fn auto_review_approvals_omit_auto_review_specific_guidance_when_approval_is_never()
```

**Purpose**: This test checks that auto-review guidance is not shown when approvals are disabled entirely. If the policy is never ask, reviewer details should not matter.

**Data flow**: It asks for approval text using the never-ask approval policy and the auto-review reviewer. The resulting text is checked to make sure it does not mention auto-review or another reviewer type.

**Call relations**: This test pairs with the previous auto-review test. Together they confirm that reviewer-specific text appears only when approval requests can actually happen.

*Call graph*: 2 external calls (assert!, empty).


##### `granular_categories_section`  (lines 287–289)

```
fn granular_categories_section(title: &str, categories: &[&str]) -> String
```

**Purpose**: This helper builds a small text section for granular approval tests. It takes a heading and a list of category lines, then joins them into the format expected in the prompt.

**Data flow**: It receives a title string and a list of category strings. It returns one string containing the title, a newline, and the categories joined with newlines.

**Call relations**: This helper is called by `granular_prompt_expected` to avoid repeating the same formatting logic in several granular approval tests. It is not itself a test case.

*Call graph*: called by 1 (granular_prompt_expected); 1 external calls (format!).


##### `granular_prompt_expected`  (lines 291–317)

```
fn granular_prompt_expected(
    prompted_categories: &[&str],
    rejected_categories: &[&str],
    include_shell_permission_request_instructions: bool,
    include_request_permissions_tool_section:
```

**Purpose**: This helper builds the full expected approval text for granular approval tests. Granular approval means different approval categories can be individually allowed to prompt or automatically rejected.

**Data flow**: It receives lists of prompted and rejected categories, plus two booleans saying whether to include inline shell permission instructions and the request-permissions tool section. It starts with the common granular introduction, conditionally adds category sections and optional guidance sections, then returns the combined text.

**Call relations**: This helper calls `granular_categories_section` when category lists need formatting. Several granular policy tests use it as the expected answer when comparing against the real approval text.

*Call graph*: calls 1 internal fn (granular_categories_section); 1 external calls (vec!).


##### `granular_policy_lists_prompted_and_rejected_categories_separately`  (lines 320–354)

```
fn granular_policy_lists_prompted_and_rejected_categories_separately()
```

**Purpose**: This test checks that granular approval text separates categories that may still ask the user from categories that are automatically rejected. That distinction matters because the model needs to know which requests are worth making.

**Data flow**: It builds approval text from a granular configuration where only the rules category may prompt, while several other categories are rejected. It compares the whole returned text to the expected intro plus separate prompted and rejected sections.

**Call relations**: The test calls the approval text builder with a granular approval policy and uses an exact equality check. It validates the basic layout that later granular tests build on.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_includes_command_permission_instructions_when_sandbox_approval_can_prompt`  (lines 357–386)

```
fn granular_policy_includes_command_permission_instructions_when_sandbox_approval_can_prompt()
```

**Purpose**: This test checks that command permission request instructions are included when sandbox approval is one of the granular categories that may prompt. In plain terms, if the model can ask for sandbox-related command approval, the prompt should tell it how.

**Data flow**: It creates a granular approval setup where all relevant categories can prompt, enables inline execution permission approvals, and asks for approval text. The result is compared to an expected string that includes prompted categories and shell permission request guidance.

**Call relations**: The test uses `granular_prompt_expected` to build the expected text. It confirms that the approval-text builder adds command permission guidance only when granular settings allow the related prompt.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_omits_shell_permission_instructions_when_inline_requests_are_disabled`  (lines 389–418)

```
fn granular_policy_omits_shell_permission_instructions_when_inline_requests_are_disabled()
```

**Purpose**: This test checks that shell command permission instructions are left out when inline permission requests are disabled. Even if sandbox approval can prompt, the prompt should not advertise a request method that is unavailable.

**Data flow**: It uses a granular approval setup where approval categories can prompt, but passes a flag saying inline execution permission approvals are disabled. It compares the returned approval text to expected text that lists prompted categories but omits shell permission request instructions.

**Call relations**: This test uses the same granular helper pattern as the previous one, but changes the feature flag. It proves that both the policy and the feature switch must allow inline guidance before it appears.

*Call graph*: 3 external calls (Granular, assert_eq!, empty).


##### `granular_policy_includes_request_permissions_tool_only_when_that_prompt_can_still_fire`  (lines 421–451)

```
fn granular_policy_includes_request_permissions_tool_only_when_that_prompt_can_still_fire()
```

**Purpose**: This test checks that the request-permissions tool section appears only when the granular request-permissions category is allowed to prompt. If that category is rejected, the tool should not be advertised even if the tool is technically enabled.

**Data flow**: It builds one granular approval text where request-permissions is allowed and confirms the tool section appears. It then builds another where request-permissions is rejected and confirms the tool section is absent.

**Call relations**: The test calls the approval text builder twice with different granular settings. It ties the request-permissions tool guidance to the category that controls whether such requests can actually happen.

*Call graph*: 3 external calls (Granular, assert!, empty).


##### `granular_policy_lists_request_permissions_category_without_tool_section_when_tool_unavailable`  (lines 454–471)

```
fn granular_policy_lists_request_permissions_category_without_tool_section_when_tool_unavailable()
```

**Purpose**: This test checks the case where the request-permissions category is enabled in policy but the actual tool is unavailable. The prompt should not list or explain a tool the model cannot use.

**Data flow**: It creates a granular approval configuration where request-permissions is true but passes a flag saying the request-permissions tool is disabled. It checks that the returned approval text does not contain the request-permissions category line or the tool section heading.

**Call relations**: This test covers the other side of the tool availability check. It ensures the approval text builder looks at both the granular policy and the tool-enabled flag before mentioning request-permissions.

*Call graph*: 3 external calls (Granular, assert!, empty).


### `memories/write/src/guard_tests.rs`

`test` · `test run`

This is a test file for a guard around rate limits. A rate limit is a cap on how much the system can use an external service in a period of time. The guard is like checking the fuel gauge before starting a trip: if there is not enough fuel left, or the tank is already marked empty, the trip should not begin.

The tests build small fake rate-limit snapshots. Each snapshot can include a “primary” and “secondary” usage percentage, meaning how much of two different quota buckets has already been spent. The production function being checked, `snapshot_allows_startup`, is expected to look at those percentages and decide whether startup is safe.

The file verifies three important rules. First, the minimum remaining quota is configurable: if 10% must remain, 89.9% used is still acceptable, but if 11% must remain, it is not. Second, both the primary and secondary quotas matter; either one being too close to full should block startup. Third, an explicit “rate limit reached” flag overrides the percentages and blocks startup immediately.

Without these tests, a future change could accidentally let the memory writer start when it is nearly out of allowed requests, causing failures later during real work.

#### Function details

##### `snapshot`  (lines 4–18)

```
fn snapshot(
    primary_used_percent: Option<f64>,
    secondary_used_percent: Option<f64>,
) -> RateLimitSnapshot
```

**Purpose**: Creates a small fake `RateLimitSnapshot` for tests. It lets the tests focus on the primary and secondary usage percentages without filling in every field by hand each time.

**Data flow**: It receives optional primary and secondary used percentages. For each percentage that is present, it turns it into a `RateLimitWindow`; for missing values, it leaves that side empty. It returns a complete snapshot object with the Codex limit ID filled in and the other fields left blank unless the test changes them later.

**Call relations**: The startup-check tests call on this helper when they need a realistic-looking snapshot. It hands those snapshots to the assertions that exercise `snapshot_allows_startup`.

*Call graph*: called by 2 (startup_check_skips_when_limit_is_reached, startup_check_uses_configured_remaining_threshold).


##### `window`  (lines 20–26)

```
fn window(used_percent: f64) -> RateLimitWindow
```

**Purpose**: Builds the small piece of a rate-limit snapshot that says how much of one quota window has been used. A window is a time period for a limit, such as a quota that resets later.

**Data flow**: It receives one number: the used percentage. It places that number into a `RateLimitWindow` and leaves timing details, such as reset time and window length, empty because these tests do not need them.

**Call relations**: This helper sits underneath `snapshot`. When `snapshot` needs to include primary or secondary usage, it uses `window` to make that part of the fake rate-limit data.


##### `startup_check_uses_configured_remaining_threshold`  (lines 29–41)

```
fn startup_check_uses_configured_remaining_threshold()
```

**Purpose**: Checks that the startup guard respects the configured minimum remaining quota. The same rate-limit snapshot can be allowed or blocked depending on how much free capacity the configuration requires.

**Data flow**: It starts with a fake snapshot where the primary quota is 89.9% used and the secondary quota is 50% used. It asks whether startup is allowed when 10% must remain, expecting yes, then asks again when 11% must remain, expecting no. The output is not a returned value; the test passes or fails through assertions.

**Call relations**: This test uses `snapshot` to prepare the input data, then calls the production startup decision function through assertions. If the guard stops honoring the configured threshold, this test is the one that fails.

*Call graph*: calls 1 internal fn (snapshot); 1 external calls (assert!).


##### `startup_check_skips_when_primary_or_secondary_is_too_low`  (lines 44–66)

```
fn startup_check_skips_when_primary_or_secondary_is_too_low()
```

**Purpose**: Checks that startup is blocked if either quota bucket has too little remaining capacity. It also confirms startup is allowed when both buckets are just under the danger line.

**Data flow**: It tries three cases with a 25% minimum remaining requirement. In the first, the primary quota is too used up, so startup should be denied. In the second, the secondary quota is too used up, so startup should also be denied. In the third, both are still slightly below the cutoff, so startup should be allowed.

**Call relations**: This test is part of the same safety net around `snapshot_allows_startup`. It uses assertions to capture the expected decisions for several primary-versus-secondary quota combinations.

*Call graph*: 1 external calls (assert!).


##### `startup_check_skips_when_limit_is_reached`  (lines 69–79)

```
fn startup_check_skips_when_limit_is_reached()
```

**Purpose**: Checks that an explicit “rate limit reached” status blocks startup even when the usage percentages look safe. This protects against trusting partial numbers when the service has already said the limit is hit.

**Data flow**: It creates a fake snapshot with low usage percentages, then changes the snapshot to say the rate limit has been reached. It passes that snapshot into the startup decision check and asserts that startup is not allowed.

**Call relations**: This test uses `snapshot` to build the starting data, then adds the reached-limit flag before checking the production guard. It covers the case where a direct warning from the rate-limit system must override normal percentage calculations.

*Call graph*: calls 1 internal fn (snapshot); 1 external calls (assert!).
