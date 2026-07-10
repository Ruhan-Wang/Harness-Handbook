# Managed proxying and local IPC transport substrates  `stage-19.3`

This stage is shared plumbing for talking safely to the outside world and to other programs on the same machine. It sits behind the scenes, supporting the main work of the system. One part decides what proxy rules really apply after mixing user choices with company or policy restrictions, then starts or updates the live proxy process. The proxy can inspect web traffic when needed: it manages its own trusted certificate setup, unwraps encrypted HTTPS traffic, applies host-specific header rewrite hooks, checks whether outgoing connections are allowed, forwards approved traffic directly or through another upstream proxy, and produces clear blocked messages when a request is denied.

The other part is about local IPC, meaning inter-process communication: private channels between programs on one computer. A cross-platform Unix-socket layer gives one simple API on Unix and Windows. The shell-escalation socket code can send JSON messages plus file handles, which is useful when a higher-privilege helper is involved. Sandbox proxy routing builds bridges so isolated Linux programs can still reach the managed proxy safely. Finally, the IDE IPC code uses Windows named pipes or platform-specific local channels to fetch context from an IDE, with timeouts and identity checks for safety.

## Files in this stage

### Managed proxy configuration
These files define the effective managed proxy policy and the hook rules that shape how proxy enforcement should behave at runtime.

### `core/src/config/network_proxy_spec.rs`

`domain_logic` · `request handling and process/tool startup when managed network proxying is enabled`

This module defines `NetworkProxySpec`, the immutable runtime description of a managed network proxy, plus `StartedNetworkProxy` for a running instance and `StaticNetworkProxyReloader` for supplying a fixed config state to the proxy runtime. The spec stores both the original `base_config` and the post-constraint `config`, the derived `NetworkProxyConstraints`, optional managed `NetworkConstraints`, and a `hard_deny_allowlist_misses` flag that changes approval behavior when managed-only allowlists are enforced.

The central constructor is `NetworkProxySpec::from_config_and_constraints`. It clones the incoming `NetworkProxyConfig`, detects whether requirements request `managed_allowed_domains_only`, applies requirements through `apply_requirements`, validates the resulting policy against the derived constraints, and returns a spec ready for runtime use. `apply_requirements` is where most policy shaping happens: it pins ports and booleans from requirements, merges or replaces allowed/denied domain lists depending on whether the current `PermissionProfile` counts as a managed sandbox, and converts managed unix-socket and local-binding rules into both effective config and constraint metadata.

At runtime, `start_proxy` builds a `NetworkProxyState` with audit metadata and a static reloader, then conditionally installs a policy decider. If network approval flow is enabled and allowlist misses are not hard-denied, it uses the supplied decider or, for managed sandboxes, a default `ask("not_allowed")` decision. The module also supports recomputing specs for a new permission profile, overlaying exec-policy network rules, and hot-updating a running proxy’s config state.

#### Function details

##### `StartedNetworkProxy::new`  (lines 38–43)

```
fn new(proxy: NetworkProxy, handle: NetworkProxyHandle) -> Self
```

**Purpose**: Wraps a built and running `NetworkProxy` together with its run handle into the module’s runtime holder type.

**Data flow**: It takes ownership of a `NetworkProxy` and `NetworkProxyHandle`, stores them in `StartedNetworkProxy`, and returns the new struct.

**Call relations**: It is called only after `NetworkProxySpec::start_proxy` has successfully built and started the proxy.

*Call graph*: called by 1 (start_proxy).


##### `StartedNetworkProxy::proxy`  (lines 45–47)

```
fn proxy(&self) -> NetworkProxy
```

**Purpose**: Returns a clone of the underlying `NetworkProxy` handle for further operations.

**Data flow**: It clones `self.proxy` and returns the cloned `NetworkProxy`.

**Call relations**: `NetworkProxySpec::apply_to_started_proxy` uses this accessor to replace the running proxy’s config state.

*Call graph*: called by 1 (apply_to_started_proxy); 1 external calls (clone).


##### `StaticNetworkProxyReloader::new`  (lines 56–58)

```
fn new(state: ConfigState) -> Self
```

**Purpose**: Constructs a fixed-state config reloader for a proxy state snapshot.

**Data flow**: It takes a `ConfigState`, stores it in the struct, and returns `StaticNetworkProxyReloader`.

**Call relations**: It is created inside `NetworkProxySpec::build_state_with_audit_metadata` so the proxy runtime has a reloader implementation even when config is static.

*Call graph*: called by 1 (build_state_with_audit_metadata).


##### `StaticNetworkProxyReloader::maybe_reload`  (lines 62–64)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements the optional reload check by always reporting that no incremental reload is available.

**Data flow**: It returns a pinned async future that resolves to `Ok(None)` and does not inspect or mutate state.

**Call relations**: This satisfies the `ConfigReloader` trait for the static reloader used by started proxies.

*Call graph*: 1 external calls (pin).


##### `StaticNetworkProxyReloader::reload_now`  (lines 66–68)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Implements forced reload by returning the stored config state snapshot.

**Data flow**: It clones `self.state`, wraps it in a pinned async future, and resolves to `Ok(cloned_state)`.

**Call relations**: The proxy runtime can call this trait method when it wants the current config state from the static reloader.

*Call graph*: 2 external calls (pin, clone).


##### `StaticNetworkProxyReloader::source_label`  (lines 70–72)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a human-readable source label for the static reloader implementation.

**Data flow**: It returns the fixed string `"StaticNetworkProxyReloader"` as a `String`.

**Call relations**: This is part of the `ConfigReloader` trait contract used by proxy diagnostics.


##### `NetworkProxySpec::enabled`  (lines 76–78)

```
fn enabled(&self) -> bool
```

**Purpose**: Reports whether the effective proxy config has network proxying enabled.

**Data flow**: It reads `self.config.network.enabled` and returns that boolean.

**Call relations**: Higher-level config code uses this to decide whether a built spec should be retained when no managed requirements force proxy presence.


##### `NetworkProxySpec::proxy_host_and_port`  (lines 80–82)

```
fn proxy_host_and_port(&self) -> String
```

**Purpose**: Returns the effective proxy listener host-and-port string derived from the configured proxy URL.

**Data flow**: It reads `self.config.network.proxy_url`, passes it to `host_and_port_from_network_addr` with default port `3128`, and returns the resulting string.

**Call relations**: Runtime code can use this to expose the proxy endpoint to child processes.

*Call graph*: 1 external calls (host_and_port_from_network_addr).


##### `NetworkProxySpec::socks_enabled`  (lines 84–86)

```
fn socks_enabled(&self) -> bool
```

**Purpose**: Reports whether SOCKS5 support is enabled in the effective proxy config.

**Data flow**: It reads and returns `self.config.network.enable_socks5`.

**Call relations**: This is a simple query used by callers that need to know whether SOCKS endpoints should be advertised.


##### `NetworkProxySpec::from_config_and_constraints`  (lines 88–120)

