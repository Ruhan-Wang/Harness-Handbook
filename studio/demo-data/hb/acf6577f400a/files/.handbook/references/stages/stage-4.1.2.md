# Requirements layering and execution-policy composition  `stage-4.1.2`

This stage is behind-the-scenes setup work. Before Codex starts running commands, it reads requirements.toml and other managed sources, then builds one clear rule set for what is allowed. config_requirements defines these high-level limits and keeps track of where each setting came from, so errors can point to the right source. requirements_layers/mod is the entry point for this combining system. layer cleans one raw requirements layer and separates normal settings from special ones, like execution policy, hooks, permissions, and sandbox rules. stack then assembles all layers into the final result.

Some fields need safer merging than simple “last one wins.” permissions keeps every denied read path from every layer. hooks combines hook event lists while preventing unsafe hook directory conflicts. rules preserves rule priority, keeping higher-priority rules first.

Execution policy is the command safety rulebook. requirements_exec_policy parses and validates it from requirements.toml. amend safely adds new allow or deny lines when a user approves something. network_proxy_loader turns config and policy into live network proxy settings and reloads them when files change. hooks/config_rules decides which saved hook settings are trusted enough to use.

## Files in this stage

### Execution-policy inputs
These files define how execution-policy data is represented in requirements-facing TOML, amended on disk, and consumed by runtime policy loaders.

### `config/src/requirements_exec_policy.rs`

`config` · `config load`

This file is the bridge between a human-written requirements file and Codex's command safety system. A `requirements.toml` file can say things like “commands matching this prefix should prompt the user” or “commands matching this prefix are forbidden.” This code reads that TOML-shaped data, checks that it is well formed, and builds a `Policy` that the execution-policy engine can use later when commands are about to run.

The central wrapper is `RequirementsExecPolicy`, which simply holds an internal `Policy`. It exists so policies that came from requirements files can be treated as a distinct kind of configuration. The file also defines TOML-friendly structs for prefix rules, pattern tokens, and decisions. A pattern token is one part of a command pattern; it can be one exact word or one of several allowed alternatives.

The most important rule here is that `allow` is rejected in `requirements.toml`. Requirements policies are merged with other configuration using the most restrictive result, so this file only permits restrictive choices: `prompt` or `forbidden`. That prevents a requirements file from silently weakening safety settings elsewhere.

When converting rules, the first pattern token is used to group rules by program name, like sorting mail into boxes by the first line of the address. Later, this lets the policy engine look up only the rules that could apply to a command.

#### Function details

##### `RequirementsExecPolicy::new`  (lines 18–20)

```
fn new(policy: Policy) -> Self
```

**Purpose**: Wraps an already-built execution `Policy` as a requirements-specific policy. This gives the rest of the program a clear signal that the policy came from `requirements.toml` rather than from some other source.

**Data flow**: A finished `Policy` goes in. The function stores it inside a `RequirementsExecPolicy` wrapper. The wrapper comes out unchanged except for having this more specific type.

**Call relations**: Other configuration code and tests call this after they already have a `Policy` and need to treat it as a requirements policy. It does not build or validate rules itself; that work is done before this function is used.

*Call graph*: called by 3 (child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs, merges_requirements_exec_policy_network_rules, preserves_host_executables_when_requirements_overlay_is_present).


##### `RequirementsExecPolicy::eq`  (lines 24–26)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two requirements policies to see whether they contain the same effective rules. It does this by comparing a stable fingerprint of each policy rather than relying on the internal storage order.

**Data flow**: Two `RequirementsExecPolicy` values go in. The function asks `policy_fingerprint` to turn each inner policy into a sorted list of rule descriptions. It returns `true` if those lists match and `false` otherwise.

**Call relations**: This is used whenever Rust needs to test equality for `RequirementsExecPolicy`. It delegates the real comparison work to `policy_fingerprint`, which hides ordering differences in the policy's internal map.

*Call graph*: calls 1 internal fn (policy_fingerprint).


##### `RequirementsExecPolicy::as_ref`  (lines 32–34)

```
fn as_ref(&self) -> &Policy
```

**Purpose**: Provides read-only access to the inner execution `Policy`. Code that knows how to work with a generic policy can use this without needing to unwrap the struct by hand.

**Data flow**: A borrowed `RequirementsExecPolicy` goes in. The function returns a borrowed reference to the contained `Policy`. Nothing is copied or changed.

**Call relations**: This connects the requirements-specific wrapper back to the broader execution-policy system. Callers can pass the result into code that expects a plain `Policy` reference.


##### `policy_fingerprint`  (lines 37–46)

```
fn policy_fingerprint(policy: &Policy) -> Vec<String>
```

**Purpose**: Creates a simple, sorted summary of a policy's rules so two policies can be compared reliably. This avoids false differences caused only by rules being stored in a different order.

**Data flow**: A `Policy` reference goes in. The function reads every program name and every rule under that program, formats each pair as text, sorts all those text entries, and returns the sorted list.

**Call relations**: It is called by `RequirementsExecPolicy::eq` when two requirements policies are compared. Its job is to turn the policy into an order-independent comparison key.

*Call graph*: called by 1 (eq); 3 external calls (new, rules, format!).


##### `RequirementsExecPolicyDecisionToml::as_decision`  (lines 84–90)

```
fn as_decision(self) -> Decision
```

**Purpose**: Converts a decision read from TOML into the decision type used by the execution-policy engine. It maps the configuration words `allow`, `prompt`, and `forbidden` to their internal equivalents.

**Data flow**: A TOML-facing decision enum goes in. The function matches it to the corresponding internal `Decision` value. The converted decision comes out.

**Call relations**: It is used during policy conversion after validation decides the TOML decision is acceptable. In this file, `allow` is checked and rejected before this conversion is used for requirements policies.


##### `RequirementsExecPolicyToml::to_policy`  (lines 125–183)

```
fn to_policy(&self) -> Result<Policy, RequirementsExecPolicyParseError>
```

**Purpose**: Validates the TOML rules and turns them into the internal `Policy` used to judge commands. This is the main conversion step from human-written configuration into executable safety rules.

**Data flow**: A parsed `RequirementsExecPolicyToml` value goes in. The function checks that there is at least one rule, that each rule has a pattern, that pattern tokens are valid, that justifications are not blank, and that a decision is present. It rejects `allow` decisions because requirements files are not allowed to loosen safety. For valid rules, it builds prefix rules grouped by their first command token and returns a `Policy`; on any problem, it returns a specific parse error.

**Call relations**: This is called by `RequirementsExecPolicyToml::to_requirements_policy`, which wraps the resulting policy. Inside the conversion it calls `parse_pattern_token` for each TOML pattern token and uses the execution-policy types to build the final rule objects.

*Call graph*: called by 1 (to_requirements_policy); 4 external calls (from, new, new, new).


##### `RequirementsExecPolicyToml::to_requirements_policy`  (lines 185–189)

```
fn to_requirements_policy(
        &self,
    ) -> Result<RequirementsExecPolicy, RequirementsExecPolicyParseError>
```

**Purpose**: Converts TOML rules directly into a `RequirementsExecPolicy` wrapper. It is a convenience step for callers that want the requirements-specific type rather than a plain internal policy.

**Data flow**: A parsed TOML policy goes in. The function calls `to_policy` to validate and build the internal policy. If that succeeds, it wraps the result in `RequirementsExecPolicy`; if validation fails, the same error comes back out.

**Call relations**: This sits one layer above `to_policy`. Configuration-loading code can call it when it wants the final requirements policy object in one step.

*Call graph*: calls 1 internal fn (to_policy).


##### `parse_pattern_token`  (lines 192–236)

```
fn parse_pattern_token(
    token: &RequirementsExecPolicyPatternTokenToml,
    rule_index: usize,
    token_index: usize,
) -> Result<PatternToken, RequirementsExecPolicyParseError>
```

**Purpose**: Checks and converts one TOML pattern token into the internal pattern-token format. It enforces that each token says either “this exact word” or “one of these words,” but not both and not neither.

**Data flow**: One TOML token plus its rule index and token index go in. The function checks whether `token` or `any_of` is set, rejects empty strings and empty alternative lists, and returns either a single-token pattern or an alternatives pattern. If the token is malformed, it returns an error that includes where the bad token was found.

**Call relations**: It is called repeatedly by `RequirementsExecPolicyToml::to_policy` while converting each rule's command pattern. Its detailed error messages help the configuration loader point users to the exact broken part of `requirements.toml`.

*Call graph*: 2 external calls (Alts, Single).


### `execpolicy/src/amend.rs`

`domain_logic` · `policy amendment / request handling`

This file exists so the program can update a policy file without asking a person to edit text by hand. A policy file is like a rulebook: each line says what kind of command or network access should be allowed, denied, or asked about. Without this code, the system could decide on a rule but would not have a safe, consistent way to save that rule for next time.

There are two public entry points. One adds an allowed command prefix, such as a command beginning with `curl`. The other adds a network rule, such as allowing HTTPS access to `api.github.com`. Before writing, the code checks that the input makes sense. For example, command prefixes cannot be empty, network hosts are normalized to a standard form, wildcard hosts are rejected, and empty justifications are not allowed.

The file then formats each rule as one policy-language line. It uses JSON-style quoting for values, so spaces and special characters are written safely. Finally, it creates the policy directory if needed, opens the file, locks it, reads existing lines, and appends the new rule only if it is not already present. The lock is an advisory file lock, meaning cooperating processes agree not to write at the same time. This is like taking a number at a counter before changing a shared notebook.

#### Function details

##### `blocking_append_allow_prefix_rule`  (lines 65–81)

```
fn blocking_append_allow_prefix_rule(
    policy_path: &Path,
    prefix: &[String],
) -> Result<(), AmendError>
```

**Purpose**: Adds a policy rule that allows commands matching a given list of starting tokens. Someone would use this after deciding that a command pattern should be trusted in the future.

**Data flow**: It receives a policy file path and a list of command tokens. It rejects an empty list, safely quotes each token, builds one `prefix_rule(...)` line, and passes that line onward to be written. The result is either success or a clear error explaining why the rule could not be made or saved.

**Call relations**: The prefix-rule tests call this function to prove it creates files, appends cleanly, and preserves line breaks. In normal flow, this is the public doorway for prefix rules; after formatting the rule text, it hands the actual file work to `append_rule_line`.

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

**Purpose**: Adds a policy rule for network access to one specific host, protocol, and decision. It is used when the system wants to remember whether a network destination should be allowed, denied, or prompted for later.

**Data flow**: It receives a policy path, host name, protocol, decision, and optional explanation. It normalizes the host, rejects invalid hosts or blank explanations, converts the protocol and decision into policy strings, safely quotes all fields, builds one `network_rule(...)` line, and sends it to be written. It returns success if the rule is saved or an error if validation, formatting, or writing fails.

**Call relations**: The network-rule tests call this function to check normal appending, combining with prefix rules, and rejecting wildcard hosts. It depends on `normalize_network_rule_host` to clean and validate the host, uses the protocol’s policy spelling through `as_policy_string`, and then delegates file writing to `append_rule_line`.

*Call graph*: calls 3 internal fn (append_rule_line, as_policy_string, normalize_network_rule_host); called by 3 (appends_network_rule, appends_prefix_and_network_rules, rejects_wildcard_network_rule_host); 4 external calls (InvalidNetworkRule, format!, to_string, vec!).


##### `append_rule_line`  (lines 127–145)

```
fn append_rule_line(policy_path: &Path, rule: &str) -> Result<(), AmendError>
```

**Purpose**: Prepares the filesystem so a rule line can be written to the policy file. It makes sure the policy file has a parent directory and creates that directory if it does not already exist.

**Data flow**: It receives the path to the policy file and the already formatted rule text. It finds the directory part of the path, reports an error if there is no directory, creates the directory when needed, and then passes the path and rule line to the lower-level writer. It returns whatever success or error comes from these steps.

**Call relations**: `blocking_append_allow_prefix_rule` and `blocking_append_network_rule` both call this after they have built a valid policy line. This function is the bridge between rule formatting and the locked file append done by `append_locked_line`.

*Call graph*: calls 1 internal fn (append_locked_line); called by 2 (blocking_append_allow_prefix_rule, blocking_append_network_rule); 2 external calls (parent, create_dir).


##### `append_locked_line`  (lines 147–193)

```
fn append_locked_line(policy_path: &Path, line: &str) -> Result<(), AmendError>
```

**Purpose**: Writes one rule line into the policy file safely and without duplicates. It is the part that actually opens, locks, reads, and appends to the file.

**Data flow**: It receives a policy file path and one full line of policy text. It opens or creates the file, takes a file lock so another cooperating writer does not change it at the same time, reads the current contents, and checks whether the exact line already exists. If the line is new, it adds a missing newline if needed and writes the rule followed by a newline. It returns success or an input/output error wrapped with the policy path for context.

**Call relations**: `append_rule_line` calls this after the directory is ready. This function is the final step in both prefix-rule and network-rule flows, and it is the reason repeated requests do not create repeated identical policy lines.

*Call graph*: called by 1 (append_rule_line); 4 external calls (new, Start, new, format!).


##### `tests::appends_rule_and_creates_directories`  (lines 202–218)

```
fn appends_rule_and_creates_directories()
```

**Purpose**: Checks that adding a prefix rule also creates the needed policy directory and file. This protects the common first-run case where no policy file exists yet.

**Data flow**: The test creates a temporary folder, chooses a nested policy path, calls `blocking_append_allow_prefix_rule`, then reads the file back. The expected result is a new file containing exactly one correctly formatted prefix rule.

**Call relations**: This test calls the public prefix-rule function as an outside caller would. It indirectly exercises `append_rule_line` directory creation and `append_locked_line` file writing.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `tests::appends_rule_without_duplicate_newline`  (lines 221–245)

```
fn appends_rule_without_duplicate_newline()
```

**Purpose**: Checks that appending to a file that already ends with a newline does not insert an extra blank line. This keeps policy files tidy and predictable.

**Data flow**: The test creates a temporary policy file with one existing rule ending in a newline. It appends a second prefix rule, reads the file, and verifies the two rules appear on consecutive lines with no empty line between them.

**Call relations**: This test calls `blocking_append_allow_prefix_rule`, which flows through the normal append path. It focuses on the newline behavior inside `append_locked_line`.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 6 external calls (from, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `tests::inserts_newline_when_missing_before_append`  (lines 248–271)

```
fn inserts_newline_when_missing_before_append()
```

**Purpose**: Checks that appending still works when an existing policy file does not end with a newline. This prevents two policy rules from being accidentally joined into one broken line.

**Data flow**: The test writes a policy file containing one rule with no final newline. It appends another prefix rule and then reads the file back. The expected result is that the code inserts the missing line break before adding the new rule.

**Call relations**: This test reaches `append_locked_line` through `blocking_append_allow_prefix_rule`. It proves the append code repairs the file boundary before writing the next rule.

*Call graph*: calls 1 internal fn (blocking_append_allow_prefix_rule); 6 external calls (from, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `tests::appends_network_rule`  (lines 274–293)

```
fn appends_network_rule()
```

**Purpose**: Checks that a network rule is normalized and written in the expected policy format. This confirms that host names, protocols, decisions, and justifications become a valid rule line.

**Data flow**: The test creates a temporary policy path, asks to allow HTTPS access to `Api.GitHub.com` with a justification, and reads the resulting file. The expected output uses the normalized lowercase host `api.github.com` and includes the quoted justification.

**Call relations**: This test calls `blocking_append_network_rule` directly. Through that call, it exercises host normalization, field serialization, and the shared append path.

*Call graph*: calls 1 internal fn (blocking_append_network_rule); 3 external calls (assert_eq!, read_to_string, tempdir).


##### `tests::appends_prefix_and_network_rules`  (lines 296–318)

```
fn appends_prefix_and_network_rules()
```

**Purpose**: Checks that prefix rules and network rules can live together in the same policy file. This matters because real policy files may contain several kinds of rules.

**Data flow**: The test creates a temporary policy file path, appends one allowed command prefix, then appends one allowed network rule. It reads the file and verifies that both formatted lines appear in order.

**Call relations**: This test calls both public amendment functions. It shows that both kinds of rules share the same lower-level append machinery without interfering with each other.

*Call graph*: calls 2 internal fn (blocking_append_allow_prefix_rule, blocking_append_network_rule); 4 external calls (from, assert_eq!, read_to_string, tempdir).


##### `tests::rejects_wildcard_network_rule_host`  (lines 321–336)

```
fn rejects_wildcard_network_rule_host()
```

**Purpose**: Checks that wildcard network hosts, such as `*.example.com`, are refused. This protects the policy from accidentally granting broad network access when only specific hosts are allowed.

**Data flow**: The test calls `blocking_append_network_rule` with a wildcard host and expects an error instead of a written rule. It then checks that the error message clearly says wildcards are not allowed.

**Call relations**: This test enters through the public network-rule function and relies on the validation performed before any file-writing step. Because validation fails, the flow stops before `append_rule_line` is used.

*Call graph*: calls 1 internal fn (blocking_append_network_rule); 2 external calls (assert_eq!, tempdir).


### `core/src/network_proxy_loader.rs`

`orchestration` · `startup and config reload`

The network proxy needs one clear set of rules: whether networking is enabled, which domains are allowed or denied, whether proxying through other servers is allowed, and whether special “man-in-the-middle” hooks should inspect traffic. In reality, those rules come from several places: system config, user config, project config, and execution policy files. This file is the funnel that reads those sources, combines them in the right order, checks that user-controlled settings do not break trusted restrictions, and produces a `ConfigState` the proxy can actually run with.

Think of it like building a final house rule sheet from several binders. Some binders are trusted, like administrator rules, and some are user-editable. User rules may add detail, but they cannot override hard safety limits from trusted layers. The file first loads all config layers, then loads the execution policy. If the execution policy has a parse error, it warns and continues with an empty policy; other errors stop the setup. It then merges network settings, adds domain rules from execution policy, validates everything against trusted constraints, and builds the final proxy state.

The file also records the last modified time of each config file. `MtimeConfigReloader` later compares those timestamps with the current files, so the proxy can refresh its rules without restarting.

#### Function details

##### `build_network_proxy_state`  (lines 41–44)

```
async fn build_network_proxy_state() -> Result<NetworkProxyState>
```

**Purpose**: Builds the full network proxy state ready for use, including the ability to reload itself later when config files change. This is the convenient top-level function for callers that just want a working proxy state.

**Data flow**: It takes no direct input. It asks `build_network_proxy_state_and_reloader` for the current config state and a reloader, wraps the reloader in shared ownership, and returns a `NetworkProxyState` that carries both the settings and the reload hook.

**Call relations**: This is the public front door for setup. It delegates the real loading work to `build_network_proxy_state_and_reloader`, then hands the result to the network proxy state constructor so the proxy can refresh itself later.

*Call graph*: calls 2 internal fn (build_network_proxy_state_and_reloader, with_reloader); 1 external calls (new).


##### `build_network_proxy_state_and_reloader`  (lines 46–50)

```
async fn build_network_proxy_state_and_reloader() -> Result<(ConfigState, MtimeConfigReloader)>
```

**Purpose**: Builds both pieces needed by the proxy: the current network configuration and the object that can rebuild it later. Use this when a caller needs direct access to the reloader as well as the config.

**Data flow**: It takes no direct input. It calls `build_config_state_with_mtimes`, receives a usable config state plus remembered file modification times, creates an `MtimeConfigReloader` from those times, and returns both.

**Call relations**: It sits between the simple public setup function and the lower-level config-building code. `build_network_proxy_state` calls it during startup, and it calls `build_config_state_with_mtimes` to do the actual reading and validation.

*Call graph*: calls 2 internal fn (new, build_config_state_with_mtimes); called by 1 (build_network_proxy_state).


##### `build_config_state_with_mtimes`  (lines 52–87)

```
async fn build_config_state_with_mtimes() -> Result<(ConfigState, Vec<LayerMtime>)>
```

**Purpose**: Reads all relevant Codex configuration, folds in execution policy network rules, checks safety limits, and returns the finished proxy config along with file timestamps for future reload checks.

**Data flow**: It starts by finding the Codex home folder, then loads the stacked config layers from disk. It tries to load the execution policy; if the policy text cannot be parsed, it logs a warning and continues with an empty policy, but other policy errors stop the process. It converts the layers into a `NetworkProxyConfig`, derives trusted constraints, records modification times for config files, builds the final `ConfigState`, and returns that state plus the timestamps.

**Call relations**: This is the central assembly line. It is called during initial setup by `build_network_proxy_state_and_reloader` and during reload paths by `MtimeConfigReloader::maybe_reload` and `MtimeConfigReloader::reload_now`. It relies on helper functions to collect timestamps, merge config, and enforce trusted restrictions before handing the result to the network proxy library.

*Call graph*: calls 6 internal fn (load_config_layers_state, find_codex_home, load_exec_policy, collect_layer_mtimes, config_from_layers, enforce_trusted_constraints); called by 3 (maybe_reload, reload_now, build_network_proxy_state_and_reloader); 5 external calls (new, build_config_state, default, empty, warn!).


##### `collect_layer_mtimes`  (lines 89–109)

```
fn collect_layer_mtimes(stack: &ConfigLayerStack) -> Vec<LayerMtime>
```

**Purpose**: Records the last modified time for each config file that came from a real file path. These records let the reloader later tell whether any relevant config file changed.

**Data flow**: It receives a stack of config layers. It walks the enabled layers from lowest to highest priority, picks out layers that correspond to known files or project `.codex/config.toml` files, creates a `LayerMtime` for each path, and returns the list.

**Call relations**: This helper is used by `build_config_state_with_mtimes` after config loading. Its output becomes the memory used by `MtimeConfigReloader` to decide whether a reload is needed.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (build_config_state_with_mtimes).


##### `enforce_trusted_constraints`  (lines 111–120)

```
fn enforce_trusted_constraints(
    layers: &ConfigLayerStack,
    config: &NetworkProxyConfig,
) -> Result<NetworkProxyConstraints>
```

**Purpose**: Makes sure the final network proxy config does not violate restrictions set by trusted configuration layers, such as system-level rules. This protects administrator or managed settings from being loosened by user or project config.

**Data flow**: It receives all config layers and the proposed final network proxy config. It extracts trusted network constraints, asks the network proxy validator to compare the config against those constraints, and returns the constraints if validation passes. If validation fails, it returns an error with context saying the problem is in network proxy constraints.

**Call relations**: It is called by `build_config_state_with_mtimes` before the final `ConfigState` is built. It delegates constraint extraction to `network_constraints_from_trusted_layers` and validation to the network proxy library.

*Call graph*: calls 1 internal fn (network_constraints_from_trusted_layers); called by 1 (build_config_state_with_mtimes); 1 external calls (validate_policy_against_constraints).


##### `network_constraints_from_trusted_layers`  (lines 122–143)

```
fn network_constraints_from_trusted_layers(
    layers: &ConfigLayerStack,
) -> Result<NetworkProxyConstraints>
```

**Purpose**: Builds the set of network limits that come only from trusted config layers. User-controlled layers are deliberately ignored here so they cannot define their own safety ceiling.

**Data flow**: It starts with empty constraints and an empty TOML table. It walks the enabled config layers, skips user, project, and session flag layers, merges the remaining trusted TOML values, parses the merged result into network-related tables, selects the active network profile if there is one, and copies its restrictive settings into `NetworkProxyConstraints`.

**Call relations**: This function is called by `enforce_trusted_constraints`. It uses `is_user_controlled_layer` to filter layers, `network_tables_from_toml` and `selected_network_from_tables` to understand the merged TOML, and `apply_network_constraints` to translate selected settings into enforceable limits.

*Call graph*: calls 5 internal fn (get_layers, apply_network_constraints, is_user_controlled_layer, network_tables_from_toml, selected_network_from_tables); called by 1 (enforce_trusted_constraints); 4 external calls (merge_toml_values, default, Table, new).


##### `apply_network_constraints`  (lines 145–182)

```
fn apply_network_constraints(network: NetworkToml, constraints: &mut NetworkProxyConstraints)
```

**Purpose**: Copies network settings from a selected permission profile into the constraint object used for safety validation. In plain terms, it turns trusted network config into hard limits.

**Data flow**: It receives one `NetworkToml` value and a mutable constraints object. For each trusted setting that is present, it writes that setting into the constraints: enabled state, mode, proxy allowances, socket rules, local binding, and domain allow or deny lists. For domain rules, it uses a temporary proxy config so the same domain-merging logic is reused.

**Call relations**: It is called by `network_constraints_from_trusted_layers` after trusted layers have been merged and a network profile has been selected. It hands back its work by mutating the shared constraints object.

*Call graph*: calls 1 internal fn (overlay_network_domain_permissions); called by 1 (network_constraints_from_trusted_layers); 1 external calls (default).


##### `network_tables_from_toml`  (lines 190–195)

```
fn network_tables_from_toml(value: &toml::Value) -> Result<NetworkTablesToml>
```

**Purpose**: Converts raw TOML configuration data into the smaller structure this file cares about: default permission selection and permission profiles. This gives later code typed fields instead of loosely shaped config text.

**Data flow**: It receives a TOML value, clones it, and tries to deserialize it into `NetworkTablesToml`. On success it returns the parsed structure; on failure it returns an error explaining that network tables could not be deserialized from config.

**Call relations**: Both full config building and trusted-constraint extraction call this after TOML layers have been merged. It prepares data for `selected_network_from_tables`, which chooses the active network settings.

*Call graph*: called by 2 (config_from_layers, network_constraints_from_trusted_layers); 1 external calls (clone).


##### `selected_network_from_tables`  (lines 197–212)

```
fn selected_network_from_tables(parsed: NetworkTablesToml) -> Result<Option<NetworkToml>>
```

**Purpose**: Finds the network settings for the configured default permission profile, if those settings should come from a custom profile. Built-in profiles are intentionally ignored here because their network defaults are handled elsewhere.

**Data flow**: It receives parsed config tables. If no `default_permissions` value is set, it returns no network settings. If the value names a known built-in profile, it also returns none. If it looks like an unknown built-in name, it raises an error. Otherwise it requires a `[permissions]` table, resolves the named profile, and returns that profile’s optional network settings.

**Call relations**: This selector is used by config application and trusted constraint extraction. `network_constraints_from_trusted_layers`, the test-only `apply_network_tables`, and `NetworkConfigAccumulator::apply_network_tables` all call it before deciding whether there is any network config to apply.

*Call graph*: called by 3 (apply_network_tables, apply_network_tables, network_constraints_from_trusted_layers); 3 external calls (is_builtin_permission_profile_name, reject_unknown_builtin_permission_profile, resolve_permission_profile).


##### `apply_network_tables`  (lines 215–220)

```
fn apply_network_tables(config: &mut NetworkProxyConfig, parsed: NetworkTablesToml) -> Result<()>
```

**Purpose**: Applies parsed network tables directly to a network proxy config in tests. It exists only in test builds, giving tests a small way to exercise config parsing and application.

**Data flow**: It receives a mutable `NetworkProxyConfig` and parsed network tables. It asks `selected_network_from_tables` for the active network settings, applies them to the config if present, and returns success or an error.

**Call relations**: Because it is compiled only for tests, it is not part of the runtime setup path. It uses the same selection logic as production code so tests can check the real behavior.

*Call graph*: calls 1 internal fn (selected_network_from_tables).


##### `NetworkConfigAccumulator::apply_network_tables`  (lines 230–235)

```
fn apply_network_tables(&mut self, parsed: NetworkTablesToml) -> Result<()>
```

**Purpose**: Applies the active network profile from parsed config into an accumulator that is building the final proxy config. The accumulator is needed because some settings, especially MITM hooks and actions, must be collected and validated together.

**Data flow**: It receives parsed network tables and mutable access to the accumulator. It selects the active network settings with `selected_network_from_tables`; if a network section exists, it passes it to `NetworkConfigAccumulator::apply_network`. It returns success unless profile selection fails.

**Call relations**: This is called during `config_from_layers` after all config layers have been merged and parsed. It is the bridge from parsed TOML tables to accumulated runtime proxy configuration.

*Call graph*: calls 2 internal fn (apply_network, selected_network_from_tables).


##### `NetworkConfigAccumulator::apply_network`  (lines 237–249)

```
fn apply_network(&mut self, mut network: NetworkToml)
```

**Purpose**: Applies one selected network configuration to the accumulator while keeping MITM hook definitions and action definitions for later validation. MITM means “man in the middle,” where proxy code can inspect or alter traffic according to configured hooks.

**Data flow**: It receives a `NetworkToml` value. It temporarily removes the MITM section, applies the ordinary network settings to the accumulator’s `NetworkProxyConfig`, then stores any MITM actions and hooks in ordered maps. Later entries can extend or replace earlier collected definitions according to map behavior.

**Call relations**: It is called by `NetworkConfigAccumulator::apply_network_tables` once a profile has been selected. It does not finish MITM setup itself; that final validation and conversion happens in `NetworkConfigAccumulator::finish`.

*Call graph*: calls 1 internal fn (apply_to_network_proxy_config); called by 1 (apply_network_tables); 1 external calls (extend).


##### `NetworkConfigAccumulator::finish`  (lines 251–266)

```
fn finish(mut self) -> Result<NetworkProxyConfig>
```

**Purpose**: Completes the accumulated network proxy config and makes MITM settings safe to use. It validates that hooks refer to known actions before converting them into runtime hooks.

**Data flow**: It consumes the accumulator. If hooks were collected, it combines hooks and actions into a MITM config, checks that every hook action reference is valid, converts those definitions into runtime hooks, and stores them on the network config. It also turns the general MITM flag on when the network mode is limited or when hooks exist, then returns the finished `NetworkProxyConfig`.

**Call relations**: This is the last step after `NetworkConfigAccumulator::apply_network_tables` has applied config data. `config_from_layers` uses the completed config before adding execution policy domain rules.

*Call graph*: 1 external calls (is_empty).


##### `config_from_layers`  (lines 269–286)

```
fn config_from_layers(
    layers: &ConfigLayerStack,
    exec_policy: &codex_execpolicy::Policy,
) -> Result<NetworkProxyConfig>
```

**Purpose**: Combines all enabled config layers into one `NetworkProxyConfig`, then adds network allow and deny rules from the execution policy. This produces the effective proxy policy before trusted constraints are checked.

**Data flow**: It receives a config layer stack and an execution policy. It merges enabled layers from lowest to highest priority into one TOML value, parses the network-related tables, applies them through a `NetworkConfigAccumulator`, finishes the config, then calls `apply_exec_policy_network_rules` to add domain rules from the execution policy. The finished `NetworkProxyConfig` is returned.

**Call relations**: It is called by `build_config_state_with_mtimes` as the main config-conversion step. It uses `network_tables_from_toml` for parsing, the accumulator for applying profile settings, and `apply_exec_policy_network_rules` to fold policy rules into the same network config.

*Call graph*: calls 3 internal fn (get_layers, apply_exec_policy_network_rules, network_tables_from_toml); called by 1 (build_config_state_with_mtimes); 4 external calls (merge_toml_values, default, Table, new).


##### `apply_exec_policy_network_rules`  (lines 288–307)

```
fn apply_exec_policy_network_rules(
    config: &mut NetworkProxyConfig,
    exec_policy: &codex_execpolicy::Policy,
)
```

**Purpose**: Copies network domain rules from the execution policy into the proxy config. This makes execution policy restrictions part of the same allow and deny list the proxy uses at runtime.

**Data flow**: It receives a mutable network proxy config and an execution policy. It asks the policy for compiled allowed and denied domains, then inserts each allowed domain with an allow permission and each denied domain with a deny permission.

**Call relations**: It is called by `config_from_layers` after config-file settings have been applied. For each domain it calls `upsert_network_domain`, which performs the normalized insert or update.

*Call graph*: calls 1 internal fn (upsert_network_domain); called by 1 (config_from_layers); 1 external calls (compiled_network_domains).


##### `upsert_network_domain`  (lines 309–317)

```
fn upsert_network_domain(
    config: &mut NetworkProxyConfig,
    host: String,
    permission: codex_network_proxy::NetworkDomainPermission,
)
```

**Purpose**: Adds or updates one domain permission in the network proxy config. “Upsert” means insert if missing, or update if it already exists.

**Data flow**: It receives a mutable proxy config, a host name, and the permission to apply. It passes those to the config’s domain-permission table along with `normalize_host`, so equivalent host spellings are treated consistently. It changes the config in place and returns nothing.

**Call relations**: It is used by `apply_exec_policy_network_rules` for every allowed or denied domain from execution policy. It is the small final step that writes those policy decisions into the proxy config.

*Call graph*: called by 1 (apply_exec_policy_network_rules).


##### `is_user_controlled_layer`  (lines 319–326)

```
fn is_user_controlled_layer(layer: &ConfigLayerSource) -> bool
```

**Purpose**: Answers whether a config layer is controlled by the user, project, or current session rather than by a trusted source. This distinction matters because user-controlled layers are ignored when building safety constraints.

**Data flow**: It receives a config layer source label. It checks whether the source is a user config, project config, or session flags, and returns `true` for those sources and `false` otherwise.

**Call relations**: It is called by `network_constraints_from_trusted_layers` while scanning config layers. That caller uses the answer to skip layers that should not be allowed to define trusted restrictions.

*Call graph*: called by 1 (network_constraints_from_trusted_layers); 1 external calls (matches!).


##### `LayerMtime::new`  (lines 335–338)

```
fn new(path: AbsolutePathBuf) -> Self
```

**Purpose**: Creates a timestamp record for one config file path. The record says where the file is and what its last modified time was when the config was loaded.

**Data flow**: It receives an absolute path. It asks the filesystem for metadata and, if possible, reads the file’s modified time. It returns a `LayerMtime` containing the path and either the timestamp or `None` if the timestamp could not be read.

**Call relations**: This constructor is used when config layer paths are collected for reload tracking. Later, `MtimeConfigReloader::needs_reload` compares these saved timestamps with the current filesystem state.

*Call graph*: 1 external calls (metadata).


##### `MtimeConfigReloader::new`  (lines 346–350)

```
fn new(layer_mtimes: Vec<LayerMtime>) -> Self
```

**Purpose**: Creates a config reloader from the remembered modification times of config layers. It wraps the timestamp list in an asynchronous read-write lock so reload checks and updates can coordinate safely.

**Data flow**: It receives a list of `LayerMtime` records. It stores them inside an `RwLock`, which is a lock that allows many readers or one writer, and returns a new `MtimeConfigReloader`.

**Call relations**: It is called by `build_network_proxy_state_and_reloader` after the initial config state has been built. The resulting reloader is attached to the network proxy state or returned to callers.

*Call graph*: called by 1 (build_network_proxy_state_and_reloader); 1 external calls (new).


##### `MtimeConfigReloader::needs_reload`  (lines 352–363)

```
async fn needs_reload(&self) -> bool
```

**Purpose**: Checks whether any tracked config file has changed since the last load. It is a quick “should we rebuild?” test before doing the more expensive reload work.

**Data flow**: It reads the saved `LayerMtime` list under a shared lock. For each path, it gets the current file modification time and compares it with the saved one. It returns `true` if a file is newer, appears after being missing, disappears after existing, or otherwise differs in a way that means the loaded config may be stale; otherwise it returns `false`.

**Call relations**: It is called by `MtimeConfigReloader::maybe_reload`. If it says nothing changed, reload is skipped; if it says something changed, the reloader rebuilds the full config state.

*Call graph*: called by 1 (maybe_reload).


##### `MtimeConfigReloader::source_label`  (lines 385–387)

```
fn source_label(&self) -> String
```

**Purpose**: Returns a human-readable name for what this reloader watches. This label can be used in logs, status messages, or error reporting.

**Data flow**: It receives shared access to the reloader and returns the fixed string `config layers`. It does not inspect or change any state.

**Call relations**: This is part of the `ConfigReloader` interface implemented for `MtimeConfigReloader`. Code that works with reloaders generically can ask this object what source it represents.


##### `MtimeConfigReloader::maybe_reload`  (lines 389–391)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements the reload-if-needed behavior for the network proxy. It rebuilds the config only when tracked config files have changed.

**Data flow**: It receives shared access to the reloader. It first checks `needs_reload`; if no file changed, it returns `None`. If a change is detected, it calls `build_config_state_with_mtimes`, replaces the saved timestamp list with the new one under a write lock, and returns the new `ConfigState` inside `Some`.

**Call relations**: This is exposed through the `ConfigReloader` trait as a boxed asynchronous operation. The network proxy can call it during runtime to refresh settings without restarting, and the heavy rebuild work is delegated back to `build_config_state_with_mtimes`.

*Call graph*: calls 2 internal fn (needs_reload, build_config_state_with_mtimes); 1 external calls (pin).


##### `MtimeConfigReloader::reload_now`  (lines 393–395)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Forces a full rebuild of the network proxy config, even if file timestamps do not show a change. This is useful when a caller explicitly wants a fresh read.

**Data flow**: It receives shared access to the reloader. It calls `build_config_state_with_mtimes`, replaces the saved timestamp list with the newly collected one, and returns the rebuilt `ConfigState`.

**Call relations**: This is also exposed through the `ConfigReloader` trait as a boxed asynchronous operation. Unlike `maybe_reload`, it skips the `needs_reload` check and immediately delegates to `build_config_state_with_mtimes`.

*Call graph*: calls 1 internal fn (build_config_state_with_mtimes); 1 external calls (pin).


### Requirements schema and layer preparation
These files establish the requirements model and prepare individual requirement sources for later composition.

### `config/src/requirements_layers/mod.rs`

`config` · `config load`

This file does not contain the actual rules for requirements itself. Instead, it acts like an index page for a small section of the configuration system. The project appears to split requirement handling into several focused files: hooks, individual layers, permissions, rules, and stacking. This module ties those files together so the rest of the codebase does not need to know their internal layout.

The important public pieces are `RequirementsLayerEntry`, which represents one entry in a requirements layer, and `compose_requirements`, which is the function other parts of the system use to combine multiple layers into one final set of requirements. A “layer” here is like a transparent sheet placed over another: each sheet can add or change requirements, and composing them means deciding what the final combined picture looks like.

Without this file, callers would have to import directly from deeper internal files such as `layer` or `stack`. That would make the subsystem harder to reorganize safely. By re-exporting only the intended public pieces, this file keeps the boundary clean: outside code gets the tools it needs, while the detailed implementation stays tucked away in the submodules.


### `config/src/config_requirements.rs`

`config` · `config load`

This file is the rulebook for managed configuration. A normal user config says what the user wants; requirements say what the system, company, or administrator allows. Without this layer, a user could accidentally or deliberately choose settings outside the managed policy, and error messages would not be able to explain which policy blocked the choice.

The file has two main shapes of data. The first is the raw TOML shape, such as allowed approval policies, sandbox modes, web search modes, network rules, filesystem deny-read patterns, plugins, apps, hooks, and execution rules. The second is the normalized shape, ConfigRequirements, which wraps many settings in a Constrained value. A constraint is like a guardrail: it stores a current value and checks every future value against the allowed list.

A key theme is source tracking. Values are wrapped with RequirementSource or Sourced so later errors can say, for example, that a setting came from MDM, a system requirements.toml file, or an enterprise-managed backend layer. The file also supports merging several requirement layers by priority, preserving higher-priority values while still combining some app restrictions safely. Tests at the bottom document the expected behavior for parsing, merging, source-aware errors, and compatibility with older config formats.

#### Function details

##### `RequirementSource::composite`  (lines 53–64)

```
fn composite(sources: impl IntoIterator<Item = RequirementSource>) -> Self
```

**Purpose**: Builds one source label from several requirement sources. This is used when a final policy value is the result of more than one managed layer.

**Data flow**: It receives a list of sources, flattens nested composite sources, removes duplicates, and returns Unknown for no sources, the single source for one source, or a Composite source for many.

**Call relations**: Higher-level merge code and tests call this when they need one human-readable origin for a value that came from several places; it delegates the flattening work to RequirementSource::append_to_composite.

*Call graph*: called by 4 (constraint_error_includes_composite_requirement_source, apply_to, merge_output_source, source_for_top_level_keys); 1 external calls (new).


##### `RequirementSource::append_to_composite`  (lines 66–79)

```
fn append_to_composite(self, flattened: &mut Vec<RequirementSource>)
```

**Purpose**: Adds a source into a growing composite source list without nesting composites or repeating the same source.

**Data flow**: It takes one RequirementSource and a mutable list. If the source is already composite, it adds each inner source; otherwise it appends the source only if it is not already present.

**Call relations**: This is the internal helper behind RequirementSource::composite, keeping composite source labels tidy before they are shown in errors.


##### `RequirementSource::fmt`  (lines 83–112)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a requirement source into text that a person can read in an error message or log.

**Data flow**: It reads the variant, such as MDM, enterprise-managed, or a TOML file path, and writes a clear label into the formatter.

**Call relations**: Rust's display formatting calls this whenever code prints a RequirementSource; composite sources use it recursively to print each part.

*Call graph*: 1 external calls (write!).


##### `ConstrainedWithSource::new`  (lines 122–124)

```
fn new(value: Constrained<T>, source: Option<RequirementSource>) -> Self
```

**Purpose**: Pairs a constrained setting with the source that imposed it. This keeps the guardrail and its explanation together.

**Data flow**: It receives a Constrained value and an optional RequirementSource, then returns a ConstrainedWithSource containing both.

**Call relations**: Default setup, config normalization, and other config builders call this whenever they create a setting that may later reject invalid values.

*Call graph*: called by 17 (resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode, default, try_from, test_requirements_web_search_mode_allowlist_does_not_warn_when_unset, default, from, from_configured_with_optional_warnings, requirements_managed_hooks_execute_from_managed_dir, requirements_managed_hooks_execute_windows_command_override, requirements_managed_hooks_load_when_managed_dir_is_missing (+7 more)).


##### `ConstrainedWithSource::deref`  (lines 130–132)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets code use ConstrainedWithSource as if it were the inner Constrained value for read-only access.

**Data flow**: It receives a reference to the wrapper and returns a reference to the wrapped Constrained value.

**Call relations**: Rust uses this automatically when callers read methods or fields from the inner constraint through the wrapper.


##### `ConstrainedWithSource::deref_mut`  (lines 136–138)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Lets code use ConstrainedWithSource as if it were the inner Constrained value for mutable access.

**Data flow**: It receives a mutable wrapper reference and returns a mutable reference to the wrapped Constrained value.

**Call relations**: Rust uses this automatically when callers need to update the constrained value while keeping the source attached.


##### `ConfigRequirements::default`  (lines 169–208)

```
fn default() -> Self
```

**Purpose**: Creates a permissive baseline requirements object for when no managed requirements are configured.

**Data flow**: It builds default constraints for approvals, reviewers, permissions, Windows sandbox choice, web search, and residency, while leaving optional managed sections unset.

**Call relations**: Config loading and tests use this as the starting point before applying stricter requirements from files or managed sources.

*Call graph*: calls 4 internal fn (new, allow_any, allow_any_from_default, read_only).


##### `ConfigRequirements::exec_policy_source`  (lines 212–214)

```
fn exec_policy_source(&self) -> Option<&RequirementSource>
```

**Purpose**: Returns where the execution policy rules came from, if any were configured.

**Data flow**: It checks the optional execution policy field and returns a reference to its source when present.

**Call relations**: Other parts of the system can call this when they need to explain or report which policy supplied command execution rules.


##### `PluginRequirementsToml::is_empty`  (lines 235–237)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a plugin requirements block actually contains any MCP server restrictions.

**Data flow**: It looks at the optional server map and returns true if it is missing or empty.

**Call relations**: The top-level emptiness check uses this to decide whether a parsed requirements file has meaningful plugin content.


##### `NetworkDomainPermissionsToml::is_empty`  (lines 247–249)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any domain allow or deny rules were configured.

**Data flow**: It reads the domain permission map and returns true when there are no entries.

**Call relations**: This is a small helper for callers that need to ignore empty network-domain sections.


##### `NetworkDomainPermissionsToml::allowed_domains`  (lines 251–259)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Extracts only the domain patterns that are explicitly allowed.

**Data flow**: It scans the domain permission map, keeps entries marked allow, and returns them as a list, or None if there are none.

**Call relations**: Network projection code and tests use this to convert the canonical allow/deny map into a simpler allow-list view.


##### `NetworkDomainPermissionsToml::denied_domains`  (lines 261–269)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Extracts only the domain patterns that are explicitly denied.

**Data flow**: It scans the domain permission map, keeps entries marked deny, and returns them as a list, or None if there are none.

**Call relations**: Network projection code and tests use this alongside allowed_domains when they need separate allow and deny lists.


##### `NetworkDomainPermissionToml::fmt`  (lines 280–286)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Prints a domain permission as the lowercase words used in TOML: allow or deny.

**Data flow**: It receives an allow/deny enum value and writes the matching string into the formatter.

**Call relations**: Rust formatting calls this when domain permission values need to be displayed or serialized in a readable way.

*Call graph*: 1 external calls (write_str).


##### `NetworkUnixSocketPermissionsToml::is_empty`  (lines 296–298)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any Unix socket network permissions were configured.

**Data flow**: It reads the socket permission map and returns true when it has no entries.

**Call relations**: Callers can use this to skip empty Unix socket permission sections.


##### `NetworkUnixSocketPermissionsToml::allow_unix_sockets`  (lines 300–306)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Extracts only the Unix socket paths that are explicitly allowed.

**Data flow**: It scans the socket permission map, keeps entries marked allow, and returns those paths as strings.

**Call relations**: Network compatibility code and tests use this to present the canonical socket map as an older allow-list shape.


##### `NetworkUnixSocketPermissionToml::fmt`  (lines 317–323)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Prints a Unix socket permission as allow or deny.

**Data flow**: It receives an allow/deny enum value and writes the matching lowercase word.

**Call relations**: Rust formatting calls this when socket permission values need readable text.

*Call graph*: 1 external calls (write_str).


##### `NetworkRequirementsToml::deserialize`  (lines 365–412)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads the network requirements section from TOML while supporting both the current format and older list-based fields.

**Data flow**: It deserializes raw fields, rejects mixed old and new shapes, converts legacy allowed and denied lists into canonical permission maps, and returns NetworkRequirementsToml.

**Call relations**: Serde calls this during config parsing, and NetworkConstraints::deserialize also relies on it before turning requirements into normalized constraints.

*Call graph*: called by 1 (deserialize); 2 external calls (custom, deserialize).


##### `legacy_domain_permissions_from_lists`  (lines 418–433)

```
fn legacy_domain_permissions_from_lists(
    allowed_domains: Option<Vec<String>>,
    denied_domains: Option<Vec<String>>,
) -> Option<NetworkDomainPermissionsToml>
```

**Purpose**: Converts old allowed_domains and denied_domains lists into the newer map of domain patterns to allow/deny permissions.

**Data flow**: It receives optional allow and deny lists, inserts each pattern into a map with its permission, and returns None if the result is empty.

**Call relations**: NetworkRequirementsToml::deserialize calls this only when the new domains table is not used.

*Call graph*: 1 external calls (new).


##### `legacy_unix_socket_permissions_from_list`  (lines 435–445)

```
fn legacy_unix_socket_permissions_from_list(
    allow_unix_sockets: Option<Vec<String>>,
) -> Option<NetworkUnixSocketPermissionsToml>
```

**Purpose**: Converts the old allow_unix_sockets list into the newer Unix socket permission map.

**Data flow**: It receives an optional list of paths, marks each path as allowed, and returns None if there are no paths.

**Call relations**: NetworkRequirementsToml::deserialize calls this only when the new unix_sockets table is not used.


##### `NetworkConstraints::deserialize`  (lines 465–471)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Lets normalized network constraints be read directly from TOML-compatible data.

**Data flow**: It first parses NetworkRequirementsToml, then converts that into NetworkConstraints.

**Call relations**: Serde calls this when a NetworkConstraints value is deserialized; it reuses NetworkRequirementsToml::deserialize so both types follow the same rules.

*Call graph*: calls 1 internal fn (deserialize).


##### `NetworkConstraints::from`  (lines 475–500)

```
fn from(value: NetworkRequirementsToml) -> Self
```

**Purpose**: Turns parsed network requirements into the normalized network constraints used by ConfigRequirements.

**Data flow**: It receives NetworkRequirementsToml, moves each network field into a NetworkConstraints value, and returns it.

**Call relations**: ConfigRequirements::try_from uses this when preserving managed network rules with their source.


##### `FilesystemRequirementsToml::deserialize`  (lines 519–545)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads filesystem requirements while preventing a reserved table from being mistaken for a permission profile.

**Data flow**: It deserializes raw filesystem fields, rejects profile-like fields such as extends or workspace_roots, and returns only deny_read requirements.

**Call relations**: Serde calls this during TOML parsing; tests verify that invalid profile-shaped filesystem requirements are rejected.

*Call graph*: 2 external calls (custom, deserialize).


##### `FilesystemConstraints::from`  (lines 563–569)

```
fn from(value: PermissionsRequirementsToml) -> Self
```

**Purpose**: Extracts filesystem deny-read rules from the broader permissions requirements section.

**Data flow**: It receives PermissionsRequirementsToml, pulls out permissions.filesystem.deny_read if present, defaults to an empty list otherwise, and returns FilesystemConstraints.

**Call relations**: ConfigRequirements::try_from calls this when turning parsed permissions requirements into runtime filesystem constraints.


##### `FilesystemDenyReadPattern::as_str`  (lines 577–579)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the stored deny-read pattern as plain text.

**Data flow**: It reads the internal string and returns it as a string slice without changing anything.

**Call relations**: Callers use this when they need to compare, display, or pass the normalized pattern onward.


##### `FilesystemDenyReadPattern::contains_glob`  (lines 581–583)

```
fn contains_glob(&self) -> bool
```

**Purpose**: Reports whether the pattern contains wildcard characters such as *, ?, or [.

**Data flow**: It scans the stored string and returns true if any glob metacharacter is found.

**Call relations**: Filesystem enforcement code can use this to decide whether a rule is an exact path or a pattern.


##### `FilesystemDenyReadPattern::from_input`  (lines 585–606)

```
fn from_input(input: &str) -> Result<Self, String>
```

**Purpose**: Normalizes a user-provided deny-read path or wildcard pattern into a safe absolute form.

**Data flow**: It receives an input string. If there are no wildcards, it parses the whole input as an absolute path. If there are wildcards, it normalizes the path prefix and then appends the wildcard suffix.

**Call relations**: FilesystemDenyReadPattern::deserialize calls this while reading TOML, and tests call it to build expected normalized patterns.

*Call graph*: calls 2 internal fn (deserialize_absolute_path, split_glob_pattern); 1 external calls (format!).


##### `FilesystemDenyReadPattern::from`  (lines 610–612)

```
fn from(value: AbsolutePathBuf) -> Self
```

**Purpose**: Creates a deny-read pattern from an already validated absolute path.

**Data flow**: It receives an AbsolutePathBuf, converts it to a string, and stores that string inside FilesystemDenyReadPattern.

**Call relations**: Tests and other code use this conversion when they already have a trusted absolute path.

*Call graph*: calls 1 internal fn (to_string_lossy).


##### `FilesystemDenyReadPattern::deserialize`  (lines 616–622)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a deny-read pattern from TOML and normalizes it immediately.

**Data flow**: It deserializes a string, passes it to FilesystemDenyReadPattern::from_input, and converts any normalization problem into a TOML parse error.

**Call relations**: Serde calls this for each entry in permissions.filesystem.deny_read.

*Call graph*: 2 external calls (from_input, deserialize).


##### `deserialize_absolute_path`  (lines 625–628)

```
fn deserialize_absolute_path(input: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: Parses a string as an AbsolutePathBuf and turns parser errors into simple strings.

**Data flow**: It receives path text, asks AbsolutePathBuf's deserializer to validate and normalize it, and returns either the path or an error message.

**Call relations**: FilesystemDenyReadPattern::from_input calls this for exact paths and for the non-wildcard prefix of glob patterns.

*Call graph*: calls 1 internal fn (deserialize); called by 1 (from_input); 1 external calls (new).


##### `split_glob_pattern`  (lines 630–653)

```
fn split_glob_pattern(input: &str) -> (&str, &str)
```

**Purpose**: Splits a wildcard path into the directory part that can be normalized and the wildcard suffix that must be preserved.

**Data flow**: It finds the first wildcard character, then looks backward for the nearest path separator, returning the prefix and suffix pieces.

**Call relations**: FilesystemDenyReadPattern::from_input calls this before normalizing glob patterns.

*Call graph*: called by 1 (from_input); 1 external calls (cfg!).


##### `is_path_separator`  (lines 655–661)

```
fn is_path_separator(ch: char) -> bool
```

**Purpose**: Identifies characters that separate path components on the current operating system.

**Data flow**: It receives one character and returns true for / on Unix-like systems, and for / or \ on Windows.

**Call relations**: split_glob_pattern uses this while locating the directory boundary before a wildcard.

*Call graph*: 1 external calls (cfg!).


##### `is_glob_metacharacter`  (lines 663–665)

```
fn is_glob_metacharacter(ch: char) -> bool
```

**Purpose**: Identifies wildcard characters used in glob patterns.

**Data flow**: It receives one character and returns true for *, ?, or [.

**Call relations**: FilesystemDenyReadPattern::contains_glob, from_input, and split_glob_pattern use this to recognize patterns rather than exact paths.

*Call graph*: 1 external calls (matches!).


##### `WebSearchModeRequirement::from`  (lines 676–682)

```
fn from(mode: WebSearchMode) -> Self
```

**Purpose**: Converts a runtime web search mode into the matching requirements enum.

**Data flow**: It receives Disabled, Cached, or Live from the protocol type and returns the same concept in requirement form.

**Call relations**: Constraint checks use this conversion when comparing a candidate runtime web search mode against allowed requirement values.


##### `WebSearchMode::from`  (lines 686–692)

```
fn from(mode: WebSearchModeRequirement) -> Self
```

**Purpose**: Converts a requirements web search mode into the runtime protocol type.

**Data flow**: It receives a requirement enum value and returns the equivalent WebSearchMode value.

**Call relations**: ConfigRequirements::try_from uses this while preparing readable allowed-value text for web search constraint errors.


##### `WebSearchModeRequirement::fmt`  (lines 696–702)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Prints a web search requirement as disabled, cached, or live.

**Data flow**: It receives the enum value and writes the matching lowercase string.

**Call relations**: Rust formatting calls this when web search modes need human-readable text.

*Call graph*: 1 external calls (write!).


##### `ComputerUseRequirementsToml::is_empty`  (lines 711–713)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the computer-use requirements table contains any setting.

**Data flow**: It returns true when allow_locked_computer_use is not set.

**Call relations**: ConfigRequirementsToml::is_empty calls this to decide whether a parsed requirements file is effectively empty.


##### `WindowsRequirementsToml::is_empty`  (lines 722–724)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the Windows-specific requirements table contains any setting.

**Data flow**: It returns true when allowed_sandbox_implementations is not set.

**Call relations**: ConfigRequirementsToml::is_empty calls this when checking whether there are meaningful Windows requirements.


##### `FeatureRequirementsToml::is_empty`  (lines 734–736)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any feature flags were required on or off.

**Data flow**: It returns true when the feature map has no entries.

**Call relations**: ConfigRequirementsToml::is_empty and ConfigRequirements::try_from use this to ignore empty feature sections.


##### `AppToolRequirementToml::is_empty`  (lines 745–747)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a tool-level app requirement contains an approval mode.

**Data flow**: It returns true when approval_mode is missing.

**Call relations**: AppToolsRequirementsToml::is_empty uses this for every tool in an app.


##### `AppToolsRequirementsToml::is_empty`  (lines 757–759)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether all tool-level requirements inside an app are empty.

**Data flow**: It scans every tool requirement and returns true only if each tool has no approval mode.

**Call relations**: AppRequirementToml::is_empty uses this when deciding whether an app requirement has meaningful tool rules.


##### `AppRequirementToml::is_empty`  (lines 769–775)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether an app requirement contains either an enabled setting or tool restrictions.

**Data flow**: It returns true when enabled is missing and the optional tools section is missing or empty.

**Call relations**: AppsRequirementsToml::is_empty uses this across all configured apps.


##### `AppsRequirementsToml::is_empty`  (lines 785–787)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the app requirements section contains any meaningful rule.

**Data flow**: It scans all app requirements and returns true only if every app requirement is empty.

**Call relations**: ConfigRequirementsToml::is_empty uses this to ignore empty app sections.


##### `merge_app_requirements_descending`  (lines 793–819)

```
fn merge_app_requirements_descending(
    base: &mut AppsRequirementsToml,
    incoming: AppsRequirementsToml,
)
```

**Purpose**: Merges lower-priority app requirements into an existing higher-priority set without weakening important restrictions.

**Data flow**: It receives a mutable base and an incoming set. It unions apps, treats any false enabled value as disabling the app, and fills missing tool approval modes without overwriting higher-priority ones.

**Call relations**: ConfigRequirementsWithSources::merge_unset_fields calls this for app requirements, and many tests exercise the edge cases around priority and disabling.

*Call graph*: called by 8 (merge_unset_fields, merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset, merge_app_requirements_descending_prefers_false_from_lower_precedence, merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app, merge_app_requirements_descending_preserves_higher_tool_approval_mode, merge_app_requirements_descending_unions_distinct_apps, merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing, merge_app_requirements_descending_uses_lower_value_when_higher_missing).


##### `Sourced::new`  (lines 865–867)

```
fn new(value: T, source: RequirementSource) -> Self
```

**Purpose**: Pairs any value with the requirement source that supplied it.

**Data flow**: It receives a value and a RequirementSource, then returns a Sourced wrapper containing both.

**Call relations**: Merge and normalization code call this whenever they preserve a requirement value together with its origin.

*Call graph*: called by 21 (try_from, merge_unset_fields, merge, apply_to, merge, populate_merged_regular_fields_with_sources, resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature, filter_mcp_servers_by_allowlist_blocks_all_when_empty, filter_mcp_servers_by_allowlist_enforces_identity_rules, filter_plugin_mcp_servers_by_allowlist_blocks_unlisted_plugin (+11 more)).


##### `Sourced::deref`  (lines 873–875)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets code read a Sourced value as if it were the wrapped value.

**Data flow**: It receives a Sourced reference and returns a reference to its inner value.

**Call relations**: Rust uses this automatically when callers access wrapped requirement data while source information remains attached.


##### `ConfigRequirementsWithSources::merge_unset_fields`  (lines 904–989)

```
fn merge_unset_fields(&mut self, source: RequirementSource, other: ConfigRequirementsToml)
```

**Purpose**: Merges one requirements layer into the accumulated requirements, respecting priority and recording where each value came from.

**Data flow**: It receives a source and a parsed TOML requirements object. For most fields it fills only missing values, ignores blank guardian policy text, and merges apps specially so lower layers can still contribute safe disables.

**Call relations**: Config-loading code calls this once per requirements layer, from highest to lowest priority, before ConfigRequirements::try_from turns the result into runtime constraints.

*Call graph*: calls 2 internal fn (new, merge_app_requirements_descending); 1 external calls (fill_missing_take!).


##### `ConfigRequirementsWithSources::into_toml`  (lines 991–1039)

```
fn into_toml(self) -> ConfigRequirementsToml
```

**Purpose**: Drops source labels and converts the source-tracked requirements back into the plain TOML-shaped structure.

**Data flow**: It receives ConfigRequirementsWithSources, unwraps each Sourced field to keep only its value, sets remote_sandbox_config to None, and returns ConfigRequirementsToml.

**Call relations**: Callers use this when they need the merged requirements in the same shape as parsed TOML rather than source-aware form.


##### `normalize_hostname`  (lines 1042–1045)

```
fn normalize_hostname(hostname: &str) -> Option<String>
```

**Purpose**: Cleans a hostname before matching it against remote sandbox rules.

**Data flow**: It trims whitespace, removes a trailing dot, lowercases the hostname, and returns None if nothing meaningful remains.

**Call relations**: ConfigRequirementsToml::apply_remote_sandbox_config and hostname_matches_any_pattern use this before wildcard matching.


##### `hostname_matches_any_pattern`  (lines 1047–1053)

```
fn hostname_matches_any_pattern(hostname: &str, patterns: &[String]) -> bool
```

**Purpose**: Checks whether a normalized hostname matches any configured wildcard hostname pattern.

**Data flow**: It normalizes each pattern, builds a case-insensitive wildcard matcher, and returns true on the first match.

**Call relations**: ConfigRequirementsToml::apply_remote_sandbox_config uses this to find the first remote sandbox override that applies to the current host.


##### `SandboxModeRequirement::from`  (lines 1073–1079)

```
fn from(mode: SandboxMode) -> Self
```

**Purpose**: Converts a runtime sandbox mode into the requirement enum used in managed policy.

**Data flow**: It receives ReadOnly, WorkspaceWrite, or DangerFullAccess and returns the matching SandboxModeRequirement.

**Call relations**: Code that compares runtime sandbox settings with requirement allow-lists uses this conversion.


##### `ConfigRequirementsToml::apply_remote_sandbox_config`  (lines 1089–1103)

```
fn apply_remote_sandbox_config(&mut self, hostname: Option<&str>)
```

**Purpose**: Applies hostname-specific sandbox mode requirements when the current machine matches a remote sandbox rule.

**Data flow**: It reads remote_sandbox_config and an optional hostname. If a normalized hostname matches the first configured pattern set, it replaces allowed_sandbox_modes with that rule's allowed modes.

**Call relations**: Config loading calls this before merging layers so host-specific sandbox rules become ordinary allowed_sandbox_modes for later constraint building.


##### `ConfigRequirementsToml::is_empty`  (lines 1105–1149)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a parsed requirements file actually contains any meaningful requirement.

**Data flow**: It examines every top-level section, treating blank guardian policy text and empty nested sections as absent, and returns true only when nothing is configured.

**Call relations**: Tests and config-loading code use this to ignore empty requirements inputs or verify that false-valued settings still count as configured.


##### `ConfigRequirements::try_from`  (lines 1155–1459)

```
fn try_from(toml: ConfigRequirementsWithSources) -> Result<Self, Self::Error>
```

**Purpose**: Converts source-tracked parsed requirements into runtime constraints that actively reject disallowed settings.

**Data flow**: It receives ConfigRequirementsWithSources, builds Constrained values for approvals, reviewers, sandbox-derived permission profiles, Windows sandbox mode, web search, hooks, residency, network, filesystem, and execution policy, and returns either ConfigRequirements or a source-aware ConstraintError.

**Call relations**: This is the central normalization step after all requirement layers have been merged; many tests call it to verify that invalid candidates are rejected with the right source.

*Call graph*: calls 7 internal fn (new, new, allow_any, allow_any_from_default, new, empty_field, read_only); 1 external calls (format!).


##### `sandbox_mode_requirement_for_permission_profile`  (lines 1462–1483)

```
fn sandbox_mode_requirement_for_permission_profile(
    permission_profile: &PermissionProfile,
) -> SandboxModeRequirement
```

**Purpose**: Classifies a permission profile into the sandbox mode category that requirements understand.

**Data flow**: It receives a PermissionProfile. Disabled becomes full access, external profiles become external sandbox, and managed profiles are inspected for write or full-disk access to choose read-only, workspace-write, or full access.

**Call relations**: ConfigRequirements::try_from uses this inside the permission profile constraint so allowed_sandbox_modes can control richer permission profiles.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy).


##### `tests::tokens`  (lines 1499–1501)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Builds command-token test data from string slices.

**Data flow**: It receives a slice of string references and returns owned String values in a vector.

**Call relations**: Execution policy tests use this helper to check how command rules match tokenized commands.


##### `tests::system_requirements_toml_file_for_test`  (lines 1503–1507)

```
fn system_requirements_toml_file_for_test() -> Result<AbsolutePathBuf>
```

**Purpose**: Creates a plausible temporary requirements.toml path for tests that need a file-based source.

**Data flow**: It takes the system temp directory, appends requirements.toml, converts it to AbsolutePathBuf, and returns it.

**Call relations**: Source-aware error tests call this when constructing RequirementSource::SystemRequirementsToml.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (temp_dir).


##### `tests::composite_requirement_source_flattens_and_deduplicates_sources`  (lines 1510–1526)

```
fn composite_requirement_source_flattens_and_deduplicates_sources()
```

**Purpose**: Verifies that composite requirement sources are flattened and duplicates are removed.

**Data flow**: It creates MDM and legacy sources, nests them in a composite, and asserts the resulting source list is ordered and unique.

**Call relations**: This directly exercises RequirementSource::composite.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::with_unknown_source`  (lines 1528–1588)

```
fn with_unknown_source(toml: ConfigRequirementsToml) -> ConfigRequirementsWithSources
```

**Purpose**: Wraps every configured field in a parsed requirements object with the Unknown source for tests.

**Data flow**: It receives ConfigRequirementsToml, maps each present field into Sourced using RequirementSource::Unknown, and returns ConfigRequirementsWithSources.

**Call relations**: Many tests use this shortcut before calling ConfigRequirements::try_from, so they can focus on behavior rather than source setup.


##### `tests::deserialize_allow_managed_hooks_only`  (lines 1591–1601)

```
fn deserialize_allow_managed_hooks_only() -> Result<()>
```

**Purpose**: Checks that allow_managed_hooks_only = true is parsed and makes the requirements non-empty.

**Data flow**: It parses a small TOML string, reads the boolean field, and asserts the config is not empty.

**Call relations**: This validates ConfigRequirementsToml parsing and ConfigRequirementsToml::is_empty behavior for this field.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::allow_managed_hooks_only_false_is_still_configured`  (lines 1604–1614)

```
fn allow_managed_hooks_only_false_is_still_configured() -> Result<()>
```

**Purpose**: Checks that an explicit false value for allow_managed_hooks_only still counts as a configured requirement.

**Data flow**: It parses TOML with false, verifies the field is Some(false), and verifies the requirements are not empty.

**Call relations**: This protects against treating false as if the field were missing.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_managed_permission_profiles`  (lines 1617–1659)

```
fn deserialize_managed_permission_profiles() -> Result<()>
```

**Purpose**: Checks that managed permission profile names, defaults, and profile definitions are parsed together.

**Data flow**: It parses TOML containing allowed profiles and profile bodies, then asserts the allowed map, default name, and profile catalog are present.

**Call relations**: This covers the TOML data model around allowed_permission_profiles, default_permissions, and permissions profiles.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_allow_appshots`  (lines 1662–1672)

```
fn deserialize_allow_appshots() -> Result<()>
```

**Purpose**: Checks that allow_appshots = true is parsed and treated as meaningful requirements content.

**Data flow**: It parses the TOML, asserts the field is Some(true), and asserts the parsed object is not empty.

**Call relations**: This validates ConfigRequirementsToml::is_empty for the appshots setting.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::filesystem_requirements_table_cannot_define_a_permission_profile`  (lines 1675–1690)

```
fn filesystem_requirements_table_cannot_define_a_permission_profile()
```

**Purpose**: Ensures permissions.filesystem cannot be used as a normal permission profile table.

**Data flow**: It parses TOML that puts extends under permissions.filesystem and expects a parse error containing the reserved-table message.

**Call relations**: This exercises FilesystemRequirementsToml::deserialize's rejection path.

*Call graph*: 1 external calls (assert!).


##### `tests::allow_appshots_false_is_still_configured`  (lines 1693–1703)

```
fn allow_appshots_false_is_still_configured() -> Result<()>
```

**Purpose**: Checks that allow_appshots = false still counts as a configured requirement.

**Data flow**: It parses the TOML, asserts Some(false), and confirms the requirements are not empty.

**Call relations**: This protects explicit administrator denials from being mistaken for missing values.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::allow_remote_control_false_is_still_configured`  (lines 1706–1716)

```
fn allow_remote_control_false_is_still_configured() -> Result<()>
```

**Purpose**: Checks that allow_remote_control = false still counts as a configured requirement.

**Data flow**: It parses the TOML, asserts Some(false), and confirms the requirements are not empty.

**Call relations**: This validates ConfigRequirementsToml::is_empty for remote-control policy.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::deserialize_computer_use_requirements`  (lines 1719–1735)

```
fn deserialize_computer_use_requirements() -> Result<()>
```

**Purpose**: Checks parsing of the computer_use requirements section.

**Data flow**: It parses allow_locked_computer_use = false and asserts the nested struct contains that value and is not empty.

**Call relations**: This covers ComputerUseRequirementsToml and its role in top-level emptiness checks.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::merge_unset_fields_copies_every_field_and_sets_sources`  (lines 1738–1839)

```
fn merge_unset_fields_copies_every_field_and_sets_sources()
```

**Purpose**: Verifies that merging into an empty source-tracked requirements object copies all ordinary fields and attaches the source.

**Data flow**: It builds a populated ConfigRequirementsToml, merges it, and compares the full source-tracked result against the expected values.

**Call relations**: This is a broad safety test for ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 4 external calls (from, assert_eq!, default, vec!).


##### `tests::merge_unset_fields_fills_missing_values`  (lines 1842–1886)

```
fn merge_unset_fields_fills_missing_values() -> Result<()>
```

**Purpose**: Checks that a missing field is filled from an incoming requirements layer.

**Data flow**: It starts with an empty target, merges a TOML layer with allowed approval policies, and asserts the field appears with the correct source.

**Call relations**: This exercises the normal fill-missing path in ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `tests::merge_unset_fields_does_not_overwrite_existing_values`  (lines 1889–1940)

```
fn merge_unset_fields_does_not_overwrite_existing_values() -> Result<()>
```

**Purpose**: Checks that higher-priority values are not overwritten by later lower-priority layers.

**Data flow**: It merges one approval policy first, then another from a different source, and asserts the first value remains.

**Call relations**: This protects the priority behavior in ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 3 external calls (assert_eq!, default, from_str).


##### `tests::merge_unset_fields_ignores_blank_guardian_override`  (lines 1943–1973)

```
fn merge_unset_fields_ignores_blank_guardian_override()
```

**Purpose**: Checks that blank guardian policy text does not block a later meaningful guardian policy value.

**Data flow**: It merges a blank guardian policy, then a real one, and asserts the real one is kept with its file source.

**Call relations**: This covers the special blank-string handling in ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 4 external calls (default, assert_eq!, default, system_requirements_toml_file_for_test).


##### `tests::deserialize_guardian_policy_config`  (lines 1976–1990)

```
fn deserialize_guardian_policy_config() -> Result<()>
```

**Purpose**: Checks that multiline guardian policy text is parsed exactly enough to preserve its content.

**Data flow**: It parses a TOML multiline string and asserts the stored value matches the expected text.

**Call relations**: This validates the guardian_policy_config field in ConfigRequirementsToml.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::blank_guardian_policy_config_is_empty`  (lines 1993–2004)

```
fn blank_guardian_policy_config_is_empty() -> Result<()>
```

**Purpose**: Checks that a guardian policy containing only whitespace does not make requirements non-empty.

**Data flow**: It parses blank multiline guardian text and asserts ConfigRequirementsToml::is_empty returns true.

**Call relations**: This verifies the blank handling used by ConfigRequirementsToml::is_empty.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::allowed_approvals_reviewers_is_not_empty`  (lines 2007–2016)

```
fn allowed_approvals_reviewers_is_not_empty() -> Result<()>
```

**Purpose**: Checks that allowed approval reviewers count as meaningful requirements.

**Data flow**: It parses a reviewers allow-list and asserts the requirements are not empty.

**Call relations**: This protects ConfigRequirementsToml::is_empty coverage for allowed_approvals_reviewers.

*Call graph*: 2 external calls (assert!, from_str).


##### `tests::deserialize_filesystem_deny_read_requirements`  (lines 2019–2054)

```
fn deserialize_filesystem_deny_read_requirements() -> Result<()>
```

**Purpose**: Checks that exact filesystem deny-read paths are parsed into normalized filesystem constraints.

**Data flow**: It builds platform-appropriate absolute paths, parses them from TOML, converts to ConfigRequirements, and compares the resulting deny_read list.

**Call relations**: This exercises FilesystemDenyReadPattern deserialization, FilesystemConstraints::from, and ConfigRequirements::try_from.

*Call graph*: 5 external calls (assert_eq!, cfg!, with_unknown_source, format!, from_str).


##### `tests::deserialize_filesystem_deny_read_glob_requirements`  (lines 2057–2081)

```
fn deserialize_filesystem_deny_read_glob_requirements() -> Result<()>
```

**Purpose**: Checks that filesystem deny-read glob patterns are normalized correctly.

**Data flow**: It sets a temporary current path context, parses a relative glob pattern, converts requirements, and compares against FilesystemDenyReadPattern::from_input.

**Call relations**: This tests the glob path path through FilesystemDenyReadPattern::from_input.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, with_unknown_source, temp_dir, from_str).


##### `tests::deserialize_apps_requirements`  (lines 2084–2104)

```
fn deserialize_apps_requirements() -> Result<()>
```

**Purpose**: Checks parsing of an app-level enabled flag.

**Data flow**: It parses TOML disabling one app and asserts the AppsRequirementsToml structure matches.

**Call relations**: This validates the app requirements TOML shape.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserialize_apps_tool_requirements`  (lines 2107–2134)

```
fn deserialize_apps_tool_requirements() -> Result<()>
```

**Purpose**: Checks parsing of tool-level approval requirements inside an app.

**Data flow**: It parses a nested app tool table with an approval mode and asserts the nested maps contain the expected value.

**Call relations**: This validates AppToolsRequirementsToml and AppToolRequirementToml deserialization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::apps_requirements`  (lines 2136–2151)

```
fn apps_requirements(entries: &[(&str, Option<bool>)]) -> AppsRequirementsToml
```

**Purpose**: Builds simple app enabled/disabled requirement test data.

**Data flow**: It receives app IDs with optional enabled values and returns an AppsRequirementsToml map containing those entries.

**Call relations**: App merge tests use this helper to keep their expected values easy to read.


##### `tests::app_tool_requirements`  (lines 2153–2174)

```
fn app_tool_requirements(
        app_id: &str,
        tool_name: &str,
        approval_mode: AppToolApproval,
    ) -> AppsRequirementsToml
```

**Purpose**: Builds app tool approval requirement test data for one app and one tool.

**Data flow**: It receives an app ID, tool name, and approval mode, then returns an AppsRequirementsToml containing that nested tool rule.

**Call relations**: Tool-level app merge tests use this helper before calling merge_app_requirements_descending.

*Call graph*: 1 external calls (from).


##### `tests::merge_app_requirements_descending_unions_distinct_apps`  (lines 2177–2190)

```
fn merge_app_requirements_descending_unions_distinct_apps()
```

**Purpose**: Checks that app requirements for different apps are combined.

**Data flow**: It starts with one app in the higher-priority set, merges a different app from the lower-priority set, and asserts both remain.

**Call relations**: This directly tests merge_app_requirements_descending.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_prefers_false_from_lower_precedence`  (lines 2193–2203)

```
fn merge_app_requirements_descending_prefers_false_from_lower_precedence()
```

**Purpose**: Checks that a lower-priority app disable can still disable an app.

**Data flow**: It starts with enabled true, merges enabled false for the same app, and asserts the merged result is false.

**Call relations**: This verifies the special safety rule in merge_app_requirements_descending where false wins.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset`  (lines 2206–2216)

```
fn merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset()
```

**Purpose**: Checks that a missing lower-priority enabled value does not erase a higher-priority true value.

**Data flow**: It merges an unset enabled value into an app already set to true and asserts true remains.

**Call relations**: This tests merge_app_requirements_descending's handling of absent lower-layer values.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_uses_lower_value_when_higher_missing`  (lines 2219–2229)

```
fn merge_app_requirements_descending_uses_lower_value_when_higher_missing()
```

**Purpose**: Checks that lower-priority app values are used when no higher-priority value exists.

**Data flow**: It starts with no app rule, merges one app rule, and asserts the incoming value is present.

**Call relations**: This covers the fill-empty case in merge_app_requirements_descending.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app`  (lines 2232–2242)

```
fn merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app()
```

**Purpose**: Checks that an existing higher-priority app disable is preserved when the lower layer has no matching app.

**Data flow**: It merges an empty lower set into a base containing a disabled app and asserts the disabled app remains.

**Call relations**: This protects merge_app_requirements_descending from dropping base entries.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, apps_requirements).


##### `tests::merge_app_requirements_descending_preserves_higher_tool_approval_mode`  (lines 2245–2267)

```
fn merge_app_requirements_descending_preserves_higher_tool_approval_mode()
```

**Purpose**: Checks that higher-priority tool approval settings are not overwritten.

**Data flow**: It merges a lower-priority approval mode for the same app tool and asserts the original higher-priority mode remains.

**Call relations**: This tests the tool-specific priority rule in merge_app_requirements_descending.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 2 external calls (assert_eq!, app_tool_requirements).


##### `tests::merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing`  (lines 2270–2288)

```
fn merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing()
```

**Purpose**: Checks that a lower-priority tool approval setting is used when the higher-priority layer has no tool setting.

**Data flow**: It starts with an app but no tool approval mode, merges an incoming tool rule, and asserts the tool rule is added.

**Call relations**: This covers the fill-missing tool branch in merge_app_requirements_descending.

*Call graph*: calls 1 internal fn (merge_app_requirements_descending); 3 external calls (assert_eq!, app_tool_requirements, apps_requirements).


##### `tests::merge_unset_fields_merges_apps_across_sources_with_enabled_evaluation`  (lines 2291–2330)

```
fn merge_unset_fields_merges_apps_across_sources_with_enabled_evaluation()
```

**Purpose**: Checks that app requirements from multiple sources are merged while preserving the source of the higher-priority app block.

**Data flow**: It merges a high-priority app set and a lower-priority app set, then asserts the combined app values and source.

**Call relations**: This exercises ConfigRequirementsWithSources::merge_unset_fields and its call to merge_app_requirements_descending.

*Call graph*: 4 external calls (default, assert_eq!, default, apps_requirements).


##### `tests::merge_unset_fields_apps_empty_higher_source_does_not_block_lower_disables`  (lines 2333–2355)

```
fn merge_unset_fields_apps_empty_higher_source_does_not_block_lower_disables()
```

**Purpose**: Checks that an empty higher-priority app section does not prevent lower-priority app disables from being added.

**Data flow**: It merges an empty app set, then a set with a disabled app, and asserts the disabled app appears.

**Call relations**: This protects the app merge behavior inside ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 4 external calls (default, assert_eq!, default, apps_requirements).


##### `tests::constraint_error_includes_requirement_source`  (lines 2358–2409)

```
fn constraint_error_includes_requirement_source() -> Result<()>
```

**Purpose**: Checks that rejected values include the source of the requirement that blocked them.

**Data flow**: It builds source-tracked requirements, converts them, tries disallowed approval, sandbox, and reviewer values, and compares the exact ConstraintError values.

**Call relations**: This exercises ConfigRequirementsWithSources::merge_unset_fields and ConfigRequirements::try_from.

*Call graph*: 5 external calls (try_from, assert_eq!, default, system_requirements_toml_file_for_test, from_str).


##### `tests::constraint_error_includes_composite_requirement_source`  (lines 2412–2442)

```
fn constraint_error_includes_composite_requirement_source() -> Result<()>
```

**Purpose**: Checks that errors can report a composite requirement source.

**Data flow**: It creates a composite source, merges approval requirements with it, triggers a rejected approval value, and asserts the composite source appears in the error.

**Call relations**: This directly calls RequirementSource::composite and then tests ConfigRequirements::try_from's source-aware constraint.

*Call graph*: calls 1 internal fn (composite); 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::constrained_fields_store_requirement_source`  (lines 2445–2489)

```
fn constrained_fields_store_requirement_source() -> Result<()>
```

**Purpose**: Checks that normalized constrained fields remember the source that created them.

**Data flow**: It parses several constrained fields, merges them with a source, converts to ConfigRequirements, and asserts each relevant field stores that source.

**Call relations**: This validates the source preservation done in ConfigRequirements::try_from.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::deserialize_allowed_approval_policies`  (lines 2492–2544)

```
fn deserialize_allowed_approval_policies() -> Result<()>
```

**Purpose**: Checks approval policy allow-list parsing and enforcement.

**Data flow**: It parses allowed approval policies, converts to requirements, checks accepted values, and checks rejected values produce the expected errors.

**Call relations**: This exercises ConfigRequirements::try_from's approval_policy constraint.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_approvals_reviewers`  (lines 2547–2573)

```
fn deserialize_allowed_approvals_reviewers() -> Result<()>
```

**Purpose**: Checks approvals reviewer allow-list parsing and enforcement.

**Data flow**: It parses allowed reviewers, converts to requirements, and verifies both listed reviewers are accepted.

**Call relations**: This exercises ConfigRequirements::try_from's approvals_reviewer constraint.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_windows_sandbox_implementations`  (lines 2576–2603)

```
fn deserialize_allowed_windows_sandbox_implementations() -> Result<()>
```

**Purpose**: Checks Windows sandbox implementation allow-list parsing and enforcement.

**Data flow**: It parses an elevated-only Windows sandbox requirement, converts it, and checks elevated is accepted while unelevated and None are rejected.

**Call relations**: This exercises the Windows sandbox branch in ConfigRequirements::try_from.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::empty_allowed_windows_sandbox_implementations_is_rejected`  (lines 2606–2621)

```
fn empty_allowed_windows_sandbox_implementations_is_rejected() -> Result<()>
```

**Purpose**: Checks that an empty Windows sandbox implementation allow-list is invalid.

**Data flow**: It parses an empty list, converts to ConfigRequirementsWithSources, and asserts ConfigRequirements::try_from returns an EmptyField error.

**Call relations**: This verifies the validation path in ConfigRequirements::try_from.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::allowed_windows_sandbox_implementations_prefer_elevated_fallback`  (lines 2624–2638)

```
fn allowed_windows_sandbox_implementations_prefer_elevated_fallback() -> Result<()>
```

**Purpose**: Checks that elevated is chosen as the initial Windows sandbox mode when both choices are allowed.

**Data flow**: It parses both unelevated and elevated, converts requirements, and asserts the current value is elevated.

**Call relations**: This validates the default selection logic inside ConfigRequirements::try_from.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_legacy_allowed_approvals_reviewer`  (lines 2641–2654)

```
fn deserialize_legacy_allowed_approvals_reviewer() -> Result<()>
```

**Purpose**: Checks compatibility with a legacy approvals reviewer name.

**Data flow**: It parses an older reviewer value alongside user, converts requirements, and asserts the runtime reviewer is AutoReview.

**Call relations**: This documents deserialization compatibility for ApprovalsReviewer values used by ConfigRequirements::try_from.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::empty_allowed_approvals_reviewers_is_rejected`  (lines 2657–2673)

```
fn empty_allowed_approvals_reviewers_is_rejected() -> Result<()>
```

**Purpose**: Checks that an empty approvals reviewer allow-list is invalid.

**Data flow**: It parses an empty reviewer list, tries to normalize it, and asserts an EmptyField error.

**Call relations**: This tests ConfigRequirements::try_from's reviewer validation.

*Call graph*: 4 external calls (try_from, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_allowed_sandbox_modes`  (lines 2676–2728)

```
fn deserialize_allowed_sandbox_modes() -> Result<()>
```

**Purpose**: Checks sandbox mode allow-list parsing and how it constrains permission profiles.

**Data flow**: It parses read-only and workspace-write modes, builds representative permission profiles, and verifies full access and external sandbox profiles are rejected.

**Call relations**: This exercises sandbox_mode_requirement_for_permission_profile through ConfigRequirements::try_from's permission_profile constraint.

*Call graph*: calls 2 internal fn (workspace_write_with, from_absolute_path); 5 external calls (assert!, assert_eq!, cfg!, with_unknown_source, from_str).


##### `tests::deserialize_remote_sandbox_config_requires_hostname_patterns_list`  (lines 2731–2764)

```
fn deserialize_remote_sandbox_config_requires_hostname_patterns_list() -> Result<()>
```

**Purpose**: Checks that remote sandbox configuration requires hostname_patterns to be a list.

**Data flow**: It parses a valid remote sandbox config and then confirms that a string hostname_patterns value fails to parse.

**Call relations**: This validates the RemoteSandboxConfigToml data shape used by ConfigRequirementsToml::apply_remote_sandbox_config.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `tests::remote_sandbox_config_first_match_overrides_top_level`  (lines 2767–2824)

```
fn remote_sandbox_config_first_match_overrides_top_level() -> Result<()>
```

**Purpose**: Checks that the first matching remote sandbox rule replaces the top-level sandbox allow-list.

**Data flow**: It parses top-level and remote sandbox rules, applies a matching hostname, merges sources, and verifies workspace-write is allowed while full access is rejected.

**Call relations**: This exercises ConfigRequirementsToml::apply_remote_sandbox_config and then ConfigRequirements::try_from.

*Call graph*: calls 2 internal fn (workspace_write_with, from_absolute_path); 6 external calls (try_from, assert!, assert_eq!, cfg!, default, from_str).


##### `tests::remote_sandbox_config_non_match_preserves_top_level`  (lines 2827–2855)

```
fn remote_sandbox_config_non_match_preserves_top_level() -> Result<()>
```

**Purpose**: Checks that remote sandbox rules do nothing when the hostname does not match.

**Data flow**: It applies a non-matching hostname and verifies the original read-only-only sandbox rule still blocks full access.

**Call relations**: This tests the no-match path in ConfigRequirementsToml::apply_remote_sandbox_config.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::remote_sandbox_config_does_not_override_higher_precedence_sandbox_modes`  (lines 2858–2894)

```
fn remote_sandbox_config_does_not_override_higher_precedence_sandbox_modes() -> Result<()>
```

**Purpose**: Checks that a lower-priority remote sandbox rule cannot override a higher-priority sandbox allow-list.

**Data flow**: It merges a high-priority read-only layer and a lower-priority hostname-matched workspace-write layer, then verifies workspace-write is still rejected.

**Call relations**: This covers the interaction between ConfigRequirementsToml::apply_remote_sandbox_config and ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::deserialize_allowed_web_search_modes`  (lines 2897–2928)

```
fn deserialize_allowed_web_search_modes() -> Result<()>
```

**Purpose**: Checks web search mode allow-list parsing where cached is allowed and live is not.

**Data flow**: It parses cached, converts requirements, verifies disabled is always allowed, cached is allowed, and live is rejected.

**Call relations**: This exercises ConfigRequirements::try_from's web_search_mode constraint.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::allowed_web_search_modes_allows_disabled`  (lines 2931–2958)

```
fn allowed_web_search_modes_allows_disabled() -> Result<()>
```

**Purpose**: Checks web search requirements that allow only disabled mode.

**Data flow**: It parses disabled, converts requirements, verifies disabled is the current value, and cached is rejected.

**Call relations**: This validates the disabled-only branch of ConfigRequirements::try_from's web search handling.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::allowed_web_search_modes_empty_restricts_to_disabled`  (lines 2961–2988)

```
fn allowed_web_search_modes_empty_restricts_to_disabled() -> Result<()>
```

**Purpose**: Checks that an empty web search allow-list means only disabled is allowed.

**Data flow**: It parses an empty list, converts requirements, and verifies disabled is accepted while cached is rejected.

**Call relations**: This documents the special behavior in ConfigRequirements::try_from that always includes disabled.

*Call graph*: 4 external calls (assert!, assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_feature_requirements`  (lines 2991–3014)

```
fn deserialize_feature_requirements() -> Result<()>
```

**Purpose**: Checks parsing and preservation of feature requirements.

**Data flow**: It parses two feature flags, converts requirements, and asserts the source-tracked feature map matches.

**Call relations**: This exercises ConfigRequirements::try_from's feature_requirements preservation.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_managed_hooks_requirements`  (lines 3017–3040)

```
fn deserialize_managed_hooks_requirements() -> Result<()>
```

**Purpose**: Checks parsing of managed hook requirements.

**Data flow**: It parses managed hook directories and a PreToolUse command hook, then asserts the managed directory and handler count.

**Call relations**: This validates the imported ManagedHooksRequirementsToml shape as used by this file.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::merge_unset_fields_does_not_overwrite_existing_hooks`  (lines 3043–3093)

```
fn merge_unset_fields_does_not_overwrite_existing_hooks() -> Result<()>
```

**Purpose**: Checks that higher-priority managed hooks are not overwritten by lower-priority hook requirements.

**Data flow**: It merges cloud hooks first, then system hooks, and asserts the cloud managed directory and source remain.

**Call relations**: This tests hook behavior in ConfigRequirementsWithSources::merge_unset_fields.

*Call graph*: 3 external calls (assert_eq!, default, system_requirements_toml_file_for_test).


##### `tests::managed_hooks_constraint_rejects_drift`  (lines 3096–3132)

```
fn managed_hooks_constraint_rejects_drift() -> Result<()>
```

**Purpose**: Checks that managed hook requirements cannot be changed after normalization.

**Data flow**: It parses managed hooks, converts requirements, tries to set different hooks, and asserts a ConstraintError is returned.

**Call relations**: This exercises the managed_hooks constraint created in ConfigRequirements::try_from.

*Call graph*: 5 external calls (assert!, with_unknown_source, default, from, from_str).


##### `tests::network_requirements_are_preserved_as_constraints_with_source`  (lines 3135–3211)

```
fn network_requirements_are_preserved_as_constraints_with_source() -> Result<()>
```

**Purpose**: Checks canonical network requirements are carried into normalized constraints with their source.

**Data flow**: It parses network settings with domain and Unix socket allow/deny maps, merges with a source, converts requirements, and asserts each field.

**Call relations**: This tests NetworkRequirementsToml::deserialize, NetworkConstraints::from, and ConfigRequirements::try_from.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::legacy_network_requirements_are_preserved_as_constraints_with_source`  (lines 3214–3278)

```
fn legacy_network_requirements_are_preserved_as_constraints_with_source() -> Result<()>
```

**Purpose**: Checks older network requirement fields are converted and preserved as normalized constraints.

**Data flow**: It parses legacy allowed_domains, denied_domains, and allow_unix_sockets lists, converts requirements, and compares the canonical maps.

**Call relations**: This exercises legacy_domain_permissions_from_lists and legacy_unix_socket_permissions_from_list through NetworkRequirementsToml::deserialize.

*Call graph*: 4 external calls (try_from, assert_eq!, default, from_str).


##### `tests::mixed_legacy_and_canonical_network_requirements_are_rejected`  (lines 3281–3315)

```
fn mixed_legacy_and_canonical_network_requirements_are_rejected()
```

**Purpose**: Checks that old and new network configuration shapes cannot be mixed.

**Data flow**: It parses TOML that combines canonical domains with legacy domain lists, then canonical unix_sockets with legacy socket lists, and expects errors.

**Call relations**: This verifies the rejection checks in NetworkRequirementsToml::deserialize.

*Call graph*: 1 external calls (assert!).


##### `tests::network_permission_containers_project_allowed_and_denied_entries`  (lines 3318–3373)

```
fn network_permission_containers_project_allowed_and_denied_entries()
```

**Purpose**: Checks helper methods that split canonical network permission maps into allowed and denied lists.

**Data flow**: It builds domain and socket permission maps, calls projection helpers, and compares the returned lists.

**Call relations**: This directly tests NetworkDomainPermissionsToml::allowed_domains, denied_domains, and NetworkUnixSocketPermissionsToml::allow_unix_sockets.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::deserialize_mcp_server_requirements`  (lines 3376–3412)

```
fn deserialize_mcp_server_requirements() -> Result<()>
```

**Purpose**: Checks parsing of top-level MCP server identity requirements.

**Data flow**: It parses one command-based and one URL-based MCP server identity, converts requirements, and compares the source-tracked server map.

**Call relations**: This validates McpServerRequirement and McpServerIdentity as preserved by ConfigRequirements::try_from.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_plugin_mcp_server_requirements`  (lines 3415–3461)

```
fn deserialize_plugin_mcp_server_requirements() -> Result<()>
```

**Purpose**: Checks parsing of MCP server requirements nested under plugins.

**Data flow**: It parses plugin-specific command and URL MCP server identities, converts requirements, and compares the source-tracked plugin map.

**Call relations**: This validates PluginRequirementsToml preservation in ConfigRequirements::try_from.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::deserialize_exec_policy_requirements`  (lines 3464–3491)

```
fn deserialize_exec_policy_requirements() -> Result<()>
```

**Purpose**: Checks parsing and use of execution policy rules from requirements.

**Data flow**: It parses a rule forbidding commands starting with rm, converts requirements, evaluates an rm command, and asserts the forbidden decision and matched rule.

**Call relations**: This exercises RequirementsExecPolicyToml conversion inside ConfigRequirements::try_from.

*Call graph*: 3 external calls (assert_eq!, with_unknown_source, from_str).


##### `tests::exec_policy_error_includes_requirement_source`  (lines 3494–3521)

```
fn exec_policy_error_includes_requirement_source() -> Result<()>
```

**Purpose**: Checks that execution policy parse errors include the source that supplied the bad policy.

**Data flow**: It parses an invalid rule missing a decision, merges it with a file source, tries to normalize it, and asserts the ExecPolicyParse error includes that source.

**Call relations**: This tests the error path in ConfigRequirements::try_from for execution policy conversion.

*Call graph*: 5 external calls (try_from, assert_eq!, default, system_requirements_toml_file_for_test, from_str).


### `config/src/requirements_layers/layer.rs`

`config` · `config load`

A requirements layer is one piece of configuration that may come from a file, an in-memory TOML value, or an older compatibility path. This file is the adapter that makes that piece safe and consistent before the wider system combines it with other layers.

It starts with `RequirementsLayerEntry`, which is a small wrapper around the raw TOML plus where it came from. The source matters because parse errors can then say which layer was bad. A layer may also carry a base directory, so relative paths inside the configuration can be interpreted from the right place.

`ComposableRequirementsLayer::from_entry` is the main conversion step. It parses the same TOML in two ways: once as general TOML that can be merged normally, and once as structured requirements data that the project understands. Then it applies remote sandbox configuration. A sandbox is a restricted environment for running commands; this code only asks for the machine hostname if the layer actually contains hostname-based sandbox choices, because that lookup can be slow.

Finally, it removes special fields like `rules`, `hooks`, and a nested denied-read permission from the ordinary TOML. Those fields are kept separately so they can be merged with domain-specific rules instead of being treated like plain settings. Without this cleanup, the same requirement data could be merged twice or merged in the wrong way.

#### Function details

##### `RequirementsLayerEntry::from_toml`  (lines 19–25)

```
fn from_toml(source: RequirementSource, contents: impl Into<String>) -> Self
```

**Purpose**: Creates a requirements layer entry from raw TOML text. Use this when the configuration was read as a string, such as from a file.

**Data flow**: It receives a source label and TOML text. It stores the text inside the entry, records the source, and leaves the base directory unset. The result is a `RequirementsLayerEntry` ready for later parsing.

**Call relations**: This is used when loading requirements TOML and in layer-building code. It does not parse the text itself; it simply packages it so `ComposableRequirementsLayer::from_entry` can do the real conversion later.

*Call graph*: called by 2 (load_requirements_toml, layer); 2 external calls (into, String).


##### `RequirementsLayerEntry::from_toml_value`  (lines 27–33)

```
fn from_toml_value(source: RequirementSource, value: TomlValue) -> Self
```

**Purpose**: Creates a requirements layer entry from an already-parsed TOML value. This is useful when older configuration code has already converted TOML text into a structured value.

**Data flow**: It receives a source label and a TOML value. It stores that value directly, records the source, and leaves the base directory unset. The output is a layer entry that can join the same composition flow as text-based layers.

**Call relations**: This is called by the legacy-scheme conversion path. It lets older configuration formats feed into `ComposableRequirementsLayer::from_entry` without first turning the TOML value back into text.

*Call graph*: called by 1 (requirements_layers_from_legacy_scheme); 1 external calls (Value).


##### `RequirementsLayerEntry::with_base_dir`  (lines 35–38)

```
fn with_base_dir(mut self, base_dir: AbsolutePathBuf) -> Self
```

**Purpose**: Attaches a base directory to a layer entry. This tells later parsing where relative paths inside that layer should be interpreted from.

**Data flow**: It takes an existing layer entry and an absolute directory path. It records that path on the entry and returns the updated entry. Nothing is parsed or validated here beyond storing the path.

**Call relations**: This is a small builder-style helper used before a layer is composed. Later, `ComposableRequirementsLayer::from_entry` reads the stored base directory and sets up the parsing context around it.


##### `ComposableRequirementsLayer::from_entry`  (lines 55–92)

```
fn from_entry(
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<Self, RequirementsCompositionError>
```

**Purpose**: Converts one raw requirements layer into the internal form that can be merged with other layers. It parses the TOML, applies sandbox-related rules, and separates special requirement fields from ordinary configuration.

**Data flow**: It receives a `RequirementsLayerEntry` and a hostname lookup function. It temporarily uses the entry’s base directory if one was provided, parses the layer both as general TOML and as structured requirements, resolves remote sandbox choices if needed, writes the final allowed sandbox modes back into the regular TOML, removes special fields from that regular TOML, and returns a `ComposableRequirementsLayer`. If parsing or conversion fails, it returns an error that points back to the layer source.

**Call relations**: This is called when a requirements stack adds a layer. It coordinates the helper functions in this file: `parse_layer_toml` for ordinary TOML, `parse_layer_requirements` for requirement-specific data, `materialize_remote_sandbox_config` for sandbox output, and `strip_special_fields` so later merging treats special fields correctly.

*Call graph*: calls 4 internal fn (materialize_remote_sandbox_config, parse_layer_requirements, parse_layer_toml, strip_special_fields); called by 1 (add_layer).


##### `parse_layer_toml`  (lines 102–117)

```
fn parse_layer_toml(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<TomlValue, RequirementsCompositionError>
```

**Purpose**: Turns the layer’s raw TOML into a general TOML value. This keeps the ordinary configuration available for normal merging.

**Data flow**: It receives either TOML text or an existing TOML value, plus the layer source for error messages. If it has text, it parses the text; if it already has a value, it clones it. It returns a TOML value or a parse error tied to the source layer.

**Call relations**: `ComposableRequirementsLayer::from_entry` calls this near the start of layer conversion. The result becomes the regular configuration part after special fields are later removed.

*Call graph*: called by 1 (from_entry); 1 external calls (from_str).


##### `parse_layer_requirements`  (lines 119–141)

```
fn parse_layer_requirements(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<ConfigRequirementsToml, RequirementsCompositionError>
```

**Purpose**: Reads the same layer as project-specific requirements data. This extracts meaning from fields like rules, hooks, permissions, and sandbox settings.

**Data flow**: It receives the raw TOML form and the source label. If the layer is text, it parses it directly into `ConfigRequirementsToml`; if it is already a TOML value, it tries to convert that value into `ConfigRequirementsToml`. It returns structured requirements or a source-aware parse error.

**Call relations**: `ComposableRequirementsLayer::from_entry` calls this alongside `parse_layer_toml`. Its output drives sandbox materialization and supplies the domain-specific fields stored separately in the final composable layer.

*Call graph*: called by 1 (from_entry); 1 external calls (from_str).


##### `materialize_remote_sandbox_config`  (lines 143–159)

```
fn materialize_remote_sandbox_config(
    layer_toml: &mut TomlValue,
    requirements: &ConfigRequirementsToml,
) -> Result<(), RequirementsCompositionError>
```

**Purpose**: Replaces the special remote sandbox selector with the concrete allowed sandbox modes that should appear in regular configuration. In other words, it turns a conditional sandbox rule into the plain setting the rest of the system expects.

**Data flow**: It receives mutable regular TOML and the parsed requirements. It first removes the top-level `remote_sandbox_config` field. If the requirements contain final `allowed_sandbox_modes` and the TOML is a table, it serializes those modes into a TOML value and inserts them under `allowed_sandbox_modes`. It returns success or a conversion error.

**Call relations**: `ComposableRequirementsLayer::from_entry` calls this after applying remote sandbox configuration. It relies on `remove_top_level_field` to clear the special selector and `toml_value_from_serializable` to turn Rust data back into TOML.

*Call graph*: calls 2 internal fn (remove_top_level_field, toml_value_from_serializable); called by 1 (from_entry); 1 external calls (as_table_mut).


##### `toml_value_from_serializable`  (lines 161–167)

```
fn toml_value_from_serializable(
    value: T,
) -> Result<TomlValue, RequirementsCompositionError>
```

**Purpose**: Converts normal Rust data into a TOML value. This is used when computed configuration needs to be written back into the TOML-shaped configuration tree.

**Data flow**: It receives any value that can be serialized. It asks the TOML library to convert that value into a `TomlValue`. If that conversion fails, it wraps the failure in a requirements composition error.

**Call relations**: `materialize_remote_sandbox_config` calls this when inserting computed `allowed_sandbox_modes` into regular TOML. It is the small bridge between structured Rust requirements data and the generic TOML representation.

*Call graph*: called by 1 (materialize_remote_sandbox_config); 1 external calls (try_from).


##### `strip_special_fields`  (lines 169–173)

```
fn strip_special_fields(layer_toml: &mut TomlValue)
```

**Purpose**: Removes requirement-only fields from the regular TOML tree. This prevents fields that need special merge rules from also being merged like ordinary settings.

**Data flow**: It receives mutable TOML. It removes the top-level `rules` and `hooks` fields, then removes the nested `permissions.filesystem.deny_read` field and prunes any empty parent tables left behind. The same TOML value comes out cleaner, with special fields stripped away.

**Call relations**: `ComposableRequirementsLayer::from_entry` calls this after sandbox materialization. It delegates simple top-level removal to `remove_top_level_field` and nested cleanup to `remove_nested_field_and_prune_empty`.

*Call graph*: calls 2 internal fn (remove_nested_field_and_prune_empty, remove_top_level_field); called by 1 (from_entry).


##### `remove_top_level_field`  (lines 175–177)

```
fn remove_top_level_field(value: &mut TomlValue, key: &str) -> Option<TomlValue>
```

**Purpose**: Removes one named field from the top level of a TOML table. It is a small helper for cleaning configuration without caring whether the field was present.

**Data flow**: It receives a mutable TOML value and a key name. If the TOML value is a table, it removes that key and returns the removed value. If the TOML is not a table or the key is missing, it returns nothing.

**Call relations**: `materialize_remote_sandbox_config` uses this to remove `remote_sandbox_config`, and `strip_special_fields` uses it to remove `rules` and `hooks`. It keeps those callers focused on policy instead of table-editing details.

*Call graph*: called by 2 (materialize_remote_sandbox_config, strip_special_fields); 1 external calls (as_table_mut).


##### `remove_nested_field_and_prune_empty`  (lines 179–197)

```
fn remove_nested_field_and_prune_empty(value: &mut TomlValue, path: &[&str]) -> Option<TomlValue>
```

**Purpose**: Removes a field buried inside nested TOML tables, then deletes any parent tables that become empty. This keeps the configuration tree tidy after removing a deeply nested special field.

**Data flow**: It receives a mutable TOML value and a path such as `permissions → filesystem → deny_read`. It walks down the tables one key at a time, removes the final field, then walks back up and removes empty tables left behind. It returns the removed value if one was found.

**Call relations**: `strip_special_fields` calls this for the nested denied-read permission. This matters because removing only the leaf field could leave empty `permissions` or `filesystem` tables that look meaningful but contain nothing.

*Call graph*: called by 1 (strip_special_fields); 1 external calls (as_table_mut).


### Field-specific merge policies
These files implement the special per-field composition rules that override ordinary TOML merging when stacking requirement layers.

### `config/src/requirements_layers/permissions.rs`

`config` · `config load`

Most configuration values follow a normal “later layer wins” rule, like putting a newer note on top of an older one. This file exists because one permission setting should not work that way: `permissions.filesystem.deny_read`. That setting lists filesystem patterns the program is not allowed to read, and each requirements layer is meant to add to the list rather than erase earlier restrictions.

`DenyReadMergeState` is a small temporary collector used while requirement layers are being merged. As each layer is inspected, it looks for a non-empty `deny_read` list. Any pattern that is not already present is added to the collector. The collector also remembers where those patterns came from, using a source value that can become a combined source if multiple layers contributed.

After all relevant layers have been checked, the collected deny-read patterns are applied back into the final permissions requirements. If there was no permissions section yet, this file creates one containing only the collected filesystem deny-read list. If permissions already exist, it adds the missing patterns without duplicating entries. This keeps deny-read rules intentionally additive while leaving other permissions content, such as profile tables, to follow the project’s normal configuration precedence rules.

#### Function details

##### `DenyReadMergeState::merge`  (lines 20–39)

```
fn merge(
        &mut self,
        incoming: Option<PermissionsRequirementsToml>,
        source: &RequirementSource,
    )
```

**Purpose**: This function reads one incoming permissions layer and adds its filesystem deny-read patterns to the temporary collector. It ignores missing, empty, or duplicate entries so the final list stays clean.

**Data flow**: It receives an optional permissions block and the source that block came from. It looks inside the permissions block for `filesystem.deny_read`; if that list exists and has items, it checks each pattern against the collector’s current list. New patterns are stored, and the collector’s remembered source is updated to include the layer that contributed them. Nothing is returned; the collector is changed in place.

**Call relations**: During layered configuration merging, this is called for each permissions layer that might contribute deny-read rules. When it accepts a new pattern, it calls `DenyReadMergeState::merge_source` so the final output can still explain which requirement source or sources produced the collected restrictions.

*Call graph*: calls 1 internal fn (merge_source).


##### `DenyReadMergeState::apply_to`  (lines 41–73)

```
fn apply_to(self, target: &mut Option<Sourced<PermissionsRequirementsToml>>)
```

**Purpose**: This function writes the collected deny-read patterns into the final permissions requirements. It is the step that turns the temporary collector into actual configuration output.

**Data flow**: It takes ownership of the collected state and receives the final permissions target to update. If no patterns were collected, it leaves the target unchanged. If the target is empty, it creates a new sourced permissions value containing a filesystem deny-read list. If the target already exists, it ensures there is a filesystem section and deny-read list, appends any missing collected patterns, and combines source information when needed. The target is changed in place.

**Call relations**: After all layers have been scanned with `DenyReadMergeState::merge`, the merge process calls this function to fold the accumulated deny-read rules into the normal permissions result. It uses `Sourced::new` when it must create a fresh permissions block, and `RequirementSource::composite` when the final value needs to record that it came from more than one source.

*Call graph*: calls 2 internal fn (composite, new); 1 external calls (default).


##### `DenyReadMergeState::merge_source`  (lines 75–81)

```
fn merge_source(&mut self, source: &RequirementSource)
```

**Purpose**: This helper updates the collector’s record of where its deny-read patterns came from. It keeps a single source when possible, and combines sources when several layers contribute rules.

**Data flow**: It receives a source from the current layer. If the collector has no source yet, it stores a clone of that source. If a source is already stored, it merges the new one into the existing source value. It returns nothing; it only updates the collector’s source field.

**Call relations**: This helper is called by `DenyReadMergeState::merge` whenever a new deny-read pattern is accepted. It delegates the actual source-combining behavior to `merge_output_source`, keeping `merge` focused on collecting patterns while this function keeps the provenance information accurate.

*Call graph*: calls 1 internal fn (merge_output_source); called by 1 (merge); 1 external calls (clone).


### `config/src/requirements_layers/hooks.rs`

`domain_logic` · `config load`

Requirement layers are like stacked instruction sheets: each layer can add rules, and the system must turn the stack into one clear result. This file handles the hook part of that process. Hooks are commands or actions that run at certain moments, such as before a tool is used or when a session starts.

Most hook events are append-only. That means if one layer says “run this before tool use” and another layer adds another event, both are kept, in order. The managed hook directory is different. Only one directory can actually be used on a given operating system, so two different values for the active platform are treated as a conflict. This is a fail-safe choice: if two layers disagree about where trusted managed hooks live, the system refuses to silently pick one.

There are two directory fields: one for normal platforms and one for Windows. The active platform’s field must not conflict. The inactive platform’s field is allowed to be filled only if it was empty, so the same configuration stack can carry both Unix-like and Windows paths without breaking on the current machine.

The file also tracks where each directory value came from. If a conflict happens, the error can point back to the layers that disagreed, which makes configuration problems much easier to understand.

#### Function details

##### `HookDirectoryField::current_platform`  (lines 25–31)

```
fn current_platform() -> Self
```

**Purpose**: Chooses which hook directory field matters for the machine currently running the program. On Windows it selects the Windows-specific field; everywhere else it selects the normal managed directory field.

**Data flow**: It reads the compile-time platform check for Windows → turns that into the matching HookDirectoryField value → returns the field that should be treated as active for this run.

**Call relations**: Higher-level requirement composition code calls this when it starts combining layers for a host. The result tells HookMergeState which directory field must be checked strictly for conflicts.

*Call graph*: called by 2 (compose_requirements_for_hostname, compose_requirements_with_hostname_resolver); 1 external calls (cfg!).


##### `HookDirectoryField::field_name`  (lines 33–38)

```
fn field_name(self) -> &'static str
```

**Purpose**: Turns a hook directory field into the human-readable configuration name used in error messages. This helps users see exactly which setting caused a problem.

**Data flow**: It receives a HookDirectoryField value → matches it to its configuration key text → returns a string such as hooks.managed_dir or hooks.windows_managed_dir.

**Call relations**: When merge_active_singleton finds two different active directory values, it calls this so the conflict error can name the exact field that disagreed.

*Call graph*: called by 1 (merge_active_singleton).


##### `HookDirectoryField::inactive`  (lines 40–45)

```
fn inactive(self) -> Self
```

**Purpose**: Finds the opposite directory field from the active one. If the active field is the normal managed directory, the inactive one is the Windows directory, and vice versa.

**Data flow**: It receives one HookDirectoryField value → switches to the other variant → returns that opposite field.

**Call relations**: HookMergeState::merge uses this while combining layers so it can apply different rules to the active platform field and the inactive platform field.


##### `HookMergeState::new`  (lines 54–59)

```
fn new(directory_field: HookDirectoryField) -> Self
```

**Purpose**: Creates the small piece of working state needed while hook requirements are being merged. It remembers which directory field is active and prepares an empty record of where directory values came from.

**Data flow**: It receives the active HookDirectoryField → stores it as the field to enforce strictly → creates an empty map for source tracking → returns a ready-to-use HookMergeState.

**Call relations**: The broader compose process creates this state before it starts walking through requirement layers. Later, each layer is fed into HookMergeState::merge.

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

**Purpose**: Combines one incoming hook configuration layer into the accumulated hook configuration. It appends hook events, fills missing directory values, and rejects conflicting active-platform hook directories.

**Data flow**: It receives the current combined target, an optional incoming hook configuration, and the source of that incoming layer → ignores empty incoming data → if this is the first real hook data, stores it and records where directory values came from → otherwise separates active and inactive directory fields, checks the active one for conflicts, fills the inactive one only if missing, appends all hook event lists, and updates the combined source if anything changed → returns success or a composition error.

**Call relations**: This is the central function in the file. The composition pipeline calls it once per relevant requirements layer. Inside, it delegates small jobs to track_singleton_source, merge_active_singleton, fill_singleton, take_hook_dir, hook_dir_mut, append_hook_events, and merge_output_source so each merge rule stays clear.

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

**Purpose**: Records which requirements source first supplied a hook directory value. This matters because later conflicts should explain where the existing value came from.

**Data flow**: It receives a directory field, a possible path value, and the source layer → if the path is present and no source has been recorded for that field yet, it stores a copy of the source → it returns nothing but updates the merge state.

**Call relations**: HookMergeState::merge calls this when the first hook configuration becomes the target. That first pass establishes source history before later layers are compared against it.

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

**Purpose**: Applies the strict merge rule for the hook directory used on the current platform. A missing value can be filled, a repeated identical value is fine, but a different value is an error.

**Data flow**: It receives the field being checked, the existing path slot, a possible incoming path, and the incoming source → if there is no incoming path, nothing changes → if an existing different path is present, it builds a conflict error naming both sources and both paths → if the existing path matches, nothing changes → if the existing slot is empty, it stores the incoming path and records its source → returns whether the target changed, or an error.

**Call relations**: HookMergeState::merge calls this for the active platform’s directory field. If this function reports a conflict, the whole requirements composition stops instead of silently choosing an unsafe directory.

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

**Purpose**: Applies the softer merge rule for the inactive platform’s hook directory. It fills the field only if it is currently empty, and it does not treat later different values as conflicts.

**Data flow**: It receives the field, the existing path slot, a possible incoming path, and the source → if the existing slot is empty and the incoming path exists, it stores that path and records its source → otherwise it leaves the existing value alone → returns true if it filled the slot, false otherwise.

**Call relations**: HookMergeState::merge calls this for the platform directory that is not active on the current machine. This lets a shared stack carry paths for another operating system without causing unnecessary failures.

*Call graph*: called by 1 (merge).


##### `take_hook_dir`  (lines 183–191)

```
fn take_hook_dir(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> Option<PathBuf>
```

**Purpose**: Removes and returns one chosen hook directory path from a hook requirements object. This lets the merge code deal with the active and inactive directory fields separately.

**Data flow**: It receives a mutable hook requirements object and a field choice → takes the path out of the matching field, leaving that field empty in the object → returns the removed path if one was present.

**Call relations**: HookMergeState::merge calls this before applying the two different directory merge rules. After the paths are taken out, the remaining hook event data can be appended without accidentally reprocessing the directories.

*Call graph*: called by 1 (merge).


##### `hook_dir_mut`  (lines 193–201)

```
fn hook_dir_mut(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> &mut Option<PathBuf>
```

**Purpose**: Finds the editable slot for one chosen hook directory field inside a hook requirements object. It gives the merge code a direct place to read or write that path.

**Data flow**: It receives a mutable hook requirements object and a field choice → selects either managed_dir or windows_managed_dir → returns a mutable reference to that optional path slot.

**Call relations**: HookMergeState::merge uses this when passing the existing target directory slot into merge_active_singleton or fill_singleton. It is the small adapter between a field name choice and the actual stored value.

*Call graph*: called by 1 (merge).


##### `append_hook_events`  (lines 203–231)

```
fn append_hook_events(existing: &mut HookEventsToml, incoming: HookEventsToml) -> bool
```

**Purpose**: Adds all incoming hook event lists to the existing hook event lists. It keeps every event rather than replacing earlier ones.

**Data flow**: It receives the existing hook events and a full incoming hook events object → breaks the incoming object into each event category → appends each incoming list onto the matching existing list → returns true if any list added at least one event.

**Call relations**: HookMergeState::merge calls this after directory fields have been handled. This function then calls append_vec for each event category, making the append-only rule explicit for every supported hook event.

*Call graph*: calls 1 internal fn (append_vec); called by 1 (merge).


##### `append_vec`  (lines 233–237)

```
fn append_vec(existing: &mut Vec<T>, mut incoming: Vec<T>) -> bool
```

**Purpose**: Appends one list of items to another and reports whether anything was added. It is a small helper used to avoid repeating the same list-append pattern.

**Data flow**: It receives an existing list and an incoming list → checks whether the incoming list is empty → moves all incoming items onto the end of the existing list → returns true if the incoming list had items, false if it was empty.

**Call relations**: append_hook_events calls this once for each hook event category. It provides the simple building block that makes hook event merging append-only.

*Call graph*: called by 1 (append_hook_events).


### `config/src/requirements_layers/rules.rs`

`config` · `config load`

This file solves a small but important configuration problem: the system can receive requirement execution rules from more than one place, or “layer.” A layer might be a project setting, a user setting, or some other source of configuration. These rules are additive, meaning a new layer does not erase the old rules. Instead, its rules are added to the list.

The order matters. Higher-priority rules are appended first, so when all layers are combined, a reader can still see which rules came from the more important sources. Think of it like stacking sticky notes on a checklist: the most important notes are placed at the top first, and later notes are added underneath.

The main work happens in `merge`. If the incoming layer has no requirement policy, nothing changes. If this is the first policy seen, it becomes the target policy and is tagged with where it came from. If there is already a policy, the new prefix rules are added to the existing list, and the recorded source information is updated so the final configuration remembers that more than one source contributed to it.

#### Function details

##### `merge`  (lines 10–26)

```
fn merge(
    target: &mut Option<Sourced<RequirementsExecPolicyToml>>,
    incoming: Option<RequirementsExecPolicyToml>,
    source: &RequirementSource,
)
```

**Purpose**: This function folds one incoming requirements policy into the combined policy being built. It preserves the rule order by adding the incoming prefix rules to the end of the existing list, and it keeps track of which configuration source contributed the rules.

**Data flow**: It receives a mutable target policy, an optional incoming policy, and the source that the incoming policy came from. If there is no incoming policy, it leaves the target unchanged. If the target is empty, it stores the incoming policy there and labels it with the source. If the target already has rules, it appends the incoming rules to the existing rules and updates the stored source information to include the new contributor.

**Call relations**: During configuration composition, `compose` calls this function when it is combining requirement-rule layers. When the first policy is stored, this function creates a sourced value so the policy is tied to its origin. When another layer contributes rules, it hands the source-tracking update to `merge_output_source`, so the final combined policy can still explain where its contents came from.

*Call graph*: calls 2 internal fn (new, merge_output_source); called by 1 (compose); 1 external calls (clone).


### Stack assembly and downstream hook state
These files assemble the full layered requirements result and then derive effective hook-related persisted state from the resulting configuration stack.

### `config/src/requirements_layers/stack.rs`

`domain_logic` · `config load`

A project can receive requirements from several places, such as defaults, user settings, or higher-priority policy files. This file is the assembly line that turns those layers into one usable requirements object, while preserving where each final value came from. Without it, later policy layers might not correctly override earlier ones, and special fields like hooks, rule prefixes, or denied file reads could be merged in an unsafe or misleading way.

The main flow starts with a list of requirement layers ordered from lowest priority to highest priority. Each layer is first converted into a form that separates ordinary TOML settings from fields that need custom rules. TOML is a configuration file format made of tables, lists, and values. Ordinary fields are merged like normal config: low-priority layers provide defaults, and higher-priority layers replace simple values while extending tables.

Some fields are treated differently. Rules and hooks are processed from highest priority back down so the final output keeps the most important entries first. Denied file reads are combined as a union, so restrictions are not accidentally lost. The file also records the source of each setting, sometimes as a composite source when a table was built from more than one layer. If the final requirements are empty, it returns no requirements at all.

#### Function details

##### `Error::from`  (lines 53–55)

```
fn from(error: RequirementsCompositionError) -> Self
```

**Purpose**: Turns a requirements-composition error into a standard input/output error. This lets code that expects ordinary I/O-style failures still report bad requirements data cleanly.

**Data flow**: It receives a detailed requirements error, wraps it as an invalid-data I/O error, and returns that new error. The original explanation is kept inside the wrapper so it can still be shown to a user or caller.

**Call relations**: This is the bridge from this file’s custom error type to Rust’s common I/O error type. It uses the standard error-construction call so callers outside this requirements code can treat malformed requirements like other bad data read from configuration.

*Call graph*: 1 external calls (new).


##### `compose_requirements`  (lines 58–62)

```
fn compose_requirements(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError>
```

**Purpose**: This is the normal public entry point for combining requirement layers. Callers use it when they want the final requirements for the current machine.

**Data flow**: It takes an ordered set of requirement layer entries, supplies the project’s normal hostname lookup, and passes both into the deeper composition routine. It returns either a finished requirements object with source information, no object if everything was empty, or a composition error.

**Call relations**: This function starts the standard composition path. It hands the work to compose_requirements_with_hostname_resolver, which adds the default hostname behavior before the stack is built and merged.

*Call graph*: calls 1 internal fn (compose_requirements_with_hostname_resolver).


##### `compose_requirements_for_hostname`  (lines 65–75)

```
fn compose_requirements_for_hostname(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositi
```

**Purpose**: Provides a test-only way to compose requirements as if the machine had a specific hostname. This makes hostname-dependent requirements predictable in tests.

**Data flow**: It receives layers and an optional hostname string, stores that hostname in a small closure, chooses the current platform’s hook-directory field, and runs the full composition flow. The result is the same kind of final requirements object or error as the normal path.

**Call relations**: Tests call this instead of the production entry point when they need to control hostname matching. It calls the shared composition routine directly, using HookDirectoryField::current_platform for the hook directory choice.

*Call graph*: calls 2 internal fn (current_platform, compose_requirements_with_hostname_resolver_and_hook_directory).


##### `compose_requirements_for_hostname_and_hook_directory`  (lines 78–89)

```
fn compose_requirements_for_hostname_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
    hook_directory_field: HookDirectoryField,
) -> Re
```

**Purpose**: Provides an even more controlled test-only composition path. It lets tests choose both the hostname and which hook-directory field should be treated as active.

**Data flow**: It receives layers, an optional hostname, and a hook-directory selector. It turns the hostname into a reusable closure and sends all of that to the shared composition routine. The output is the final composed requirements, no requirements, or an error.

**Call relations**: Tests use this when they need to check behavior that depends on both hostname and hook-directory platform rules. It goes straight to compose_requirements_with_hostname_resolver_and_hook_directory so no production defaults get in the way.

*Call graph*: calls 1 internal fn (compose_requirements_with_hostname_resolver_and_hook_directory).


##### `compose_requirements_with_hostname_resolver`  (lines 91–100)

```
fn compose_requirements_with_hostname_resolver(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
) -> Result<Option<ConfigRequirementsW
```

**Purpose**: Adds the normal hook-directory choice to a composition run where the hostname lookup has been supplied by the caller. This is useful when the caller wants custom hostname lookup but not custom hook-directory behavior.

**Data flow**: It receives layers and a hostname-resolving function. It chooses the current platform’s hook-directory field and forwards everything to the most detailed composition routine. The result is whatever that routine produces.

**Call relations**: compose_requirements calls this in the production path. This function then calls compose_requirements_with_hostname_resolver_and_hook_directory, filling in the platform-specific hook-directory default.

*Call graph*: calls 2 internal fn (current_platform, compose_requirements_with_hostname_resolver_and_hook_directory); called by 1 (compose_requirements).


##### `compose_requirements_with_hostname_resolver_and_hook_directory`  (lines 102–116)

```
fn compose_requirements_with_hostname_resolver_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
    hook_directory_
```

**Purpose**: Runs the full composition process with all environment choices supplied: the layers, hostname lookup, and hook-directory platform field. This is the shared core used by both production and tests.

**Data flow**: It receives requirement layers, a function that can find the hostname, and a hook-directory selector. It wraps the hostname lookup in a one-time cache so all layers see the same hostname and the lookup only happens if needed. Then it creates a RequirementsLayerStack, adds each parsed layer to it, and asks the stack to compose the final result.

**Call relations**: This is called by the production helper and by the test helpers. It creates the stack with RequirementsLayerStack::new, feeds it layers, and then moves into the stack’s compose step for the actual merging.

*Call graph*: calls 1 internal fn (new); called by 3 (compose_requirements_for_hostname, compose_requirements_for_hostname_and_hook_directory, compose_requirements_with_hostname_resolver); 1 external calls (new).


##### `RequirementsLayerStack::new`  (lines 124–129)

```
fn new(hook_directory_field: HookDirectoryField) -> Self
```

**Purpose**: Creates an empty stack that is ready to receive requirement layers. The stack remembers which hook-directory field applies to this platform or test scenario.

**Data flow**: It receives a hook-directory field, creates an empty list of composable layers, stores both pieces, and returns the new stack. Nothing is merged yet.

**Call relations**: The shared composition routine calls this before adding layers. It is the starting container for the later add-layer and compose steps.

*Call graph*: called by 1 (compose_requirements_with_hostname_resolver_and_hook_directory); 1 external calls (new).


##### `RequirementsLayerStack::add_layer`  (lines 131–141)

```
fn add_layer(
        &mut self,
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<(), RequirementsCompositionError>
```

**Purpose**: Adds one raw requirement layer to the stack after converting it into the form needed for composition. This is where per-layer parsing and hostname-sensitive evaluation happen.

**Data flow**: It receives a layer entry and a hostname resolver. It converts the entry with ComposableRequirementsLayer::from_entry, which can fail if the layer cannot be parsed or evaluated. On success, it appends the converted layer to the stack and returns success.

**Call relations**: The shared composition routine calls this for each incoming layer before final merging. It hands off parsing and layer preparation to ComposableRequirementsLayer::from_entry so the stack only stores layers that are ready to merge.

*Call graph*: calls 1 internal fn (from_entry).


##### `RequirementsLayerStack::compose`  (lines 143–187)

```
fn compose(
        self,
    ) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError>
```

**Purpose**: Combines all prepared layers into the final requirements object. It applies ordinary config merging first, then applies special rules for fields that cannot safely be merged as plain TOML.

**Data flow**: It starts with an empty TOML table and folds in each layer’s ordinary TOML from low priority to high priority. It parses that merged TOML into the requirements type, copies regular fields into the output along with source information, then processes special fields from high priority to low priority: rules, hooks, and denied file reads. Finally it returns no value if the output is empty, or the completed requirements with sources if anything was set.

**Call relations**: This is the main work step after layers have been added to the stack. It uses merge_toml_values for normal TOML merging, calls populate_merged_regular_fields_with_sources to attach source information, and then delegates special merging to the rules, hooks, and deny-read merger helpers.

*Call graph*: calls 4 internal fn (merge_toml_values, new, merge, populate_merged_regular_fields_with_sources); 4 external calls (Table, default, default, new).


##### `populate_merged_regular_fields_with_sources`  (lines 190–266)

```
fn populate_merged_regular_fields_with_sources(
    output: &mut ConfigRequirementsWithSources,
    requirements: ConfigRequirementsToml,
    layers: &[ComposableRequirementsLayer],
)
```

**Purpose**: Copies the normally merged requirements fields into the final output and records where each value came from. This gives users and diagnostics a way to explain which layer supplied a setting.

**Data flow**: It receives the output object, the parsed merged requirements, and the prepared layers. For each regular field that is present, it wraps the value in a Sourced object containing both the value and the source found by source_for_top_level_keys. It intentionally skips fields that have special merge rules, and it ignores an empty guardian policy string.

**Call relations**: RequirementsLayerStack::compose calls this after ordinary TOML has been merged and parsed. This function repeatedly asks source_for_top_level_keys to identify the winning or composite source for each top-level setting.

*Call graph*: calls 2 internal fn (new, source_for_top_level_keys); called by 1 (compose); 1 external calls (set_sourced!).


##### `source_for_top_level_keys`  (lines 268–297)

```
fn source_for_top_level_keys(
    layers: &[ComposableRequirementsLayer],
    keys: &[&str],
) -> RequirementSource
```

**Purpose**: Finds which requirement source should be credited for a top-level field in the merged output. For tables, it can report a combined source when several layers contributed pieces.

**Data flow**: It receives the prepared layers and one or more possible top-level key names. It scans layers for that field, keeps the last matching layer as the winner for simple values, and returns Unknown if no layer had the field. If the winning value is a table and multiple layers contributed tables, it returns a composite source made from those layers.

**Call relations**: populate_merged_regular_fields_with_sources calls this whenever it wraps a regular value with source information. It uses top_level_value_for_keys to look inside each layer’s TOML table.

*Call graph*: calls 1 internal fn (composite); called by 1 (populate_merged_regular_fields_with_sources); 1 external calls (iter).


##### `top_level_value_for_keys`  (lines 299–302)

```
fn top_level_value_for_keys(value: &'a TomlValue, keys: &[&str]) -> Option<&'a TomlValue>
```

**Purpose**: Looks for one of several possible names at the top level of a TOML value. This supports fields that may have more than one accepted key name.

**Data flow**: It receives a TOML value and a list of key names. If the value is a table, it checks those names and returns the first matching value it finds; if the value is not a table or none of the keys exist, it returns nothing.

**Call relations**: source_for_top_level_keys relies on this small lookup helper while scanning every layer. It uses the TOML table view provided by as_table before checking keys.

*Call graph*: 1 external calls (as_table).


##### `merge_output_source`  (lines 304–308)

```
fn merge_output_source(existing: &mut RequirementSource, incoming: &RequirementSource)
```

**Purpose**: Combines source labels when one output value has been built from more than one requirement layer. This prevents later merging from hiding the fact that multiple files contributed.

**Data flow**: It receives a mutable existing source and an incoming source. If they are different, it replaces the existing source with a composite source containing both; if they are the same, it leaves the source unchanged.

**Call relations**: Special merge code elsewhere calls this while combining fields such as hooks, permissions, or other domain-specific outputs. It delegates to RequirementSource::composite to build the combined source label.

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

**Purpose**: Creates a clear conflict error when two requirement layers cannot be safely combined. It packages the field name, both sources, and a human-readable explanation.

**Data flow**: It receives the conflicting field name, the existing source, the incoming source, and an error message. It turns the message into a string and returns a RequirementsCompositionError::Conflict containing all of that context.

**Call relations**: Special merge logic calls this when it detects an unsafe conflict, such as an active singleton value that cannot have two competing definitions. The returned error travels back through the composition flow so loading can fail closed instead of silently choosing a risky result.

*Call graph*: called by 1 (merge_active_singleton); 1 external calls (into).


### `hooks/src/config_rules.rs`

`config` · `config load and hook discovery`

Hooks are pieces of behavior that can run at certain moments, such as before a tool is used. The system needs to remember user choices about those hooks, for example whether a hook is enabled or whether a particular hook file hash has been trusted. This file builds that “effective” hook state from the layered configuration stack.

A configuration stack is like a pile of notes where later notes can override earlier ones. This file reads the pile from lowest priority to highest priority, but it only listens to two kinds of notes: the user’s own configuration and session flags passed for the current run. That matters because project or plugin configuration may be allowed to discover hooks, but it must not silently change whether the user has enabled or trusted them.

For each allowed layer, it looks under `hooks.state`. If that section is missing, malformed, or contains bad entries, it skips the bad parts instead of failing the whole process. When the same hook appears in multiple layers, later layers win one field at a time. So a later setting can update only `trusted_hash` without accidentally deleting an earlier `enabled` choice. The tests check these safety rules: precedence, field-by-field merging, and ignoring malformed hook-related data.

#### Function details

##### `hook_states_from_stack`  (lines 16–70)

```
fn hook_states_from_stack(
    config_layer_stack: Option<&ConfigLayerStack>,
) -> HashMap<String, HookStateToml>
```

**Purpose**: Builds the final saved state for hooks from the configuration layers that are allowed to affect user preferences. It returns a map from each hook’s unique key to its remembered settings, such as whether it is enabled or which hash is trusted.

**Data flow**: It receives an optional configuration layer stack. If there is no stack, it returns an empty map. Otherwise, it walks through the layers from lowest priority to highest priority, reads only user and session-flag layers, looks for `hooks.state`, converts each valid entry into hook state, trims and checks the hook key, and merges fields into the output map. The result is a clean set of effective hook states, with later allowed layers overriding earlier ones only for the fields they actually provide.

**Call relations**: During hook discovery, `discover_handlers` calls this function to learn what the user or current session has already said about hooks. This function does not discover hooks itself; it supplies the trusted and enabled state that discovery can apply when deciding how hooks should behave.

*Call graph*: called by 1 (discover_handlers); 2 external calls (new, matches!).


##### `tests::hook_states_from_stack_respects_layer_precedence`  (lines 83–114)

```
fn hook_states_from_stack_respects_layer_precedence()
```

**Purpose**: Checks that a higher-priority layer can override a lower-priority layer for the same hook. In plain terms, it verifies that a session choice can beat an older saved user choice.

**Data flow**: The test builds a stack with two layers for the same hook key: a user layer saying the hook is disabled, and a session-flags layer saying it is enabled. It runs `hook_states_from_stack` and compares the result with the expected map. The expected outcome is that the hook ends up enabled.

**Call relations**: This test exercises the main function in the situation where two allowed layers disagree. It proves that the layer ordering used by `hook_states_from_stack` gives the later, higher-priority layer the final say.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::hook_states_from_stack_merges_fields_across_layers`  (lines 117–160)

```
fn hook_states_from_stack_merges_fields_across_layers()
```

**Purpose**: Checks that hook state is merged one field at a time instead of replacing the whole record. This prevents a later partial update from erasing an earlier setting.

**Data flow**: The test creates a user layer that sets `enabled` and a session-flags layer that sets only `trusted_hash` for the same hook. It passes the stack into `hook_states_from_stack` and expects the final result to contain both pieces of information. The output should keep the earlier enabled value and add the later trusted hash.

**Call relations**: This test focuses on the merge behavior inside `hook_states_from_stack`. It shows why the function updates individual fields rather than overwriting the entire hook state each time it sees the same key.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, assert_eq!, vec!).


##### `tests::hook_states_from_stack_ignores_malformed_hook_events`  (lines 163–199)

```
fn hook_states_from_stack_ignores_malformed_hook_events()
```

**Purpose**: Checks that unrelated or malformed hook event configuration does not prevent valid hook state from being read. This makes the configuration reader tolerant of bad data outside the `hooks.state` section.

**Data flow**: The test builds a configuration where `hooks.state` contains a valid saved state, while another hook-related entry has the wrong shape. It creates a stack from that configuration, runs `hook_states_from_stack`, and expects the valid state to be returned. The malformed event entry is ignored.

**Call relations**: This test supports the main function’s narrow focus: it only reads saved hook state, not the full hook event configuration. It confirms that bad event definitions do not interfere with state loading.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, from_value, json!, vec!).


##### `tests::hook_states_from_stack_ignores_malformed_state_entries`  (lines 202–240)

```
fn hook_states_from_stack_ignores_malformed_state_entries()
```

**Purpose**: Checks that one bad saved-state entry does not spoil all the good ones. This helps the system recover gracefully if a config file contains a typo or wrong value type.

**Data flow**: The test creates a `hooks.state` table with one valid hook entry and one malformed entry whose `enabled` value is not a true-or-false value. It runs `hook_states_from_stack` and expects only the valid hook state to appear in the result. The malformed entry is skipped.

**Call relations**: This test verifies the error-tolerant path inside `hook_states_from_stack`. It shows that the function treats each saved hook entry separately, so a single bad entry does not block hook discovery from using the rest.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, from_value, json!, vec!).


##### `tests::config_with_hook_override`  (lines 242–250)

```
fn config_with_hook_override(key: &str, enabled: Option<bool>) -> TomlValue
```

**Purpose**: Creates a small test configuration for a hook with just an `enabled` setting. It is a convenience helper so the tests can describe their intent without repeating setup details.

**Data flow**: It receives a hook key and an optional true-or-false enabled value. It wraps that value in a `HookStateToml` structure with no trusted hash, then passes it to `tests::config_with_hook_state`. The output is a TOML-like configuration value containing `hooks.state` for that hook.

**Call relations**: The precedence test uses this helper when it only needs to vary whether a hook is enabled. The helper then hands off to `tests::config_with_hook_state`, which does the actual conversion into the configuration shape used by the main function.

*Call graph*: 1 external calls (config_with_hook_state).


##### `tests::config_with_hook_state`  (lines 252–262)

```
fn config_with_hook_state(key: &str, state: HookStateToml) -> TomlValue
```

**Purpose**: Builds a small TOML-like configuration value containing one hook state entry. It keeps the tests short and ensures they all create configuration data in the same shape.

**Data flow**: It receives a hook key and a `HookStateToml` value. It converts the hook state into a JSON-like value, places it under `hooks.state` using the given key, and converts that into the `TomlValue` format used by the configuration system. The result is a ready-to-use config layer value for tests.

**Call relations**: The tests and the simpler `tests::config_with_hook_override` helper rely on this function to create realistic config input. That input is then placed into config layers and passed to `hook_states_from_stack`.

*Call graph*: 3 external calls (from_value, json!, to_value).