```
fn from_config_and_constraints(
        config: NetworkProxyConfig,
        requirements: Option<NetworkConstraints>,
        permission_profile: &PermissionProfile,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds a validated proxy spec from user config, optional managed network constraints, and the current permission profile.

**Data flow**: It clones the incoming `NetworkProxyConfig` into `base_config`, computes `hard_deny_allowlist_misses` from requirements, applies requirements when present to produce an effective `config` and `NetworkProxyConstraints`, validates the effective policy against those constraints, and returns a populated `NetworkProxySpec` or an `InvalidInput` error.

**Call relations**: This is the main constructor used by config loading and by spec recomputation when permission profiles change.

*Call graph*: called by 25 (build_network_proxy_spec, allow_only_requirements_do_not_create_deny_constraints_in_full_access, danger_full_access_keeps_managed_allowlist_and_denylist_fixed, deny_only_requirements_do_not_create_allow_constraints_in_full_access, managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list, managed_allowed_domains_only_disables_default_mode_allowlist_expansion, managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses, managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains, managed_unrestricted_profile_allows_domain_expansion, requirements_allowed_domains_are_a_baseline_for_user_allowlist (+15 more)); 4 external calls (apply_requirements, validate_policy_against_constraints, clone, default).


##### `NetworkProxySpec::start_proxy`  (lines 122–151)

```
async fn start_proxy(
        &self,
        permission_profile: &PermissionProfile,
        policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
        blocked_request_observer: Option<Arc<dyn Blo
```

**Purpose**: Starts a live managed network proxy from the spec, optionally wiring in approval and blocked-request observers.

**Data flow**: It builds a `NetworkProxyState` with audit metadata, creates a `NetworkProxy` builder with that state, conditionally installs a policy decider when approval flow is enabled and allowlist misses are not hard-denied, optionally installs a blocked-request observer, builds the proxy, runs it to obtain a handle, and returns `StartedNetworkProxy`. Build/run failures are mapped into `std::io::Error::other`.

**Call relations**: Managed network-proxy startup code calls this after it has chosen the effective permission profile and any approval observer hooks.

*Call graph*: calls 3 internal fn (build_state_with_audit_metadata, new, builder); called by 1 (start_managed_network_proxy); 2 external calls (new, managed_sandbox_active).


##### `NetworkProxySpec::recompute_for_permission_profile`  (lines 153–162)

```
fn recompute_for_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> std::io::Result<Self>
```

**Purpose**: Rebuilds the spec for a different permission profile while preserving the original base config and managed requirements.

**Data flow**: It clones `self.base_config` and `self.requirements`, passes them with the new `permission_profile` into `from_config_and_constraints`, and returns the new spec or validation error.

**Call relations**: This supports runtime permission-profile changes without losing the original configured proxy policy.

*Call graph*: 2 external calls (from_config_and_constraints, clone).


##### `NetworkProxySpec::with_exec_policy_network_rules`  (lines 164–177)

```
fn with_exec_policy_network_rules(
        &self,
        exec_policy: &Policy,
    ) -> std::io::Result<Self>
```

**Purpose**: Returns a cloned spec with exec-policy-derived domain allow/deny rules overlaid onto the effective proxy config.

**Data flow**: It clones `self` into `spec`, mutates `spec.config` via `apply_exec_policy_network_rules`, revalidates the resulting config against `spec.constraints`, and returns the updated spec or an `InvalidInput` error.

**Call relations**: Managed proxy startup code uses this when exec policy contributes additional network domain rules.

*Call graph*: calls 1 internal fn (apply_exec_policy_network_rules); called by 1 (start_managed_network_proxy); 1 external calls (validate_policy_against_constraints).


##### `NetworkProxySpec::apply_to_started_proxy`  (lines 179–191)

```
async fn apply_to_started_proxy(
        &self,
        started_proxy: &StartedNetworkProxy,
    ) -> std::io::Result<()>
```

**Purpose**: Hot-applies the spec’s current config state to an already running proxy instance.

**Data flow**: It builds a fresh `ConfigState` from the spec, obtains a cloned proxy handle from `started_proxy.proxy()`, calls `replace_config_state(state).await`, and maps failures into `std::io::Error::other`.

**Call relations**: This is used when runtime config changes require updating a live proxy without restarting it.

*Call graph*: calls 2 internal fn (build_config_state_for_spec, proxy).


##### `NetworkProxySpec::build_state_with_audit_metadata`  (lines 193–204)

```
fn build_state_with_audit_metadata(
        &self,
        audit_metadata: NetworkProxyAuditMetadata,
    ) -> std::io::Result<NetworkProxyState>
```

**Purpose**: Builds a `NetworkProxyState` that combines the spec’s config state, a static reloader, and audit metadata.

**Data flow**: It first builds a `ConfigState` from the spec, clones that state into a `StaticNetworkProxyReloader`, and returns `NetworkProxyState::with_reloader_and_audit_metadata(state, reloader, audit_metadata)`.

**Call relations**: It is called by `start_proxy` before constructing the runtime proxy builder.

*Call graph*: calls 3 internal fn (build_config_state_for_spec, new, with_reloader_and_audit_metadata); called by 1 (start_proxy); 1 external calls (new).


##### `NetworkProxySpec::build_config_state_for_spec`  (lines 206–210)

```
fn build_config_state_for_spec(&self) -> std::io::Result<ConfigState>
```

**Purpose**: Converts the spec’s effective config and constraints into the proxy library’s `ConfigState` representation.

**Data flow**: It clones `self.config` and `self.constraints`, passes them to `build_config_state`, and maps any failure into `std::io::Error::other` with context.

**Call relations**: Both proxy startup and live proxy updates depend on this conversion step.

*Call graph*: called by 2 (apply_to_started_proxy, build_state_with_audit_metadata); 3 external calls (build_config_state, clone, clone).


##### `NetworkProxySpec::apply_requirements`  (lines 212–318)

```
fn apply_requirements(
        mut config: NetworkProxyConfig,
        requirements: &NetworkConstraints,
        permission_profile: &PermissionProfile,
        hard_deny_allowlist_misses: bool,
```

**Purpose**: Applies managed network requirements to a mutable proxy config and derives the corresponding constraint set, with behavior that depends on the permission profile.

**Data flow**: It takes a `NetworkProxyConfig`, `NetworkConstraints`, `PermissionProfile`, and `hard_deny_allowlist_misses` flag. It computes whether allowlist and denylist expansion are enabled, then overlays requirement-controlled booleans, ports, upstream-proxy flags, unix-socket flags, local binding, and domain lists. Managed allowed/denied domains are either merged with user entries or replace them entirely depending on expansion rules, and the original managed lists are stored in `NetworkProxyConstraints`. It returns the mutated config plus the derived constraints.

**Call relations**: This is the policy-shaping core called only by `from_config_and_constraints`.

*Call graph*: 5 external calls (allowlist_expansion_enabled, denylist_expansion_enabled, merge_domain_lists, format!, default).


##### `NetworkProxySpec::allowlist_expansion_enabled`  (lines 320–325)

```
fn allowlist_expansion_enabled(
        permission_profile: &PermissionProfile,
        hard_deny_allowlist_misses: bool,
    ) -> bool
```

**Purpose**: Determines whether user allowlist entries may extend the managed allowlist baseline.

**Data flow**: It returns true only when `managed_sandbox_active(permission_profile)` is true and `hard_deny_allowlist_misses` is false.

**Call relations**: This helper is used inside `apply_requirements` when deciding whether to merge or replace allowed domains.

*Call graph*: 1 external calls (managed_sandbox_active).


##### `NetworkProxySpec::managed_allowed_domains_only`  (lines 327–329)

```
fn managed_allowed_domains_only(requirements: &NetworkConstraints) -> bool
```

**Purpose**: Reads the managed-only allowlist mode flag from network requirements.

**Data flow**: It returns `requirements.managed_allowed_domains_only.unwrap_or(false)`.

**Call relations**: The constructor uses this to decide whether allowlist misses should be hard-denied.


##### `NetworkProxySpec::denylist_expansion_enabled`  (lines 331–333)

```
fn denylist_expansion_enabled(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Determines whether user denylist entries may extend the managed denylist baseline.

**Data flow**: It returns the result of `managed_sandbox_active(permission_profile)`.

**Call relations**: This helper is used inside `apply_requirements` when deciding whether to merge or replace denied domains.

*Call graph*: 1 external calls (managed_sandbox_active).


##### `NetworkProxySpec::managed_sandbox_active`  (lines 335–337)

```
fn managed_sandbox_active(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Checks whether the permission profile represents a managed sandbox mode.

**Data flow**: It pattern-matches the profile and returns true only for `PermissionProfile::Managed { .. }`.

**Call relations**: This predicate drives allowlist/denylist mutability and default approval behavior in several methods.

*Call graph*: 1 external calls (matches!).


##### `NetworkProxySpec::merge_domain_lists`  (lines 339–349)

```
fn merge_domain_lists(mut managed: Vec<String>, user_entries: &[String]) -> Vec<String>
```

**Purpose**: Appends user domain entries to a managed domain list without duplicating entries case-insensitively.

**Data flow**: It takes an owned managed `Vec<String>` and a slice of user entries, iterates the user entries, and pushes each one only if no existing managed entry matches it ignoring ASCII case. It returns the merged vector.

**Call relations**: This helper is used by `apply_requirements` for both allowed and denied domain merging.


##### `apply_exec_policy_network_rules`  (lines 352–356)

```
fn apply_exec_policy_network_rules(config: &mut NetworkProxyConfig, exec_policy: &Policy)
```

**Purpose**: Overlays compiled exec-policy network domain rules onto a proxy config.

**Data flow**: It asks the `Policy` for `(allowed_domains, denied_domains)` via `compiled_network_domains()`, then calls `upsert_network_domains` twice to apply allow and deny entries.

**Call relations**: It is used only by `NetworkProxySpec::with_exec_policy_network_rules`.

*Call graph*: calls 1 internal fn (upsert_network_domains); called by 1 (with_exec_policy_network_rules); 1 external calls (compiled_network_domains).


##### `upsert_network_domains`  (lines 358–373)

```
fn upsert_network_domains(config: &mut NetworkProxyConfig, hosts: Vec<String>, allow: bool)
```

**Purpose**: Adds or updates a batch of domain permissions in the proxy config while deduplicating incoming hosts.

**Data flow**: It takes a mutable `NetworkProxyConfig`, a vector of host strings, and an `allow` flag. It deduplicates the incoming hosts with a `HashSet`, then calls `config.network.upsert_domain_permission` for each unique host using `Allow` or `Deny` and `normalize_host`.

**Call relations**: This is the low-level mutation helper used by `apply_exec_policy_network_rules`.

*Call graph*: called by 1 (apply_exec_policy_network_rules); 1 external calls (new).


### `network-proxy/src/mitm_hook.rs`

`domain_logic` · `config compilation and HTTPS request matching`

This file is the MITM hook subsystem’s compiler and matcher. User-facing config types (`MitmHookConfig`, `MitmHookMatchConfig`, `MitmHookActionsConfig`, `InjectedHeaderConfig`) are deserializable structures embedded in network proxy config. Compilation produces normalized runtime types: exact-host `MitmHook`s grouped in `MitmHooksByHost`, each with uppercase methods, path/query/header constraints, and resolved header actions. Hook hosts must normalize to a non-empty exact host with no wildcards, and hooks are only valid when `network.mitm = true`. Validation also requires non-empty method and path matcher lists, rejects body matchers as reserved for future use, validates header names, and enforces that injected headers specify exactly one secret source (`secret_env_var` or absolute `secret_file`).

Matching supports literal values by default and glob patterns only when prefixed with `pattern:`; `literal:` escapes those reserved prefixes so strings like `pattern:*` can still be matched literally. Path globs are compiled with `literal_separator(true)`, so `*` does not cross `/` boundaries, while query/header value globs allow separator crossing. `evaluate_mitm_hooks` normalizes the host, looks up hooks for that exact host, and returns the first matching hook’s actions; if the host is configured but no hook matches, it returns `HookedHostNoMatch`, which the MITM policy layer treats as a denial for hooked hosts.

Injected header compilation resolves secrets eagerly from environment variables or files and stores both the final `HeaderValue` and a `SecretSource` describing where it came from. Tests cover validation failures, env/file secret resolution, wildcard semantics, literal-prefix escaping, and first-match behavior.

#### Function details

##### `CompiledGlobMatcher::fmt`  (lines 141–145)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a debug representation of a compiled glob matcher that exposes only the original pattern string.

**Data flow**: It takes `&self` and a formatter, builds a debug struct containing the `pattern` field, and writes it.

**Call relations**: Used whenever compiled matchers appear in debug output or test assertions.

*Call graph*: 1 external calls (debug_struct).


##### `CompiledGlobMatcher::eq`  (lines 149–151)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines equality for compiled glob matchers based solely on their original pattern text.

**Data flow**: It takes `&self` and `other: &Self` and returns whether `self.pattern == other.pattern`.

**Call relations**: This supports deterministic comparisons in tests and derived equality for structures containing glob matchers.


##### `CompiledGlobMatcher::is_match`  (lines 157–159)

```
fn is_match(&self, candidate: &str) -> bool
```

**Purpose**: Tests whether a candidate string matches the compiled glob pattern.

**Data flow**: It takes `&self` and `candidate: &str`, forwards to the inner `GlobMatcher`, and returns the boolean result.

**Call relations**: Both `PathMatcher` and `ValueMatcher` delegate glob matching to this helper.

*Call graph*: 1 external calls (is_match).


##### `validate_mitm_hook_config`  (lines 171–229)

```
fn validate_mitm_hook_config(config: &NetworkProxyConfig) -> Result<()>
```

**Purpose**: Performs semantic validation of MITM hook configuration before compilation, enforcing feature gates and rejecting unsupported or malformed matcher/action definitions.

**Data flow**: It takes `config: &NetworkProxyConfig`. If no hooks are configured it returns success. Otherwise it requires `config.network.mitm` to be true, then for each hook normalizes the host, normalizes methods and requires them non-empty, compiles path matchers and requires them non-empty, rejects any configured body matcher, validates query constraints, header constraints, strip-header names, and injected-header definitions, and errors if the normalized host is empty.

**Call relations**: Compilation calls this first, and tests call it directly to verify validation behavior. It delegates each sub-area to specialized validators and normalizers.

*Call graph*: calls 7 internal fn (compile_path_matchers, normalize_hook_host, normalize_methods, validate_header_constraints, validate_injected_headers, validate_query_constraints, validate_strip_request_headers); called by 8 (compile_mitm_hooks_with_resolvers, validate_allows_hooks_in_full_mode, validate_rejects_body_matchers_for_now, validate_rejects_dual_secret_sources, validate_rejects_invalid_wildcard_path_pattern, validate_rejects_relative_secret_file, validate_requires_mitm_for_hooks, validate_policy_against_constraints); 1 external calls (anyhow!).


##### `compile_mitm_hooks`  (lines 231–242)

```
fn compile_mitm_hooks(config: &NetworkProxyConfig) -> Result<MitmHooksByHost>
```

**Purpose**: Compiles MITM hooks using the real process environment and filesystem to resolve injected-header secrets.

**Data flow**: It takes `config: &NetworkProxyConfig`, passes it to `compile_mitm_hooks_with_resolvers` along with closures that read environment variables and absolute secret files, trims file contents, and returns the compiled `MitmHooksByHost`.

**Call relations**: Runtime state building uses this production entry point. Tests that need deterministic secret resolution often bypass it in favor of the resolver-injected variant.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); called by 3 (compile_resolves_file_backed_injected_headers, network_proxy_state_for_policy, build_config_state).


##### `evaluate_mitm_hooks`  (lines 244–263)

```
fn evaluate_mitm_hooks(
    hooks_by_host: &MitmHooksByHost,
    host: &str,
    req: &Request,
) -> HookEvaluation
```

**Purpose**: Evaluates a request against the compiled hooks for a host and returns whether no hooks exist, a hook matched, or the host is hooked but this request matched none of them.

**Data flow**: It takes `hooks_by_host`, `host`, and `req`. It normalizes the host, looks up the vector of hooks for that exact normalized host, returns `NoHooksForHost` if absent, iterates hooks in order and returns `Matched { actions: hook.actions.clone() }` for the first `hook_matches`, and otherwise returns `HookedHostNoMatch`.

**Call relations**: The MITM policy layer calls this through state to decide whether a hooked host request should be allowed with actions or denied because no hook matched.

*Call graph*: calls 2 internal fn (hook_matches, normalize_host); called by 2 (evaluate_returns_first_matching_hook, evaluate_mitm_hook_request); 1 external calls (get).


##### `compile_mitm_hooks_with_resolvers`  (lines 265–339)

```
fn compile_mitm_hooks_with_resolvers(
    config: &NetworkProxyConfig,
    resolve_env_var: EnvFn,
    read_secret_file: FileFn,
) -> Result<MitmHooksByHost>
```

**Purpose**: Compiles validated MITM hook config into normalized runtime matchers and resolved header actions using caller-supplied secret resolvers.

**Data flow**: It takes config plus `resolve_env_var` and `read_secret_file` closures. After `validate_mitm_hook_config`, it iterates configured hooks, normalizes host and methods, compiles path matchers, converts query and header maps into vectors of normalized constraints with compiled value matchers, parses strip-header names, compiles each injected header via `compile_injected_header`, groups the resulting `MitmHook` values by host in a `BTreeMap`, and returns that map.

**Call relations**: This is the core compiler used by production `compile_mitm_hooks` and many tests. It delegates secret resolution and low-level matcher parsing to helper functions.

*Call graph*: calls 4 internal fn (compile_path_matchers, normalize_hook_host, normalize_methods, validate_mitm_hook_config); called by 9 (compile_mitm_hooks, compile_resolves_env_backed_injected_headers, evaluate_allows_literal_values_with_reserved_prefixes, evaluate_matches_query_and_header_constraints, evaluate_matches_wildcard_path_query_and_header_constraints, evaluate_path_wildcard_does_not_cross_segment_boundaries, evaluate_returns_first_matching_hook, evaluate_returns_hooked_host_no_match_when_query_constraint_fails, evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix); 1 external calls (new).


##### `compile_injected_header`  (lines 341–381)

```
fn compile_injected_header(
    header: &InjectedHeaderConfig,
    resolve_env_var: &EnvFn,
    read_secret_file: &FileFn,
) -> Result<ResolvedInjectedHeader>
```

**Purpose**: Resolves one injected-header config into a concrete header name/value pair and records where the secret came from.

**Data flow**: It takes an `InjectedHeaderConfig` plus environment and file resolver closures. It parses the header name, requires exactly one of `secret_env_var` or `secret_file`, resolves the secret string from the chosen source, parses absolute secret-file paths when needed, prepends any configured prefix, converts the final string into `HeaderValue`, and returns `ResolvedInjectedHeader { name, value, source }`.

**Call relations**: Called from hook compilation for each configured injected header. It centralizes the exactly-one-secret-source rule and eager secret materialization.

*Call graph*: calls 2 internal fn (parse_header_name, parse_secret_file); 5 external calls (from_str, anyhow!, format!, EnvVar, File).


##### `hook_matches`  (lines 383–404)

```
fn hook_matches(hook: &MitmHook, req: &Request) -> bool
```

**Purpose**: Checks whether a request satisfies all matcher dimensions of a compiled MITM hook.

**Data flow**: It takes `hook: &MitmHook` and `req: &Request`. It uppercases the request method and requires it to appear in `hook.matcher.methods`, checks the request path against `path_matches`, checks query constraints with `query_matches`, and finally checks header constraints with `headers_match`, returning `true` only if all stages pass.

**Call relations**: Only `evaluate_mitm_hooks` calls this while scanning hooks for a host.

*Call graph*: calls 3 internal fn (headers_match, path_matches, query_matches); called by 1 (evaluate_mitm_hooks); 2 external calls (method, uri).


##### `query_matches`  (lines 406–430)

```
fn query_matches(query_constraints: &[QueryConstraint], req: &Request) -> bool
```

**Purpose**: Evaluates query-string constraints against a request, requiring each configured query key to have at least one allowed matching value.

**Data flow**: It takes a slice of `QueryConstraint` and a request. If no constraints exist it returns `true`. Otherwise it parses the request URI query string with `form_urlencoded::parse`, accumulates actual values into `BTreeMap<String, Vec<String>>`, and returns whether every constraint name exists and has at least one actual value matched by at least one `ValueMatcher`.

**Call relations**: Called from `hook_matches` after method and path checks succeed.

*Call graph*: called by 1 (hook_matches); 5 external calls (new, uri, parse, is_empty, iter).


##### `headers_match`  (lines 432–451)

```
fn headers_match(header_constraints: &[HeaderConstraint], req: &Request) -> bool
```

**Purpose**: Evaluates header constraints against a request, requiring each configured header to be present and, when values are specified, to contain at least one matching value.

**Data flow**: It takes a slice of `HeaderConstraint` and a request. For each constraint it gets all values for the header name, fails if none are present, returns success immediately for that header if `allowed_values` is empty, otherwise checks whether any actual header value is valid UTF-8 and matched by any configured `ValueMatcher`.

**Call relations**: This is the final matcher stage in `hook_matches`.

*Call graph*: called by 1 (hook_matches); 1 external calls (iter).


##### `path_matches`  (lines 453–455)

```
fn path_matches(path_prefixes: &[PathMatcher], path: &str) -> bool
```

**Purpose**: Checks whether the request path matches any configured path matcher.

**Data flow**: It takes `path_prefixes: &[PathMatcher]` and `path: &str`, iterates the matchers, and returns `true` if any `matcher.matches(path)` succeeds.

**Call relations**: Called from `hook_matches` after method matching.

*Call graph*: called by 1 (hook_matches); 1 external calls (iter).


##### `PathMatcher::matches`  (lines 458–463)

```
fn matches(&self, candidate: &str) -> bool
```

**Purpose**: Matches a request path either by literal prefix or by compiled glob.

**Data flow**: It takes `&self` and `candidate: &str`. For `Prefix`, it returns `candidate.starts_with(prefix)`; for `Glob`, it delegates to `CompiledGlobMatcher::is_match(candidate)`.

**Call relations**: Used by `path_matches` for each configured path matcher.


##### `ValueMatcher::matches`  (lines 467–472)

```
fn matches(&self, candidate: &str) -> bool
```

**Purpose**: Matches a query or header value either exactly or via glob.

**Data flow**: It takes `&self` and `candidate: &str`. For `Exact`, it compares strings directly; for `Glob`, it delegates to `CompiledGlobMatcher::is_match(candidate)`.

**Call relations**: Used by both `query_matches` and `headers_match`.


##### `compile_path_matchers`  (lines 475–493)

```
fn compile_path_matchers(path_prefixes: &[String]) -> Result<Vec<PathMatcher>>
```

**Purpose**: Compiles configured path matcher strings into runtime `PathMatcher` values with literal-versus-glob semantics.

**Data flow**: It takes `path_prefixes: &[String]`, parses each string with `parse_matcher_pattern`, rejects empty literal entries, turns literals into `PathMatcher::Prefix`, turns glob patterns into `PathMatcher::Glob(compile_glob_matcher(..., literal_separator = true))`, and collects the results.

**Call relations**: Validation and full hook compilation both call this so path syntax is checked consistently.

*Call graph*: called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config).


##### `compile_value_matchers`  (lines 495–506)

```
fn compile_value_matchers(values: &[String]) -> Result<Vec<ValueMatcher>>
```

**Purpose**: Compiles configured query/header value matcher strings into runtime `ValueMatcher` values.

**Data flow**: It takes `values: &[String]`, parses each with `parse_matcher_pattern`, converts literals into `ValueMatcher::Exact`, converts glob patterns into `ValueMatcher::Glob(compile_glob_matcher(..., literal_separator = false))`, and collects the results.

**Call relations**: Query and header validation use this to verify syntax, and full compilation uses it to build runtime matchers.

*Call graph*: called by 2 (validate_header_constraints, validate_query_constraints).


##### `parse_matcher_pattern`  (lines 508–519)

```
fn parse_matcher_pattern(pattern: &str) -> Result<MatcherPattern<'_>>
```

**Purpose**: Interprets reserved matcher prefixes so config strings can explicitly mean literal text or glob patterns.

**Data flow**: It takes `pattern: &str`. If the string starts with `literal:`, it returns `MatcherPattern::Literal` for the remainder. Otherwise if it starts with `pattern:`, it requires the remainder to be non-empty and returns `MatcherPattern::Glob`. If neither prefix is present, it treats the whole string as a literal.

**Call relations**: Both path and value matcher compilation depend on this helper to implement the prefix-based syntax.

*Call graph*: 3 external calls (anyhow!, Glob, Literal).


##### `compile_glob_matcher`  (lines 521–533)

```
fn compile_glob_matcher(pattern: &str, literal_separator: bool) -> Result<CompiledGlobMatcher>
```

**Purpose**: Builds a compiled glob matcher with the desired separator semantics and preserves the original pattern text for debugging and equality.

**Data flow**: It takes `pattern: &str` and `literal_separator: bool`. It configures a `GlobBuilder` with backslash escaping and the requested separator behavior, builds the glob, compiles its matcher, wraps it in `CompiledGlobMatcher { pattern: pattern.to_string(), matcher }`, and returns it or an `anyhow!` error describing invalid syntax.

**Call relations**: Called by both path and value matcher compilation, with different separator settings.

*Call graph*: 1 external calls (new).


##### `normalize_hook_host`  (lines 535–546)

```
fn normalize_hook_host(host: &str) -> Result<String>
```

**Purpose**: Normalizes a hook host and enforces that it is a non-empty exact host without wildcards.

**Data flow**: It takes `host: &str`, normalizes it with `normalize_host`, errors if the result is empty or contains `*`, and otherwise returns the normalized host string.

**Call relations**: Validation and compilation both call this so host normalization and exact-host enforcement stay aligned.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config); 1 external calls (anyhow!).


##### `normalize_methods`  (lines 548–559)

```
fn normalize_methods(methods: &[String]) -> Result<Vec<String>>
```

**Purpose**: Normalizes configured HTTP methods to uppercase and rejects empty entries.

**Data flow**: It takes `methods: &[String]`, trims and uppercases each method string, errors if any normalized method is empty, and returns the collected vector.

**Call relations**: Validation and compilation both use this helper before storing methods in runtime hooks.

*Call graph*: called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config).


##### `validate_query_constraints`  (lines 561–576)

```
fn validate_query_constraints(query: &BTreeMap<String, Vec<String>>) -> Result<()>
```

**Purpose**: Checks that query constraint keys are non-empty and each key lists at least one syntactically valid allowed value matcher.

**Data flow**: It takes `query: &BTreeMap<String, Vec<String>>`, normalizes each key with `normalize_query_name`, errors on empty keys or empty value lists, compiles the values with `compile_value_matchers` to validate matcher syntax, and returns success otherwise.

**Call relations**: Called from top-level hook validation before full compilation.

*Call graph*: calls 2 internal fn (compile_value_matchers, normalize_query_name); called by 1 (validate_mitm_hook_config); 1 external calls (anyhow!).


##### `normalize_query_name`  (lines 578–583)

```
fn normalize_query_name(name: &str) -> Result<String>
```

**Purpose**: Validates and returns a query parameter name unchanged.

**Data flow**: It takes `name: &str`, errors if it is empty, and otherwise returns `name.to_string()`.

**Call relations**: Used by query validation and full compilation when constructing `QueryConstraint`s.

*Call graph*: called by 1 (validate_query_constraints); 1 external calls (anyhow!).


##### `validate_header_constraints`  (lines 585–592)

```
fn validate_header_constraints(headers: &BTreeMap<String, Vec<String>>) -> Result<()>
```

**Purpose**: Checks that configured header constraint names are valid HTTP header names and that their value matchers are syntactically valid.

**Data flow**: It takes `headers: &BTreeMap<String, Vec<String>>`, parses each header name with `parse_header_name`, validates each value list with `compile_value_matchers`, and returns success if all entries are valid.

**Call relations**: Called from top-level hook validation.

*Call graph*: calls 2 internal fn (compile_value_matchers, parse_header_name); called by 1 (validate_mitm_hook_config).


##### `validate_strip_request_headers`  (lines 594–599)

```
fn validate_strip_request_headers(header_names: &[String]) -> Result<()>
```

**Purpose**: Checks that each configured strip-header name is a valid HTTP header name.

**Data flow**: It takes `header_names: &[String]`, parses each with `parse_header_name`, and returns success if all parse.

**Call relations**: Used during top-level hook validation.

*Call graph*: calls 1 internal fn (parse_header_name); called by 1 (validate_mitm_hook_config).


##### `validate_injected_headers`  (lines 601–624)

```
fn validate_injected_headers(headers: &[InjectedHeaderConfig]) -> Result<()>
```

**Purpose**: Checks that injected-header configs have valid names and exactly one valid secret source.

**Data flow**: It takes `headers: &[InjectedHeaderConfig]`. For each header it parses the name, then matches on `(secret_env_var, secret_file)`: non-empty env var is accepted, absolute secret file is parsed and accepted, and all other combinations error.

**Call relations**: Called from top-level hook validation before any secrets are actually resolved.

*Call graph*: calls 2 internal fn (parse_header_name, parse_secret_file); called by 1 (validate_mitm_hook_config); 1 external calls (anyhow!).


##### `parse_header_name`  (lines 626–629)

```
fn parse_header_name(name: &str) -> Result<HeaderName>
```

**Purpose**: Parses a string into an HTTP `HeaderName` with a descriptive error on failure.

**Data flow**: It takes `name: &str`, calls `HeaderName::from_bytes(name.as_bytes())`, and returns the parsed header name or an `anyhow!` error containing the original string.

**Call relations**: Used throughout validation and compilation for strip, match, and injected header names.

*Call graph*: called by 4 (compile_injected_header, validate_header_constraints, validate_injected_headers, validate_strip_request_headers); 1 external calls (from_bytes).


##### `parse_secret_file`  (lines 631–641)

```
fn parse_secret_file(path: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Validates that a secret-file path is non-empty and absolute, then normalizes it into `AbsolutePathBuf`.

**Data flow**: It takes `path: &str`, errors if the trimmed string is empty, converts it to `Path`, errors if it is not absolute, then calls `AbsolutePathBuf::from_absolute_path` and returns the normalized absolute path.

**Call relations**: Validation and injected-header compilation both use this helper for file-backed secrets.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (compile_injected_header, validate_injected_headers); 2 external calls (new, anyhow!).


##### `tests::base_config`  (lines 653–661)

```
fn base_config() -> NetworkProxyConfig
```

**Purpose**: Builds a baseline network proxy config fixture with MITM enabled and limited mode selected.

**Data flow**: It returns `NetworkProxyConfig` containing `NetworkProxySettings { mitm: true, mode: NetworkMode::Limited, ..Default::default() }`.

**Call relations**: Most MITM hook tests start from this fixture and then add hooks or tweak fields.

*Call graph*: calls 1 internal fn (default).


##### `tests::github_hook`  (lines 663–681)

```
fn github_hook() -> MitmHookConfig
```

**Purpose**: Builds a representative GitHub write-hook fixture that strips and reinjects `authorization` from an environment variable.

**Data flow**: It returns a `MitmHookConfig` targeting `api.github.com`, matching `POST`/`PUT` under `/repos/openai/`, and configuring one injected `authorization` header with `secret_env_var = CODEX_GITHUB_TOKEN` and prefix `Bearer `.

**Call relations**: Many tests reuse this fixture to focus on validation and matching behavior rather than hook construction boilerplate.

*Call graph*: 2 external calls (default, vec!).


##### `tests::validate_requires_mitm_for_hooks`  (lines 684–694)

```
fn validate_requires_mitm_for_hooks()
```

**Purpose**: Verifies that configuring hooks without enabling MITM is rejected.

**Data flow**: It builds `base_config()`, disables `network.mitm`, adds one hook, calls `validate_mitm_hook_config`, expects an error, and asserts the message mentions the MITM requirement.

**Call relations**: This covers the top-level feature-gate check in hook validation.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 3 external calls (assert!, base_config, vec!).


##### `tests::validate_allows_hooks_in_full_mode`  (lines 697–703)

```
fn validate_allows_hooks_in_full_mode()
```

**Purpose**: Verifies that hooks are allowed in full network mode and are not limited to limited mode.

**Data flow**: It builds `base_config()`, switches mode to `Full`, adds one hook, calls `validate_mitm_hook_config`, and expects success.

**Call relations**: This confirms that hook validation depends on `network.mitm`, not on limited mode.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 2 external calls (base_config, vec!).


##### `tests::validate_rejects_body_matchers_for_now`  (lines 706–716)

```
fn validate_rejects_body_matchers_for_now()
```

**Purpose**: Checks that body matchers are explicitly rejected as reserved for a future release.

**Data flow**: It builds a hook with `matcher.body = Some(...)`, validates the config, expects an error, and asserts the message mentions `match.body is reserved`.

**Call relations**: This covers the current unsupported-feature branch in validation.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 5 external calls (assert!, base_config, github_hook, json!, vec!).


##### `tests::validate_rejects_relative_secret_file`  (lines 719–728)

```
fn validate_rejects_relative_secret_file()
```

**Purpose**: Verifies that injected-header secret files must be absolute paths.

**Data flow**: It modifies the GitHub hook to use `secret_file = "token.txt"` instead of an env var, validates the config, expects an error, and asserts the message mentions absolute paths.

**Call relations**: This covers `parse_secret_file` through top-level validation.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::validate_rejects_dual_secret_sources`  (lines 731–739)

```
fn validate_rejects_dual_secret_sources()
```

**Purpose**: Verifies that an injected header cannot specify both an environment variable and a secret file.

**Data flow**: It modifies the GitHub hook to set both `secret_env_var` and `secret_file`, validates the config, expects an error, and asserts the message mentions exactly one secret source.

**Call relations**: This covers the exclusivity rule enforced by `validate_injected_headers`.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::compile_resolves_env_backed_injected_headers`  (lines 742–763)

```
fn compile_resolves_env_backed_injected_headers()
```

**Purpose**: Checks that compilation resolves env-backed injected headers into concrete header values and records the env-var source.

**Data flow**: It compiles a config containing the GitHub hook using a resolver closure that returns `ghp-secret` for `CODEX_GITHUB_TOKEN`, then asserts the compiled hook’s injected header source is `SecretSource::EnvVar(...)` and its value is `Bearer ghp-secret`.

**Call relations**: This exercises `compile_mitm_hooks_with_resolvers` and `compile_injected_header` without touching the real environment.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 3 external calls (assert_eq!, base_config, vec!).


##### `tests::compile_resolves_file_backed_injected_headers`  (lines 766–783)

```
fn compile_resolves_file_backed_injected_headers()
```

**Purpose**: Checks that compilation reads and trims file-backed secrets when building injected headers.

**Data flow**: It writes `ghp-file-secret\n` to a temporary file, configures the hook to use that file, calls `compile_mitm_hooks`, and asserts the compiled injected header value is `Bearer ghp-file-secret`.

**Call relations**: This covers the production compiler path with real filesystem secret resolution.

*Call graph*: calls 1 internal fn (compile_mitm_hooks); 6 external calls (new, assert_eq!, base_config, github_hook, write, vec!).


##### `tests::evaluate_returns_first_matching_hook`  (lines 786–816)

```
fn evaluate_returns_first_matching_hook()
```

**Purpose**: Verifies that when multiple hooks for the same host match, evaluation returns the first one in configuration order.

**Data flow**: It builds two similar hooks with different injected-header prefixes, compiles them with a fixed env resolver, constructs a matching POST request, evaluates hooks for `api.github.com`, destructures the `Matched` result, and asserts the injected header value came from the first hook.

**Call relations**: This covers ordered scanning in `evaluate_mitm_hooks`.

*Call graph*: calls 2 internal fn (compile_mitm_hooks_with_resolvers, evaluate_mitm_hooks); 7 external calls (assert_eq!, builder, empty, base_config, github_hook, panic!, vec!).


##### `tests::evaluate_matches_query_and_header_constraints`  (lines 819–851)

```
fn evaluate_matches_query_and_header_constraints()
```

**Purpose**: Checks that query and header constraints participate in hook matching and can allow a request when satisfied.

**Data flow**: It adds query and header constraints to the GitHub hook, compiles hooks with a fixed env resolver, builds a request whose query and header satisfy those constraints, evaluates the hooks, and asserts a `Matched` result with the compiled actions.

**Call relations**: This exercises `query_matches` and `headers_match` in the positive case.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_matches_wildcard_path_query_and_header_constraints`  (lines 854–885)

```
fn evaluate_matches_wildcard_path_query_and_header_constraints()
```

**Purpose**: Verifies wildcard matching across path, query, and header constraints when values are prefixed with `pattern:`.

**Data flow**: It configures glob-based path, query, and header constraints, compiles hooks, builds a request satisfying those globs, evaluates hooks, and asserts a `Matched` result.

**Call relations**: This covers glob compilation and matching semantics across all matcher dimensions.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::validate_rejects_invalid_wildcard_path_pattern`  (lines 888–896)

```
fn validate_rejects_invalid_wildcard_path_pattern()
```

**Purpose**: Checks that invalid glob syntax in path matchers is rejected during validation.

**Data flow**: It sets `path_prefixes` to `pattern:/repos/[`, validates the config, expects an error, and asserts the message mentions an invalid glob pattern.

**Call relations**: This covers `compile_glob_matcher` error propagation through validation.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::evaluate_path_wildcard_does_not_cross_segment_boundaries`  (lines 899–921)

```
fn evaluate_path_wildcard_does_not_cross_segment_boundaries()
```

**Purpose**: Verifies that path globs use literal separator semantics so `*` does not match across `/` boundaries.

**Data flow**: It configures a path glob `/repos/*/codex/issues*`, compiles hooks, builds a nested path request `/repos/openai/private/codex/issues`, evaluates hooks, and asserts `HookedHostNoMatch`.

**Call relations**: This specifically tests the `literal_separator(true)` choice in path glob compilation.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 6 external calls (assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix`  (lines 924–964)

```
fn evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix()
```

**Purpose**: Verifies that glob metacharacters are treated literally unless the string is explicitly prefixed with `pattern:`.

**Data flow**: It configures path, query, and header values containing glob-like characters without the glob prefix, compiles hooks, evaluates one exact-literal request and one wildcard-like request, and asserts only the exact-literal request matches.

**Call relations**: This covers the default-literal behavior of `parse_matcher_pattern`.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_allows_literal_values_with_reserved_prefixes`  (lines 967–1007)

```
fn evaluate_allows_literal_values_with_reserved_prefixes()
```

**Purpose**: Checks that `literal:` can escape reserved prefixes so values beginning with `pattern:` are matched literally.

**Data flow**: It configures query and header constraints as `literal:pattern:*`, compiles hooks, evaluates one request containing the literal value `pattern:*` and another containing non-literal variants, and asserts only the literal one matches.

**Call relations**: This covers the reserved-prefix escaping branch in matcher parsing.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_returns_hooked_host_no_match_when_query_constraint_fails`  (lines 1010–1032)

```
fn evaluate_returns_hooked_host_no_match_when_query_constraint_fails()
```

**Purpose**: Verifies that a host with hooks returns `HookedHostNoMatch` rather than `NoHooksForHost` when the request fails a query constraint.

**Data flow**: It configures a query constraint requiring `state=open`, compiles hooks, builds a request with `state=closed`, evaluates hooks, and asserts `HookedHostNoMatch`.

**Call relations**: This distinction is important because the MITM policy layer treats hooked-host misses as denials.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_returns_no_hooks_for_unconfigured_host`  (lines 1035–1046)

```
fn evaluate_returns_no_hooks_for_unconfigured_host()
```

**Purpose**: Verifies that evaluating a request against an empty hook map reports `NoHooksForHost`.

**Data flow**: It builds a request and calls `evaluate_mitm_hooks(&MitmHooksByHost::new(), "api.github.com", &req)`, then asserts the result is `NoHooksForHost`.

**Call relations**: This is the baseline negative case for hook evaluation.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


### Proxy enforcement pipeline
These files provide the certificate, policy, response, upstream, and MITM machinery that implements managed HTTP and HTTPS proxy enforcement.

### `network-proxy/src/certs.rs`

`io_transport` · `startup and HTTPS MITM setup`

This file is the proxy’s TLS certificate plumbing for HTTPS interception. `ManagedMitmCa` wraps an `rcgen::Issuer<KeyPair>` created from a persisted CA certificate and private key under the Codex home `proxy/` directory. `ManagedMitmCa::load_or_create` ensures those files exist and parse correctly, while `tls_acceptor_data_for_host` issues an ephemeral leaf certificate for a requested host or IP SAN and converts the PEM outputs into `rustls::ServerConfig` with ALPN set to HTTP/2 and HTTP/1.1.

The module also exposes trust-bundle generation. `managed_ca_trust_bundle` ensures the CA exists, captures any startup values already present for a curated set of CA-related environment variables, loads native root certificates, appends the managed CA PEM, hashes the resulting bundle contents, and persists the bundle as `ca-bundle-<sha256>.pem`. Bundle reuse is content-addressed and guarded against symlink tricks or mismatched existing files.

A major design focus is secure file handling. Existing CA keys are validated on Unix to reject symlinks, non-regular files, and group/world-readable permissions. New files are written atomically via temporary files plus hard-link-or-rename semantics, with parent-directory fsync on Unix for durability. CA creation uses create-new semantics intentionally so an existing trusted CA is never silently replaced, and if cert persistence fails after key creation the key file is removed to avoid a half-created CA state.

#### Function details

##### `ManagedMitmCa::load_or_create`  (lines 43–49)

```
fn load_or_create() -> Result<Self>
```

**Purpose**: Loads the persisted managed CA certificate and key, or creates them if absent, then constructs the in-memory issuer used to sign host certificates. It is the entry point from proxy startup into the CA persistence layer.

**Data flow**: It takes no arguments. It calls `load_or_create_ca()` to obtain CA cert and key PEM strings, parses the key with `KeyPair::from_pem`, parses the CA certificate plus key into an `Issuer`, and returns `ManagedMitmCa { issuer }`. On parse or file errors it returns an `anyhow::Result` with added context.

**Call relations**: Proxy state construction invokes this through MITM initialization. After obtaining PEM material from `load_or_create_ca`, it delegates parsing to rcgen helpers so later host-specific certificate issuance can happen entirely in memory.

*Call graph*: calls 1 internal fn (load_or_create_ca); called by 1 (new); 2 external calls (from_ca_cert_pem, from_pem).


##### `ManagedMitmCa::tls_acceptor_data_for_host`  (lines 51–68)

```
fn tls_acceptor_data_for_host(&self, host: &str) -> Result<TlsAcceptorData>
```

**Purpose**: Generates a leaf certificate for a specific intercepted host and packages it into `TlsAcceptorData` for a Rustls server. This is what lets the MITM layer terminate client TLS for each CONNECT target.

**Data flow**: It takes `&self` and `host: &str`. It calls `issue_host_certificate_pem(host, &self.issuer)`, parses the returned PEM strings into `CertificateDer` and `PrivateKeyDer`, builds a `rustls::ServerConfig` with all protocol versions and no client auth, installs the single generated cert/key pair, sets ALPN protocols to HTTP/2 and HTTP/1.1, and returns `TlsAcceptorData::from(server_config)`.

**Call relations**: The MITM stream path calls this whenever it needs TLS acceptor material for a target host. It delegates certificate creation to `issue_host_certificate_pem` and then performs the Rustls-specific wrapping needed by the server-side TLS layer.

*Call graph*: calls 1 internal fn (issue_host_certificate_pem); called by 1 (tls_acceptor_data_for_host); 5 external calls (from_pem_slice, from_pem_slice, from, builder_with_protocol_versions, vec!).


##### `issue_host_certificate_pem`  (lines 71–98)

```
fn issue_host_certificate_pem(
    host: &str,
    issuer: &Issuer<'_, KeyPair>,
) -> Result<(String, String)>
```

**Purpose**: Creates and signs a per-host server certificate and private key in PEM form using the managed CA issuer. It handles both DNS names and literal IP addresses correctly by choosing the right SAN representation.

**Data flow**: It takes `host: &str` and an `Issuer`. It parses `host` as `IpAddr`; if successful it creates empty `CertificateParams` and pushes `SanType::IpAddress`, otherwise it creates params seeded with the hostname. It sets server-auth EKU and digital-signature/key-encipherment usages, generates an ECDSA P-256 key pair, signs the certificate with the issuer, and returns `(cert.pem(), key_pair.serialize_pem())`.

**Call relations**: Only `ManagedMitmCa::tls_acceptor_data_for_host` calls this, as part of preparing a TLS server config for intercepted HTTPS traffic. It isolates the rcgen parameter setup from the Rustls conversion logic.

*Call graph*: called by 1 (tls_acceptor_data_for_host); 5 external calls (new, generate_for, IpAddress, new, vec!).


##### `managed_ca_paths`  (lines 127–135)

```
fn managed_ca_paths() -> Result<(PathBuf, PathBuf)>
```

**Purpose**: Computes the filesystem locations for the managed CA certificate and key under the Codex home directory. It centralizes the path convention used by CA loading, creation, and trust-bundle checks.

**Data flow**: It takes no arguments. It resolves the Codex home directory via `find_codex_home()`, appends the fixed `proxy` subdirectory, then returns `(proxy/ca.pem, proxy/ca.key)` as `PathBuf`s.

**Call relations**: CA creation, trust-bundle generation, and bundle-path validation all call this first to agree on the canonical managed CA location. It delegates home-directory discovery to the shared utility crate.

*Call graph*: called by 3 (is_managed_mitm_ca_trust_bundle_path, load_or_create_ca, managed_ca_trust_bundle); 1 external calls (find_codex_home).


##### `managed_ca_trust_bundle`  (lines 137–143)

```
fn managed_ca_trust_bundle(
    env: &HashMap<&'static str, String>,
) -> Result<ManagedMitmCaTrustBundle>
```

**Purpose**: Builds or reuses a trust bundle file that contains native roots plus the managed MITM CA, while also recording startup CA-related environment variables. This gives child tools a single CA bundle path and preserves what CA env settings were already present.

**Data flow**: It takes `env: &HashMap<&'static str, String>`. It first ensures the CA exists via `load_or_create_ca()`, obtains the CA cert path from `managed_ca_paths()`, then calls `managed_ca_trust_bundle_for_cert_path(&cert_path, env)` and returns the resulting `ManagedMitmCaTrustBundle`.

**Call relations**: Configuration/state assembly calls this when preparing proxy runtime environment for subprocesses or clients. It orchestrates CA existence and path lookup, then delegates actual bundle assembly and persistence to `managed_ca_trust_bundle_for_cert_path`.

*Call graph*: calls 3 internal fn (load_or_create_ca, managed_ca_paths, managed_ca_trust_bundle_for_cert_path); called by 1 (from_config).


##### `managed_ca_trust_bundle_for_cert_path`  (lines 145–164)

```
fn managed_ca_trust_bundle_for_cert_path(
    cert_path: &Path,
    env: &HashMap<&'static str, String>,
) -> Result<ManagedMitmCaTrustBundle>
```

**Purpose**: Constructs a `ManagedMitmCaTrustBundle` for a specific CA certificate path and captures non-empty startup values for known CA environment variables. It is the core implementation behind the public trust-bundle helper and a direct test seam.

**Data flow**: It takes `cert_path: &Path` and `env: &HashMap<&'static str, String>`. It filters `CUSTOM_CA_ENV_KEYS` against the provided environment map, cloning only non-empty values into `startup_env_values`; then it builds the bundle string with `build_managed_ca_trust_bundle(cert_path)`, persists it with `persist_managed_ca_trust_bundle`, and returns `ManagedMitmCaTrustBundle { path, startup_env_values }`.

**Call relations**: Called by `managed_ca_trust_bundle` in production and directly by tests that verify startup env capture. It delegates bundle content creation and content-addressed persistence to separate helpers so those concerns remain testable independently.

*Call graph*: calls 2 internal fn (build_managed_ca_trust_bundle, persist_managed_ca_trust_bundle); called by 2 (managed_ca_trust_bundle, managed_ca_trust_bundle_records_startup_ca_env_values).


##### `build_managed_ca_trust_bundle`  (lines 166–181)

```
fn build_managed_ca_trust_bundle(managed_ca_cert_path: &Path) -> Result<String>
```

**Purpose**: Assembles the PEM text for a trust bundle by concatenating native root certificates and the managed CA certificate. It tolerates partial native-root loading failures while warning about them.

**Data flow**: It takes `managed_ca_cert_path: &Path`. It initializes an empty `String`, loads native certs via `rustls_native_certs::load_native_certs()`, logs a warning if any load errors were reported, appends each native DER certificate as PEM using `push_certificate_pem`, then appends the managed CA PEM file contents via `append_pem_file`, and returns the final bundle string.

**Call relations**: This is called only from `managed_ca_trust_bundle_for_cert_path` as the content-generation phase before hashing and persistence. It delegates PEM formatting and file appending to small helpers to keep native-root iteration straightforward.

*Call graph*: calls 2 internal fn (append_pem_file, push_certificate_pem); called by 1 (managed_ca_trust_bundle_for_cert_path); 3 external calls (new, load_native_certs, warn!).


##### `is_current_generated_trust_bundle_path`  (lines 183–206)

```
fn is_current_generated_trust_bundle_path(path: &Path, managed_ca_cert_path: &Path) -> bool
```

**Purpose**: Checks whether a path points to a Codex-generated trust bundle in the expected directory and whether that bundle still contains the current managed CA certificate bytes. It rejects stale, malformed, or unrelated files.

**Data flow**: It takes `path: &Path` and `managed_ca_cert_path: &Path`. It verifies the path’s parent matches the CA directory, the filename starts with `ca-bundle` and ends with `.pem`, reads both the candidate bundle and current CA cert bytes, and returns `true` only if the CA cert is non-empty and appears as a contiguous byte window inside the bundle contents.

**Call relations**: The public path-checking API delegates to this helper after resolving the canonical CA path. Tests use it indirectly to verify stale bundles are rejected.

*Call graph*: called by 1 (is_managed_mitm_ca_trust_bundle_path); 3 external calls (file_name, parent, read).


##### `is_managed_mitm_ca_trust_bundle_path`  (lines 209–214)

```
fn is_managed_mitm_ca_trust_bundle_path(path: &str) -> bool
```

**Purpose**: Publicly reports whether a string path refers to the current generated managed MITM trust bundle. It is a safe, failure-tolerant predicate for callers that only need yes/no classification.

**Data flow**: It takes `path: &str`. It resolves the managed CA cert path with `managed_ca_paths()`, converts the input string to `Path`, calls `is_current_generated_trust_bundle_path`, and returns `false` on any path-resolution failure.

**Call relations**: This function is used by external callers that need to recognize Codex-generated CA bundles. It wraps `managed_ca_paths` and the stricter internal checker, intentionally collapsing all errors into `false`.

*Call graph*: calls 2 internal fn (is_current_generated_trust_bundle_path, managed_ca_paths); 1 external calls (new).


##### `persist_managed_ca_trust_bundle`  (lines 216–241)

```
fn persist_managed_ca_trust_bundle(
    managed_ca_cert_path: &Path,
    trust_bundle: &str,
) -> Result<PathBuf>
```

**Purpose**: Writes the generated trust bundle to a deterministic content-addressed filename under the proxy directory. It avoids rewriting identical content and refuses to reuse mismatched existing files.

**Data flow**: It takes `managed_ca_cert_path: &Path` and `trust_bundle: &str`. It derives the proxy directory from the cert path, creates that directory, computes a SHA-256 digest of the bundle bytes, formats `ca-bundle-<hash>.pem`, writes the file via `write_atomic_create_new_or_reuse(..., 0o644)`, and returns the resulting `PathBuf`.

**Call relations**: Called after `build_managed_ca_trust_bundle` has produced the PEM text. It delegates the actual safe-write semantics to `write_atomic_create_new_or_reuse`, because bundle persistence allows idempotent reuse when contents match.

*Call graph*: calls 1 internal fn (write_atomic_create_new_or_reuse); called by 1 (managed_ca_trust_bundle_for_cert_path); 4 external calls (parent, digest, format!, create_dir_all).


##### `append_pem_file`  (lines 243–254)

```
fn append_pem_file(bundle: &mut String, path: &Path) -> Result<()>
```

**Purpose**: Appends the textual contents of a PEM file to an in-memory bundle string while ensuring newline separation. It preserves PEM block boundaries cleanly when concatenating multiple sources.

**Data flow**: It takes `bundle: &mut String` and `path: &Path`. It inserts a leading newline if the bundle does not already end with one, reads the file as UTF-8 text, appends it, ensures a trailing newline, and returns `Result<()>`.

**Call relations**: Used by `build_managed_ca_trust_bundle` specifically for the managed CA PEM file, after native roots have been encoded into the same string.

*Call graph*: called by 1 (build_managed_ca_trust_bundle); 1 external calls (read_to_string).


##### `push_certificate_pem`  (lines 256–264)

```
fn push_certificate_pem(bundle: &mut String, der: &[u8])
```

**Purpose**: Encodes a DER certificate into PEM and appends it to a bundle string. It emits standard BEGIN/END markers and wraps base64 output at 64-character lines.

**Data flow**: It takes `bundle: &mut String` and `der: &[u8]`. It base64-encodes the DER bytes, writes the PEM header, appends each 64-byte chunk plus newline, then writes the PEM footer. It returns no value and mutates the bundle string in place.

**Call relations**: This helper is called from `build_managed_ca_trust_bundle` for each native root certificate returned by the platform certificate loader.

*Call graph*: called by 1 (build_managed_ca_trust_bundle); 1 external calls (from_utf8_lossy).


##### `load_or_create_ca`  (lines 266–313)

```
fn load_or_create_ca() -> Result<(String, String)>
```

**Purpose**: Loads the managed CA certificate and key from disk if both exist and are acceptable, or generates and persists a new CA pair otherwise. It enforces the invariant that the cert and key must appear together and that an existing trusted CA is never silently overwritten.

**Data flow**: It takes no arguments. It resolves `(cert_path, key_path)` via `managed_ca_paths()`. If either file exists, it requires both to exist, validates the key file with `validate_existing_ca_key_file`, reads both PEM files as strings, and returns them. If neither exists, it creates parent directories, calls `generate_ca()`, writes the key atomically with mode `0o600`, writes the cert atomically with mode `0o644`, removes the key if cert persistence fails, logs the generated paths, and returns the PEM strings.

**Call relations**: Both CA issuer initialization and trust-bundle generation depend on this function to guarantee CA material exists. It delegates key-file validation, CA generation, and atomic file creation to specialized helpers because those steps have distinct security and durability requirements.

*Call graph*: calls 4 internal fn (generate_ca, managed_ca_paths, validate_existing_ca_key_file, write_atomic_create_new); called by 2 (load_or_create, managed_ca_trust_bundle); 5 external calls (anyhow!, create_dir_all, read_to_string, remove_file, info!).


##### `generate_ca`  (lines 315–333)

```
fn generate_ca() -> Result<(String, String)>
```

**Purpose**: Creates a new self-signed certificate authority and private key suitable for signing intercepted host certificates. The generated CA uses ECDSA P-256 and CA-specific key usages.

**Data flow**: It takes no arguments. It starts from default `CertificateParams`, marks the certificate as an unconstrained CA, sets key usages for cert signing plus digital signature and key encipherment, sets the distinguished name common name to `network_proxy MITM CA`, generates a key pair, self-signs the certificate, and returns `(cert.pem(), key_pair.serialize_pem())`.

**Call relations**: Only `load_or_create_ca` calls this, and only when no persisted CA files exist yet.

*Call graph*: called by 1 (load_or_create_ca); 5 external calls (default, new, Ca, generate_for, vec!).


##### `write_atomic_create_new`  (lines 335–393)

```
fn write_atomic_create_new(path: &Path, contents: &[u8], mode: u32) -> Result<()>
```

**Purpose**: Atomically creates a new file with specified contents and permissions, refusing to overwrite an existing destination. It is the low-level primitive used for secure CA and bundle persistence.

**Data flow**: It takes `path: &Path`, `contents: &[u8]`, and `mode: u32`. It derives the parent directory, creates a unique temporary filename using current time nanos and process ID, opens that temp file with `open_create_new_with_mode`, writes and fsyncs the contents, then tries to publish it by hard-linking to the final path. If the destination already exists it errors and removes the temp file; if hard links are unsupported it falls back to `rename` after an existence check. Finally it fsyncs the parent directory via `sync_parent_dir` and returns `Result<()>`.

**Call relations**: CA creation and bundle persistence both rely on this helper, directly or through `write_atomic_create_new_or_reuse`. It delegates platform-specific file opening and directory syncing to dedicated helpers.

*Call graph*: calls 2 internal fn (open_create_new_with_mode, sync_parent_dir); called by 2 (load_or_create_ca, write_atomic_create_new_or_reuse); 10 external calls (exists, file_name, parent, now, anyhow!, format!, hard_link, remove_file, rename, id).


##### `sync_parent_dir`  (lines 404–406)

```
fn sync_parent_dir(_parent: &Path) -> Result<()>
```

**Purpose**: Performs a best-effort fsync of the parent directory after file creation so the directory entry itself is durable on Unix. On Windows the alternate implementation is a no-op.

**Data flow**: On Unix it takes `parent: &Path`, opens the directory as a `File`, calls `sync_all`, and returns the result. The Windows variant ignores the argument and returns `Ok(())`.

**Call relations**: This is only called from `write_atomic_create_new` after the final file has been linked or renamed into place.

*Call graph*: called by 1 (write_atomic_create_new); 1 external calls (open).


##### `write_atomic_create_new_or_reuse`  (lines 408–429)

```
fn write_atomic_create_new_or_reuse(path: &Path, contents: &[u8], mode: u32) -> Result<()>
```

**Purpose**: Creates a file atomically if absent, or reuses an existing file only when its contents already match exactly. It adds symlink rejection and mismatch detection on top of the stricter create-new primitive.

**Data flow**: It takes `path: &Path`, `contents: &[u8]`, and `mode: u32`. It first checks `symlink_metadata` and rejects symlinks, then returns success immediately if reading the existing file yields identical bytes. If a different file already exists it errors. Otherwise it calls `write_atomic_create_new`; if that races and another writer created the same contents, it treats that as success by rereading the destination and comparing bytes.

**Call relations**: Trust-bundle persistence uses this helper because bundles are content-addressed and safe to reuse when identical. A dedicated test also exercises its symlink rejection behavior.

*Call graph*: calls 1 internal fn (write_atomic_create_new); called by 2 (persist_managed_ca_trust_bundle, write_atomic_create_new_or_reuse_rejects_matching_symlink_target); 4 external calls (exists, anyhow!, read, symlink_metadata).


##### `validate_existing_ca_key_file`  (lines 462–464)

```
fn validate_existing_ca_key_file(_path: &Path) -> Result<()>
```

**Purpose**: Validates that an existing CA private key file is safe to use. On Unix it rejects symlinks, non-regular files, and permissions broader than owner-only access; on non-Unix it accepts the path without extra checks.

**Data flow**: On Unix it takes `path: &Path`, reads symlink metadata, errors if the path is a symlink or not a regular file, masks permissions to `0o777`, and errors if any group/world bits are set. On non-Unix it ignores the path and returns `Ok(())`.

**Call relations**: Called by `load_or_create_ca` before reading an existing key file, and directly by tests that verify permission and symlink handling.

*Call graph*: called by 4 (load_or_create_ca, validate_existing_ca_key_file_allows_private_permissions, validate_existing_ca_key_file_rejects_group_world_permissions, validate_existing_ca_key_file_rejects_symlink); 2 external calls (anyhow!, symlink_metadata).


##### `open_create_new_with_mode`  (lines 479–485)

```
fn open_create_new_with_mode(path: &Path, _mode: u32) -> Result<File>
```

**Purpose**: Opens a new writable file with create-new semantics and, on Unix, an explicit permission mode. It is the platform-specific file-opening primitive used by atomic writes.

**Data flow**: It takes `path: &Path` and `mode: u32`. On Unix it builds `OpenOptions` with `write(true)`, `create_new(true)`, and `.mode(mode)`; on non-Unix it omits the mode setting. It returns the opened `File` or an error with path context.

**Call relations**: Only `write_atomic_create_new` calls this while creating its temporary file.

*Call graph*: called by 1 (write_atomic_create_new); 1 external calls (new).


##### `tests::current_generated_trust_bundle_path_rejects_stale_bundle`  (lines 498–508)

```
fn current_generated_trust_bundle_path_rejects_stale_bundle()
```

**Purpose**: Verifies that a bundle file with the right naming pattern is still rejected when it does not actually contain the current managed CA certificate bytes.

**Data flow**: The test creates a temporary directory, writes a fake `ca.pem` and a stale `ca-bundle-123.pem`, calls `is_current_generated_trust_bundle_path`, and asserts the result is `false`.

**Call relations**: This test exercises the byte-content check inside the internal bundle-path validator rather than only its filename heuristics.

*Call graph*: 3 external calls (assert!, write, tempdir).


##### `tests::managed_ca_trust_bundle_records_startup_ca_env_values`  (lines 511–522)

```
fn managed_ca_trust_bundle_records_startup_ca_env_values()
```

**Purpose**: Checks that trust-bundle creation preserves non-empty startup values for recognized CA-related environment variables.

**Data flow**: It creates a temporary CA PEM file, constructs an environment map containing `SSL_CERT_FILE`, calls `managed_ca_trust_bundle_for_cert_path`, and asserts that the returned `startup_env_values` map contains the original key/value pair.

**Call relations**: This test targets the environment-capture branch of `managed_ca_trust_bundle_for_cert_path` without depending on the real Codex home directory.

*Call graph*: calls 1 internal fn (managed_ca_trust_bundle_for_cert_path); 4 external calls (from, assert_eq!, write, tempdir).


##### `tests::validate_existing_ca_key_file_rejects_group_world_permissions`  (lines 526–537)

```
fn validate_existing_ca_key_file_rejects_group_world_permissions()
```

**Purpose**: Ensures Unix key-file validation rejects CA private keys that are readable by group or world.

**Data flow**: The test writes a temporary key file, changes its mode to `0o644`, calls `validate_existing_ca_key_file`, captures the error, and asserts the message mentions group/world accessibility.

**Call relations**: It directly covers the Unix permission check used before loading an existing CA key.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 5 external calls (assert!, from_mode, set_permissions, write, tempdir).


##### `tests::validate_existing_ca_key_file_rejects_symlink`  (lines 541–555)

```
fn validate_existing_ca_key_file_rejects_symlink()
```

**Purpose**: Ensures Unix key-file validation refuses symlinked CA key paths.

**Data flow**: The test creates a real key file and a symlink pointing to it, calls `validate_existing_ca_key_file` on the symlink, and asserts the resulting error mentions symlinks.

**Call relations**: It validates the symlink-defense branch that protects `load_or_create_ca` from following attacker-controlled links.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 3 external calls (assert!, write, tempdir).


##### `tests::validate_existing_ca_key_file_allows_private_permissions`  (lines 559–566)

```
fn validate_existing_ca_key_file_allows_private_permissions()
```

**Purpose**: Confirms that a regular CA key file with owner-only permissions passes validation.

**Data flow**: The test writes a temporary key file, sets mode `0o600`, calls `validate_existing_ca_key_file`, and expects success.

**Call relations**: This is the positive counterpart to the permission-rejection test for the Unix validator.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 4 external calls (from_mode, set_permissions, write, tempdir).


##### `tests::write_atomic_create_new_or_reuse_rejects_matching_symlink_target`  (lines 570–585)

```
fn write_atomic_create_new_or_reuse_rejects_matching_symlink_target()
```

**Purpose**: Verifies that bundle reuse logic rejects symlink paths even when the symlink target contains matching bytes.

**Data flow**: The test creates a real bundle file and a symlink to it, calls `write_atomic_create_new_or_reuse` on the symlink path with identical contents, and asserts the exact refusal message.

**Call relations**: It covers the early symlink check in the reuse helper, demonstrating that content equality does not bypass path-safety rules.

*Call graph*: calls 1 internal fn (write_atomic_create_new_or_reuse); 3 external calls (assert_eq!, write, tempdir).


### `network-proxy/src/responses.rs`

`util` · `request denial and response formatting`

This file is a compact response-formatting utility for the proxy’s HTTP-facing denial paths. `PolicyDecisionDetails` carries structured context about a denial—decision subtype, reason, source, protocol, host, and port—but the current message formatter intentionally does not expose most of that detail to users yet. Instead, the file maps internal reason constants such as `REASON_NOT_ALLOWED`, `REASON_DENIED`, `REASON_METHOD_NOT_ALLOWED`, `REASON_MITM_HOOK_DENIED`, `REASON_MITM_REQUIRED`, and `REASON_PROXY_DISABLED` to stable header values and short human-readable messages.

`text_response` and `json_response` are generic helpers for successful or informational responses. Both use `rama_http::Response::builder`; `json_response` serializes with `serde_json::to_string`, logs serialization or builder failures with `tracing::error!`, and falls back to `{}` if anything goes wrong. For blocked requests, `blocked_text_response` and `blocked_text_response_with_policy` always return HTTP 403 with `content-type: text/plain` and an `x-proxy-error` header derived from `blocked_header_value`. The `_with_policy` variant currently delegates to `blocked_message_with_policy`, which simply returns the same human message as `blocked_message` while explicitly ignoring the richer details payload. That design leaves room for future protocol/source-specific wording without changing callers.

The single test confirms that even when detailed policy metadata is supplied, the current user-visible message remains the concise allowlist denial text.

#### Function details

##### `text_response`  (lines 26–32)

```
fn text_response(status: StatusCode, body: &str) -> Response
```

**Purpose**: Builds a plain-text HTTP response with the supplied status code and body.

**Data flow**: Takes a `StatusCode` and `&str`, uses `Response::builder()` to set status and `content-type: text/plain`, converts the body into `rama_http::Body`, and falls back to `Response::new(...)` if builder construction fails.

**Call relations**: Used by MITM-related handlers when they need a simple text response.

*Call graph*: called by 2 (evaluate_mitm_policy, handle_mitm_request); 2 external calls (builder, from).


##### `json_response`  (lines 34–50)

```
fn json_response(value: &T) -> Response
```

**Purpose**: Builds a JSON HTTP 200 response from any serializable value, with defensive fallbacks on serialization or builder failure.

**Data flow**: Serializes `value` with `serde_json::to_string`; on error logs and substitutes `{}`. It then builds a response with status 200 and `content-type: application/json`; if response building fails, it logs and returns a bare `{}` body response.

**Call relations**: Called by JSON-blocking paths that need a structured response body.

*Call graph*: called by 1 (json_blocked); 4 external calls (builder, error!, from, to_string).


##### `blocked_header_value`  (lines 52–61)

```
fn blocked_header_value(reason: &str) -> &'static str
```

**Purpose**: Maps an internal block reason to a stable machine-readable `x-proxy-error` header value.

**Data flow**: Matches the input reason string against known constants and returns a static header token such as `blocked-by-allowlist`, `blocked-by-denylist`, `blocked-by-method-policy`, `blocked-by-mitm-hook`, `blocked-by-mitm-required`, or the generic `blocked-by-policy`.

**Call relations**: Used by both plain-text blocked response builders and JSON-blocking code so clients can classify denials programmatically.

*Call graph*: called by 3 (json_blocked, blocked_text_response, blocked_text_response_with_policy).


##### `blocked_message`  (lines 63–74)

```
fn blocked_message(reason: &str) -> &'static str
```

**Purpose**: Maps an internal block reason to a short human-readable explanation.

**Data flow**: Matches the reason string against known constants and returns a static message like `Domain not in allowlist.` or `MITM required for limited HTTPS.`; unknown reasons fall back to `Request blocked by network policy.`

**Call relations**: Used directly by simple blocked responses and indirectly by the policy-aware message helper.

*Call graph*: called by 2 (blocked_message_with_policy, blocked_text_response).


##### `blocked_text_response`  (lines 76–83)

```
fn blocked_text_response(reason: &str) -> Response
```

**Purpose**: Builds the standard plain-text HTTP 403 response for a blocked request using only the reason string.

**Data flow**: Computes the header via `blocked_header_value(reason)` and body via `blocked_message(reason)`, builds a forbidden response with those values, and falls back to a minimal `blocked` body if builder creation fails.

**Call relations**: Used by MITM policy evaluation paths that do not need richer policy details in the body.

*Call graph*: calls 2 internal fn (blocked_header_value, blocked_message); called by 1 (evaluate_mitm_policy); 2 external calls (builder, from).


##### `blocked_message_with_policy`  (lines 84–87)

```
fn blocked_message_with_policy(reason: &str, details: &PolicyDecisionDetails<'_>) -> String
```

**Purpose**: Returns the current user-facing blocked message while accepting richer policy details for future customization.

**Data flow**: Accepts a reason and `PolicyDecisionDetails`, explicitly ignores `details.reason` and `details.host`, delegates to `blocked_message(reason)`, and returns the resulting owned `String`.

**Call relations**: Called by proxy-disabled and policy-denied error paths, plus the policy-aware blocked response builder.

*Call graph*: calls 1 internal fn (blocked_message); called by 4 (proxy_disabled_response, blocked_text_response_with_policy, blocked_message_with_policy_returns_human_message, policy_denied_error).


##### `blocked_text_response_with_policy`  (lines 89–99)

```
fn blocked_text_response_with_policy(
    reason: &str,
    details: &PolicyDecisionDetails<'_>,
) -> Response
```

**Purpose**: Builds a plain-text HTTP 403 blocked response using the policy-aware message helper.

**Data flow**: Computes the `x-proxy-error` header from `reason`, computes the body from `blocked_message_with_policy(reason, details)`, builds the response, and falls back to a minimal `blocked` body on builder failure.

**Call relations**: Used by callers that already have `PolicyDecisionDetails` and want the same response shape as simpler blocked responses.

*Call graph*: calls 2 internal fn (blocked_header_value, blocked_message_with_policy); called by 1 (blocked_text_with_details); 2 external calls (builder, from).


##### `tests::blocked_message_with_policy_returns_human_message`  (lines 108–120)

```
fn blocked_message_with_policy_returns_human_message()
```

**Purpose**: Verifies that the policy-aware message helper currently returns the same concise human message as the plain reason-based helper.

**Data flow**: Constructs a `PolicyDecisionDetails` for an allowlist denial, calls `blocked_message_with_policy`, and asserts the returned string is `Domain not in allowlist.`

**Call relations**: Documents the current intentionally simple behavior of the policy-aware formatter.

*Call graph*: calls 1 internal fn (blocked_message_with_policy); 1 external calls (assert_eq!).


### `network-proxy/src/connect_policy.rs`

`domain_logic` · `outbound connection setup`

This file enforces one narrow but important rule: direct outbound TCP dials to non-public IPs are blocked unless `allow_local_binding` is enabled. `TargetCheckedTcpConnector` is the service-facing wrapper. It can be constructed either from live `NetworkProxyState` (`TargetPolicy::State`) or from a fixed boolean (`TargetPolicy::Config`) for simpler direct clients. In its `Service` implementation, it deliberately skips the local-target check when a `ProxyAddress` extension is already present, because in that case the connector is dialing an upstream proxy rather than the final destination. Otherwise it installs `TargetCheckedStreamConnector` as the underlying `TcpStreamConnector`.

`TargetCheckedStreamConnector::connect` performs the actual gate: it asynchronously asks the policy whether local binding is allowed, checks the destination IP with `policy::is_non_public_ip`, and returns an `io::ErrorKind::PermissionDenied` boxed as a Rama error when the target is local/private and policy forbids it. If allowed, it opens a Tokio TCP stream and wraps it as `rama_tcp::TcpStream`.

When policy comes from shared state, `TargetPolicy::allow_local_binding` reads it asynchronously and wraps any state-read failure in an `OpaqueError` with `read network proxy config` context. The tests demonstrate both rejection and acceptance against a real localhost listener.

#### Function details

##### `TargetCheckedTcpConnector::new`  (lines 24–28)

```
fn new(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Constructs a connector whose local-target policy is read dynamically from shared `NetworkProxyState`.

**Data flow**: It takes `state: Arc<NetworkProxyState>`, wraps it in `TargetPolicy::State`, stores that in `TargetCheckedTcpConnector`, and returns the connector.

**Call relations**: HTTP CONNECT forwarding, SOCKS handling, and connector tests use this constructor when they want policy to reflect live proxy state.

*Call graph*: called by 10 (direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled, forward_connect_tunnel, run_socks5_with_listener, handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode, handle_socks5_tcp_blocks_limited_mode_without_mitm_state, handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode, handle_socks5_tcp_uses_mitm_in_limited_mode, direct, from_env_proxy); 1 external calls (State).


##### `TargetCheckedTcpConnector::from_allow_local_binding`  (lines 30–36)

```
fn from_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Constructs a connector with a fixed allow/deny decision for local binding, without consulting shared state.

**Data flow**: It takes `allow_local_binding: bool`, stores it in `TargetPolicy::Config`, and returns the connector.

**Call relations**: Direct upstream client builders use this constructor when they already know the effective local-binding policy and do not need async state reads.

*Call graph*: called by 2 (direct_with_allow_local_binding, from_env_proxy_with_allow_local_binding).


##### `TargetCheckedTcpConnector::serve`  (lines 47–58)

```
async fn serve(&self, input: Input) -> Result<Self::Output, Self::Error>
```

**Purpose**: Implements the Rama `Service` interface for outbound TCP establishment, choosing whether to enforce target checks based on request extensions.

**Data flow**: It takes an input transport context. If `input.extensions().get::<ProxyAddress>()` is present, it immediately delegates to a plain `TcpConnector::new().serve(input)` so the dial to the upstream proxy is not blocked by final-target policy. Otherwise it builds a `TcpConnector` with `TargetCheckedStreamConnector { policy: self.policy.clone() }`, serves the input through it, and returns the established client connection or boxed error.

**Call relations**: SOCKS TCP handling invokes this service. Its main branching role is deciding whether the target check applies to the current dial or should be bypassed because another proxy hop is in use.

*Call graph*: called by 1 (handle_socks5_tcp); 3 external calls (extensions, new, clone).


##### `TargetCheckedStreamConnector::connect`  (lines 69–82)

```
async fn connect(&self, addr: SocketAddr) -> Result<TcpStream, Self::Error>
```

**Purpose**: Performs the actual socket-address policy check before opening a TCP stream.

**Data flow**: It takes `addr: SocketAddr`. It asynchronously reads `allow_local_binding` from its `TargetPolicy`; if that is false and `is_non_public_ip(addr.ip())` is true, it returns a boxed permission-denied I/O error. Otherwise it awaits `tokio::net::TcpStream::connect(addr)`, wraps the result as `rama_tcp::TcpStream`, and returns it.

**Call relations**: This method is installed by `TargetCheckedTcpConnector::serve` only for direct target dials. It delegates policy lookup to `TargetPolicy::allow_local_binding` and IP classification to `is_non_public_ip`.

*Call graph*: calls 2 internal fn (allow_local_binding, is_non_public_ip); 3 external calls (ip, new, connect).


##### `TargetPolicy::allow_local_binding`  (lines 92–104)

```
async fn allow_local_binding(&self) -> Result<bool, BoxError>
```

**Purpose**: Resolves whether local/private target connections are permitted, either from a fixed config value or by reading shared proxy state.

**Data flow**: It takes `&self`. For `Config`, it returns the stored boolean. For `State`, it awaits `state.allow_local_binding()`, converts any error into `BoxError`, wraps it in `OpaqueError` with `read network proxy config` context, and returns the boolean on success.

**Call relations**: Only `TargetCheckedStreamConnector::connect` calls this, because that is the point where the connector must decide whether to reject a non-public destination.

*Call graph*: called by 1 (connect).


##### `tests::direct_connector_rejects_non_public_target_when_local_binding_disabled`  (lines 117–136)

```
async fn direct_connector_rejects_non_public_target_when_local_binding_disabled()
```

**Purpose**: Verifies that the connector refuses to dial a localhost target when local binding is disabled in proxy state.

**Data flow**: The test binds a Tokio listener on localhost, builds a `TargetCheckedTcpConnector` from default proxy state, creates a Rama TCP client request targeting the listener, serves it through the connector, expects an error, and asserts the error text mentions policy rejection.

**Call relations**: This test exercises the state-backed policy path and the non-public-IP rejection branch in `connect`.

*Call graph*: calls 3 internal fn (new, default, new); 6 external calls (new, from, serve, bind, assert!, network_proxy_state_for_policy).


##### `tests::direct_connector_allows_non_public_target_when_local_binding_enabled`  (lines 139–156)

```
async fn direct_connector_allows_non_public_target_when_local_binding_enabled()
```

**Purpose**: Verifies that the connector permits dialing a localhost target when local binding is enabled.

**Data flow**: The test binds a Tokio listener on localhost, builds proxy state with `allow_local_binding: true`, constructs the connector, sends a request through it, and asserts the result is successful.

**Call relations**: This is the positive counterpart to the rejection test and covers the allowed branch of the same connection policy.

*Call graph*: calls 3 internal fn (new, default, new); 6 external calls (new, from, serve, bind, assert!, network_proxy_state_for_policy).


### `network-proxy/src/upstream.rs`

`io_transport` · `outbound request routing and upstream connection establishment`

This file encapsulates how the proxy talks to upstream servers. `ProxyConfig` is a small immutable snapshot of HTTP/HTTPS/ALL proxy settings read from the process environment. `read_proxy_env` scans canonical and lowercase keys, ignores empty values, parses them as `rama_net::address::ProxyAddress`, and deliberately accepts only HTTP-family proxy protocols; invalid or non-HTTP proxy values are ignored with warnings. `proxy_for_connect` exposes the secure-protocol selection used by CONNECT handling.

`UpstreamClient` wraps a boxed `rama` service that turns an HTTP request into an established upstream HTTP client connection. Constructors choose between direct transport and environment-proxy transport, either from a full `NetworkProxyState` via `TargetCheckedTcpConnector::new(state)` or from a simple `allow_local_binding` boolean via `TargetCheckedTcpConnector::from_allow_local_binding`. On macOS there is also a unix-socket constructor that bypasses TCP entirely.

The `Service<Request<Body>>` implementation performs the actual outbound request flow. It derives a `RequestContext` from the request to identify the authority and whether the protocol is secure, selects an upstream proxy route from `proxy_config`, logs whether the route is direct or via upstream proxy, and if needed inserts the chosen `ProxyAddress` into request extensions for the connector layer. It then times connection establishment through the boxed connector, copies connection extensions back onto the request, times the HTTP request/response-header exchange, and returns the response or wraps failures in `OpaqueError` with URI context.

`build_http_connector` assembles the layered outbound stack: ensure rustls provider initialization, optional HTTP proxy connector layer, rustls TLS connector with automatic HTTP ALPN, request-version adaptation, and finally `HttpConnector` boxed as a service.

#### Function details

##### `ProxyConfig::from_env`  (lines 40–45)

```
fn from_env() -> Self
```

**Purpose**: Reads HTTP, HTTPS, and ALL proxy settings from the current process environment into a normalized config snapshot.

**Data flow**: Calls `read_proxy_env` for `HTTP_PROXY/http_proxy`, `HTTPS_PROXY/https_proxy`, and `ALL_PROXY/all_proxy`, stores the resulting optional `ProxyAddress` values, and returns `ProxyConfig`.

**Call relations**: Used by environment-proxy client constructors and by `proxy_for_connect`.

*Call graph*: calls 1 internal fn (read_proxy_env); called by 3 (from_env_proxy, from_env_proxy_with_allow_local_binding, proxy_for_connect).


##### `ProxyConfig::proxy_for_protocol`  (lines 47–56)

```
fn proxy_for_protocol(&self, is_secure: bool) -> Option<ProxyAddress>
```

**Purpose**: Selects the appropriate upstream proxy for secure or insecure traffic using standard precedence rules.

**Data flow**: If `is_secure` is true, returns `https` first, then `http`, then `all`; otherwise returns `http` first, then `all`. Clones the chosen `ProxyAddress` if present.

**Call relations**: Called by `UpstreamClient::serve` after deriving request protocol information.

*Call graph*: called by 1 (serve).


##### `read_proxy_env`  (lines 59–86)

```
fn read_proxy_env(keys: &[&str]) -> Option<ProxyAddress>
```

**Purpose**: Scans a list of environment keys and returns the first valid HTTP-family proxy address.

**Data flow**: Iterates the provided keys, reads each with `std::env::var`, trims whitespace, skips empty values, parses with `ProxyAddress::try_from`, accepts only proxies whose protocol is HTTP or unspecified, logs warnings for invalid or non-HTTP values, and returns the first accepted `ProxyAddress` or `None`.

**Call relations**: Internal helper used by `ProxyConfig::from_env`.

*Call graph*: called by 1 (from_env); 3 external calls (try_from, var, warn!).


##### `proxy_for_connect`  (lines 88–90)

```
fn proxy_for_connect() -> Option<ProxyAddress>
```

**Purpose**: Returns the environment-configured upstream proxy that should be used for secure CONNECT-style traffic.

**Data flow**: Builds `ProxyConfig::from_env()` and asks it for `proxy_for_protocol(true)`.

**Call relations**: Used by HTTP CONNECT proxy handling when deciding whether to chain through an upstream proxy.

*Call graph*: calls 1 internal fn (from_env); called by 1 (http_connect_proxy).


##### `UpstreamClient::direct`  (lines 103–108)

```
fn direct(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Constructs an upstream client that connects directly using policy-checked TCP transport from shared runtime state.

**Data flow**: Creates `ProxyConfig::default()`, builds `TargetCheckedTcpConnector::new(state)`, passes both to `Self::new`, and returns the client.

**Call relations**: Used by plain HTTP proxying when upstream proxy chaining is not desired.

*Call graph*: calls 1 internal fn (new); called by 1 (http_plain_proxy); 2 external calls (new, default).


##### `UpstreamClient::from_env_proxy`  (lines 110–115)

```
fn from_env_proxy(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Constructs an upstream client that may chain through environment-configured upstream proxies using policy-checked TCP transport.

**Data flow**: Builds `ProxyConfig::from_env()`, creates `TargetCheckedTcpConnector::new(state)`, passes both to `Self::new`, and returns the client.

**Call relations**: Used by plain HTTP proxying when upstream proxy chaining is allowed.

*Call graph*: calls 2 internal fn (new, from_env); called by 1 (http_plain_proxy); 1 external calls (new).


##### `UpstreamClient::direct_with_allow_local_binding`  (lines 117–122)

```
fn direct_with_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Constructs a direct upstream client from a simple local-binding policy flag rather than full runtime state.

**Data flow**: Creates default proxy config, builds `TargetCheckedTcpConnector::from_allow_local_binding(allow_local_binding)`, passes both to `Self::new`, and returns the client.

**Call relations**: Used by code paths that need a lightweight outbound client without a full `NetworkProxyState`.

*Call graph*: calls 1 internal fn (from_allow_local_binding); called by 1 (new); 2 external calls (new, default).


##### `UpstreamClient::from_env_proxy_with_allow_local_binding`  (lines 124–129)

```
fn from_env_proxy_with_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Constructs an environment-proxy-capable upstream client from a simple local-binding policy flag.

**Data flow**: Builds `ProxyConfig::from_env()`, creates `TargetCheckedTcpConnector::from_allow_local_binding(allow_local_binding)`, passes both to `Self::new`, and returns the client.

**Call relations**: Used by code paths that need upstream proxy chaining without a full runtime state handle.

*Call graph*: calls 2 internal fn (from_allow_local_binding, from_env); called by 1 (new); 1 external calls (new).


##### `UpstreamClient::unix_socket`  (lines 132–138)

```
fn unix_socket(path: &str) -> Self
```

**Purpose**: Constructs a macOS-only upstream client that sends HTTP over a fixed unix socket path.

**Data flow**: Builds a boxed connector with `build_unix_connector(path)`, pairs it with `ProxyConfig::default()`, and returns `UpstreamClient`.

**Call relations**: Used by unix-socket proxying paths instead of TCP-based upstream transport.

*Call graph*: calls 1 internal fn (build_unix_connector); called by 1 (proxy_via_unix_socket); 1 external calls (default).


##### `UpstreamClient::new`  (lines 140–146)

```
fn new(proxy_config: ProxyConfig, transport: TargetCheckedTcpConnector) -> Self
```

**Purpose**: Builds an upstream client from a proxy-selection config and a transport connector.

**Data flow**: Passes the `TargetCheckedTcpConnector` into `build_http_connector`, stores the resulting boxed connector service plus the supplied `ProxyConfig`, and returns `UpstreamClient`.

**Call relations**: Shared constructor behind all TCP-based client constructors.

*Call graph*: calls 1 internal fn (build_http_connector).


##### `UpstreamClient::serve`  (lines 153–219)

```
async fn serve(&self, mut req: Request<Body>) -> Result<Self::Output, Self::Error>
```

**Purpose**: Executes one outbound HTTP request, optionally routing through an upstream proxy and logging connection/request timing.

**Data flow**: Takes a mutable `Request<Body>`, derives optional `RequestContext` to compute authority and secure/insecure protocol, selects an optional upstream proxy via `proxy_for_protocol`, logs the chosen route, inserts the proxy into request extensions if present, clones the URI for error context, times `self.connector.serve(req)` to establish an `HttpClientService` connection, copies connection extensions back onto the request, then times `http_connection.serve(req)` to obtain the response. Returns the response on success or wraps connection/request failures in `OpaqueError`, adding URI context for request failures.

**Call relations**: This is the main outbound path used after incoming requests have passed policy checks.

*Call graph*: calls 1 internal fn (proxy_for_protocol); 9 external calls (serve, now, from_boxed, try_from, extensions_mut, uri, format!, info!, warn!).


##### `build_http_connector`  (lines 222–240)

```
fn build_http_connector(
    transport: TargetCheckedTcpConnector,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    BoxError,
>
```

**Purpose**: Assembles the layered outbound HTTP connector stack with optional upstream proxy support and rustls TLS.

**Data flow**: Ensures the rustls crypto provider is initialized, wraps the transport in `HttpProxyConnectorLayer::optional()`, builds TLS connector data with automatic HTTP ALPN, wraps it in `TlsConnectorLayer::auto()`, adapts request versions with `RequestVersionAdapter`, constructs `HttpConnector`, boxes it, and returns the boxed service.

**Call relations**: Used by `UpstreamClient::new` for all TCP-based outbound clients.

*Call graph*: called by 1 (new); 6 external calls (new, optional, new, new, auto, ensure_rustls_crypto_provider).


##### `build_unix_connector`  (lines 243–253)

```
fn build_unix_connector(
    path: &str,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    BoxError,
>
```

**Purpose**: Builds a boxed HTTP connector that talks over a fixed unix socket path.

**Data flow**: Creates `UnixConnector::fixed(path)`, wraps it in `HttpConnector`, boxes the connector service, and returns it.

**Call relations**: Used only by the macOS-only `UpstreamClient::unix_socket` constructor.

*Call graph*: called by 1 (unix_socket); 2 external calls (new, fixed).


### `network-proxy/src/mitm.rs`

`domain_logic` · `HTTPS CONNECT handling`

This file contains the proxy’s TLS-terminating HTTPS path. `MitmState` owns the managed CA, an `UpstreamClient` configured either direct or via environment proxy, and two inspection settings (`inspect` and `max_body_bytes`) currently fixed by constants. `MitmState::new` ensures the Rustls provider is installed, loads or creates the managed CA, and chooses the upstream client according to `MitmUpstreamConfig`.

`mitm_stream` is the central runtime entry point. It extracts `Arc<MitmState>`, `Arc<NetworkProxyState>`, `ProxyTarget`, and optional `NetworkMode` from stream extensions, normalizes the target host, generates host-specific TLS acceptor data from the CA, builds a `MitmRequestContext`, and serves the raw stream through a `TlsAcceptorLayer` wrapped around an auto HTTP server. That inner server strips hop-by-hop headers and routes each decrypted request to `handle_mitm_request`.

`forward_request` first calls `evaluate_mitm_policy`, which blocks nested CONNECT, rejects host mismatches between the CONNECT target and inner request, re-checks local/private target policy to defend against DNS rebinding after CONNECT, evaluates host-specific MITM hooks, and finally enforces limited-mode method restrictions. Allowed requests may have headers stripped or injected by hook actions, then get rewritten to an absolute `https://authority/path` URI with a matching `Host` header before being sent upstream.

Body inspection is implemented generically via `InspectStream<T>`, which wraps a `BodyDataStream`, counts bytes as chunks pass through, and logs request or response metadata once the stream ends. Inspection is currently disabled by constant, but the plumbing is complete for both directions.

#### Function details

##### `MitmState::fmt`  (lines 92–98)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a redacted debug representation of `MitmState` that avoids exposing CA material or connector internals.

**Data flow**: It takes `&self` and a formatter, builds a debug struct containing only `inspect` and `max_body_bytes`, marks it non-exhaustive, and writes it to the formatter.

**Call relations**: This custom `Debug` implementation is used whenever `MitmState` appears in logs or diagnostics.

*Call graph*: 1 external calls (debug_struct).


##### `MitmState::new`  (lines 102–123)

```
fn new(config: MitmUpstreamConfig) -> Result<Self>
```

**Purpose**: Constructs MITM runtime state by preparing the managed CA and selecting the appropriate upstream client strategy.

**Data flow**: It takes `config: MitmUpstreamConfig`. It ensures the Rustls crypto provider is installed, loads or creates the managed CA via `ManagedMitmCa::load_or_create()`, chooses `UpstreamClient::from_env_proxy_with_allow_local_binding` or `UpstreamClient::direct_with_allow_local_binding` based on `allow_upstream_proxy`, and returns `MitmState { ca, upstream, inspect: false, max_body_bytes: 4096 }`.

**Call relations**: Proxy config-state building calls this when MITM support is enabled. It delegates certificate persistence to the certs module and outbound transport selection to the upstream client layer.

*Call graph*: calls 3 internal fn (load_or_create, direct_with_allow_local_binding, from_env_proxy_with_allow_local_binding); called by 1 (build_config_state); 1 external calls (ensure_rustls_crypto_provider).


##### `MitmState::tls_acceptor_data_for_host`  (lines 125–127)

```
fn tls_acceptor_data_for_host(&self, host: &str) -> Result<TlsAcceptorData>
```

**Purpose**: Obtains server-side TLS acceptor data for a specific intercepted host from the managed CA.

**Data flow**: It takes `&self` and `host: &str`, forwards to `self.ca.tls_acceptor_data_for_host(host)`, and returns the resulting `TlsAcceptorData`.

**Call relations**: The MITM stream setup path calls this after extracting the CONNECT target host.

*Call graph*: calls 1 internal fn (tls_acceptor_data_for_host).


##### `MitmState::inspect_enabled`  (lines 129–131)

```
fn inspect_enabled(&self) -> bool
```

**Purpose**: Reports whether request/response body inspection logging is enabled.

**Data flow**: It takes `&self` and returns the stored `inspect` boolean.

**Call relations**: `forward_request` uses this to decide whether to wrap request and response bodies in inspection streams.


##### `MitmState::max_body_bytes`  (lines 133–135)

```
fn max_body_bytes(&self) -> usize
```

**Purpose**: Returns the configured byte threshold used when logging inspected body sizes.

**Data flow**: It takes `&self` and returns the stored `max_body_bytes` value.

**Call relations**: Inspection wrappers use this to decide whether the logged body length should be marked as truncated.


##### `mitm_tunnel`  (lines 139–141)

```
async fn mitm_tunnel(upgraded: Upgraded) -> Result<()>
```

**Purpose**: Entry point for MITM handling of an upgraded CONNECT stream.

**Data flow**: It takes `upgraded: Upgraded`, forwards it to `mitm_stream(upgraded).await`, and returns that result.

**Call relations**: The HTTP CONNECT upgraded path calls this when CONNECT acceptance determined MITM is required and MITM state is available.

*Call graph*: calls 1 internal fn (mitm_stream); called by 1 (http_connect_proxy).


##### `mitm_stream`  (lines 144–211)

```
async fn mitm_stream(stream: S) -> Result<()>
```

**Purpose**: Terminates TLS on a raw stream using a generated host certificate and serves decrypted HTTPS requests through the MITM policy/forwarding pipeline.

**Data flow**: It takes a generic stream implementing `Stream + Unpin + ExtensionsMut`. It extracts `Arc<MitmState>`, `Arc<NetworkProxyState>`, and `ProxyTarget` from extensions, normalizes the target host and port, generates `TlsAcceptorData`, reads `NetworkMode` or defaults to `Full`, builds an `Arc<MitmRequestContext>`, obtains an `Executor` from extensions or default, constructs an auto HTTP server that removes hop-by-hop request/response headers and routes requests to `handle_mitm_request`, wraps that server in `TlsAcceptorLayer::new(acceptor_data).with_store_client_hello(true)`, serves the stream, and maps any serve error into `anyhow!("MITM serve error: ...")`.

**Call relations**: Both `mitm_tunnel` and SOCKS MITM paths delegate here. It is the central bridge from raw CONNECT stream to decrypted HTTP request handling.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (mitm_tunnel, proxy_socks5_tcp); 7 external calls (new, auto, hop_by_hop, hop_by_hop, extensions, new, service_fn).


##### `handle_mitm_request`  (lines 213–225)

```
async fn handle_mitm_request(
    req: Request,
    request_ctx: Arc<MitmRequestContext>,
) -> Result<Response, std::convert::Infallible>
```

**Purpose**: Runs one decrypted HTTPS request through forwarding and converts upstream failures into a generic MITM bad-gateway response.

**Data flow**: It takes a `Request` and shared `MitmRequestContext`. It awaits `forward_request`; on success it returns that response, and on error it logs a warning and returns `text_response(StatusCode::BAD_GATEWAY, "mitm upstream error")` wrapped in `Ok`.

**Call relations**: Installed as the per-request service inside `mitm_stream`.

*Call graph*: calls 2 internal fn (forward_request, text_response); 1 external calls (warn!).


##### `forward_request`  (lines 227–275)

```
async fn forward_request(req: Request, request_ctx: &MitmRequestContext) -> Result<Response>
```

**Purpose**: Applies MITM policy and hook actions to a decrypted HTTPS request, rewrites it for upstream forwarding, and optionally wraps request/response bodies for inspection logging.

**Data flow**: It takes a `Request` and `&MitmRequestContext`. It evaluates policy via `evaluate_mitm_policy`; if blocked, it returns the blocking response immediately. Otherwise it clones target host/port and MITM state, captures method and path strings for logging, splits the request into parts and body, applies hook header mutations with `apply_mitm_hook_actions`, computes the authority string with `authority_header_value`, rewrites the URI to an absolute HTTPS URI via `build_https_uri`, overwrites the `Host` header, optionally wraps the request body with `inspect_body`, reconstructs the request, sends it through `mitm.upstream.serve`, and passes the upstream response through `respond_with_inspection` before returning it.

**Call relations**: Only `handle_mitm_request` calls this. It orchestrates policy, request mutation, upstream forwarding, and optional body logging.

*Call graph*: calls 8 internal fn (apply_mitm_hook_actions, authority_header_value, build_https_uri, evaluate_mitm_policy, inspect_body, path_and_query, path_for_log, respond_with_inspection); called by 1 (handle_mitm_request); 5 external calls (from_str, from_parts, into_parts, method, uri).


##### `mitm_blocking_response`  (lines 278–286)

```
async fn mitm_blocking_response(
    req: &Request,
    policy: &MitmPolicyContext,
) -> Result<Option<Response>>
```

**Purpose**: Test-oriented helper that exposes MITM policy evaluation as an optional blocking response without performing upstream forwarding.

**Data flow**: It takes `req: &Request` and `policy: &MitmPolicyContext`, awaits `evaluate_mitm_policy`, and returns `Ok(None)` for allow or `Ok(Some(response))` for block.

**Call relations**: MITM tests call this directly to validate policy decisions in isolation from TLS and upstream transport.

*Call graph*: calls 1 internal fn (evaluate_mitm_policy).


##### `evaluate_mitm_policy`  (lines 288–408)

```
async fn evaluate_mitm_policy(
    req: &Request,
    policy: &MitmPolicyContext,
) -> Result<MitmPolicyDecision>
```

**Purpose**: Determines whether a decrypted HTTPS request should be allowed, blocked by method or hook policy, or blocked due to host mismatch or local/private target restrictions.

**Data flow**: It takes `req: &Request` and `policy: &MitmPolicyContext`. It blocks nested CONNECT with `405`, captures method, path, and optional client address, extracts and normalizes the request host and rejects mismatches against `policy.target_host` with `400`, asynchronously re-checks `app_state.host_blocked(target_host, target_port)` and blocks local/private targets while recording a `BlockedRequest`, evaluates MITM hooks via `app_state.evaluate_mitm_hook_request`, blocks hooked hosts whose request does not match any hook while recording telemetry, checks `policy.mode.allows_method(&method)` and blocks disallowed methods while recording telemetry, and otherwise returns `MitmPolicyDecision::Allow { hook_actions }`.

**Call relations**: Both `forward_request` and the test helper `mitm_blocking_response` call this. It is the core HTTPS inner-request policy engine.

*Call graph*: calls 6 internal fn (extract_request_host, path_for_log, normalize_host, blocked_text_response, text_response, new); called by 2 (forward_request, mitm_blocking_response); 6 external calls (extensions, method, uri, matches!, Block, warn!).


##### `apply_mitm_hook_actions`  (lines 410–421)

```
fn apply_mitm_hook_actions(headers: &mut HeaderMap, actions: Option<&MitmHookActions>)
```

**Purpose**: Mutates request headers according to resolved MITM hook actions by stripping selected headers and injecting replacement values.

**Data flow**: It takes `headers: &mut HeaderMap` and `actions: Option<&MitmHookActions>`. If actions are present, it removes each header named in `strip_request_headers` and inserts each `ResolvedInjectedHeader` name/value pair into the map.

**Call relations**: Called from `forward_request` after policy evaluation has returned hook actions. A dedicated test verifies authorization replacement behavior.

*Call graph*: called by 1 (forward_request); 2 external calls (insert, remove).


##### `respond_with_inspection`  (lines 423–447)

```
fn respond_with_inspection(
    resp: Response,
    inspect: bool,
    max_body_bytes: usize,
    method: &str,
    log_path: &str,
    authority: &str,
) -> Result<Response>
```

**Purpose**: Optionally wraps an upstream response body in an inspection stream that logs body length and metadata when the stream completes.

**Data flow**: It takes `resp: Response`, `inspect: bool`, `max_body_bytes`, and request metadata strings. If inspection is disabled it returns the response unchanged. Otherwise it splits the response into parts and body, wraps the body with `inspect_body` using a `ResponseLogContext`, reconstructs the response, and returns it.

**Call relations**: Only `forward_request` calls this after receiving the upstream response.

*Call graph*: calls 1 internal fn (inspect_body); called by 1 (forward_request); 2 external calls (from_parts, into_parts).


##### `inspect_body`  (lines 449–460)

```
fn inspect_body(
    body: Body,
    max_body_bytes: usize,
    ctx: T,
) -> Body
```

**Purpose**: Wraps an HTTP body in an `InspectStream` that counts bytes and logs metadata at end-of-stream.

**Data flow**: It takes a `Body`, `max_body_bytes`, and a context implementing `BodyLoggable`. It converts the body into a data stream, boxes and pins it, constructs `InspectStream { inner, ctx: Some(Box::new(ctx)), len: 0, max_body_bytes }`, and returns `Body::from_stream(...)`.

**Call relations**: Used for both request and response bodies by `forward_request` and `respond_with_inspection` when inspection is enabled.

*Call graph*: called by 2 (forward_request, respond_with_inspection); 4 external calls (new, pin, from_stream, into_data_stream).


##### `InspectStream::poll_next`  (lines 472–488)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements streaming body passthrough while accumulating total byte length and emitting a final log when the body ends.

**Data flow**: It polls the inner `BodyDataStream`. On `Ok(bytes)` it saturating-adds `bytes.len()` to `self.len` and yields the bytes unchanged. On stream error it forwards the error. On end-of-stream it takes the stored logging context, calls `ctx.log(self.len, self.len > self.max_body_bytes)`, and returns `None`.

**Call relations**: This is the runtime behavior behind `inspect_body`; request and response inspection both rely on it.

*Call graph*: 1 external calls (Ready).


##### `RequestLogContext::log`  (lines 509–516)

```
fn log(self, len: usize, truncated: bool)
```

**Purpose**: Logs request-body inspection metadata once a request body stream completes.

**Data flow**: It takes ownership of `RequestLogContext`, plus `len` and `truncated`, extracts host/method/path fields, and emits an `info!` log line containing those values and the body length.

**Call relations**: Called by `InspectStream::poll_next` when a wrapped request body reaches EOF.

*Call graph*: 1 external calls (info!).


##### `ResponseLogContext::log`  (lines 520–528)

```
fn log(self, len: usize, truncated: bool)
```

**Purpose**: Logs response-body inspection metadata once a response body stream completes.

**Data flow**: It takes ownership of `ResponseLogContext`, plus `len` and `truncated`, extracts host/method/path/status fields, and emits an `info!` log line containing those values and the body length.

**Call relations**: Called by `InspectStream::poll_next` when a wrapped response body reaches EOF.

*Call graph*: 1 external calls (info!).


##### `extract_request_host`  (lines 531–537)

```
fn extract_request_host(req: &Request) -> Option<String>
```

**Purpose**: Extracts the effective host for a decrypted HTTPS request from the `Host` header or URI authority.

**Data flow**: It takes `req: &Request`, first tries `req.headers().get(HOST)` and UTF-8 conversion, maps that to `String`, and if absent falls back to `req.uri().authority()` converted to string.

**Call relations**: Used by `evaluate_mitm_policy` to detect host mismatches between the CONNECT target and the inner request.

*Call graph*: called by 1 (evaluate_mitm_policy); 1 external calls (headers).


##### `authority_header_value`  (lines 539–552)

```
fn authority_header_value(host: &str, port: u16) -> String
```

**Purpose**: Formats a host and port into the correct authority/Host-header string, including IPv6 brackets and omission of default HTTPS port 443.

**Data flow**: It takes `host: &str` and `port: u16`. For IPv6 hosts it returns `[host]` or `[host]:port`; for non-IPv6 hosts it returns `host` when port is 443 or `host:port` otherwise.

**Call relations**: `forward_request` uses this to rewrite both the upstream URI authority and the `Host` header consistently.

*Call graph*: called by 1 (forward_request); 1 external calls (format!).


##### `build_https_uri`  (lines 554–557)

```
fn build_https_uri(authority: &str, path: &str) -> Result<Uri>
```

**Purpose**: Builds an absolute HTTPS URI from an authority string and path/query string.

**Data flow**: It takes `authority: &str` and `path: &str`, formats `https://{authority}{path}`, parses it into `Uri`, and returns the result.

**Call relations**: Called by `forward_request` when rewriting decrypted requests for upstream forwarding.

*Call graph*: called by 1 (forward_request); 1 external calls (format!).


##### `path_and_query`  (lines 559–564)

```
fn path_and_query(uri: &Uri) -> String
```

**Purpose**: Extracts the path-and-query portion of a URI, defaulting to `/` when absent.

**Data flow**: It takes `uri: &Uri`, reads `uri.path_and_query()`, converts it to string when present, and otherwise returns `/`.

**Call relations**: Used by `forward_request` to preserve the original request target when rebuilding the absolute upstream URI.

*Call graph*: called by 1 (forward_request); 1 external calls (path_and_query).


##### `path_for_log`  (lines 566–568)

```
fn path_for_log(uri: &Uri) -> String
```

**Purpose**: Extracts just the path portion of a URI for logging, excluding query parameters.

**Data flow**: It takes `uri: &Uri`, reads `uri.path()`, converts it to `String`, and returns it.

**Call relations**: Used by both `evaluate_mitm_policy` and `forward_request` so logs avoid including query secrets.

*Call graph*: called by 2 (evaluate_mitm_policy, forward_request); 1 external calls (path).


### Local socket substrates
These files supply the reusable local IPC transports used by sandbox bridges, shell escalation, and higher-level local communication channels.

### `uds/src/lib.rs`

`io_transport` · `socket setup and bidirectional IPC whenever Unix-domain-style control channels are opened`

This crate wraps platform-specific socket implementations behind a common async interface. At the public layer, `prepare_private_socket_directory` and `is_stale_socket_path` delegate to a hidden `platform` module, while `UnixListener` and `UnixStream` are thin newtypes around `platform::Listener` and `platform::Stream`. The public listener supports async `bind` and `accept`; the public stream supports async `connect` and implements `tokio::io::AsyncRead` and `AsyncWrite` by pin-projecting into the inner platform stream.

On Unix, the platform module uses `tokio::net::UnixListener` and `tokio::net::UnixStream` directly. `prepare_private_socket_directory` creates the directory with mode `0700`, verifies an existing path is actually a directory, and repairs insecure or unusable permission bits by resetting them to exactly `0700`. `is_stale_socket_path` checks whether the path’s file type is a socket.

On Windows, the module uses `uds_windows` wrapped in `async_io::Async`, plus `tokio_util::compat::Compat` to expose Tokio-compatible async I/O. Blocking bind/connect operations are offloaded through `spawn_blocking_io`, which converts task-join failures into `io::Error::other`. Because `Compat<Async<_>>` does not perform a real socket half-close on shutdown, `platform::Stream::poll_shutdown` first flushes and then calls the underlying socket’s `shutdown(Shutdown::Write)` directly. Windows stale-path detection is necessarily weaker and treats mere path existence as the useful signal. The file also defines small wrapper types implementing `Deref`, `AsSocket`, and standard `Read`/`Write` where needed so the async adapters can operate on `uds_windows` handles safely.

#### Function details

##### `prepare_private_socket_directory`  (lines 15–17)

```
async fn prepare_private_socket_directory(socket_dir: impl AsRef<Path>) -> IoResult<()>
```

**Purpose**: Creates or fixes up the directory that will hold a socket path, delegating platform-specific behavior to the internal platform module. The public contract is that the directory exists and is private where the OS supports that notion.

**Data flow**: Accepts any `socket_dir` implementing `AsRef<Path>`, converts it to `&Path`, awaits `platform::prepare_private_socket_directory`, and returns its `IoResult<()>` unchanged.

**Call relations**: Called by higher-level socket setup code before binding listeners; it is a thin public wrapper over the platform-specific implementation.

*Call graph*: 2 external calls (as_ref, prepare_private_socket_directory).


##### `is_stale_socket_path`  (lines 24–26)

```
async fn is_stale_socket_path(socket_path: impl AsRef<Path>) -> IoResult<bool>
```

**Purpose**: Checks whether a socket rendezvous path looks stale according to platform-specific rules. On Unix this means an existing socket file; on Windows it degrades to path existence.

**Data flow**: Accepts any `socket_path` implementing `AsRef<Path>`, converts it to `&Path`, awaits `platform::is_stale_socket_path`, and returns the resulting `IoResult<bool>`.

**Call relations**: Used by callers deciding whether an existing socket path should be treated as leftover rendezvous state before binding or connecting.

*Call graph*: 2 external calls (as_ref, is_stale_socket_path).


##### `UnixListener::bind`  (lines 35–39)

```
async fn bind(socket_path: impl AsRef<Path>) -> IoResult<Self>
```

**Purpose**: Binds a new async listener at the given socket path using the platform backend. It wraps the platform listener in the public `UnixListener` newtype.

**Data flow**: Accepts any `socket_path` implementing `AsRef<Path>`, converts it to `&Path`, awaits `platform::bind_listener`, maps the returned platform listener into `UnixListener { inner }`, and returns it.

**Call relations**: This is the public listener-construction entrypoint used by many higher-level control-socket and bridge setup paths.

*Call graph*: called by 12 (remote_unix_socket_typed_request_roundtrip_works, disable_remote_control_retries_without_params_for_older_servers, run_enable_remote_control_scenario, start_control_socket_acceptor, run_host_bridge, pipes_stdin_and_stdout_through_socket, fetch_ide_context_uses_unregistered_request_route, validate_unix_socket_path_rejects_unsafe_parent_directory, default_daemon_auto_connect_probes_socket_only, bound_listener_path_is_stale_socket_path (+2 more)); 2 external calls (as_ref, bind_listener).


##### `UnixListener::accept`  (lines 42–44)

```
async fn accept(&mut self) -> IoResult<UnixStream>
```

**Purpose**: Accepts the next incoming connection from the bound listener. It wraps the accepted platform stream in the public `UnixStream` type.

**Data flow**: Mutably borrows `self`, awaits `self.inner.accept()`, maps the returned platform stream into `UnixStream { inner }`, and returns it.

**Call relations**: Called by listener-accept loops after `UnixListener::bind`; it delegates directly to the platform listener.

*Call graph*: called by 1 (accept_initialized_client); 1 external calls (accept).


##### `UnixStream::connect`  (lines 54–58)

```
async fn connect(socket_path: impl AsRef<Path>) -> IoResult<Self>
```

**Purpose**: Connects to an existing socket path using the platform backend. It wraps the resulting platform stream in the public `UnixStream` newtype.

**Data flow**: Accepts any `socket_path` implementing `AsRef<Path>`, converts it to `&Path`, awaits `platform::connect_stream`, maps the returned platform stream into `UnixStream { inner }`, and returns it.

**Call relations**: This is the public client-side connection entrypoint used by various socket consumers.

*Call graph*: called by 8 (connect_unix_socket_endpoint, connect, prepare_control_socket_path, connect_to_socket, run, maybe_probe_default_daemon_socket, stream_round_trips_data_between_listener_and_client, connect_stream); 2 external calls (as_ref, connect_stream).


##### `UnixStream::poll_read`  (lines 62–68)

```
fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncRead` for the public stream by forwarding reads to the inner platform stream. It performs no buffering or transformation itself.

**Data flow**: Receives a pinned mutable `UnixStream`, extracts `&mut self.inner`, pins that inner stream, calls its `poll_read(cx, buf)`, and returns the resulting `Poll<IoResult<()>>`.

**Call relations**: Invoked by Tokio I/O consumers whenever they read from a `UnixStream`; it is a pure forwarding shim.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_write`  (lines 72–74)

```
fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<IoResult<usize>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_write` for the public stream by forwarding to the inner platform stream. It writes bytes unchanged.

**Data flow**: Receives pinned `self`, context, and `buf: &[u8]`, pins `self.inner`, calls `poll_write(cx, buf)`, and returns the resulting `Poll<IoResult<usize>>`.

**Call relations**: Used by Tokio write paths on the public `UnixStream`.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_flush`  (lines 76–78)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_flush` for the public stream by delegating to the inner platform stream. It ensures buffered writes are pushed according to the backend’s semantics.

**Data flow**: Pins `self.inner`, calls `poll_flush(cx)`, and returns the resulting `Poll<IoResult<()>>`.

**Call relations**: Invoked by Tokio flush operations on the public stream.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_shutdown`  (lines 80–82)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_shutdown` for the public stream by delegating to the inner platform stream. The exact shutdown semantics come from the platform backend.

**Data flow**: Pins `self.inner`, calls `poll_shutdown(cx)`, and returns the resulting `Poll<IoResult<()>>`.

**Call relations**: Used by Tokio shutdown paths on the public stream; on Windows the delegated implementation contains special handling.

*Call graph*: 1 external calls (new).


##### `platform::prepare_private_socket_directory`  (lines 187–189)

```
async fn prepare_private_socket_directory(socket_dir: &Path) -> IoResult<()>
```

**Purpose**: Platform-specific implementation of socket-directory preparation. On Unix it enforces owner-only permissions; on Windows it simply ensures the directory exists.

**Data flow**: On Unix, creates the directory with a `tokio::fs::DirBuilder` configured to mode `0700`, tolerates `AlreadyExists`, checks metadata to ensure the path is a directory, compares permission bits against `0700`, and if needed resets them with `set_permissions`. On Windows, calls `tokio::fs::create_dir_all(socket_dir)` and returns the result.

**Call relations**: Reached only through the public `prepare_private_socket_directory` wrapper; it encapsulates the OS-specific policy differences.

*Call graph*: 7 external calls (new, from_mode, format!, new, set_permissions, symlink_metadata, create_dir_all).


##### `platform::bind_listener`  (lines 193–198)

```
async fn bind_listener(socket_path: &Path) -> IoResult<Listener>
```

**Purpose**: Platform-specific listener bind operation. It creates the underlying socket listener and wraps it in the platform `Listener` type.

**Data flow**: On Unix, calls `tokio::net::UnixListener::bind(socket_path)` and wraps the result in `Listener`. On Windows, clones the path into an owned `PathBuf`, runs `uds_windows::UnixListener::bind` inside `spawn_blocking_io`, wraps the result in `WindowsUnixListener`, then in `async_io::Async`, then in `Listener`.

**Call relations**: Called by the public `UnixListener::bind`; it is the backend-specific bind step.

*Call graph*: calls 1 internal fn (bind); 4 external calls (new, to_path_buf, from, spawn_blocking_io).


##### `platform::Listener::accept`  (lines 201–206)

```
async fn accept(&mut self) -> IoResult<Stream>
```

**Purpose**: Accepts an incoming connection on the platform listener and returns the platform stream type. It hides the differing accept APIs of Unix and Windows backends.

**Data flow**: On Unix, awaits `self.0.accept()` and discards the returned address, yielding the `UnixStream`. On Windows, awaits `self.0.read_with(|listener| listener.accept())`, wraps the accepted `uds_windows` stream in `WindowsUnixStream`, then `Async`, then `Compat`, then `Stream`.

**Call relations**: Called by the public `UnixListener::accept` wrapper.

*Call graph*: 2 external calls (new, from).


##### `platform::connect_stream`  (lines 209–216)

```
async fn connect_stream(socket_path: &Path) -> IoResult<Stream>
```

**Purpose**: Platform-specific client connection operation. It creates the underlying stream and wraps it in the platform `Stream` type.

**Data flow**: On Unix, awaits `tokio::net::UnixStream::connect(socket_path)` and returns it. On Windows, clones the path into a `PathBuf`, runs `uds_windows::UnixStream::connect` inside `spawn_blocking_io`, wraps the result in `WindowsUnixStream`, then `Async`, then `Compat`, then `Stream`.

**Call relations**: Called by the public `UnixStream::connect`; it is the backend-specific connect step.

*Call graph*: calls 1 internal fn (connect); 4 external calls (new, to_path_buf, from, spawn_blocking_io).


##### `platform::is_stale_socket_path`  (lines 218–220)

```
async fn is_stale_socket_path(socket_path: &Path) -> IoResult<bool>
```

**Purpose**: Platform-specific stale-path detection. Unix checks for an existing socket file type, while Windows checks whether the path exists at all.

**Data flow**: On Unix, awaits `tokio::fs::symlink_metadata(socket_path)`, reads the file type, and returns whether `is_socket()` is true. On Windows, awaits `tokio::fs::try_exists(socket_path)` and returns that boolean.

**Call relations**: Reached through the public `is_stale_socket_path` wrapper whenever callers need stale-path detection.

*Call graph*: 2 external calls (symlink_metadata, try_exists).


##### `platform::spawn_blocking_io`  (lines 222–231)

```
async fn spawn_blocking_io(
        operation: impl FnOnce() -> IoResult<T> + Send + 'static,
    ) -> IoResult<T>
```

**Purpose**: Runs a blocking socket operation on Tokio’s blocking thread pool and normalizes join failures into `io::Error`. It is used only on Windows where `uds_windows` bind/connect are blocking.

**Data flow**: Accepts a `FnOnce() -> IoResult<T>` operation, submits it to `task::spawn_blocking`, awaits the join handle, maps join errors into `io::Error::other`, then returns the inner `IoResult<T>` from the operation.

**Call relations**: Used by Windows `bind_listener` and `connect_stream` to keep blocking socket setup off the async reactor.

*Call graph*: 1 external calls (spawn_blocking).


##### `platform::WindowsUnixListener::from`  (lines 236–238)

```
fn from(listener: uds_windows::UnixListener) -> Self
```

**Purpose**: Wraps a raw `uds_windows::UnixListener` in the local `WindowsUnixListener` newtype. This enables trait implementations needed by async adapters.

**Data flow**: Consumes the raw listener and returns `WindowsUnixListener(listener)`.

**Call relations**: Used during Windows listener binding before wrapping the handle in `async_io::Async`.


##### `platform::WindowsUnixListener::deref`  (lines 244–246)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the inner `uds_windows::UnixListener` by reference. This lets wrapper code and trait implementations treat the newtype like the underlying listener.

**Data flow**: Returns `&self.0` as `&uds_windows::UnixListener`.

**Call relations**: Supports the Windows wrapper type’s integration with other APIs and traits.


##### `platform::WindowsUnixListener::as_socket`  (lines 250–252)

```
fn as_socket(&self) -> BorrowedSocket<'_>
```

**Purpose**: Implements `AsSocket` for the Windows listener wrapper so `async_io::Async` can work with it. It borrows the raw socket handle without taking ownership.

**Data flow**: Reads the raw socket via `as_raw_socket()` and unsafely constructs `BorrowedSocket::borrow_raw(...)`, returning the borrowed handle.

**Call relations**: Used implicitly by `async_io::Async::new` and related socket-based async machinery on Windows.

*Call graph*: 1 external calls (borrow_raw).


##### `platform::WindowsUnixStream::from`  (lines 258–260)

```
fn from(stream: uds_windows::UnixStream) -> Self
```

**Purpose**: Wraps a raw `uds_windows::UnixStream` in the local `WindowsUnixStream` newtype. This enables the trait implementations needed for async compatibility.

**Data flow**: Consumes the raw stream and returns `WindowsUnixStream(stream)`.

**Call relations**: Used during Windows accept/connect before wrapping the stream in `Async` and `Compat`.


##### `platform::WindowsUnixStream::deref`  (lines 266–268)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the inner `uds_windows::UnixStream` by reference. This supports wrapper interoperability and direct method access.

**Data flow**: Returns `&self.0` as `&uds_windows::UnixStream`.

**Call relations**: Supports the Windows stream wrapper’s trait implementations and adapter usage.


##### `platform::WindowsUnixStream::as_socket`  (lines 272–274)

```
fn as_socket(&self) -> BorrowedSocket<'_>
```

**Purpose**: Implements `AsSocket` for the Windows stream wrapper so it can be registered with async I/O adapters. It borrows the raw socket handle.

**Data flow**: Reads the raw socket via `as_raw_socket()` and returns `BorrowedSocket::borrow_raw(...)` from it.

**Call relations**: Used implicitly by `async_io::Async::new` for Windows streams.

*Call graph*: 1 external calls (borrow_raw).


##### `platform::WindowsUnixStream::read`  (lines 278–280)

```
fn read(&mut self, buf: &mut [u8]) -> IoResult<usize>
```

**Purpose**: Implements blocking `std::io::Read` for the Windows stream wrapper by forwarding to the underlying `uds_windows` stream. This is required by the async compatibility layer.

**Data flow**: Mutably borrows `self.0`, calls `io::Read::read(&mut self.0, buf)`, and returns the resulting `IoResult<usize>`.

**Call relations**: Used indirectly by `async_io::Async`/`Compat` when performing reads on Windows.

*Call graph*: 1 external calls (read).


##### `platform::WindowsUnixStream::write`  (lines 284–286)

```
fn write(&mut self, buf: &[u8]) -> IoResult<usize>
```

**Purpose**: Implements blocking `std::io::Write::write` for the Windows stream wrapper by forwarding to the underlying stream. This supports the async compatibility stack.

**Data flow**: Mutably borrows `self.0`, calls `io::Write::write(&mut self.0, buf)`, and returns the resulting `IoResult<usize>`.

**Call relations**: Used indirectly by the Windows async adapters during write operations.

*Call graph*: 1 external calls (write).


##### `platform::WindowsUnixStream::flush`  (lines 288–290)

```
fn flush(&mut self) -> IoResult<()>
```

**Purpose**: Implements blocking `std::io::Write::flush` for the Windows stream wrapper. It forwards flush semantics to the underlying `uds_windows` stream.

**Data flow**: Mutably borrows `self.0`, calls `io::Write::flush(&mut self.0)`, and returns the resulting `IoResult<()>`.

**Call relations**: Used indirectly by the Windows async adapters and by shutdown logic that flushes before half-closing.

*Call graph*: 1 external calls (flush).


##### `platform::Stream::poll_read`  (lines 294–300)

```
fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncRead` for the Windows platform stream wrapper by forwarding to the inner `Compat<Async<WindowsUnixStream>>`. It is the Windows backend counterpart to the public stream forwarding methods.

**Data flow**: Pins `self.0`, calls `poll_read(cx, buf)` on the compat wrapper, and returns the resulting `Poll<IoResult<()>>`.

**Call relations**: Used by the public `UnixStream::poll_read` through the platform stream abstraction on Windows.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_write`  (lines 304–310)

```
fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<IoResult<usize>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_write` for the Windows platform stream wrapper by forwarding to the compat-wrapped async stream.

**Data flow**: Pins `self.0`, calls `poll_write(cx, buf)`, and returns the resulting `Poll<IoResult<usize>>`.

**Call relations**: Used by the public `UnixStream::poll_write` on Windows.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_flush`  (lines 312–314)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_flush` for the Windows platform stream wrapper by forwarding to the compat layer.

**Data flow**: Pins `self.0`, calls `poll_flush(cx)`, and returns the resulting `Poll<IoResult<()>>`.

**Call relations**: Used by the public `UnixStream::poll_flush` on Windows.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_shutdown`  (lines 316–323)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Implements Tokio `AsyncWrite::poll_shutdown` for the Windows platform stream wrapper with an explicit socket half-close. It works around `Compat<Async<_>>` only flushing on close instead of shutting down the write side.

**Data flow**: Gets a mutable reference to the inner compat stream, polls `poll_flush(cx)` to completion with `ready!`, then calls `stream.get_ref().get_ref().shutdown(Shutdown::Write)?` on the underlying socket and returns `Poll::Ready(Ok(()))`.

**Call relations**: Used by the public `UnixStream::poll_shutdown` on Windows; it is the one platform method with custom shutdown semantics rather than simple forwarding.

*Call graph*: 2 external calls (Ready, ready!).


### `shell-escalation/src/unix/socket.rs`

`io_transport` · `request handling`

This file builds two concrete transports on top of `socket2::Socket` and `tokio::io::unix::AsyncFd`: `AsyncSocket` for `SOCK_STREAM` and `AsyncDatagramSocket` for `SOCK_DGRAM`. For stream sockets, messages are serialized with `serde_json`, prefixed with a little-endian `u32` payload length, and sent as a frame; any SCM_RIGHTS file descriptors are attached only to the first chunk of the frame, so the receiver must capture control data while reading the fixed-size header. `read_frame_header` therefore loops until exactly `LENGTH_PREFIX_SIZE` bytes are read, using `recvmsg` on the first read to collect ancillary data and plain `recv` thereafter. `read_frame_payload` then reads the declared payload length to completion, treating EOF mid-frame as `UnexpectedEof`.

For datagrams, the whole payload and optional FDs are sent and received in one `sendmsg`/`recvmsg` operation, bounded by `MAX_DATAGRAM_SIZE`. Ancillary data buffers are sized with `CMSG_SPACE`, and `make_control_message` enforces `MAX_FDS_PER_MESSAGE` before constructing an SCM_RIGHTS control message. Received control buffers are parsed by `extract_fds`, which walks `cmsghdr` records and converts raw descriptors into `OwnedFd` ownership.

The file also contains unsafe helpers for converting `MaybeUninit` buffers once reads have initialized them, plus tests covering round-trips, oversized FD rejection, large stream payloads, and EOF before a frame header arrives. A notable design choice is avoiding `socket2::Socket::pair()` in favor of `pair_raw()` plus explicit `CLOEXEC`, sidestepping platform-specific side effects such as `SO_NOSIGPIPE` failures on AF_UNIX sockets.

#### Function details

##### `assume_init`  (lines 26–28)

```
fn assume_init(buf: &[MaybeUninit<T>]) -> &[T]
```

**Purpose**: Reinterprets a fully initialized `&[MaybeUninit<T>]` as `&[T]` without copying. It is the low-level bridge from partially uninitialized receive buffers to typed slices once the caller knows the bytes are valid.

**Data flow**: Takes a borrowed slice of `MaybeUninit<T>` and reads only its pointer and length metadata. It performs an unsafe cast to produce a borrowed `&[T]` over the same memory and returns that view without modifying any state.

**Call relations**: It is used after socket reads have reported how many bytes were initialized: `read_frame_header` uses it for the ancillary control buffer before FD extraction, and `receive_datagram_bytes` uses it for both payload and control slices after `recvmsg` fills them.

*Call graph*: called by 2 (read_frame_header, receive_datagram_bytes); 3 external calls (as_ptr, len, from_raw_parts).


##### `assume_init_slice`  (lines 30–32)

```
fn assume_init_slice(buf: &[MaybeUninit<T>; N]) -> &[T; N]
```

**Purpose**: Converts a fixed-size array reference of `MaybeUninit<T>` into a fixed-size array reference of initialized `T`. In this file it is specifically used to reinterpret the 4-byte frame length header once all bytes have been read.

**Data flow**: Accepts `&[MaybeUninit<T>; N]`, performs an unsafe pointer cast preserving the array length at compile time, and returns `&[T; N]`. It does not allocate or mutate memory.

**Call relations**: It is called only from `read_frame_header` at the point where the header buffer is known to be completely filled and needs to be passed to `u32::from_le_bytes`.

*Call graph*: called by 1 (read_frame_header).


##### `assume_init_vec`  (lines 34–42)

```
fn assume_init_vec(mut buf: Vec<MaybeUninit<T>>) -> Vec<T>
```

**Purpose**: Turns a `Vec<MaybeUninit<T>>` whose elements are all initialized into a `Vec<T>` without copying. This avoids an extra allocation when assembling a fully read stream payload.

**Data flow**: Consumes the input vector, extracts its raw pointer, length, and capacity, forgets the original `Vec<MaybeUninit<T>>`, and reconstructs a `Vec<T>` from the same allocation. Ownership of the buffer moves to the returned vector.

**Call relations**: It is the final step in `read_frame_payload` once the payload loop has filled the entire buffer and wants to return owned bytes.

*Call graph*: called by 1 (read_frame_payload); 2 external calls (from_raw_parts, forget).


##### `control_space_for_fds`  (lines 44–46)

```
fn control_space_for_fds(count: usize) -> usize
```

**Purpose**: Computes the ancillary buffer size needed to carry a given number of file descriptors in an SCM_RIGHTS control message. It centralizes the `CMSG_SPACE` arithmetic used by both send and receive paths.

**Data flow**: Takes an FD count, multiplies by `size_of::<RawFd>()`, passes that byte count to `libc::CMSG_SPACE`, and returns the resulting usize buffer size. It has no side effects.

**Call relations**: This helper underpins control-buffer sizing throughout the file, ensuring `make_control_message`, `read_frame_header`, and `receive_datagram_bytes` reserve enough space for up to `MAX_FDS_PER_MESSAGE` descriptors.

*Call graph*: 1 external calls (CMSG_SPACE).


##### `extract_fds`  (lines 49–79)

```
fn extract_fds(control: &[u8]) -> Vec<OwnedFd>
```

**Purpose**: Parses a raw ancillary-data buffer and extracts any SCM_RIGHTS file descriptors into owned Rust handles. It walks all control-message headers rather than assuming a single message.

**Data flow**: Receives a byte slice containing control data, builds a temporary `libc::msghdr` pointing at that slice, iterates `cmsghdr` records with `CMSG_FIRSTHDR`/`CMSG_NXTHDR`, filters for `SOL_SOCKET` + `SCM_RIGHTS`, computes the number of embedded `RawFd` values from `cmsg_len`, reads each descriptor, and wraps each one with `OwnedFd::from_raw_fd`. It returns a `Vec<OwnedFd>` and transfers ownership of those descriptors to the caller.

**Call relations**: It is invoked after receive operations that captured ancillary data: `read_frame_header` uses it to recover FDs attached to the first stream read, and `receive_datagram_bytes` uses it for datagram control data.

*Call graph*: called by 2 (read_frame_header, receive_datagram_bytes); 8 external calls (from_raw_fd, new, CMSG_DATA, CMSG_FIRSTHDR, CMSG_LEN, CMSG_NXTHDR, zeroed, try_from).


##### `read_frame`  (lines 85–89)

```
async fn read_frame(async_socket: &AsyncFd<Socket>) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Reads one complete framed message from a stream socket, returning both the payload bytes and any attached file descriptors. It is the high-level receive primitive for `AsyncSocket`.

**Data flow**: Given an `AsyncFd<Socket>`, it first awaits `read_frame_header` to obtain the payload length and FD list, then awaits `read_frame_payload` for exactly that many bytes. It returns `(Vec<u8>, Vec<OwnedFd>)` without mutating external state.

**Call relations**: This function is called by `AsyncSocket::receive_with_fds` as the transport-level receive path, and it delegates the two phases of stream framing to `read_frame_header` and `read_frame_payload`.

*Call graph*: calls 2 internal fn (read_frame_header, read_frame_payload); called by 1 (receive_with_fds).


##### `read_frame_header`  (lines 92–145)

```
async fn read_frame_header(
    async_socket: &AsyncFd<Socket>,
) -> std::io::Result<(usize, Vec<OwnedFd>)>
```

**Purpose**: Reads the fixed-size stream frame header and captures any SCM_RIGHTS descriptors that arrive with the first bytes of the frame. It guarantees either a complete length prefix plus extracted FDs or an error.

**Data flow**: It allocates an uninitialized 4-byte header buffer and a control buffer sized for `MAX_FDS_PER_MESSAGE`, then loops on `async_socket.readable()`. On the first successful readiness cycle it uses `recvmsg` into the remaining header bytes plus control buffer, truncates control to the reported control length, and marks control as captured; subsequent iterations use plain `recv` into the remaining header bytes. If any read returns 0 before the header is complete, it returns `UnexpectedEof`. Once all 4 bytes are filled, it decodes a little-endian `u32` payload length, extracts FDs from the captured control bytes, and returns `(payload_len, fds)`.

**Call relations**: It is the first half of `read_frame`. The function exists because stream FD passing is only expected on the initial read of a frame, so `read_frame` relies on it to separate header/control handling from payload reads.

*Call graph*: calls 3 internal fn (assume_init, assume_init_slice, extract_fds); called by 1 (read_frame); 7 external calls (readable, uninit, assert!, new, from_le_bytes, unreachable!, vec!).


##### `read_frame_payload`  (lines 148–177)

```
async fn read_frame_payload(
    async_socket: &AsyncFd<Socket>,
    message_len: usize,
) -> std::io::Result<Vec<u8>>
```

**Purpose**: Reads exactly the declared number of payload bytes from a stream socket after the frame header has been parsed. It treats short reads as normal and EOF before completion as an error.

**Data flow**: It takes the async socket and a `message_len`. For zero length it immediately returns an empty `Vec<u8>`. Otherwise it allocates a `Vec<MaybeUninit<u8>>` of that size, repeatedly waits for readability and calls `recv` into the unfilled tail, increments `filled`, and errors with `UnexpectedEof` if a read returns 0 before completion. When `filled == message_len`, it converts the buffer to `Vec<u8>` with `assume_init_vec` and returns it.

**Call relations**: This is the second half of `read_frame`, called only after `read_frame_header` has produced the payload length.

*Call graph*: calls 1 internal fn (assume_init_vec); called by 1 (read_frame); 6 external calls (readable, new, assert!, new, unreachable!, vec!).


##### `send_datagram_bytes`  (lines 179–198)

```
fn send_datagram_bytes(socket: &Socket, data: &[u8], fds: &[OwnedFd]) -> std::io::Result<()>
```

**Purpose**: Sends one complete datagram payload, optionally with attached file descriptors, and rejects partial writes. It is the synchronous core used by the async datagram wrapper.

**Data flow**: It accepts a `Socket`, a byte slice payload, and a slice of `OwnedFd`. It builds ancillary data with `make_control_message`, constructs a `MsgHdr` with one `IoSlice` and optional control bytes, calls `sendmsg`, and verifies that the returned byte count equals `data.len()`. On success it returns `()`, otherwise it returns either the control-message construction error or a `WriteZero` error for a short datagram write.

**Call relations**: It is executed inside `AsyncDatagramSocket::send_with_fds` via `AsyncFd::async_io`, and it is also exercised directly by the test that verifies excessive FD counts are rejected.

*Call graph*: calls 1 internal fn (make_control_message); called by 1 (send_datagram_bytes_rejects_excessive_fd_counts); 5 external calls (new, new, sendmsg, new, format!).


##### `encode_length`  (lines 200–208)

```
fn encode_length(len: usize) -> std::io::Result<[u8; LENGTH_PREFIX_SIZE]>
```

**Purpose**: Encodes a payload length into the 4-byte little-endian frame prefix used by stream messages. It enforces that stream payloads fit in a `u32`.

**Data flow**: Takes a `usize` length, attempts `u32::try_from`, and on success returns `to_le_bytes()`. If the length exceeds `u32::MAX`, it returns an `InvalidInput` I/O error describing the oversized message.

**Call relations**: It is used by `AsyncSocket::send_with_fds` before assembling the frame, and a dedicated test checks the oversized-message error path.

*Call graph*: called by 2 (send_with_fds, encode_length_errors_for_oversized_messages); 1 external calls (try_from).


##### `make_control_message`  (lines 210–233)

```
fn make_control_message(fds: &[OwnedFd]) -> std::io::Result<Vec<u8>>
```

**Purpose**: Constructs the raw ancillary-data buffer for sending SCM_RIGHTS file descriptors. It is the single place that enforces the per-message FD limit and lays out the `cmsghdr` fields.

**Data flow**: Given a slice of `OwnedFd`, it first rejects counts above `MAX_FDS_PER_MESSAGE` with `InvalidInput`, returns an empty `Vec<u8>` for no descriptors, or allocates a zeroed control buffer sized by `control_space_for_fds`. It then writes a `libc::cmsghdr` header with `SOL_SOCKET`/`SCM_RIGHTS`, computes `cmsg_len` with `CMSG_LEN`, and copies each `fd.as_raw_fd()` into the control payload. The returned `Vec<u8>` is ready to attach to `sendmsg`.

**Call relations**: Both send paths depend on it: `send_datagram_bytes` uses it for whole datagrams, and `send_stream_chunk` uses it only for the first chunk of a framed stream message.

*Call graph*: called by 2 (send_datagram_bytes, send_stream_chunk); 9 external calls (is_empty, iter, len, new, new, format!, CMSG_DATA, CMSG_LEN, vec!).


##### `receive_datagram_bytes`  (lines 235–249)

```
fn receive_datagram_bytes(socket: &Socket) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Receives one datagram and any attached file descriptors in a single syscall. It returns owned payload bytes and owned descriptors extracted from ancillary data.

**Data flow**: It allocates an uninitialized payload buffer of `MAX_DATAGRAM_SIZE` and a control buffer sized for the maximum FD count, then calls `recvmsg` with both. Using the returned payload byte count and control length, it copies the initialized payload bytes into a `Vec<u8>`, parses the initialized control bytes with `extract_fds`, and returns `(data, fds)`.

**Call relations**: This function is passed directly to `AsyncFd::async_io` by `AsyncDatagramSocket::receive_with_fds`, making it the synchronous receive primitive for datagram sockets.

*Call graph*: calls 2 internal fn (assume_init, extract_fds); 4 external calls (new, new, recvmsg, vec!).


##### `AsyncSocket::new`  (lines 256–262)

```
fn new(socket: Socket) -> std::io::Result<AsyncSocket>
```

**Purpose**: Wraps a `socket2::Socket` in Tokio readiness handling for stream use. It ensures the underlying file descriptor is nonblocking before constructing `AsyncFd`.

**Data flow**: Consumes a `Socket`, calls `set_nonblocking(true)`, wraps it in `AsyncFd::new`, and returns `AsyncSocket { inner }`. Errors from either setup step are propagated.

**Call relations**: It is the internal constructor used by `AsyncSocket::from_fd` and `AsyncSocket::pair` after they obtain a raw Unix stream socket.

*Call graph*: called by 2 (from_fd, pair); 2 external calls (new, set_nonblocking).


##### `AsyncSocket::from_fd`  (lines 264–266)

```
fn from_fd(fd: OwnedFd) -> std::io::Result<AsyncSocket>
```

**Purpose**: Builds an async stream socket wrapper from an already-owned file descriptor. This is the adapter used when another subsystem hands over a Unix socket endpoint.

**Data flow**: Consumes an `OwnedFd`, converts it into `socket2::Socket` via `Socket::from`, then delegates to `AsyncSocket::new`. It returns the initialized wrapper or any setup error.

**Call relations**: It is called by higher-level escalation code when a stream socket FD is received externally and needs to enter this module’s framed async transport.

*Call graph*: calls 1 internal fn (new); called by 1 (escalate_task); 1 external calls (from).


##### `AsyncSocket::pair`  (lines 268–277)

```
fn pair() -> std::io::Result<(AsyncSocket, AsyncSocket)>
```

**Purpose**: Creates a connected pair of async Unix stream sockets for local IPC. It deliberately avoids `socket2`’s higher-level pair helper to prevent problematic platform-specific socket options.

**Data flow**: It calls `Socket::pair_raw(Domain::UNIX, Type::STREAM, None)`, sets `CLOEXEC` on both returned sockets, wraps each with `AsyncSocket::new`, and returns the pair. Any socket creation or setup failure aborts the operation.

**Call relations**: This constructor is used by production escalation flows and multiple tests to create in-process stream channels for framed JSON and FD passing.

*Call graph*: calls 1 internal fn (new); called by 10 (run_shell_escalation_execve_wrapper, dropping_session_aborts_intercept_workers_and_kills_spawned_child, handle_escalate_session_accepts_received_fds_that_overlap_destinations, handle_escalate_session_executes_escalated_command, handle_escalate_session_passes_permissions_to_executor, handle_escalate_session_resolves_relative_file_against_request_workdir, handle_escalate_session_respects_run_in_sandbox_decision, async_socket_handles_large_payload, async_socket_round_trips_payload_and_fds, receive_fails_when_peer_closes_before_header); 1 external calls (pair_raw).


##### `AsyncSocket::send_with_fds`  (lines 279–289)

```
async fn send_with_fds(
        &self,
        msg: T,
        fds: &[OwnedFd],
    ) -> std::io::Result<()>
```

**Purpose**: Serializes a Rust value as JSON, frames it with a length prefix, and sends it over a stream socket with optional file descriptors. It is the main typed send API for `AsyncSocket`.

**Data flow**: It takes `&self`, a serializable message `T`, and a slice of `OwnedFd`. The message is encoded with `serde_json::to_vec`, a frame buffer is allocated with capacity for prefix plus payload, the encoded length prefix from `encode_length` is appended, then the payload bytes are appended. Finally it awaits `send_stream_frame` on `self.inner` and returns its result.

**Call relations**: This is the core outbound path for stream messages. `AsyncSocket::send` delegates to it with an empty FD list.

*Call graph*: calls 2 internal fn (encode_length, send_stream_frame); called by 1 (send); 2 external calls (with_capacity, to_vec).


##### `AsyncSocket::receive_with_fds`  (lines 291–297)

```
async fn receive_with_fds(
        &self,
    ) -> std::io::Result<(T, Vec<OwnedFd>)>
```

**Purpose**: Receives one framed JSON message from a stream socket and deserializes it together with any passed file descriptors. It is the typed counterpart to `send_with_fds`.

**Data flow**: It awaits `read_frame(&self.inner)` to obtain raw payload bytes and `Vec<OwnedFd>`, then deserializes the payload with `serde_json::from_slice` into `T`. It returns `(message, fds)` or propagates transport/JSON errors.

**Call relations**: This is the core inbound path for stream messages. `AsyncSocket::receive` builds on it and adds a warning if unexpected FDs were present.

*Call graph*: calls 1 internal fn (read_frame); called by 1 (receive); 1 external calls (from_slice).


##### `AsyncSocket::send`  (lines 299–304)

```
async fn send(&self, msg: T) -> std::io::Result<()>
```

**Purpose**: Sends a JSON-serialized message over the stream socket without any file descriptors. It is a convenience wrapper for the common no-FD case.

**Data flow**: It takes a serializable `msg`, borrows it, and forwards to `send_with_fds(&msg, &[])`. The return value is the underlying async send result.

**Call relations**: Higher-level code that only needs typed message transport calls this method instead of `send_with_fds`; internally it is just a thin delegation.

*Call graph*: calls 1 internal fn (send_with_fds); called by 1 (handle_escalate_session_with_policy).


##### `AsyncSocket::receive`  (lines 306–312)

```
async fn receive(&self) -> std::io::Result<T>
```

**Purpose**: Receives and deserializes a JSON message from the stream socket while discarding any attached file descriptors. It preserves compatibility with callers that do not expect FD passing.

**Data flow**: It awaits `receive_with_fds`, inspects the returned FD vector, emits a `tracing::warn!` if the vector is non-empty, and returns only the deserialized message. No descriptors are returned to the caller.

**Call relations**: This convenience API sits above `receive_with_fds` for callers that only care about the typed payload and want accidental FD delivery surfaced as a warning.

*Call graph*: calls 1 internal fn (receive_with_fds); 1 external calls (warn!).


##### `AsyncSocket::into_inner`  (lines 314–316)

```
fn into_inner(self) -> Socket
```

**Purpose**: Unwraps the async stream wrapper and returns the underlying `socket2::Socket`. It is an ownership escape hatch for code that needs direct socket access.

**Data flow**: Consumes `self`, calls `AsyncFd::into_inner` on `inner`, and returns the raw `Socket`. No I/O occurs.

**Call relations**: It is a terminal conversion method used when the caller wants to leave this module’s async abstraction.

*Call graph*: 1 external calls (into_inner).


##### `send_stream_frame`  (lines 319–344)

```
async fn send_stream_frame(
    socket: &AsyncFd<Socket>,
    frame: &[u8],
    fds: &[OwnedFd],
) -> std::io::Result<()>
```

**Purpose**: Writes an entire framed stream message, handling partial writes and ensuring file descriptors are attached only once. It is the async transport loop beneath `AsyncSocket::send_with_fds`.

**Data flow**: It takes an async socket, a complete frame byte slice, and optional FDs. It tracks `written` bytes and an `include_fds` flag initialized from whether any FDs exist. In a loop it waits for writability, then calls `send_stream_chunk` on the remaining frame bytes; after the first successful write it disables FD inclusion. A zero-byte write becomes `WriteZero`, otherwise the loop continues until all bytes are sent and returns `()`.

**Call relations**: Called only by `AsyncSocket::send_with_fds`, it delegates each actual syscall to `send_stream_chunk` while managing readiness and partial-write state.

*Call graph*: called by 1 (send_with_fds); 3 external calls (writable, is_empty, new).


##### `send_stream_chunk`  (lines 346–364)

```
fn send_stream_chunk(
    socket: &Socket,
    frame: &[u8],
    fds: &[OwnedFd],
    include_fds: bool,
) -> std::io::Result<usize>
```

**Purpose**: Performs one `sendmsg` call for a stream frame slice, optionally attaching SCM_RIGHTS control data. It is the synchronous syscall wrapper used by the async send loop.

**Data flow**: It accepts a `Socket`, the remaining frame bytes, the FD slice, and a boolean `include_fds`. If `include_fds` is true it builds ancillary data with `make_control_message`; otherwise it uses an empty control buffer. It constructs a `MsgHdr` over one `IoSlice`, optionally adds control data, calls `sendmsg`, and returns the number of bytes written.

**Call relations**: This function is invoked repeatedly by `send_stream_frame`; tests also call it directly to verify that excessive FD counts are rejected before any send occurs.

*Call graph*: calls 1 internal fn (make_control_message); called by 1 (send_stream_chunk_rejects_excessive_fd_counts); 4 external calls (new, new, sendmsg, new).


##### `AsyncDatagramSocket::new`  (lines 371–376)

```
fn new(socket: Socket) -> std::io::Result<Self>
```

**Purpose**: Wraps a Unix datagram socket in Tokio’s `AsyncFd` after enabling nonblocking mode. It is the internal constructor for datagram transport.

**Data flow**: Consumes a `Socket`, sets it nonblocking, wraps it in `AsyncFd`, and returns `AsyncDatagramSocket { inner }`. Setup errors are propagated.

**Call relations**: It is used by `AsyncDatagramSocket::from_raw_fd` and `AsyncDatagramSocket::pair` after they obtain a datagram socket endpoint.

*Call graph*: 2 external calls (new, set_nonblocking).


##### `AsyncDatagramSocket::from_raw_fd`  (lines 378–380)

```
fn from_raw_fd(fd: RawFd) -> std::io::Result<Self>
```

**Purpose**: Constructs an async datagram socket wrapper from a raw file descriptor. Because ownership is assumed from a bare integer, the function is marked unsafe.

**Data flow**: It takes a `RawFd`, unsafely converts it into `socket2::Socket` with `Socket::from_raw_fd`, then delegates to `Self::new`. The returned wrapper owns the descriptor.

**Call relations**: Higher-level escalation code uses this when a datagram socket FD is supplied from outside Rust’s ownership system and must be adopted into async I/O.

*Call graph*: called by 2 (get_escalate_client, dropping_session_aborts_intercept_workers_and_kills_spawned_child); 2 external calls (new, from_raw_fd).


##### `AsyncDatagramSocket::pair`  (lines 382–391)

```
fn pair() -> std::io::Result<(Self, Self)>
```

**Purpose**: Creates a connected pair of async Unix datagram sockets for local message passing with optional FD transfer. Like the stream variant, it avoids `socket2`’s side-effectful helper.

**Data flow**: It calls `Socket::pair_raw(Domain::UNIX, Type::DGRAM, None)`, sets `CLOEXEC` on both sockets, wraps them with `Self::new`, and returns the pair. Errors from creation or setup are propagated.

**Call relations**: This constructor is used by session startup code and by tests that verify datagram round-tripping.

*Call graph*: called by 2 (start_session, async_datagram_sockets_round_trip_messages); 2 external calls (new, pair_raw).


##### `AsyncDatagramSocket::send_with_fds`  (lines 393–399)

```
async fn send_with_fds(&self, data: &[u8], fds: &[OwnedFd]) -> std::io::Result<()>
```

**Purpose**: Asynchronously sends one datagram payload with optional file descriptors. It bridges Tokio readiness handling to the synchronous `send_datagram_bytes` helper.

**Data flow**: It takes `&self`, a payload byte slice, and an FD slice, then calls `self.inner.async_io(Interest::WRITABLE, ...)` with a closure that invokes `send_datagram_bytes`. The future resolves to the send result.

**Call relations**: This is the public outbound API for `AsyncDatagramSocket`; all actual datagram formatting and validation is delegated to `send_datagram_bytes`.

*Call graph*: 1 external calls (async_io).


##### `AsyncDatagramSocket::receive_with_fds`  (lines 401–405)

```
async fn receive_with_fds(&self) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Asynchronously receives one datagram and any attached file descriptors. It is the public inbound API for datagram transport.

**Data flow**: It calls `self.inner.async_io(Interest::READABLE, receive_datagram_bytes)` and returns the resulting `(Vec<u8>, Vec<OwnedFd>)`. No additional transformation is applied.

**Call relations**: This method delegates all synchronous receive work to `receive_datagram_bytes` and is used by callers that need raw datagram bytes plus passed descriptors.

*Call graph*: 1 external calls (async_io).


##### `AsyncDatagramSocket::into_inner`  (lines 407–409)

```
fn into_inner(self) -> Socket
```

**Purpose**: Consumes the async datagram wrapper and returns the underlying `socket2::Socket`. It allows callers to leave the Tokio abstraction when needed.

**Data flow**: Consumes `self`, unwraps `inner` with `into_inner`, and returns the owned socket. It does not perform I/O.

**Call relations**: This is a terminal conversion method for code that needs direct access to the datagram socket.

*Call graph*: 1 external calls (into_inner).


##### `tests::fd_list`  (lines 428–435)

```
fn fd_list(count: usize) -> std::io::Result<Vec<OwnedFd>>
```

**Purpose**: Creates a vector of duplicated file descriptors backed by a temporary file for FD-passing tests. It gives tests valid, clonable descriptors without depending on external files.

**Data flow**: It creates a `NamedTempFile`, repeatedly clones its borrowed FD into owned descriptors with `try_clone_to_owned`, pushes them into a `Vec<OwnedFd>`, and returns that vector.

**Call relations**: Multiple tests call it to prepare realistic FD slices for stream and datagram send paths and for excessive-count validation.

*Call graph*: 2 external calls (new, new).


##### `tests::async_socket_round_trips_payload_and_fds`  (lines 438–460)

```
async fn async_socket_round_trips_payload_and_fds() -> std::io::Result<()>
```

**Purpose**: Verifies that `AsyncSocket` can send a JSON payload and one file descriptor across a socket pair and that the received descriptor is valid. It exercises the full framed stream path including ancillary data extraction.

**Data flow**: The test creates a socket pair, constructs a `TestPayload`, builds one send FD via `fd_list`, spawns a receiver task awaiting `receive_with_fds`, sends the payload and FD from the client, drops the sender-side FD copies, then asserts payload equality, FD count, and `fcntl(F_GETFD)` success on the received descriptor.

**Call relations**: It drives `AsyncSocket::pair`, `AsyncSocket::send_with_fds`, and `AsyncSocket::receive_with_fds` together to validate the intended end-to-end behavior.

*Call graph*: calls 1 internal fn (pair); 5 external calls (assert!, assert_eq!, fcntl, fd_list, spawn).


##### `tests::async_socket_handles_large_payload`  (lines 463–471)

```
async fn async_socket_handles_large_payload() -> std::io::Result<()>
```

**Purpose**: Checks that stream framing supports payloads larger than a single small read by round-tripping a 10,000-byte vector. This specifically exercises the partial-read and partial-write loops.

**Data flow**: The test creates a stream pair, allocates a large `Vec<u8>` payload, spawns a receiver awaiting `receive::<Vec<u8>>()`, sends the payload with `send`, awaits the receiver, and asserts byte-for-byte equality.

**Call relations**: It validates the interaction of `AsyncSocket::send`, `send_stream_frame`, `read_frame_header`, and `read_frame_payload` under multi-iteration transfer.

*Call graph*: calls 1 internal fn (pair); 3 external calls (assert_eq!, spawn, vec!).


##### `tests::async_datagram_sockets_round_trip_messages`  (lines 474–487)

```
async fn async_datagram_sockets_round_trip_messages() -> std::io::Result<()>
```

**Purpose**: Verifies that datagram sockets round-trip a payload and one passed file descriptor in a single message. It covers the datagram-specific sendmsg/recvmsg path.

**Data flow**: The test creates a datagram pair, prepares a byte vector and one FD, spawns a receiver awaiting `receive_with_fds`, sends the datagram with `send_with_fds`, drops the sender-side FD copies, then asserts the received bytes and FD count.

**Call relations**: It exercises `AsyncDatagramSocket::pair`, `AsyncDatagramSocket::send_with_fds`, and `AsyncDatagramSocket::receive_with_fds` together.

*Call graph*: calls 1 internal fn (pair); 3 external calls (assert_eq!, fd_list, spawn).


##### `tests::send_datagram_bytes_rejects_excessive_fd_counts`  (lines 490–496)

```
fn send_datagram_bytes_rejects_excessive_fd_counts() -> std::io::Result<()>
```

**Purpose**: Confirms that datagram sending fails fast when asked to attach more than `MAX_FDS_PER_MESSAGE` descriptors. This protects the ancillary-data builder’s invariant.

**Data flow**: The test creates a raw datagram socket pair, builds `MAX_FDS_PER_MESSAGE + 1` descriptors with `fd_list`, calls `send_datagram_bytes`, captures the error, and asserts that its kind is `InvalidInput`.

**Call relations**: It directly targets the validation path inside `make_control_message` as reached through `send_datagram_bytes`.

*Call graph*: calls 1 internal fn (send_datagram_bytes); 3 external calls (pair_raw, assert_eq!, fd_list).


##### `tests::send_stream_chunk_rejects_excessive_fd_counts`  (lines 499–505)

```
fn send_stream_chunk_rejects_excessive_fd_counts() -> std::io::Result<()>
```

**Purpose**: Checks that the stream send path also rejects oversized FD lists before attempting a send. It mirrors the datagram validation test for stream sockets.

**Data flow**: The test creates a raw stream socket pair, prepares too many FDs, calls `send_stream_chunk` with `include_fds = true`, and asserts that the returned error kind is `InvalidInput`.

**Call relations**: It directly exercises `send_stream_chunk`’s delegation to `make_control_message` on the first-chunk-with-FDs path.

*Call graph*: calls 1 internal fn (send_stream_chunk); 3 external calls (pair_raw, assert_eq!, fd_list).


##### `tests::encode_length_errors_for_oversized_messages`  (lines 508–511)

```
fn encode_length_errors_for_oversized_messages()
```

**Purpose**: Verifies that frame-length encoding rejects lengths that do not fit in the 32-bit wire format. This guards the stream framing contract.

**Data flow**: It calls `encode_length(usize::MAX)`, unwraps the error, and asserts that the error kind is `InvalidInput`.

**Call relations**: This test isolates the size-checking logic used by `AsyncSocket::send_with_fds` before any socket I/O occurs.

*Call graph*: calls 1 internal fn (encode_length); 1 external calls (assert_eq!).


##### `tests::receive_fails_when_peer_closes_before_header`  (lines 514–522)

```
async fn receive_fails_when_peer_closes_before_header()
```

**Purpose**: Ensures that a stream receiver reports EOF if the peer closes before even the frame header arrives. It validates the explicit `UnexpectedEof` handling in the header loop.

**Data flow**: The test creates a stream pair, drops the client immediately, awaits `server.receive::<serde_json::Value>()`, expects an error, and asserts that the error kind is `UnexpectedEof`.

**Call relations**: It drives the `AsyncSocket::receive` path into `read_frame_header`’s zero-byte-read branch.

*Call graph*: calls 1 internal fn (pair); 1 external calls (assert_eq!).


### Sandbox and IDE IPC channels
These files apply the local transport substrates to sandbox proxy routing and IDE-context request/response communication across platforms.

### `linux-sandbox/src/proxy_routing.rs`

`io_transport` · `managed proxy setup before inner exec and during bridged network I/O`

This module supports the helper's 'allow network only through managed proxy bridges' mode. It begins by scanning environment variables listed in `PROXY_ENV_KEYS`, parsing only loopback proxy URLs or host:port values, and building a `ProxyRoutePlan` of `env_key -> SocketAddr` routes. `prepare_host_proxy_route_spec` runs on the host side: it rejects missing or unparsable proxy configuration, chooses a private temp directory for Unix sockets, cleans stale directories from dead processes, allocates one socket path per unique endpoint, forks a host bridge process for each endpoint, starts a cleanup worker that removes the socket directory after all bridges die, and serializes a `ProxyRouteSpec` containing only env keys and UDS paths. Notably, the serialized spec omits original proxy URLs.

Inside the sandbox network namespace, `activate_proxy_routes_in_netns` deserializes that spec, spawns one local loopback TCP bridge per unique UDS path, and rewrites each original proxy environment variable to point at `127.0.0.1:<local_port>` while preserving scheme, credentials, path/query/fragment, and whether the original value omitted a scheme. The bridge topology is asymmetric: host bridges listen on Unix sockets and connect outward to the original loopback TCP proxy; local bridges listen on sandbox loopback TCP ports and connect inward to those Unix sockets. Both bridge process types harden themselves with parent-death signaling and process-dump disabling.

The file also contains path-length checks for `sockaddr_un`, private directory creation under `CODEX_HOME/tmp` or a temp fallback, stale-directory cleanup keyed by owner pid, loopback-interface bring-up logic for isolated namespaces, bidirectional stream copying, and small fd/pipe helpers. Tests cover env-key recognition, loopback parsing, URL rewriting, path-length enforcement, serialization privacy, and stale-directory cleanup.

#### Function details

##### `prepare_host_proxy_route_spec`  (lines 73–122)

```
fn prepare_host_proxy_route_spec() -> io::Result<String>
```

**Purpose**: Builds the host-side proxy routing plan, spawns Unix-socket bridge processes for each unique loopback proxy endpoint, and returns a serialized route spec for the inner sandbox stage. It is the outer-stage setup entrypoint for managed proxy mode.

**Data flow**: Reads the current environment into a `HashMap<String, String>`, computes a `ProxyRoutePlan` with `plan_proxy_routes`, rejects empty plans with an `InvalidInput` error whose message distinguishes missing config from unparsable config, chooses a socket parent dir, opportunistically cleans stale proxy socket dirs there, creates a fresh private socket dir, assigns one `proxy-route-N.sock` path per unique endpoint, spawns a host bridge for each endpoint and records their pids, starts a cleanup worker for the socket dir, maps each planned route to its assigned UDS path, and serializes `ProxyRouteSpec { routes }` to JSON. It mutates the filesystem and forks bridge/cleanup processes.

**Call relations**: Called by `run_main` before launching bubblewrap when managed proxy routing is requested. Its serialized output is later passed into `build_inner_seccomp_command` and consumed by `activate_proxy_routes_in_netns` inside the sandbox.

*Call graph*: calls 6 internal fn (cleanup_stale_proxy_socket_dirs_in, create_proxy_socket_dir, plan_proxy_routes, proxy_socket_parent_dir, spawn_host_bridge, spawn_proxy_socket_dir_cleanup_worker); called by 1 (run_main); 7 external calls (new, with_capacity, new, other, format!, to_string, vars).


##### `activate_proxy_routes_in_netns`  (lines 124–170)

```
fn activate_proxy_routes_in_netns(serialized_spec: &str) -> io::Result<()>
```

**Purpose**: Activates managed proxy routing inside the sandbox network namespace by spawning local loopback TCP bridges and rewriting proxy environment variables to point at them. It is the inner-stage counterpart to host-side route preparation.

**Data flow**: Consumes `serialized_spec`, deserializes it into `ProxyRouteSpec`, rejects empty route lists, spawns one local bridge per unique `uds_path` and records the assigned local TCP port, then for each route reads the current env var value, rewrites it with `rewrite_proxy_env_value(original_value, local_port)`, and updates the environment with `set_var`. Returns `io::Result<()>` and mutates process environment plus bridge subprocess state.

**Call relations**: Called by `run_main` only in the inner `--apply-seccomp-then-exec` stage when managed proxy mode is active. It depends on the host-side bridges and UDS paths created by `prepare_host_proxy_route_spec`.

*Call graph*: calls 2 internal fn (rewrite_proxy_env_value, spawn_local_bridge); called by 1 (run_main); 7 external calls (new, new, other, format!, from_str, set_var, var).


##### `plan_proxy_routes`  (lines 172–201)

```
fn plan_proxy_routes(env: &HashMap<String, String>) -> ProxyRoutePlan
```

**Purpose**: Scans environment variables and extracts only valid loopback proxy endpoints that should be bridged. It also records whether any proxy configuration existed at all, even if none was usable.

**Data flow**: Reads `env: &HashMap<String, String>`, iterates key/value pairs, filters keys through `is_proxy_env_key`, trims values, skips empties, sets `has_proxy_config` when any non-empty proxy variable is seen, parses loopback endpoints with `parse_loopback_proxy_endpoint`, pushes `PlannedProxyRoute { env_key, endpoint }` for successful parses, sorts routes by `env_key`, and returns `ProxyRoutePlan { routes, has_proxy_config }`.

**Call relations**: Used by `prepare_host_proxy_route_spec` to decide whether managed proxy mode can proceed and which unique endpoints need host bridges.

*Call graph*: calls 2 internal fn (is_proxy_env_key, parse_loopback_proxy_endpoint); called by 2 (prepare_host_proxy_route_spec, plan_proxy_routes_only_includes_valid_loopback_endpoints); 1 external calls (new).


##### `is_proxy_env_key`  (lines 203–206)

```
fn is_proxy_env_key(key: &str) -> bool
```

**Purpose**: Checks whether an environment variable name is one of the supported proxy-related keys, case-insensitively. It normalizes to uppercase before matching.

**Data flow**: Reads `key: &str`, computes `to_ascii_uppercase()`, and returns whether the normalized string is contained in `PROXY_ENV_KEYS`. It is pure.

**Call relations**: Called by `plan_proxy_routes` while scanning the environment.

*Call graph*: called by 1 (plan_proxy_routes).


##### `parse_loopback_proxy_endpoint`  (lines 208–239)

```
fn parse_loopback_proxy_endpoint(proxy_url: &str) -> Option<SocketAddr>
```

**Purpose**: Parses a proxy URL or bare host:port string and returns a `SocketAddr` only if it targets a loopback host. It also supplies default ports based on proxy scheme when none is present.

**Data flow**: Reads `proxy_url`, prepends `http://` if no scheme is present, parses with `Url::parse`, extracts `host_str`, rejects non-loopback hosts via `is_loopback_host`, lowercases the scheme, chooses an explicit or default port via `default_proxy_port`, maps `localhost` to `127.0.0.1` or parses the host as `IpAddr`, and returns `Some(SocketAddr)` only when the resulting IP is loopback and the port is nonzero.

**Call relations**: Used by `plan_proxy_routes` to filter proxy env vars down to bridgeable loopback endpoints. Tests call it directly for parsing behavior.

*Call graph*: calls 1 internal fn (is_loopback_host); called by 2 (plan_proxy_routes, parses_loopback_proxy_endpoint); 4 external calls (V4, new, parse, format!).


##### `is_loopback_host`  (lines 241–243)

```
fn is_loopback_host(host: &str) -> bool
```

**Purpose**: Recognizes the host strings that are treated as loopback proxy endpoints. It accepts `localhost`, `127.0.0.1`, and `::1`.

**Data flow**: Reads `host: &str` and returns a boolean based on string comparison. It is pure.

**Call relations**: Called only by `parse_loopback_proxy_endpoint` as an early host filter.

*Call graph*: called by 1 (parse_loopback_proxy_endpoint).


##### `default_proxy_port`  (lines 245–251)

```
fn default_proxy_port(scheme: &str) -> u16
```

**Purpose**: Returns the conventional default port for a proxy scheme when the URL omits one. It distinguishes HTTPS and SOCKS variants from the HTTP default.

**Data flow**: Matches `scheme: &str` and returns `443` for `https`, `1080` for SOCKS schemes, and `80` otherwise. It is pure.

**Call relations**: Used by `parse_loopback_proxy_endpoint` when a parsed proxy URL has no explicit port.


##### `rewrite_proxy_env_value`  (lines 253–279)

```
fn rewrite_proxy_env_value(proxy_url: &str, local_port: u16) -> Option<String>
```

**Purpose**: Rewrites a proxy URL or bare host:port string so it points at `127.0.0.1:<local_port>` while preserving the rest of the URL structure. It keeps scheme omission and trailing-slash behavior compatible with the original value.

**Data flow**: Reads `proxy_url` and `local_port`, notes whether the original had a scheme, prepends `http://` if needed, parses with `Url::parse`, sets host to `127.0.0.1` and port to `local_port`, converts back to string, strips the synthetic `http://` prefix if the original lacked a scheme, and removes a trailing slash when the original lacked one and had no query/fragment. Returns `Option<String>`.

**Call relations**: Called by `activate_proxy_routes_in_netns` for each proxy env var after local bridges are started. Tests also call it directly to verify URL rewriting semantics.

*Call graph*: called by 2 (activate_proxy_routes_in_netns, rewrites_proxy_url_to_local_loopback_port); 2 external calls (parse, format!).


##### `create_proxy_socket_dir`  (lines 281–304)

```
fn create_proxy_socket_dir() -> io::Result<PathBuf>
```

**Purpose**: Allocates a fresh private directory for Unix-domain proxy sockets under the chosen parent directory. It retries candidate names derived from pid, uid, and an attempt counter.

**Data flow**: Reads the parent dir from `proxy_socket_parent_dir()`, current process id, and effective uid; loops up to 128 times constructing `codex-linux-sandbox-proxy-<pid>-<uid>-<attempt>`, creates it with mode `0o700` via `DirBuilder`, returns the first successful `PathBuf`, retries on `AlreadyExists`, and otherwise returns an error.

**Call relations**: Called by `prepare_host_proxy_route_spec` before assigning per-endpoint socket paths.

*Call graph*: calls 1 internal fn (proxy_socket_parent_dir); called by 1 (prepare_host_proxy_route_spec); 5 external calls (new, new, format!, geteuid, id).


##### `proxy_socket_parent_dir`  (lines 306–321)

```
fn proxy_socket_parent_dir() -> PathBuf
```

**Purpose**: Chooses the parent directory under which proxy socket directories should be created, preferring `CODEX_HOME/tmp` when it is private and path-length-safe. It falls back to the system temp dir or `/tmp` if necessary.

**Data flow**: Reads `CODEX_HOME` from the environment, constructs `<CODEX_HOME>/tmp`, checks `proxy_socket_paths_fit` and `ensure_private_proxy_socket_parent_dir`, and returns that path if usable. Otherwise it checks `std::env::temp_dir()` for path-length fit and returns it or `/tmp` as a final fallback.

**Call relations**: Used by both `prepare_host_proxy_route_spec` and `create_proxy_socket_dir` to determine where Unix sockets should live.

*Call graph*: calls 2 internal fn (ensure_private_proxy_socket_parent_dir, proxy_socket_paths_fit); called by 2 (create_proxy_socket_dir, prepare_host_proxy_route_spec); 3 external calls (from, temp_dir, var_os).


##### `proxy_socket_paths_fit`  (lines 323–332)

```
fn proxy_socket_paths_fit(parent: &Path) -> bool
```

**Purpose**: Checks whether the longest plausible proxy socket path under a candidate parent directory fits within Linux `sockaddr_un.sun_path` limits. This prevents runtime bind failures due to overlong Unix socket paths.

**Data flow**: Constructs a worst-case socket path under `parent` using maximal pid/uid/route-index formatting and returns whether its byte length is at most `UNIX_SOCKET_PATH_MAX_BYTES`. It is pure.

**Call relations**: Called by `proxy_socket_parent_dir` when evaluating candidate parent directories.

*Call graph*: called by 1 (proxy_socket_parent_dir); 2 external calls (join, format!).


##### `ensure_private_proxy_socket_parent_dir`  (lines 334–344)

```
fn ensure_private_proxy_socket_parent_dir(path: &Path) -> io::Result<()>
```

**Purpose**: Creates the proxy socket parent directory if needed and forces its permissions to `0700`. This ensures other processes cannot traverse the directory containing bridge sockets.

**Data flow**: Uses `DirBuilder` with `recursive(true)` and mode `0o700` to create `path`, tolerates `AlreadyExists`, then calls `std::fs::set_permissions(path, Permissions::from_mode(0o700))`. Returns `io::Result<()>`.

**Call relations**: Called by `proxy_socket_parent_dir` when considering `CODEX_HOME/tmp` as the preferred socket parent.

*Call graph*: called by 1 (proxy_socket_parent_dir); 3 external calls (new, from_mode, set_permissions).


##### `cleanup_stale_proxy_socket_dirs_in`  (lines 346–373)

```
fn cleanup_stale_proxy_socket_dirs_in(temp_dir: &Path) -> io::Result<()>
```

**Purpose**: Removes leftover proxy socket directories whose encoded owner pid is no longer alive. It opportunistically cleans stale bridge artifacts before allocating a new socket directory.

**Data flow**: Reads `temp_dir`, iterates `std::fs::read_dir(temp_dir)?`, skips unreadable entries and non-directories, parses each directory name with `parse_proxy_socket_dir_owner_pid`, checks liveness with `is_pid_alive`, and calls `cleanup_proxy_socket_dir` on dead-owner directories while ignoring cleanup errors. Returns `Ok(())` unless the initial directory read fails.

**Call relations**: Called by `prepare_host_proxy_route_spec` before creating a new socket dir, and directly by tests for stale-directory behavior.

*Call graph*: calls 3 internal fn (cleanup_proxy_socket_dir, is_pid_alive, parse_proxy_socket_dir_owner_pid); called by 2 (prepare_host_proxy_route_spec, cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories); 1 external calls (read_dir).


##### `parse_proxy_socket_dir_owner_pid`  (lines 375–379)

```
fn parse_proxy_socket_dir_owner_pid(file_name: &str) -> Option<u32>
```

**Purpose**: Extracts the owner pid from a proxy socket directory name. It understands both the older `prefix<pid>-0` shape and the newer `prefix<pid>-<uid>-<attempt>` shape.

**Data flow**: Strips `PROXY_SOCKET_DIR_PREFIX`, splits once on `-`, parses the first segment as `u32`, filters out zero, and returns `Option<u32>`. It is pure.

**Call relations**: Used by `cleanup_stale_proxy_socket_dirs_in` to decide whether a directory belongs to a dead process.

*Call graph*: called by 1 (cleanup_stale_proxy_socket_dirs_in).


##### `is_pid_alive`  (lines 381–386)

```
fn is_pid_alive(pid: u32) -> bool
```

**Purpose**: Checks whether a `u32` pid corresponds to a live process, safely handling values that do not fit `libc::pid_t`. It is a typed wrapper around the raw liveness probe.

**Data flow**: Attempts `libc::pid_t::try_from(pid)`, returns false on conversion failure, otherwise delegates to `is_pid_alive_raw(pid)`. It is pure aside from the delegated kernel probe.

**Call relations**: Called by stale-directory cleanup after parsing owner pids from directory names.

*Call graph*: calls 1 internal fn (is_pid_alive_raw); called by 1 (cleanup_stale_proxy_socket_dirs_in); 1 external calls (try_from).


##### `is_pid_alive_raw`  (lines 388–395)

```
fn is_pid_alive_raw(pid: libc::pid_t) -> bool
```

**Purpose**: Performs the actual process-liveness probe using `kill(pid, 0)`. It treats any error other than `ESRCH` as evidence that the process still exists.

**Data flow**: Calls `libc::kill(pid, 0)`, returns true on success, otherwise reads `io::Error::last_os_error()` and returns false only for `ESRCH`. It is pure.

**Call relations**: Used by `is_pid_alive` and by the cleanup worker that waits for host bridge processes to exit.

*Call graph*: called by 1 (is_pid_alive); 3 external calls (last_os_error, kill, matches!).


##### `spawn_proxy_socket_dir_cleanup_worker`  (lines 397–423)

```
fn spawn_proxy_socket_dir_cleanup_worker(
    socket_dir: PathBuf,
    host_bridge_pids: Vec<libc::pid_t>,
) -> io::Result<()>
```

**Purpose**: Forks a detached worker that waits for all host bridge processes to die and then removes the proxy socket directory. This decouples directory cleanup from the main helper process lifetime.

**Data flow**: Consumes `socket_dir` and `host_bridge_pids`, forks, returns an OS error on fork failure, and in the child loops sleeping 100 ms until all bridge pids are no longer alive, then calls `cleanup_proxy_socket_dir(socket_dir.as_path())` and `_exit(0)`. The parent returns `Ok(())` immediately.

**Call relations**: Called by `prepare_host_proxy_route_spec` after all host bridges have been spawned.

*Call graph*: calls 1 internal fn (cleanup_proxy_socket_dir); called by 1 (prepare_host_proxy_route_spec); 6 external calls (from_millis, as_path, last_os_error, _exit, fork, sleep).


##### `cleanup_proxy_socket_dir`  (lines 425–439)

```
fn cleanup_proxy_socket_dir(socket_dir: &Path) -> io::Result<()>
```

**Purpose**: Removes a proxy socket directory and its contents, retrying briefly to tolerate transient races with bridge shutdown. It treats missing directories as already cleaned up.

**Data flow**: Attempts `std::fs::remove_dir_all(socket_dir)` up to 20 times, sleeping 100 ms between non-`NotFound` failures, then performs one final attempt and returns `Ok(())` on success or `NotFound`, otherwise the final error.

**Call relations**: Used by stale-directory cleanup, the cleanup worker, and tests. It is the common filesystem cleanup primitive for proxy socket directories.

*Call graph*: called by 3 (cleanup_stale_proxy_socket_dirs_in, spawn_proxy_socket_dir_cleanup_worker, cleanup_proxy_socket_dir_removes_bridge_artifacts); 3 external calls (from_millis, remove_dir_all, sleep).


##### `spawn_host_bridge`  (lines 441–472)

```
fn spawn_host_bridge(endpoint: SocketAddr, uds_path: &Path) -> io::Result<libc::pid_t>
```

**Purpose**: Forks a host-side bridge process that listens on a Unix socket and forwards connections to the original loopback TCP proxy endpoint. It waits for a one-byte readiness acknowledgment before returning.

**Data flow**: Creates a ready pipe with `create_ready_pipe`, forks, closes both pipe ends and returns an error on fork failure, and in the child closes the read end, runs `run_host_bridge(endpoint, uds_path, write_fd)`, and `_exit`s with 0/1 based on success. In the parent it closes the write end, wraps the read end in `File::from_raw_fd`, reads one readiness byte, validates it equals `HOST_BRIDGE_READY`, and returns the child pid.

**Call relations**: Called by `prepare_host_proxy_route_spec` once per unique endpoint. It delegates the actual bridge server loop to `run_host_bridge`.

*Call graph*: calls 3 internal fn (close_fd, create_ready_pipe, run_host_bridge); called by 1 (prepare_host_proxy_route_spec); 5 external calls (from_raw_fd, last_os_error, other, _exit, fork).


##### `run_host_bridge`  (lines 474–495)

```
fn run_host_bridge(endpoint: SocketAddr, uds_path: &Path, ready_fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Runs the host-side bridge server loop in the forked child process. It binds the Unix socket, signals readiness, and spawns a thread per accepted Unix connection to connect outward to the real TCP proxy.

**Data flow**: Reads `endpoint`, `uds_path`, and `ready_fd`; hardens the process, removes any pre-existing socket file at `uds_path`, binds a `UnixListener`, writes `HOST_BRIDGE_READY` to `ready_fd` via `File::from_raw_fd`, then loops accepting Unix connections and spawning threads that connect `TcpStream::connect(endpoint)` and call `proxy_bidirectional(tcp_stream, unix_stream)`, silently dropping failed outbound connects.

**Call relations**: Executed only in the child branch of `spawn_host_bridge`. It is the long-lived host-side transport endpoint for managed proxy routing.

*Call graph*: calls 2 internal fn (harden_bridge_process, bind); called by 1 (spawn_host_bridge); 4 external calls (from_raw_fd, exists, remove_file, spawn).


##### `spawn_local_bridge`  (lines 497–523)

```
fn spawn_local_bridge(uds_path: &Path) -> io::Result<u16>
```

**Purpose**: Forks a sandbox-side bridge process that listens on a local loopback TCP port and forwards connections to a host-side Unix socket bridge. It returns the chosen local port to the caller.

**Data flow**: Creates a ready pipe, forks, handles fork failure by closing fds and returning an error, and in the child closes the read end, runs `run_local_bridge(uds_path, write_fd)`, and `_exit`s with 0/1. In the parent it closes the write end, reads two bytes from the pipe via `File::from_raw_fd`, interprets them as a big-endian `u16`, and returns that port.

**Call relations**: Called by `activate_proxy_routes_in_netns` once per unique UDS path. It delegates the actual listener loop to `run_local_bridge`.

*Call graph*: calls 3 internal fn (close_fd, create_ready_pipe, run_local_bridge); called by 1 (activate_proxy_routes_in_netns); 5 external calls (from_raw_fd, last_os_error, _exit, fork, from_be_bytes).


##### `run_local_bridge`  (lines 525–546)

```
fn run_local_bridge(uds_path: &Path, ready_fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Runs the sandbox-side bridge server loop in the forked child process. It binds a loopback TCP listener, reports the chosen port, and spawns a thread per accepted TCP connection to connect to the host-side Unix socket.

**Data flow**: Hardens the process, obtains a `TcpListener` from `bind_local_loopback_listener`, reads its assigned port, writes that port to `ready_fd`, clones `uds_path` into owned storage, then loops accepting TCP connections and spawning threads that connect `UnixStream::connect(socket_path)` and call `proxy_bidirectional(tcp_stream, unix_stream)`, silently dropping failed Unix connects.

**Call relations**: Executed only in the child branch of `spawn_local_bridge`. It is the in-namespace transport endpoint that rewritten proxy env vars point to.

*Call graph*: calls 2 internal fn (bind_local_loopback_listener, harden_bridge_process); called by 1 (spawn_local_bridge); 4 external calls (from_raw_fd, clone, to_path_buf, spawn).


##### `bind_local_loopback_listener`  (lines 548–564)

```
fn bind_local_loopback_listener() -> io::Result<TcpListener>
```

**Purpose**: Binds a TCP listener on `127.0.0.1:0`, retrying after bringing up the loopback interface when the namespace initially lacks a usable loopback device. This handles isolated network namespaces where `lo` starts down.

**Data flow**: Attempts `TcpListener::bind((Ipv4Addr::LOCALHOST, 0))`; on success returns the listener. On `EADDRNOTAVAIL` or `ENETUNREACH`, it calls `ensure_loopback_interface_up()` and retries the bind once; on other errors it returns the original bind error.

**Call relations**: Called by `run_local_bridge` before the sandbox-side bridge starts accepting connections.

*Call graph*: calls 1 internal fn (ensure_loopback_interface_up); called by 1 (run_local_bridge); 2 external calls (bind, matches!).


##### `ensure_loopback_interface_up`  (lines 566–626)

```
fn ensure_loopback_interface_up() -> io::Result<()>
```

**Purpose**: Brings the `lo` interface up and ensures it has the loopback address configured inside the current namespace. It uses raw socket ioctls because this runs before any external tooling is available.

**Data flow**: Opens an `AF_INET` datagram socket, fills an `ifreq` with interface name `lo`, reads flags with `SIOCGIFFLAGS`, sets `IFF_UP` with `SIOCSIFFLAGS` if needed, prepares another `ifreq` containing `127.0.0.1`, attempts `SIOCSIFADDR`, tolerates `EEXIST` and `EPERM` for already-present or immutable addresses, and closes the socket via `close_fd`. Returns `io::Result<()>`.

**Call relations**: Called only by `bind_local_loopback_listener` when the initial loopback bind suggests the interface is unavailable in the namespace.

*Call graph*: calls 1 internal fn (close_fd); called by 1 (bind_local_loopback_listener); 5 external calls (last_os_error, htonl, ioctl, socket, matches!).


##### `set_parent_death_signal`  (lines 628–637)

```
fn set_parent_death_signal() -> io::Result<()>
```

**Purpose**: Configures the current process to receive `SIGTERM` if its parent dies and rejects the setup if the parent is already gone. This prevents orphaned bridge processes.

**Data flow**: Calls `prctl(PR_SET_PDEATHSIG, SIGTERM)`, returns `last_os_error()` on failure, then checks `getppid() == 1` and returns an `io::Error::other("parent process already exited")` if so, otherwise returns `Ok(())`.

**Call relations**: Used by `harden_bridge_process` before bridge loops begin.

*Call graph*: called by 1 (harden_bridge_process); 4 external calls (last_os_error, other, getppid, prctl).


##### `harden_bridge_process`  (lines 639–642)

```
fn harden_bridge_process() -> io::Result<()>
```

**Purpose**: Applies basic hardening to bridge subprocesses by tying their lifetime to the parent and disabling process dumping. It centralizes the common setup for both host and local bridges.

**Data flow**: Calls `set_parent_death_signal()?` and `codex_process_hardening::disable_process_dumping()`, returning `io::Result<()>`. It mutates process attributes in the bridge child.

**Call relations**: Called at the start of both `run_host_bridge` and `run_local_bridge`.

*Call graph*: calls 1 internal fn (set_parent_death_signal); called by 2 (run_host_bridge, run_local_bridge); 1 external calls (disable_process_dumping).


##### `proxy_bidirectional`  (lines 644–655)

```
fn proxy_bidirectional(mut tcp_stream: TcpStream, mut unix_stream: UnixStream) -> io::Result<()>
```

**Purpose**: Copies bytes in both directions between a TCP stream and a Unix stream until EOF or error. It is the core transport primitive used by both bridge types.

**Data flow**: Takes owned `TcpStream` and `UnixStream`, clones each side as needed so one direction can run in a spawned thread, starts a thread copying TCP->Unix, performs Unix->TCP copy on the current thread, joins the spawned thread and converts a panic into `io::Error::other`, propagates any copy errors, and returns `Ok(())` on clean completion.

**Call relations**: Used by per-connection threads in both `run_host_bridge` and `run_local_bridge` to implement actual proxy traffic forwarding.

*Call graph*: 4 external calls (try_clone, copy, spawn, try_clone).


##### `create_ready_pipe`  (lines 657–664)

```
fn create_ready_pipe() -> io::Result<(libc::c_int, libc::c_int)>
```

**Purpose**: Creates a close-on-exec pipe used for parent/child readiness handshakes when spawning bridge processes. It returns the raw read and write fds.

**Data flow**: Allocates a two-element fd array, calls `libc::pipe2(..., O_CLOEXEC)`, returns `last_os_error()` on failure, and otherwise returns `(read_fd, write_fd)`.

**Call relations**: Used by both `spawn_host_bridge` and `spawn_local_bridge` to communicate readiness or chosen port numbers from child to parent.

*Call graph*: called by 2 (spawn_host_bridge, spawn_local_bridge); 2 external calls (last_os_error, pipe2).


##### `close_fd`  (lines 666–672)

```
fn close_fd(fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Closes a raw file descriptor and returns an `io::Result` instead of panicking. It is the small fd-management helper used throughout bridge setup.

**Data flow**: Calls `libc::close(fd)`, returns `last_os_error()` on negative result, otherwise `Ok(())`. It mutates kernel fd state.

**Call relations**: Used by loopback-interface setup and by both bridge-spawning functions when cleaning up pipe/socket fds.

*Call graph*: called by 3 (ensure_loopback_interface_up, spawn_host_bridge, spawn_local_bridge); 2 external calls (last_os_error, close).


##### `tests::recognizes_proxy_env_keys_case_insensitively`  (lines 694–698)

```
fn recognizes_proxy_env_keys_case_insensitively()
```

**Purpose**: Verifies that supported proxy environment keys are matched regardless of case and that unrelated keys are rejected. This documents the env-key filter behavior.

**Data flow**: Calls `is_proxy_env_key` on uppercase, lowercase, and unrelated keys and asserts the expected booleans.

**Call relations**: Exercises the pure key-recognition helper used by route planning.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_loopback_proxy_endpoint`  (lines 701–711)

```
fn parses_loopback_proxy_endpoint()
```

**Purpose**: Checks that a loopback proxy URL parses into the expected `SocketAddr`. It validates the positive parsing path.

**Data flow**: Calls `parse_loopback_proxy_endpoint("http://127.0.0.1:43128")` and asserts it equals the parsed socket address.

**Call relations**: Directly tests the endpoint parser used by `plan_proxy_routes`.

*Call graph*: calls 1 internal fn (parse_loopback_proxy_endpoint); 1 external calls (assert_eq!).


##### `tests::ignores_non_loopback_proxy_endpoint`  (lines 714–719)

```
fn ignores_non_loopback_proxy_endpoint()
```

**Purpose**: Verifies that non-loopback proxy URLs are ignored rather than bridged. This enforces the security boundary that only loopback proxies are managed.

**Data flow**: Calls `parse_loopback_proxy_endpoint("http://example.com:3128")` and asserts it returns `None`.

**Call relations**: Covers the negative host-filter branch of the endpoint parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plan_proxy_routes_only_includes_valid_loopback_endpoints`  (lines 722–744)

```
fn plan_proxy_routes_only_includes_valid_loopback_endpoints()
```

**Purpose**: Checks that route planning includes only supported proxy env vars with valid loopback endpoints and still records that proxy configuration existed. It validates filtering and `has_proxy_config` semantics together.

**Data flow**: Builds a `HashMap` containing one valid loopback proxy, one non-loopback proxy, and one unrelated key; calls `plan_proxy_routes`; asserts `has_proxy_config` is true, route count is 1, and the remaining route matches the valid env key and endpoint.

**Call relations**: Exercises the main environment-scanning logic used by `prepare_host_proxy_route_spec`.

*Call graph*: calls 1 internal fn (plan_proxy_routes); 2 external calls (new, assert_eq!).


##### `tests::rewrites_proxy_url_to_local_loopback_port`  (lines 747–752)

```
fn rewrites_proxy_url_to_local_loopback_port()
```

**Purpose**: Verifies that proxy URL rewriting preserves the scheme while replacing the endpoint with the sandbox-local loopback port. This is the core env-rewrite behavior used inside the namespace.

**Data flow**: Calls `rewrite_proxy_env_value("socks5h://127.0.0.1:8081", 43210)` and asserts the result is `socks5h://127.0.0.1:43210`.

**Call relations**: Directly tests the URL-rewrite helper used by `activate_proxy_routes_in_netns`.

*Call graph*: calls 1 internal fn (rewrite_proxy_env_value); 1 external calls (assert_eq!).


##### `tests::default_proxy_ports_match_expected_schemes`  (lines 755–759)

```
fn default_proxy_ports_match_expected_schemes()
```

**Purpose**: Checks the default-port mapping for common proxy schemes. This ensures omitted-port URLs are interpreted consistently.

**Data flow**: Calls `default_proxy_port` for `http`, `https`, and `socks5h` and asserts the expected numeric ports.

**Call relations**: Exercises the scheme-to-port helper used by endpoint parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::proxy_socket_paths_enforce_linux_path_limit`  (lines 762–771)

```
fn proxy_socket_paths_enforce_linux_path_limit()
```

**Purpose**: Verifies that the Unix-socket path-length check accepts short parent directories and rejects overly long ones. This protects bridge socket creation from `sockaddr_un` truncation issues.

**Data flow**: Calls `proxy_socket_paths_fit` on `/tmp` and on an artificially long `/tmp/<96 a's>` path and asserts true then false.

**Call relations**: Tests the path-length guard used by `proxy_socket_parent_dir`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::cleanup_proxy_socket_dir_removes_bridge_artifacts`  (lines 774–784)

```
fn cleanup_proxy_socket_dir_removes_bridge_artifacts()
```

**Purpose**: Checks that proxy socket directory cleanup removes the directory and its contents. It validates the filesystem cleanup primitive used by stale cleanup and the detached worker.

**Data flow**: Creates a temp root, a socket dir, and a marker file inside it; calls `cleanup_proxy_socket_dir`; then asserts the socket dir no longer exists.

**Call relations**: Exercises the common cleanup helper used after bridge processes exit.

*Call graph*: calls 1 internal fn (cleanup_proxy_socket_dir); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `tests::proxy_route_spec_serialization_omits_proxy_urls`  (lines 787–800)

```
fn proxy_route_spec_serialization_omits_proxy_urls()
```

**Purpose**: Verifies that serialized proxy route specs contain only env keys and Unix socket paths, not the original proxy URLs. This documents the privacy/minimality of the handoff format.

**Data flow**: Constructs a `ProxyRouteSpec` with one `ProxyRouteEntry`, serializes it with `serde_json::to_string`, and asserts the exact JSON string lacks any proxy URL field.

**Call relations**: Tests the data model emitted by `prepare_host_proxy_route_spec` and consumed by `activate_proxy_routes_in_netns`.

*Call graph*: 3 external calls (assert_eq!, to_string, vec!).


##### `tests::parse_proxy_socket_dir_owner_pid_reads_owner_pid`  (lines 803–817)

```
fn parse_proxy_socket_dir_owner_pid_reads_owner_pid()
```

**Purpose**: Checks that owner pid parsing works for both supported directory-name formats and rejects malformed names. This supports stale-directory cleanup correctness.

**Data flow**: Calls `parse_proxy_socket_dir_owner_pid` on several sample names and asserts the expected `Some(pid)` or `None` results.

**Call relations**: Exercises the parser used by `cleanup_stale_proxy_socket_dirs_in`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories`  (lines 820–840)

```
fn cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories()
```

**Purpose**: Verifies that stale proxy socket cleanup removes directories owned by dead pids while preserving directories for the current live pid and unrelated names. This validates the opportunistic cleanup behavior before new bridge setup.

**Data flow**: Creates a temp root containing a dead-owner proxy dir, a live-owner proxy dir named with `std::process::id()`, and an unrelated dir; runs `cleanup_stale_proxy_socket_dirs_in`; then asserts the dead dir is gone while the live and unrelated dirs remain.

**Call relations**: Exercises the full stale-directory cleanup flow used by `prepare_host_proxy_route_spec`.

*Call graph*: calls 1 internal fn (cleanup_stale_proxy_socket_dirs_in); 4 external calls (assert_eq!, format!, create_dir, tempdir).


### `tui/src/ide_context/windows_pipe.rs`

`io_transport` · `request handling`

This module is the Windows counterpart to the Unix IPC transport. `WindowsPipeStream` wraps an `OwnedHandle` for the named pipe plus an absolute deadline. `connect` converts the pipe path to a null-terminated UTF-16 string, opens it with `CreateFileW` using overlapped I/O flags, then calls `validate_pipe_server_owner` to ensure the server process runs as the same user before returning the stream. Reads and writes are implemented with `ReadFile` and `WriteFile` in overlapped mode via `OverlappedOperation`, which owns an event handle and `OVERLAPPED` struct. `complete` handles the common pattern: if the initial syscall returns `ERROR_IO_PENDING`, it waits on the event until the remaining deadline, cancels on timeout with `CancelIoEx`, drains completion state safely with `GetOverlappedResult`, and returns either bytes transferred or a timeout/error. `OwnedHandle` closes Win32 handles on drop, preventing leaks across all helper types. Security validation uses `GetNamedPipeServerProcessId`, opens the server process token and current process token, extracts `TOKEN_USER` data into `TokenUserBuffer`, and compares SIDs with `EqualSid`; mismatches become `PermissionDenied`. The module also includes small helpers for remaining timeout conversion and constructing the standard timeout `io::Error`. Overall, it encapsulates the unsafe Win32 details needed so the higher-level IPC code can treat Windows pipes like a deadline-aware byte stream.

#### Function details

##### `WindowsPipeStream::connect`  (lines 56–82)

```
fn connect(pipe_path: PathBuf, deadline: Instant) -> io::Result<Self>
```

**Purpose**: Opens the IDE-context named pipe in overlapped mode and verifies the server process belongs to the current user.

**Data flow**: Consumes a pipe `PathBuf` and deadline, encodes the path as null-terminated UTF-16, calls `CreateFileW` with read/write sharing and `FILE_FLAG_OVERLAPPED`, wraps the resulting handle in `OwnedHandle`, validates ownership with `validate_pipe_server_owner`, and returns `WindowsPipeStream { handle, deadline }` or an `io::Error`.

**Call relations**: Called by the Windows `connect_stream` adapter in `ipc.rs`. It performs both connection establishment and security validation before higher-level framing begins.

*Call graph*: calls 1 internal fn (validate_pipe_server_owner); called by 1 (connect_stream); 5 external calls (as_os_str, last_os_error, null, once, CreateFileW).


##### `WindowsPipeStream::set_deadline`  (lines 84–86)

```
fn set_deadline(&mut self, deadline: Instant)
```

**Purpose**: Updates the absolute deadline used by subsequent overlapped operations.

**Data flow**: Mutably stores the provided `Instant` in `self.deadline`.

**Call relations**: Called from the shared response loop so each frame read uses the current request deadline.


##### `WindowsPipeStream::read`  (lines 90–108)

```
fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>
```

**Purpose**: Performs one deadline-aware overlapped read from the named pipe.

**Data flow**: If `buf` is empty returns 0; otherwise converts the buffer length to `u32`, creates an `OverlappedOperation`, calls `ReadFile` with a null immediate-byte-count pointer and the operation’s `OVERLAPPED`, then delegates completion handling to `operation.complete(self.handle.raw(), result, self.deadline)`.

**Call relations**: Used by the shared IPC framing code through the standard `Read` trait.

*Call graph*: calls 2 internal fn (new, raw); 3 external calls (null_mut, try_from, ReadFile).


##### `WindowsPipeStream::write`  (lines 112–130)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Performs one deadline-aware overlapped write to the named pipe.

**Data flow**: If `buf` is empty returns 0; otherwise converts the length to `u32`, creates an `OverlappedOperation`, calls `WriteFile` with the operation’s `OVERLAPPED`, and delegates completion handling to `operation.complete`.

**Call relations**: Used by the shared IPC framing code through the standard `Write` trait.

*Call graph*: calls 2 internal fn (new, raw); 3 external calls (null_mut, try_from, WriteFile).


##### `WindowsPipeStream::flush`  (lines 132–134)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements `Write::flush` as a no-op because writes are already completed explicitly.

**Data flow**: Returns `Ok(())` without touching the pipe handle.

**Call relations**: Called by `write_frame` after writing a complete frame.


##### `OverlappedOperation::new`  (lines 143–155)

```
fn new() -> io::Result<Self>
```

**Purpose**: Allocates the event and zeroed `OVERLAPPED` state needed for one asynchronous pipe operation.

**Data flow**: Calls `CreateEventW` to create a manual-reset event, errors if creation fails, zero-initializes an `OVERLAPPED`, stores the event handle in `overlapped.hEvent`, wraps the event in `OwnedHandle`, and returns the new operation.

**Call relations**: Constructed by both `WindowsPipeStream::read` and `WindowsPipeStream::write` for each I/O call.

*Call graph*: called by 2 (read, write); 3 external calls (last_os_error, null, CreateEventW).


##### `OverlappedOperation::as_mut_ptr`  (lines 157–159)

```
fn as_mut_ptr(&mut self) -> *mut OVERLAPPED
```

**Purpose**: Exposes a mutable raw pointer to the embedded `OVERLAPPED` for Win32 APIs.

**Data flow**: Returns `&mut self.overlapped` as `*mut OVERLAPPED`.

**Call relations**: Used by `complete` and `cancel_and_timeout` when passing the operation state to Win32 functions.

*Call graph*: called by 2 (cancel_and_timeout, complete).


##### `OverlappedOperation::complete`  (lines 161–196)

```
fn complete(
        &mut self,
        handle: HANDLE,
        initial_result: BOOL,
        deadline: Instant,
    ) -> io::Result<usize>
```

**Purpose**: Finishes an overlapped read/write, waiting until the deadline and converting timeout/cancellation behavior into a normal `io::Result<usize>`.

**Data flow**: Accepts the pipe handle, initial syscall result, and deadline. If the initial result is failure, it checks `last_os_error`; non-`ERROR_IO_PENDING` errors are returned immediately. For pending I/O it waits on the event with `WaitForSingleObject(remaining_timeout_ms(deadline))`, timing out via `cancel_and_timeout`, erroring on `WAIT_FAILED`, and rejecting unexpected wait codes. It then calls `GetOverlappedResult` without waiting and returns the transferred byte count.

**Call relations**: Shared completion path for both reads and writes. It delegates timeout cleanup to `cancel_and_timeout`.

*Call graph*: calls 4 internal fn (as_mut_ptr, cancel_and_timeout, raw, remaining_timeout_ms); 5 external calls (last_os_error, other, format!, GetOverlappedResult, WaitForSingleObject).


##### `OverlappedOperation::cancel_and_timeout`  (lines 198–220)

```
fn cancel_and_timeout(&mut self, handle: HANDLE) -> io::Error
```

**Purpose**: Cancels a pending overlapped operation and returns the standard timeout error without leaking or reusing an in-flight `OVERLAPPED`.

**Data flow**: Calls `CancelIoEx(handle, overlapped_ptr)`. If cancellation reports `ERROR_NOT_FOUND`, it treats that as a race where the operation already completed, drains completion state with `GetOverlappedResult(..., FALSE)`, and returns `timeout_io_error()`. If cancellation succeeds, it drains completion with `GetOverlappedResult(..., TRUE)` and then returns `timeout_io_error()`. Other cancellation errors are returned directly.

**Call relations**: Called only by `complete` on wait timeout.

*Call graph*: calls 2 internal fn (as_mut_ptr, timeout_io_error); called by 1 (complete); 3 external calls (last_os_error, CancelIoEx, GetOverlappedResult).


##### `OwnedHandle::raw`  (lines 226–228)

```
fn raw(&self) -> HANDLE
```

**Purpose**: Returns the underlying Win32 `HANDLE` without transferring ownership.

**Data flow**: Reads and returns `self.0`.

**Call relations**: Used throughout the module wherever Win32 APIs need the raw handle value.

*Call graph*: called by 3 (complete, read, write).


##### `OwnedHandle::drop`  (lines 232–238)

```
fn drop(&mut self)
```

**Purpose**: Closes owned Win32 handles automatically when wrapper values go out of scope.

**Data flow**: On drop, checks that the handle is neither null nor `INVALID_HANDLE_VALUE`, then calls `CloseHandle`.

**Call relations**: Provides RAII cleanup for pipe handles, event handles, process handles, and token handles created elsewhere in the module.

*Call graph*: 1 external calls (CloseHandle).


##### `TokenUserBuffer::sid`  (lines 246–260)

```
fn sid(&self) -> io::Result<windows_sys::Win32::Foundation::PSID>
```

**Purpose**: Extracts the SID pointer from a raw `TOKEN_USER` byte buffer returned by `GetTokenInformation`.

**Data flow**: Checks the buffer is at least `size_of::<TOKEN_USER>()`, performs an unaligned read of the fixed `TOKEN_USER` header from the `Vec<u8>`, and returns `token_user.User.Sid` or an `InvalidData` error if the buffer is too small.

**Call relations**: Used by `validate_pipe_server_owner` after `token_user` fetches token information for the server and current process.

*Call graph*: 2 external calls (new, read_unaligned).


##### `validate_pipe_server_owner`  (lines 263–289)

```
fn validate_pipe_server_owner(pipe_handle: HANDLE) -> io::Result<()>
```

**Purpose**: Ensures the named-pipe server process is running as the same user as the current TUI process.

**Data flow**: Calls `GetNamedPipeServerProcessId` to find the server pid, opens that process with `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, opens both server and current process tokens via `open_process_token`, fetches `TOKEN_USER` buffers via `token_user`, extracts SIDs with `sid()`, compares them with `EqualSid`, and returns `PermissionDenied` if they differ.

**Call relations**: Called by `WindowsPipeStream::connect` immediately after opening the pipe handle.

*Call graph*: calls 2 internal fn (open_process_token, token_user); called by 1 (connect); 6 external calls (last_os_error, new, EqualSid, GetNamedPipeServerProcessId, GetCurrentProcess, OpenProcess).


##### `open_process_token`  (lines 291–299)

```
fn open_process_token(process: HANDLE) -> io::Result<OwnedHandle>
```

**Purpose**: Opens a process token for querying user identity.

**Data flow**: Calls `OpenProcessToken(process, TOKEN_QUERY, &mut token)`, wraps the resulting token handle in `OwnedHandle`, and returns it or the last OS error.

**Call relations**: Used by `validate_pipe_server_owner` for both the server process and the current process.

*Call graph*: called by 1 (validate_pipe_server_owner); 2 external calls (last_os_error, OpenProcessToken).


##### `token_user`  (lines 301–325)

```
fn token_user(token: HANDLE) -> io::Result<TokenUserBuffer>
```

**Purpose**: Fetches the `TokenUser` information block for a process token into an owned byte buffer.

**Data flow**: Calls `GetTokenInformation` once with a null buffer to obtain `return_length`, allocates a `Vec<u8>` of that size, calls `GetTokenInformation` again to fill it, and returns `TokenUserBuffer { buffer }` or an OS error.

**Call relations**: Used by `validate_pipe_server_owner` before SID extraction and comparison.

*Call graph*: called by 1 (validate_pipe_server_owner); 4 external calls (last_os_error, null_mut, vec!, GetTokenInformation).


##### `remaining_timeout_ms`  (lines 327–335)

```
fn remaining_timeout_ms(deadline: Instant) -> u32
```

**Purpose**: Computes the remaining time until a deadline as a `u32` millisecond timeout for Win32 wait APIs.

**Data flow**: Compares `Instant::now()` to the deadline, returns 0 if expired, otherwise computes `deadline.duration_since(now).as_millis().max(1)`, saturates into `u32`, and returns it.

**Call relations**: Used by `OverlappedOperation::complete` when waiting on the event handle.

*Call graph*: called by 1 (complete); 3 external calls (duration_since, now, try_from).


##### `timeout_io_error`  (lines 337–339)

```
fn timeout_io_error() -> io::Error
```

**Purpose**: Creates the standard timeout `io::Error` used by the Windows pipe transport.

**Data flow**: Returns `io::Error::new(io::ErrorKind::TimedOut, "timed out waiting for IDE context")`.

**Call relations**: Used by `cancel_and_timeout` so timeout behavior matches the Unix transport and shared IPC expectations.

*Call graph*: called by 1 (cancel_and_timeout); 1 external calls (new).


### `tui/src/ide_context/ipc.rs`

`io_transport` · `request handling`

This module is the low-level transport layer behind `/ide`. It defines `IdeContextError`, whose variants distinguish connect/send/read/parse/request-failure cases and expose two hint methods: `user_facing_hint` for explicit `/ide` failures and `prompt_skip_hint` for silent prompt-time skips. On Unix and Windows, `fetch_ide_context` resolves the default socket/pipe path, applies a five-second request budget, connects, sends a framed JSON `ide-context` request tagged with `sourceClientId = "codex-tui"`, then loops reading framed messages until it finds the matching response. The response loop intentionally tolerates unrelated broadcasts, answers inbound unsupported requests with `no-handler-for-request`, and replies to client-discovery probes with `canHandle: false`, so the TUI behaves as a passive client on the shared IPC channel. Unix transport is implemented by `UnixDeadlineStream`, which wraps a nonblocking `UnixStream` plus an absolute deadline and uses `poll` for readiness instead of socket timeouts; connection setup validates socket path ownership/permissions and peer UID to avoid trusting another user’s socket. Framing is length-prefixed little-endian `u32`, capped at `MAX_IPC_FRAME_BYTES`, with explicit deadline checks between partial reads. Once a response arrives, `ensure_success_response` validates `resultType`, and `extract_ide_context` deserializes `result.ideContext` into the shared `IdeContext` model. The tests simulate a Unix server to verify timeout behavior, unsafe socket rejection, and mixed-message routing before the final response.

#### Function details

##### `IdeContextError::user_facing_hint`  (lines 120–122)

```
fn user_facing_hint(&self) -> String
```

**Purpose**: Maps transport and protocol failures into concise user-facing guidance for explicit `/ide` commands.

**Data flow**: Reads the error variant and, for Unix/Windows builds, returns a `String` tailored to connect failures, known request-failure codes, oversized responses, send/read/parse failures, or generic unsupported-platform text on other targets.

**Call relations**: Called by higher-level UI code after `fetch_ide_context` fails. It does not perform transport work itself; it translates already-classified errors into actionable text.

*Call graph*: 1 external calls (format!).


##### `IdeContextError::prompt_skip_hint`  (lines 125–127)

```
fn prompt_skip_hint(&self) -> String
```

**Purpose**: Produces a softer hint string for prompt-time IDE-context failures where Codex should continue without context and retry later.

**Data flow**: Matches on the error variant and returns a `String`, often via `hint_with_retry`, with special handling for timeout, client disconnect, version mismatch, unsupported request handlers, oversized selections, and connect failures.

**Call relations**: Used when IDE context is optional during prompt submission. It builds on the same error classification as `user_facing_hint` but emphasizes retry semantics.

*Call graph*: calls 1 internal fn (hint_with_retry).


##### `hint_with_retry`  (lines 131–133)

```
fn hint_with_retry(message: &str) -> String
```

**Purpose**: Appends the shared retry sentence to a base IDE-context failure message.

**Data flow**: Accepts a message `&str`, formats `"{message} {KEEP_TRYING_HINT}"`, and returns the resulting `String`.

**Call relations**: A small helper used by `IdeContextError::prompt_skip_hint` to keep retry wording consistent across several failure cases.

*Call graph*: called by 1 (prompt_skip_hint); 1 external calls (format!).


##### `fetch_ide_context`  (lines 151–153)

```
fn fetch_ide_context(_workspace_root: &Path) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Public entry point that fetches IDE context for a workspace root using the platform’s default IPC endpoint and timeout budget.

**Data flow**: Accepts `&Path workspace_root`, computes the default socket/pipe path with `default_ipc_socket_path`, forwards to `fetch_ide_context_from_socket` with `IDE_CONTEXT_REQUEST_TIMEOUT`, and returns `Result<IdeContext, IdeContextError>`.

**Call relations**: Re-exported by `ide_context.rs` and called by `/ide`-related flows. It delegates all actual connection and framing work to `fetch_ide_context_from_socket`.

*Call graph*: calls 2 internal fn (default_ipc_socket_path, fetch_ide_context_from_socket).


##### `default_ipc_socket_path`  (lines 169–171)

```
fn default_ipc_socket_path() -> PathBuf
```

**Purpose**: Computes the platform-specific IPC endpoint path used for IDE-context requests.

**Data flow**: On Unix, reads the current uid and returns `<temp>/codex-ipc/ipc-<uid>.sock`; on Windows, returns `\\.\pipe\codex-ipc`; on unsupported platforms, returns an empty `PathBuf`.

**Call relations**: Used only by `fetch_ide_context` so callers do not need to know endpoint naming conventions.

*Call graph*: called by 1 (fetch_ide_context); 5 external calls (from, new, format!, getuid, temp_dir).


##### `fetch_ide_context_from_socket`  (lines 174–182)

```
fn fetch_ide_context_from_socket(
    socket_path: PathBuf,
    workspace_root: &Path,
    timeout: Duration,
) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Connects to a specific IPC endpoint with an absolute deadline and fetches one `IdeContext` response.

**Data flow**: Accepts a socket/pipe `PathBuf`, workspace root, and timeout `Duration`; computes `deadline = Instant::now() + timeout`; opens a stream via `connect_stream`; then passes the mutable stream, workspace root, and deadline to `fetch_ide_context_from_stream`, returning its result.

**Call relations**: This is the core orchestration step beneath `fetch_ide_context` and the Unix integration test. It separates endpoint selection from request/response exchange.

*Call graph*: calls 2 internal fn (connect_stream, fetch_ide_context_from_stream); called by 2 (fetch_ide_context, fetch_ide_context_uses_unregistered_request_route); 1 external calls (now).


##### `UnixDeadlineStream::connect`  (lines 200–204)

```
fn connect(socket_path: PathBuf, deadline: Instant) -> std::io::Result<Self>
```

**Purpose**: Creates a Unix IPC stream before the deadline and validates that the peer belongs to the current user.

**Data flow**: Accepts a socket path and deadline, opens a nonblocking Unix stream via `connect_unix_stream_before_deadline`, validates peer ownership with `validate_unix_peer_owner`, wraps the stream and deadline in `UnixDeadlineStream`, and returns it.

**Call relations**: Called by Unix `connect_stream`. It combines connection establishment and security validation before higher-level framing begins.

*Call graph*: calls 2 internal fn (connect_unix_stream_before_deadline, validate_unix_peer_owner); called by 1 (connect_stream); 1 external calls (new).


##### `UnixDeadlineStream::new`  (lines 206–208)

```
fn new(stream: std::os::unix::net::UnixStream, deadline: Instant) -> Self
```

**Purpose**: Constructs a `UnixDeadlineStream` from an already-open `UnixStream` and deadline.

**Data flow**: Stores the provided stream and deadline in the struct and returns `Self`.

**Call relations**: Used internally by `UnixDeadlineStream::connect` and directly by the timeout test to bypass socket-path setup.

*Call graph*: called by 1 (unix_deadline_stream_uses_remaining_deadline_for_blocking_reads).


##### `UnixDeadlineStream::set_deadline`  (lines 210–212)

```
fn set_deadline(&mut self, deadline: Instant)
```

**Purpose**: Updates the absolute deadline used by subsequent blocking read/write readiness waits.

**Data flow**: Mutably writes the provided `Instant` into `self.deadline`.

**Call relations**: Called by `read_response_frame` before each frame read so the stream’s readiness waits stay aligned with the request-scoped deadline.


##### `UnixDeadlineStream::wait_for_ready`  (lines 214–218)

```
fn wait_for_ready(&self, events: libc::c_short) -> std::io::Result<()>
```

**Purpose**: Waits until the wrapped Unix socket is readable or writable before the stored deadline.

**Data flow**: Reads the raw file descriptor from `self.stream`, forwards the fd, requested poll events, and `self.deadline` to `wait_for_fd_ready`, and returns its `io::Result<()>`.

**Call relations**: Used by the `Read` and `Write` trait impls and `flush` to enforce deadline-aware blocking semantics.

*Call graph*: calls 1 internal fn (wait_for_fd_ready); called by 3 (flush, read, write); 1 external calls (as_raw_fd).


##### `connect_unix_stream_before_deadline`  (lines 222–262)

```
fn connect_unix_stream_before_deadline(
    socket_path: &Path,
    deadline: Instant,
) -> std::io::Result<std::os::unix::net::UnixStream>
```

**Purpose**: Performs a nonblocking Unix-domain socket connect with explicit deadline handling and socket-path validation.

**Data flow**: Validates the socket path, builds a `sockaddr_un` via `unix_socket_addr`, creates a raw socket fd, marks it close-on-exec and nonblocking, calls `connect`, and if the connect is in progress waits for writability until the deadline and checks `SO_ERROR`. On success it converts the owned fd into `UnixStream` and returns it.

**Call relations**: Called only by `UnixDeadlineStream::connect`. It encapsulates the low-level Unix connect sequence and timeout behavior.

*Call graph*: calls 7 internal fn (is_in_progress_connect_error, set_fd_close_on_exec, set_fd_nonblocking, socket_error, unix_socket_addr, validate_unix_socket_path, wait_for_fd_ready); called by 1 (connect); 6 external calls (from_raw_fd, from_raw_os_error, last_os_error, connect, socket, from_raw_fd).


##### `unix_socket_addr`  (lines 265–314)

```
fn unix_socket_addr(socket_path: &Path) -> std::io::Result<(libc::sockaddr_un, libc::socklen_t)>
```

**Purpose**: Builds a `sockaddr_un` and length from a filesystem socket path, rejecting invalid or oversized paths.

**Data flow**: Reads the path bytes, rejects embedded NULs and paths too long for `sun_path`, zero-initializes `sockaddr_un`, copies bytes into `sun_path`, computes the platform-correct address length, and returns `(addr, addr_len)`.

**Call relations**: Used by `connect_unix_stream_before_deadline` before the raw `connect` syscall.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 4 external calls (as_os_str, new, try_from, try_from).


##### `set_fd_close_on_exec`  (lines 317–328)

```
fn set_fd_close_on_exec(fd: libc::c_int) -> std::io::Result<()>
```

**Purpose**: Marks a Unix socket fd with `FD_CLOEXEC` so child processes do not inherit it.

**Data flow**: Reads current fd flags with `fcntl(F_GETFD)`, ORs in `FD_CLOEXEC`, writes them back with `fcntl(F_SETFD)`, and returns `io::Result<()>`.

**Call relations**: Called during Unix socket setup before connection proceeds.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 2 external calls (last_os_error, fcntl).


##### `set_fd_nonblocking`  (lines 331–342)

```
fn set_fd_nonblocking(fd: libc::c_int) -> std::io::Result<()>
```

**Purpose**: Marks a Unix socket fd as nonblocking so readiness polling can enforce the request deadline.

**Data flow**: Reads current file status flags with `fcntl(F_GETFL)`, ORs in `O_NONBLOCK`, writes them back with `fcntl(F_SETFL)`, and returns `io::Result<()>`.

**Call relations**: Used by `connect_unix_stream_before_deadline` before attempting the nonblocking connect.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 2 external calls (last_os_error, fcntl).


##### `is_in_progress_connect_error`  (lines 345–354)

```
fn is_in_progress_connect_error(error: &std::io::Error) -> bool
```

**Purpose**: Recognizes Unix connect errors that mean the nonblocking connection is still in progress rather than failed.

**Data flow**: Reads `error.raw_os_error()` and returns true for `EINPROGRESS`, `EALREADY`, `EWOULDBLOCK`, or `EINTR`.

**Call relations**: Used only by `connect_unix_stream_before_deadline` to decide whether to wait for writability or fail immediately.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 1 external calls (matches!).


##### `socket_error`  (lines 357–380)

```
fn socket_error(fd: libc::c_int) -> std::io::Result<libc::c_int>
```

**Purpose**: Reads `SO_ERROR` from a connected socket to determine whether a nonblocking connect ultimately succeeded.

**Data flow**: Allocates an `int` output buffer and length, calls `getsockopt(SOL_SOCKET, SO_ERROR)`, and returns the resulting error code or an `io::Error` if the syscall fails.

**Call relations**: Called after `wait_for_fd_ready` in the Unix connect path to finalize connection status.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 3 external calls (last_os_error, getsockopt, try_from).


##### `remaining_timeout`  (lines 383–388)

```
fn remaining_timeout(deadline: Instant) -> std::io::Result<Duration>
```

**Purpose**: Computes the positive remaining duration until a deadline or returns a timeout error if the deadline has passed.

**Data flow**: Subtracts `Instant::now()` from the provided deadline using `checked_duration_since`, rejects zero or negative durations by returning `deadline_timeout_io_error()`, and otherwise returns the remaining `Duration`.

**Call relations**: Used by `remaining_timeout_ms` to feed poll timeouts.

*Call graph*: called by 1 (remaining_timeout_ms); 2 external calls (checked_duration_since, now).


##### `remaining_timeout_ms`  (lines 391–394)

```
fn remaining_timeout_ms(deadline: Instant) -> std::io::Result<libc::c_int>
```

**Purpose**: Converts the remaining time until a deadline into a poll-compatible millisecond timeout.

**Data flow**: Calls `remaining_timeout`, converts the duration to milliseconds with a minimum of 1, saturates into `libc::c_int`, and returns it.

**Call relations**: Used by `wait_for_fd_ready` so poll waits honor the absolute request deadline.

*Call graph*: calls 1 internal fn (remaining_timeout); called by 1 (wait_for_fd_ready); 1 external calls (try_from).


##### `wait_for_fd_ready`  (lines 397–431)

```
fn wait_for_fd_ready(
    fd: libc::c_int,
    events: libc::c_short,
    deadline: Instant,
) -> std::io::Result<()>
```

**Purpose**: Polls a Unix fd for readability or writability until the deadline, handling interrupts and invalid descriptors.

**Data flow**: Builds a `libc::pollfd`, repeatedly calls `poll` with `remaining_timeout_ms(deadline)`, returns a timeout error on zero, retries on interrupted syscalls, errors on `POLLNVAL`, and succeeds when requested events or error/hangup bits appear.

**Call relations**: Used both during nonblocking connect and by `UnixDeadlineStream::wait_for_ready` for subsequent reads/writes.

*Call graph*: calls 2 internal fn (deadline_timeout_io_error, remaining_timeout_ms); called by 2 (wait_for_ready, connect_unix_stream_before_deadline); 3 external calls (last_os_error, new, poll).


##### `UnixDeadlineStream::read`  (lines 435–448)

```
fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize>
```

**Purpose**: Implements deadline-aware blocking reads on top of a nonblocking Unix stream.

**Data flow**: If the buffer is empty returns 0; otherwise loops waiting for `POLLIN`, then calls the underlying stream’s `read`, retrying on `WouldBlock` or `Interrupted`, and returns the first successful read result.

**Call relations**: Used indirectly by frame-reading helpers through the standard `Read` trait.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (read).


##### `UnixDeadlineStream::write`  (lines 453–466)

```
fn write(&mut self, buf: &[u8]) -> std::io::Result<usize>
```

**Purpose**: Implements deadline-aware blocking writes on top of a nonblocking Unix stream.

**Data flow**: If the buffer is empty returns 0; otherwise loops waiting for `POLLOUT`, then calls the underlying stream’s `write`, retrying on `WouldBlock` or `Interrupted`, and returns the first successful write result.

**Call relations**: Used by frame-writing helpers through the standard `Write` trait.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (write).


##### `UnixDeadlineStream::flush`  (lines 468–471)

```
fn flush(&mut self) -> std::io::Result<()>
```

**Purpose**: Flushes the Unix stream after waiting for writability before the deadline.

**Data flow**: Waits for `POLLOUT` via `wait_for_ready` and then calls the underlying stream’s `flush`.

**Call relations**: Used by `write_frame` after writing a complete JSON frame.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (flush).


##### `validate_unix_socket_path`  (lines 475–507)

```
fn validate_unix_socket_path(socket_path: &Path) -> std::io::Result<()>
```

**Purpose**: Rejects unsafe Unix socket paths whose directory or socket file is not owned by the current user or is writable by others.

**Data flow**: Reads the current uid, inspects the parent directory with `symlink_metadata`, checks it is a directory owned by the uid and not group/world writable, then inspects the socket path metadata and checks it is a socket owned by the uid. Returns `PermissionDenied` errors with specific messages on violations.

**Call relations**: Called before connecting to a Unix socket and directly by a test that verifies unsafe directories are rejected.

*Call graph*: calls 1 internal fn (permission_denied_io_error); called by 2 (connect_unix_stream_before_deadline, validate_unix_socket_path_rejects_unsafe_parent_directory); 3 external calls (parent, getuid, symlink_metadata).


##### `validate_unix_peer_owner`  (lines 569–571)

```
fn validate_unix_peer_owner(_stream: &std::os::unix::net::UnixStream) -> std::io::Result<()>
```

**Purpose**: Verifies that the connected Unix peer process belongs to the current user.

**Data flow**: On Linux/Android it reads peer credentials with `SO_PEERCRED`; on BSD/macOS variants it uses `getpeereid`; then forwards the peer uid to `ensure_peer_uid_matches_current_user`. Unsupported Unix variants accept all peers.

**Call relations**: Called by `UnixDeadlineStream::connect` after the socket connection succeeds, adding a second ownership check beyond filesystem metadata.

*Call graph*: calls 1 internal fn (ensure_peer_uid_matches_current_user); called by 1 (connect); 4 external calls (last_os_error, getpeereid, getsockopt, as_raw_fd).


##### `ensure_peer_uid_matches_current_user`  (lines 574–582)

```
fn ensure_peer_uid_matches_current_user(peer_uid: libc::uid_t) -> std::io::Result<()>
```

**Purpose**: Rejects a Unix peer uid that differs from the current process uid.

**Data flow**: Compares `peer_uid` to `getuid()`, returning a permission-denied `io::Error` if they differ, otherwise `Ok(())`.

**Call relations**: Shared by the platform-specific `validate_unix_peer_owner` implementations.

*Call graph*: calls 1 internal fn (permission_denied_io_error); called by 1 (validate_unix_peer_owner); 1 external calls (getuid).


##### `connect_stream`  (lines 585–591)

```
fn connect_stream(
    socket_path: PathBuf,
    deadline: Instant,
) -> Result<IdeContextStream, IdeContextError>
```

**Purpose**: Platform abstraction that opens the appropriate IDE-context stream type and maps connection failures into `IdeContextError::Connect`.

**Data flow**: On Unix it calls `UnixDeadlineStream::connect`; on Windows it calls `WindowsPipeStream::connect`; in both cases it maps `io::Error` into `IdeContextError::Connect`.

**Call relations**: Used only by `fetch_ide_context_from_socket` so the rest of the module can work against the `IdeContextStream` alias.

*Call graph*: calls 2 internal fn (connect, connect); called by 1 (fetch_ide_context_from_socket).


##### `answer_unsupported_request`  (lines 594–608)

```
fn answer_unsupported_request(
    stream: &mut T,
    message: &Value,
) -> Result<(), IdeContextError>
```

**Purpose**: Replies to inbound IPC requests that the TUI does not implement, preventing the shared channel from stalling.

**Data flow**: Reads `requestId` from an inbound JSON message; if present, constructs a JSON error response with `resultType: "error"` and `error: "no-handler-for-request"`; writes it as a frame to the stream; and returns `Result<(), IdeContextError>`.

**Call relations**: Called by `read_response_frame` when unrelated `type: "request"` messages arrive while waiting for the IDE-context response.

*Call graph*: calls 1 internal fn (write_frame); called by 1 (read_response_frame); 2 external calls (get, json!).


##### `fetch_ide_context_from_stream`  (lines 611–621)

```
fn fetch_ide_context_from_stream(
    stream: &mut IdeContextStream,
    workspace_root: &Path,
    deadline: Instant,
) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Runs the full request/response exchange over an already-connected stream and returns the parsed `IdeContext`.

**Data flow**: Generates a UUID request id string, writes the IDE-context request frame with `write_ide_context_request`, waits for the matching response via `read_response_frame`, then parses it with `extract_ide_context`.

**Call relations**: Called by `fetch_ide_context_from_socket` after connection setup. It is the central orchestration point for framing and parsing.

*Call graph*: calls 3 internal fn (extract_ide_context, read_response_frame, write_ide_context_request); called by 1 (fetch_ide_context_from_socket); 1 external calls (new_v4).


##### `write_ide_context_request`  (lines 624–640)

```
fn write_ide_context_request(
    stream: &mut T,
    request_id: &str,
    workspace_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Serializes and sends the JSON request asking the IDE extension for context for a workspace root.

**Data flow**: Builds a JSON object containing `type: request`, the request id, `sourceClientId`, protocol version 0, method `ide-context`, and `params.workspaceRoot` from `workspace_root.to_string_lossy()`, then writes it with `write_frame`.

**Call relations**: Used only by `fetch_ide_context_from_stream` before entering the response loop.

*Call graph*: calls 1 internal fn (write_frame); called by 1 (fetch_ide_context_from_stream); 1 external calls (json!).


##### `write_frame`  (lines 643–659)

```
fn write_frame(stream: &mut T, message: &Value) -> std::io::Result<()>
```

**Purpose**: Writes one length-prefixed JSON frame to the IPC stream.

**Data flow**: Serializes the JSON `Value` to bytes with `serde_json::to_vec`, converts the payload length to little-endian `u32`, writes the 4-byte length prefix, writes the payload bytes, flushes the stream, and returns `io::Result<()>`.

**Call relations**: Shared by request sending, unsupported-request replies, client-discovery replies, and test server helpers.

*Call graph*: called by 4 (answer_unsupported_request, read_response_frame, write_ide_context_response, write_ide_context_request); 4 external calls (flush, write_all, to_vec, try_from).


##### `read_frame`  (lines 662–677)

```
fn read_frame(
    stream: &mut T,
    deadline: Instant,
) -> Result<Value, IdeContextError>
```

**Purpose**: Reads one length-prefixed JSON frame from the IPC stream and parses it into `serde_json::Value`.

**Data flow**: Reads exactly 4 bytes before the deadline, decodes a little-endian `u32` payload length, rejects frames larger than `MAX_IPC_FRAME_BYTES`, reads exactly that many payload bytes before the deadline, and deserializes them with `serde_json::from_slice`, mapping parse failures to `IdeContextError::InvalidResponse`.

**Call relations**: Called repeatedly by `read_response_frame` while waiting for the matching response.

*Call graph*: calls 1 internal fn (read_exact_before_deadline); called by 1 (read_response_frame); 3 external calls (from_slice, from_le_bytes, vec!).


##### `read_exact_before_deadline`  (lines 680–706)

```
fn read_exact_before_deadline(
    stream: &mut T,
    buf: &mut [u8],
    deadline: Instant,
) -> Result<(), IdeContextError>
```

**Purpose**: Reads a buffer fully while checking the absolute deadline between partial reads.

**Data flow**: Loops until `buf` is filled, calling `ensure_deadline_not_expired` before each read; treats EOF as `IdeContextError::Read(UnexpectedEof)`, retries interrupted reads, wraps other read errors in `IdeContextError::Read`, and performs one final deadline check before returning success.

**Call relations**: Used by `read_frame` for both the frame header and payload so the whole response stays within one request budget.

*Call graph*: calls 1 internal fn (ensure_deadline_not_expired); called by 1 (read_frame); 3 external calls (read, new, Read).


##### `read_response_frame`  (lines 709–754)

```
fn read_response_frame(
    stream: &mut IdeContextStream,
    request_id: &str,
    deadline: Instant,
) -> Result<Value, IdeContextError>
```

**Purpose**: Consumes frames until it finds the response matching the current request id, while handling unrelated traffic on the shared IPC channel.

**Data flow**: Loops until the deadline, updates the stream deadline, reads a frame, inspects `message["type"]`, returns the frame if it is a matching `response`, ignores broadcasts and unrelated responses, answers `client-discovery-request` with `canHandle: false`, ignores `client-discovery-response`, answers generic inbound `request` messages via `answer_unsupported_request`, and errors on missing or unexpected message types.

**Call relations**: Called by `fetch_ide_context_from_stream` after sending the request. It is the key control-flow hub that makes the TUI coexist with other IPC traffic.

*Call graph*: calls 4 internal fn (answer_unsupported_request, ensure_deadline_not_expired, read_frame, write_frame); called by 1 (fetch_ide_context_from_stream); 4 external calls (set_deadline, format!, json!, InvalidResponse).


##### `ensure_deadline_not_expired`  (lines 757–763)

```
fn ensure_deadline_not_expired(deadline: Instant) -> Result<(), IdeContextError>
```

**Purpose**: Converts an expired absolute deadline into the module’s standard timeout error.

**Data flow**: Compares `Instant::now()` to the provided deadline and returns `Err(timeout_error())` if the deadline has passed, otherwise `Ok(())`.

**Call relations**: Used by both frame-reading helpers and the response loop to enforce the request-scoped timeout consistently.

*Call graph*: calls 1 internal fn (timeout_error); called by 2 (read_exact_before_deadline, read_response_frame); 1 external calls (now).


##### `timeout_error`  (lines 766–768)

```
fn timeout_error() -> IdeContextError
```

**Purpose**: Builds the canonical `IdeContextError` representing a timed-out read.

**Data flow**: Constructs `IdeContextError::Read(deadline_timeout_io_error())` and returns it.

**Call relations**: Used by `ensure_deadline_not_expired` so all timeout paths share the same error shape.

*Call graph*: calls 1 internal fn (deadline_timeout_io_error); called by 1 (ensure_deadline_not_expired); 1 external calls (Read).


##### `deadline_timeout_io_error`  (lines 771–776)

```
fn deadline_timeout_io_error() -> std::io::Error
```

**Purpose**: Creates the underlying `io::Error` used for IDE-context timeout failures.

**Data flow**: Returns `std::io::Error::new(ErrorKind::TimedOut, "timed out waiting for IDE context")`.

**Call relations**: Used by both generic timeout conversion and Unix poll timeout handling.

*Call graph*: called by 2 (timeout_error, wait_for_fd_ready); 1 external calls (new).


##### `permission_denied_io_error`  (lines 779–781)

```
fn permission_denied_io_error(message: &'static str) -> std::io::Error
```

**Purpose**: Creates a permission-denied `io::Error` with a static explanatory message.

**Data flow**: Wraps the provided static message in `std::io::ErrorKind::PermissionDenied` and returns it.

**Call relations**: Used by Unix socket-path and peer-ownership validation helpers.

*Call graph*: called by 2 (ensure_peer_uid_matches_current_user, validate_unix_socket_path); 1 external calls (new).


##### `extract_ide_context`  (lines 784–797)

```
fn extract_ide_context(response: Value) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Validates a successful response frame and deserializes `result.ideContext` into the shared `IdeContext` struct.

**Data flow**: Calls `ensure_success_response`, extracts and clones `response["result"]["ideContext"]`, errors if missing, then deserializes it with `serde_json::from_value`, mapping failures to `IdeContextError::InvalidResponse`.

**Call relations**: Called after `read_response_frame` returns the matching response. It is the final parsing step before the public API returns.

*Call graph*: calls 1 internal fn (ensure_success_response); called by 1 (fetch_ide_context_from_stream); 2 external calls (get, from_value).


##### `ensure_success_response`  (lines 800–814)

```
fn ensure_success_response(response: &Value) -> Result<(), IdeContextError>
```

**Purpose**: Checks the response `resultType` and converts protocol-level errors into `IdeContextError::RequestFailed`.

**Data flow**: Reads `response["resultType"]`; returns `Ok(())` for `success`, returns `RequestFailed(error_string)` for `error`, and otherwise returns `InvalidResponse` if the field is missing or malformed.

**Call relations**: Used only by `extract_ide_context` before attempting to deserialize the payload.

*Call graph*: called by 1 (extract_ide_context); 3 external calls (get, InvalidResponse, RequestFailed).


##### `tests::test_deadline`  (lines 823–825)

```
fn test_deadline() -> Instant
```

**Purpose**: Provides a short future deadline for Unix IPC tests.

**Data flow**: Returns `Instant::now() + Duration::from_secs(1)`.

**Call relations**: Used by test helpers and the integration-style Unix server test to keep frame reads bounded.

*Call graph*: 2 external calls (from_secs, now).


##### `tests::write_ide_context_response`  (lines 828–862)

```
fn write_ide_context_response(
        stream: &mut impl std::io::Write,
        request_id: &str,
        active_selection_content: &str,
    )
```

**Purpose**: Writes a successful IDE-context response frame to a test stream with configurable selected text.

**Data flow**: Builds a JSON success response containing one active file and the provided `active_selection_content`, writes it with `write_frame`, and panics if writing fails.

**Call relations**: Used by the Unix integration test to emulate the IDE server’s final response.

*Call graph*: calls 1 internal fn (write_frame); 2 external calls (json!, panic!).


##### `tests::unix_deadline_stream_uses_remaining_deadline_for_blocking_reads`  (lines 866–880)

```
fn unix_deadline_stream_uses_remaining_deadline_for_blocking_reads()
```

**Purpose**: Verifies that `UnixDeadlineStream::read` times out near the configured deadline instead of blocking indefinitely.

**Data flow**: Creates a `UnixStream::pair`, wraps one end in `UnixDeadlineStream` with a 50 ms deadline, attempts a read into a one-byte buffer, captures the error, and asserts it is `TimedOut` and occurs well before two seconds.

**Call relations**: Directly tests the deadline-aware `Read` impl without involving framing or socket-path validation.

*Call graph*: calls 1 internal fn (new); 6 external calls (from_millis, now, assert!, assert_eq!, read, pair).


##### `tests::validate_unix_socket_path_rejects_unsafe_parent_directory`  (lines 884–898)

```
fn validate_unix_socket_path_rejects_unsafe_parent_directory()
```

**Purpose**: Checks that Unix socket validation rejects sockets located in world-writable parent directories.

**Data flow**: Creates a temp directory, changes its permissions to `0o777`, binds a Unix listener socket inside it, calls `validate_unix_socket_path`, and asserts the returned error kind is `PermissionDenied`.

**Call relations**: Exercises the filesystem-permission checks in `validate_unix_socket_path`.

*Call graph*: calls 2 internal fn (validate_unix_socket_path, bind); 4 external calls (assert_eq!, from_mode, set_permissions, tempdir).


##### `tests::fetch_ide_context_uses_unregistered_request_route`  (lines 902–1008)

```
fn fetch_ide_context_uses_unregistered_request_route()
```

**Purpose**: Integration-style test that verifies the full Unix request/response loop, including unsupported inbound requests, client-discovery handling, large broadcasts, and final context extraction.

**Data flow**: Spawns a Unix listener server thread that accepts a connection, reads the outgoing IDE-context request frame, asserts method/source/workspaceRoot fields, sends an unrelated inbound request and checks the TUI replies with `no-handler-for-request`, sends a client-discovery request and checks the `canHandle: false` response, sends a large broadcast, then sends a successful IDE-context response. The client side calls `fetch_ide_context_from_socket` and asserts the returned `IdeContext.active_file.active_selection_content` is `use`.

**Call relations**: This test drives the entire transport stack from `fetch_ide_context_from_socket` through framing, response routing, and final deserialization.

*Call graph*: calls 2 internal fn (fetch_ide_context_from_socket, bind); 5 external calls (from_secs, new, assert_eq!, tempdir, spawn).
