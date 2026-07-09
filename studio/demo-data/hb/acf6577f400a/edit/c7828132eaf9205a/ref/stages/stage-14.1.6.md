# Approval-adjacent enforcement runtimes  `stage-14.1.6`

This stage is the “rules are enforced for real” part of the system. It sits in the main execution path and in platform setup. Earlier stages decide what should be allowed; these pieces turn those decisions into live behavior while tools are running.

The network-proxy crate is the shell that assembles the proxy subsystem and exposes the parts other code uses. Inside it, state.rs takes raw network rules and turns them into a checked runtime form the proxy can use safely. network_policy.rs defines the question-and-answer format for policy decisions, asks for a decision asynchronously, and records audit events about what happened. runtime.rs is the live engine: it keeps the current allow and deny rules, optional MITM state (where traffic is inspected by the proxy), buffered blocked requests, and the logic used by both HTTP and SOCKS traffic.

On the approval side, network_approval.rs manages user or guardian approval for tool network access. It avoids asking the same question twice, remembers session decisions, and turns blocked proxy events into tool-facing errors.

For Windows, the sandbox files apply operating-system protections. windows_sandbox_read_grants.rs safely adds extra readable folders. deny_read_state.rs remembers persistent “no read” permissions. workspace_acl.rs locks down sensitive workspace folders. wfp.rs installs Windows network blocking filters, and wfp_setup.rs does that setup carefully so failures are logged and measured without stopping the rest of startup.

## Files in this stage

### Proxy policy interfaces
These files introduce the network proxy subsystem and define the validated policy types that feed the live enforcement engine.

### `network-proxy/src/lib.rs`

`orchestration` · `startup`

This file defines the top-level API surface of the `network-proxy` crate. It first enforces a crate-wide lint policy forbidding direct stdout/stderr printing, which is significant for a proxy component that should route diagnostics through structured logging instead of ad hoc console output. It then declares the implementation modules that cover certificate handling, configuration parsing, connection policy, HTTP and SOCKS5 proxying, MITM interception and hooks, policy evaluation, runtime state, upstream forwarding, and response generation. The long `pub use` section is the real contract: callers can configure permissions (`NetworkDomainPermission*`, `NetworkUnixSocketPermission*`, `NetworkMode`, `NetworkProxyConfig`), inspect or build runtime state (`ConfigState`, `NetworkProxyState`, `build_config_state`, `validate_policy_against_constraints`), instantiate and control the proxy (`NetworkProxy`, `NetworkProxyBuilder`, `NetworkProxyHandle`, `Args`), integrate policy callbacks (`NetworkPolicyDecider`, `BlockedRequestObserver`, and their futures), and consume environment-variable conventions (`PROXY_ENV_KEYS`, `NO_PROXY_ENV_KEYS`, `PROXY_ACTIVE_ENV_KEY`, etc.). Platform-specific exports for macOS SSH proxy integration are gated with `cfg(target_os = "macos")`. This file contains no logic itself, but it is the subsystem’s architectural seam: it hides internal module boundaries while exposing the exact knobs needed for startup, request handling, policy enforcement, and audit/constraint validation.


### `network-proxy/src/state.rs`

`config` · `config load, validation, and live config mutation checks`

This file is the config-to-runtime compiler and constraint validator for the network proxy. `NetworkProxyConstraints` describes externally managed limits on what the live config may do: whether networking can be enabled, the maximum network mode, whether upstream proxies or local binding are allowed, whether unix sockets may be broadly or selectively allowed, and managed allow/deny domain baselines with optional expansion flags. `PartialNetworkProxyConfig` and `PartialNetworkConfig` are deserializable partial forms used when only some network settings are supplied.

`build_config_state` turns a validated `NetworkProxyConfig` into the runtime `ConfigState` consumed by `NetworkProxyState`. It first validates unix-socket allowlist paths, extracts allowed and denied domain lists, rejects global wildcard patterns in denied domains, compiles deny and allow `GlobSet`s, compiles MITM hooks, and conditionally constructs a `MitmState` with `MitmUpstreamConfig` derived from `allow_upstream_proxy` and `allow_local_binding`. The resulting state starts with empty blocked-request telemetry.

`validate_policy_against_constraints` is the core managed-policy checker. It validates MITM hook configuration, rejects global wildcard patterns in managed domain constraints, and then enforces each constrained field. Boolean flags can only be widened when explicitly allowed. `network.mode` is compared via `network_mode_rank`, so `Limited` is stricter than `Full`. Allowlist constraints support three modes: exact fixed set, required baseline plus expansion, or semantic subset-of-managed-patterns using `DomainPattern::parse_for_constraints` and `DomainPattern::allows`. Denylist constraints require managed entries to remain present and may optionally forbid expansion. Unix-socket allowlists are enforced as case-insensitive subsets. Errors are reported as `NetworkProxyConstraintError::InvalidValue` and can be converted into `anyhow::Error` for higher layers.

#### Function details

##### `build_config_state`  (lines 64–94)

```
fn build_config_state(
    config: NetworkProxyConfig,
    constraints: NetworkProxyConstraints,
) -> anyhow::Result<ConfigState>
```

**Purpose**: Validates and compiles a network proxy config plus constraints into the runtime `ConfigState` structure.

**Data flow**: Takes ownership of `NetworkProxyConfig` and `NetworkProxyConstraints`, validates unix-socket allowlist paths, extracts allowed/denied domain vectors, rejects global wildcard denied patterns, compiles deny and allow globsets, compiles MITM hooks, conditionally constructs `MitmState::new(MitmUpstreamConfig { allow_upstream_proxy, allow_local_binding })`, and returns `ConfigState` with empty blocked telemetry.

**Call relations**: Called during initial state construction and whenever domain-list updates or tests need to recompile config into runtime state.

*Call graph*: calls 6 internal fn (validate_unix_socket_allowlist_paths, new, compile_mitm_hooks, compile_allowlist_globset, compile_denylist_globset, validate_non_global_wildcard_domain_patterns); called by 6 (state_with_metadata, update_domain_list, add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed, add_allowed_domain_succeeds_when_managed_baseline_allows_expansion, add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed, state_for_settings); 2 external calls (new, new).


##### `validate_policy_against_constraints`  (lines 96–386)

```
fn validate_policy_against_constraints(
    config: &NetworkProxyConfig,
    constraints: &NetworkProxyConstraints,
) -> Result<(), NetworkProxyConstraintError>
```

**Purpose**: Checks whether a candidate network proxy config stays within externally managed constraints.

**Data flow**: Reads the candidate config and constraints, validates MITM hook config and non-global wildcard patterns, then enforces constrained booleans, mode rank, upstream-proxy and local-binding flags, dangerous unix-socket behavior, allowlist semantics, denylist semantics, and unix-socket allowlist subset rules. It returns `Ok(())` if all checks pass or a detailed `NetworkProxyConstraintError` otherwise.

**Call relations**: Used by runtime mutation paths such as `set_network_mode` and `update_domain_list` before accepting live config changes.

*Call graph*: calls 2 internal fn (validate_mitm_hook_config, validate_non_global_wildcard_domain_patterns); called by 2 (set_network_mode, update_domain_list).


##### `invalid_mitm_hook_configuration`  (lines 388–394)

```
fn invalid_mitm_hook_configuration(err: anyhow::Error) -> NetworkProxyConstraintError
```

**Purpose**: Converts an arbitrary MITM hook validation error into the standardized constraint-error shape.

**Data flow**: Takes an `anyhow::Error`, stringifies it, and returns `NetworkProxyConstraintError::InvalidValue` for field `network.mitm_hooks` with allowed text `valid MITM hook configuration`.

**Call relations**: Used inside `validate_policy_against_constraints` when MITM hook validation fails.

*Call graph*: 1 external calls (to_string).


##### `validate_non_global_wildcard_domain_patterns`  (lines 396–412)

```
fn validate_non_global_wildcard_domain_patterns(
    field_name: &'static str,
    patterns: &[String],
) -> Result<(), NetworkProxyConstraintError>
```

**Purpose**: Rejects domain-pattern lists containing any pattern that semantically expands to a global wildcard.

**Data flow**: Scans the pattern slice with `is_global_wildcard_domain_pattern`; if any match, returns `NetworkProxyConstraintError::InvalidValue` naming the offending field and pattern, otherwise returns `Ok(())`.

**Call relations**: Called by both `build_config_state` and `validate_policy_against_constraints` to keep deny lists and managed domain constraints from using unrestricted wildcards.

*Call graph*: called by 2 (build_config_state, validate_policy_against_constraints).


##### `NetworkProxyConstraintError::into_anyhow`  (lines 425–427)

```
fn into_anyhow(self) -> anyhow::Error
```

**Purpose**: Wraps a typed constraint error into `anyhow::Error` for APIs that use erased error types.

**Data flow**: Consumes `self` and returns `anyhow!(self)`.

**Call relations**: Used by runtime mutation code when attaching context to constraint failures.

*Call graph*: 1 external calls (anyhow!).


##### `network_mode_rank`  (lines 430–435)

```
fn network_mode_rank(mode: NetworkMode) -> u8
```

**Purpose**: Assigns an ordering to network modes so constraint checks can compare strictness.

**Data flow**: Maps `NetworkMode::Limited` to `0` and `NetworkMode::Full` to `1`, returning the rank as `u8`.

**Call relations**: Used by `validate_policy_against_constraints` to reject widening mode beyond the managed maximum.


### Live proxy enforcement
These files implement the runtime policy engine and the approval-aware decision flow that evaluates and audits network access during tool execution.

### `core/src/tools/network_approval.rs`

`domain_logic` · `during sandboxed tool execution and inline network-policy decisions`

This file contains the full state machine for network approvals when tools run under managed network restrictions. The core service is `NetworkApprovalService`, which owns four mutex-protected stores: active calls plus recorded outcomes (`calls`), in-flight host approvals (`pending_host_approvals`), session-scoped approved hosts, and session-scoped denied hosts. Host identity is normalized by `HostApprovalKey`, which lowercases the host and keys approvals by protocol label plus port, so approvals are scoped precisely to `(host, protocol, port)`.

Two wrapper types model call lifetime. `ActiveNetworkApproval` is created at tool start and carries a registration ID, mode (`Immediate` or `Deferred`), and a cancellation token that can interrupt the running tool if network access is denied. `DeferredNetworkApproval` is the post-run handle for deferred mode; it memoizes the final outcome in a `OnceCell` so multiple consumers see the same denial result even after the underlying call state has been removed.

The central path is `handle_inline_policy_request`, invoked by the network proxy decider. It first checks session deny/allow caches, then deduplicates concurrent requests for the same host via `PendingHostApproval`. If the current session/turn/policy/profile does not permit approval flow, it denies immediately and records a policy outcome for the sole active call when attribution is unambiguous. Otherwise it optionally consults permission-request hooks, then falls back to guardian review or direct user approval. Review results are translated into `PendingApprovalDecision`, may persist network policy amendments, may cache session allow/deny state, and may record `DeniedByUser` or `DeniedByPolicy` outcomes against the owning call. Recorded outcomes cancel the call’s token so the runtime can stop promptly.

The module also exposes closures for the proxy layer (`build_blocked_request_observer`, `build_network_policy_decider`) and lifecycle helpers to begin and finish approval tracking around tool attempts. A notable invariant is that unattributed blocked requests only affect a tool when exactly one active call exists; with multiple concurrent calls, the service intentionally refuses to guess ownership.

#### Function details

##### `DeferredNetworkApproval::registration_id`  (lines 64–66)

```
fn registration_id(&self) -> &str
```

**Purpose**: Returns the registration ID associated with a deferred network-approval handle. This exposes the stable identifier without transferring ownership.

**Data flow**: Reads `self.registration_id` → returns `&str` borrowed from the stored `String` → no mutation or side effects.

**Call relations**: This is an accessor on the deferred handle used by callers that need to correlate deferred approval state with a registered call. It does not delegate further.


##### `DeferredNetworkApproval::cancellation_token`  (lines 68–70)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Provides a clone of the deferred approval’s cancellation token so external code can observe or propagate network-denial cancellation. The clone preserves shared cancellation semantics.

**Data flow**: Reads `self.cancellation_token` → clones it → returns the cloned `CancellationToken`.

**Call relations**: Runtime cleanup code uses this when it needs to terminate a process if deferred network approval later resolves to denial. It is a simple accessor and does not alter approval state.

*Call graph*: called by 1 (terminate_process_on_network_denial); 1 external calls (clone).


##### `DeferredNetworkApproval::is_cancelled`  (lines 72–74)

```
fn is_cancelled(&self) -> bool
```

**Purpose**: Reports whether the deferred approval’s cancellation token has already been cancelled. This lets callers cheaply detect that a denial or cancellation has occurred.

**Data flow**: Reads `self.cancellation_token` → calls `is_cancelled()` on it → returns the resulting `bool`.

**Call relations**: This is a read-only convenience method on the deferred handle. It does not participate in broader call flow beyond exposing cancellation state.

*Call graph*: 1 external calls (is_cancelled).


##### `DeferredNetworkApproval::finish`  (lines 76–83)

```
async fn finish(&self, service: &NetworkApprovalService) -> Result<(), ToolError>
```

**Purpose**: Finalizes a deferred network approval exactly once and converts any stored denial outcome into a `ToolError`. It memoizes the fetched outcome so repeated finish calls return the same result.

**Data flow**: Reads `self.finish_outcome` and `self.registration_id`, plus the provided `service` → uses `OnceCell::get_or_init` to call `service.finish_call_outcome(&self.registration_id)` at most once, clones the resulting `Option<NetworkApprovalOutcome>`, then passes it to `network_approval_outcome_to_result` → returns `Ok(())` for no outcome or `Err(ToolError::Rejected(...))` for denial.

**Call relations**: Deferred completion paths call this after the tool has already returned but network approval may still resolve later. It delegates outcome-to-error translation to `network_approval_outcome_to_result` and shields callers from double-consuming service state.

*Call graph*: calls 1 internal fn (network_approval_outcome_to_result).


##### `ActiveNetworkApproval::mode`  (lines 94–96)

```
fn mode(&self) -> NetworkApprovalMode
```

**Purpose**: Returns whether the active approval should be finalized immediately after the tool run or deferred until later. It exposes the mode chosen when approval tracking began.

**Data flow**: Reads `self.mode` → returns the `NetworkApprovalMode` copy.

**Call relations**: The orchestrator checks this after each tool attempt to decide whether to call immediate finish logic or convert the handle into a deferred one. It is a pure accessor.


##### `ActiveNetworkApproval::cancellation_token`  (lines 98–100)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Clones and returns the cancellation token tied to the active approval. This token is passed into sandbox attempts so network denial can interrupt execution.

**Data flow**: Reads `self.cancellation_token` → clones it → returns the clone.

**Call relations**: The orchestrator uses this while constructing `SandboxAttempt` so the running tool can be cancelled if approval is denied. It does not mutate approval state.

*Call graph*: 1 external calls (clone).


##### `ActiveNetworkApproval::into_deferred`  (lines 102–118)

```
fn into_deferred(self) -> Option<DeferredNetworkApproval>
```

**Purpose**: Consumes an active approval and converts it into a `DeferredNetworkApproval` only when the mode is deferred and a registration ID exists. Other cases intentionally yield `None`.

**Data flow**: Consumes `self`, destructuring `registration_id`, `mode`, and `cancellation_token` → if `(mode, registration_id)` is `(Deferred, Some(id))`, constructs `DeferredNetworkApproval { registration_id: id, cancellation_token, finish_outcome: Arc::new(OnceCell::new()) }`; otherwise returns `None`.

**Call relations**: The orchestrator calls this after a deferred-mode tool attempt succeeds or needs post-run tracking. It is the handoff point from active execution-time tracking to deferred completion-time tracking.

*Call graph*: 2 external calls (new, new).


##### `HostApprovalKey::from_request`  (lines 129–135)

```
fn from_request(request: &NetworkPolicyRequest, protocol: NetworkApprovalProtocol) -> Self
```

**Purpose**: Normalizes a `NetworkPolicyRequest` into the deduplication/cache key used for host approvals. It lowercases the host and converts the protocol enum into a stable string label.

**Data flow**: Reads `request.host`, `request.port`, and the supplied `NetworkApprovalProtocol` → lowercases the host with `to_ascii_lowercase()`, maps protocol via `protocol_key_label`, and returns `HostApprovalKey { host, protocol, port }`.

**Call relations**: Inline policy handling calls this at the start of approval processing so all cache lookups and pending-approval deduplication use the same normalized key. It delegates protocol labeling to `protocol_key_label`.

*Call graph*: calls 1 internal fn (protocol_key_label); called by 1 (handle_inline_policy_request).


##### `protocol_key_label`  (lines 138–145)

```
fn protocol_key_label(protocol: NetworkApprovalProtocol) -> &'static str
```

**Purpose**: Maps `NetworkApprovalProtocol` variants to the static string labels used in approval keys and IDs. This keeps protocol naming stable across caches and prompt identifiers.

**Data flow**: Consumes `protocol: NetworkApprovalProtocol` → matches it to one of `"http"`, `"https"`, `"socks5-tcp"`, or `"socks5-udp"` → returns the `&'static str` label.

**Call relations**: Only `HostApprovalKey::from_request` uses this helper. It centralizes the protocol-string mapping so host keys and approval IDs stay consistent.

*Call graph*: called by 1 (from_request).


##### `network_approval_outcome_to_result`  (lines 160–170)

```
fn network_approval_outcome_to_result(
    outcome: Option<NetworkApprovalOutcome>,
) -> Result<(), ToolError>
```

**Purpose**: Converts an optional stored network-approval outcome into the `Result<(), ToolError>` shape expected by tool execution code. Absence means success; denial becomes a rejected tool error.

**Data flow**: Consumes `outcome: Option<NetworkApprovalOutcome>` → maps `DeniedByUser` to `Err(ToolError::Rejected("rejected by user"))`, `DeniedByPolicy(message)` to `Err(ToolError::Rejected(message))`, and `None` to `Ok(())`.

**Call relations**: Both deferred and immediate finish paths use this to turn recorded approval outcomes into tool-level success or rejection. It is the canonical translation from approval state to execution error.

*Call graph*: called by 2 (finish, finish_call); 1 external calls (Rejected).


##### `allows_network_approval_flow`  (lines 173–175)

```
fn allows_network_approval_flow(policy: AskForApproval) -> bool
```

**Purpose**: Determines whether the current approval policy permits an allowlist miss to enter the interactive network-approval flow. Only `AskForApproval::Never` disables that path entirely.

**Data flow**: Consumes `policy: AskForApproval` → checks whether it matches `Never` → returns `false` only for that variant and `true` otherwise.

**Call relations**: Inline policy handling consults this before prompting the user or guardian. It is a small policy gate used alongside permission-profile checks.

*Call graph*: called by 1 (handle_inline_policy_request); 1 external calls (matches!).


##### `permission_profile_allows_network_approval_flow`  (lines 177–179)

```
fn permission_profile_allows_network_approval_flow(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Restricts network approval flow to managed permission profiles. It excludes fully disabled or external profiles even if the approval policy would otherwise allow prompting.

**Data flow**: Reads `permission_profile: &PermissionProfile` → returns `true` only when it matches `PermissionProfile::Managed { .. }` and `false` for other variants.

**Call relations**: This is another early gate in inline policy handling. It ensures network approval prompts are only offered in the sandbox modes where managed-network semantics apply.

*Call graph*: called by 1 (handle_inline_policy_request); 1 external calls (matches!).


##### `PendingApprovalDecision::to_network_decision`  (lines 182–187)

```
fn to_network_decision(self) -> NetworkDecision
```

**Purpose**: Converts an internal pending-approval resolution into the proxy layer’s `NetworkDecision`. Both allow variants become `Allow`; deny becomes a standard `not_allowed` denial.

**Data flow**: Consumes `self` → maps `AllowOnce` and `AllowForSession` to `NetworkDecision::Allow`, and `Deny` to `NetworkDecision::deny("not_allowed")` → returns the resulting decision.

**Call relations**: Waiters on a shared pending approval use this after the owner resolves the prompt. It is the final translation from approval bookkeeping to the proxy’s decision type.

*Call graph*: calls 1 internal fn (deny).


##### `PendingHostApproval::new`  (lines 196–201)

```
fn new() -> Self
```

**Purpose**: Creates a fresh pending host-approval slot with no decision yet and a notifier for waiting tasks. This is the synchronization primitive used to deduplicate concurrent prompts.

**Data flow**: Allocates `Mutex<Option<PendingApprovalDecision>>` initialized to `None` and a new `Notify` → returns `PendingHostApproval { decision, notify }`.

**Call relations**: The service creates one of these when the first request for a host/protocol/port key arrives. Other concurrent requests then share the same instance instead of prompting independently.

*Call graph*: called by 2 (get_or_create_pending_approval, pending_waiters_receive_owner_decision); 2 external calls (new, new).


##### `PendingHostApproval::wait_for_decision`  (lines 203–211)

```
async fn wait_for_decision(&self) -> PendingApprovalDecision
```

**Purpose**: Asynchronously waits until some owner task records a decision for this pending host approval. It loops to avoid races between notification registration and decision observation.

**Data flow**: Reads `self.decision` under lock and `self.notify` → repeatedly creates a `notified()` future, checks whether a decision is already present, and if not awaits notification → returns the first stored `PendingApprovalDecision` once available.

**Call relations**: Non-owner requests returned by `get_or_create_pending_approval` call this to reuse the owner’s eventual decision. It does not resolve approvals itself; it only blocks until `set_decision` runs.

*Call graph*: 1 external calls (notified).


##### `PendingHostApproval::set_decision`  (lines 213–219)

```
async fn set_decision(&self, decision: PendingApprovalDecision)
```

**Purpose**: Stores the final decision for a pending host approval and wakes all waiters. This completes the deduplicated approval exchange for every concurrent requester sharing the key.

**Data flow**: Takes `decision: PendingApprovalDecision` → locks `self.decision` and writes `Some(decision)` → calls `self.notify.notify_waiters()` → returns `()`.

**Call relations**: The owner branch of inline policy handling calls this after hooks, guardian review, or user approval resolve. Waiting requests then resume through `wait_for_decision` and convert the stored decision into `NetworkDecision`.

*Call graph*: 1 external calls (notify_waiters).


##### `NetworkApprovalService::default`  (lines 244–251)

```
fn default() -> Self
```

**Purpose**: Constructs an empty approval service with no active calls, no pending approvals, and empty session allow/deny caches. It is the standard initializer for session services and tests.

**Data flow**: Allocates default/empty `NetworkApprovalCallState`, `HashMap`, and `HashSet` containers inside `Mutex` wrappers → returns `NetworkApprovalService { calls, pending_host_approvals, session_approved_hosts, session_denied_hosts }`.

**Call relations**: Session setup and many tests instantiate the service through this default constructor. It establishes the baseline state all other methods mutate.

*Call graph*: called by 14 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, active_call_preserves_triggering_command_context, blocked_request_policy_does_not_override_user_denial_outcome, deferred_finish_reuses_denial_result_after_first_consumer, finish_call_returns_denial_and_unregisters_active_call, pending_approvals_are_deduped_per_host_protocol_and_port, pending_approvals_do_not_dedupe_across_ports, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests (+4 more)); 4 external calls (new, new, new, default).


##### `NetworkApprovalService::sync_session_approved_hosts_to`  (lines 257–262)

```
async fn sync_session_approved_hosts_to(&self, other: &Self)
```

**Purpose**: Copies the current session-approved host cache into another service, replacing whatever approvals the target already had. This supports session cloning or handoff while preserving approval scope.

**Data flow**: Locks `self.session_approved_hosts`, clones the full `HashSet<HostApprovalKey>`, then locks `other.session_approved_hosts`, clears it, and extends it with the cloned entries → returns `()`.

**Call relations**: Higher-level session-management code uses this when one session should inherit another session’s approved-host cache. It intentionally copies only approvals, not denials or active-call state.


##### `NetworkApprovalService::register_call`  (lines 264–284)

```
async fn register_call(
        &self,
        registration_id: String,
        turn_id: String,
        trigger: GuardianNetworkAccessTrigger,
        command: String,
        cancellation_token: Can
```

**Purpose**: Registers a tool call as an active owner candidate for future network-denial attribution. It stores the call’s turn, trigger context, command string, and cancellation token under a registration ID.

**Data flow**: Consumes `registration_id`, `turn_id`, `trigger`, `command`, and `cancellation_token` → locks `self.calls`, clones the registration ID for use as the `IndexMap` key, constructs `ActiveNetworkApprovalCall`, wraps it in `Arc`, and inserts it into `active_calls` → returns `()`.

**Call relations**: Tool-attempt startup calls this indirectly through `begin_network_approval`. Later attribution logic such as `resolve_single_active_call`, `record_call_outcome`, and approval prompts depend on the metadata stored here.

*Call graph*: called by 1 (register_call_with_default_shell_trigger); 1 external calls (new).


##### `NetworkApprovalService::unregister_call`  (lines 286–288)

```
async fn unregister_call(&self, registration_id: &str)
```

**Purpose**: Removes an active call registration and any stored outcome associated with it. This is the explicit cleanup path when a call should no longer participate in approval attribution.

**Data flow**: Reads `registration_id: &str` → delegates to `remove_call(registration_id).await` and discards the returned outcome → returns `()`.

**Call relations**: Call cleanup code and tests use this when they want to drop a registration without converting any outcome into an error. It is a thin wrapper over the internal removal helper.

*Call graph*: calls 1 internal fn (remove_call).


##### `NetworkApprovalService::resolve_single_active_call`  (lines 290–300)

```
async fn resolve_single_active_call(&self) -> Option<Arc<ActiveNetworkApprovalCall>>
```

**Purpose**: Returns the sole active call when exactly one call is registered, and `None` otherwise. This avoids misattributing blocked requests or approval prompts when multiple tools are running concurrently.

**Data flow**: Locks `self.calls` → checks `active_calls.len()` → if it is exactly 1, clones and returns the only `Arc<ActiveNetworkApprovalCall>`; otherwise returns `None`.

**Call relations**: Both blocked-request handling and inline approval prompting use this to decide whether a network event can safely be tied to a specific tool call. The method intentionally refuses to guess under concurrency.

*Call graph*: called by 2 (handle_inline_policy_request, record_outcome_for_single_active_call).


##### `NetworkApprovalService::get_or_create_pending_approval`  (lines 302–314)

```
async fn get_or_create_pending_approval(
        &self,
        key: HostApprovalKey,
    ) -> (Arc<PendingHostApproval>, bool)
```

**Purpose**: Deduplicates concurrent approval requests for the same host key by returning a shared `PendingHostApproval` plus an ownership flag. The first caller becomes the owner responsible for prompting; later callers wait on the same object.

**Data flow**: Consumes `key: HostApprovalKey` → locks `pending_host_approvals` → if the key exists, clones and returns the existing `Arc<PendingHostApproval>` with `false`; otherwise creates a new `PendingHostApproval`, inserts it, and returns it with `true`.

**Call relations**: Inline policy handling calls this before any prompt logic. The returned boolean drives the branch between owner-side approval resolution and waiter-side `wait_for_decision` reuse.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_inline_policy_request); 2 external calls (clone, new).


##### `NetworkApprovalService::record_outcome_for_single_active_call`  (lines 316–322)

```
async fn record_outcome_for_single_active_call(&self, outcome: NetworkApprovalOutcome)
```

**Purpose**: Records a denial outcome against the only active call, if there is exactly one. It is the safe attribution helper for blocked requests and immediate policy denials.

**Data flow**: Consumes `outcome: NetworkApprovalOutcome` → calls `resolve_single_active_call()` → if a sole owner exists, forwards `owner_call.registration_id` and the outcome to `record_call_outcome`; otherwise does nothing.

**Call relations**: This helper is used when the system knows a denial occurred but lacks explicit call attribution. It delegates actual storage and cancellation to `record_call_outcome` after the single-owner check.

*Call graph*: calls 2 internal fn (record_call_outcome, resolve_single_active_call); called by 2 (handle_inline_policy_request, record_blocked_request).


##### `NetworkApprovalService::take_call_outcome`  (lines 325–328)

```
async fn take_call_outcome(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Test-only helper that removes and returns the stored outcome for a registration ID. It lets tests inspect denial bookkeeping directly.

**Data flow**: Locks `self.calls` mutably → removes `registration_id` from `call_outcomes` → returns `Option<NetworkApprovalOutcome>`.

**Call relations**: Only tests call this to assert internal state transitions. It bypasses the normal finish path and should not be part of production flow.


##### `NetworkApprovalService::record_call_outcome`  (lines 330–347)

```
async fn record_call_outcome(&self, registration_id: &str, outcome: NetworkApprovalOutcome)
```

**Purpose**: Stores a denial outcome for an active call and cancels its token so execution can stop. It preserves an existing `DeniedByUser` outcome against later policy-denial overwrites.

**Data flow**: Reads `registration_id` and `outcome` → locks `self.calls`, looks up the active call, returns early if absent → if `call_outcomes` already contains `DeniedByUser`, returns without overwriting → otherwise inserts the new outcome under the registration ID, drops the lock, and calls `call.cancellation_token.cancel()`.

**Call relations**: Inline approval handling and blocked-request attribution both use this to persist denials. It is the key mutation point that links approval outcomes to runtime cancellation.

*Call graph*: called by 2 (handle_inline_policy_request, record_outcome_for_single_active_call); 1 external calls (matches!).


##### `NetworkApprovalService::remove_call`  (lines 349–353)

```
async fn remove_call(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Removes an active call registration and returns any stored outcome for it. This is the internal primitive for unregistering and finishing calls.

**Data flow**: Locks `self.calls` mutably → removes the registration from `active_calls` with `shift_remove` and removes any matching entry from `call_outcomes` → returns the removed `Option<NetworkApprovalOutcome>`.

**Call relations**: Both `unregister_call` and finish helpers delegate to this method. It centralizes the invariant that active-call and outcome state are cleaned up together.

*Call graph*: called by 2 (finish_call_outcome, unregister_call).


##### `NetworkApprovalService::finish_call_outcome`  (lines 355–357)

```
async fn finish_call_outcome(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Finalizes a call by removing it from service state and returning its stored outcome, if any. It is the outcome-producing half of call completion.

**Data flow**: Reads `registration_id` → awaits `remove_call(registration_id)` → returns the resulting `Option<NetworkApprovalOutcome>`.

**Call relations**: Immediate and deferred finish paths use this to consume approval state at the end of a call. It is a thin wrapper that exists to name the completion semantics more clearly.

*Call graph*: calls 1 internal fn (remove_call); called by 1 (finish_call).


##### `NetworkApprovalService::finish_call`  (lines 359–361)

```
async fn finish_call(&self, registration_id: &str) -> Result<(), ToolError>
```

**Purpose**: Finalizes a call and converts any stored denial into a `ToolError`. This is the immediate-mode completion API used by tool orchestration.

**Data flow**: Reads `registration_id` → awaits `finish_call_outcome(registration_id)` → passes the optional outcome to `network_approval_outcome_to_result` → returns `Ok(())` or `Err(ToolError::Rejected(...))`.

**Call relations**: The orchestrator’s immediate network-approval path calls this after a tool attempt completes. It combines state cleanup with the standard outcome-to-error translation.

*Call graph*: calls 2 internal fn (finish_call_outcome, network_approval_outcome_to_result).


##### `NetworkApprovalService::record_blocked_request`  (lines 363–370)

```
async fn record_blocked_request(&self, blocked: BlockedRequest)
```

**Purpose**: Converts a blocked proxy request into a policy-denial outcome for the owning tool call when possible. Requests without a recognizable denial message are ignored.

**Data flow**: Consumes `blocked: BlockedRequest` → calls `denied_network_policy_message(&blocked)`; if it returns `None`, exits → otherwise wraps the message in `NetworkApprovalOutcome::DeniedByPolicy` and passes it to `record_outcome_for_single_active_call` → returns `()`.

**Call relations**: The blocked-request observer closure feeds proxy denials into this method. It delegates message formatting to `denied_network_policy_message` and safe attribution to `record_outcome_for_single_active_call`.

*Call graph*: calls 2 internal fn (denied_network_policy_message, record_outcome_for_single_active_call); 1 external calls (DeniedByPolicy).


##### `NetworkApprovalService::active_turn_context`  (lines 372–380)

```
async fn active_turn_context(
        session: &Session,
    ) -> Option<Arc<crate::session::turn_context::TurnContext>>
```

**Purpose**: Fetches the currently active turn context from a session, if one exists and has an attached task. This is needed because inline network requests are handled outside the original tool call stack.

**Data flow**: Locks `session.active_turn` → reads the optional active turn, then its optional task, then clones and returns `task.turn_context` inside `Option<Arc<TurnContext>>`.

**Call relations**: Inline policy handling uses this to recover the turn context needed for approval prompts, hooks, and policy checks. If it returns `None`, approval flow cannot proceed and the request is denied.


##### `NetworkApprovalService::format_network_target`  (lines 382–384)

```
fn format_network_target(protocol: &str, host: &str, port: u16) -> String
```

**Purpose**: Formats a protocol/host/port triple into the canonical target string shown in prompts and denial messages. The output is URI-like but always includes an explicit port.

**Data flow**: Reads `protocol`, `host`, and `port` → returns `format!("{protocol}://{host}:{port}")`.

**Call relations**: Inline policy handling uses this when constructing user-facing prompt text and policy-denial messages. It is a small formatting helper to keep those strings consistent.

*Call graph*: 1 external calls (format!).


##### `NetworkApprovalService::approval_id_for_key`  (lines 386–388)

```
fn approval_id_for_key(key: &HostApprovalKey) -> String
```

**Purpose**: Builds the stable approval identifier string for a host key. This ID is used when invoking hooks and approval systems so repeated requests for the same target share identity.

**Data flow**: Reads `key.protocol`, `key.host`, and `key.port` → returns `format!("network#{}#{}#{}", ...)`.

**Call relations**: Inline policy handling calls this before hook evaluation and approval prompting. It ensures all approval surfaces refer to the same network target with the same ID format.

*Call graph*: 1 external calls (format!).


##### `NetworkApprovalService::handle_inline_policy_request`  (lines 390–671)

```
async fn handle_inline_policy_request(
        &self,
        session: Arc<Session>,
        request: NetworkPolicyRequest,
    ) -> NetworkDecision
```

**Purpose**: Processes a network policy miss from the proxy, deciding whether to allow, deny, or prompt for approval. It performs cache checks, deduplicates concurrent prompts, consults hooks, invokes guardian or user review, persists policy amendments, records call outcomes, and updates session-scoped allow/deny caches.

**Data flow**: Consumes `session: Arc<Session>` and `request: NetworkPolicyRequest` → maps proxy protocol to `NetworkApprovalProtocol`, derives a normalized `HostApprovalKey`, checks `session_denied_hosts` then `session_approved_hosts` for immediate deny/allow, and obtains a shared `PendingHostApproval` via `get_or_create_pending_approval` → non-owner callers wait on `wait_for_decision()` and convert the result with `to_network_decision()`.

For the owner path, it formats target and denial strings, fetches the active turn via `active_turn_context`, and rejects early if there is no active turn, the permission profile is not managed, or the approval policy forbids network approval; each early denial sets the pending decision, removes the pending entry, records a policy outcome for the sole active call when possible, and returns `NetworkDecision::deny("not_allowed")`.

If approval flow is allowed, it resolves the sole active call for attribution, builds `NetworkApprovalContext`, approval IDs, and a prompt command, then runs permission-request hooks. Hook allow returns `Allow`; hook deny records a policy outcome for the owner call, resolves the pending approval as deny, and returns a deny decision.

Without a hook decision, it chooses guardian review or direct session approval, awaits a `ReviewDecision`, translates that into `PendingApprovalDecision`, optionally persists network policy amendments and emits warning events on persistence failure, records `DeniedByUser` or `DeniedByPolicy` outcomes for the owner call as appropriate, updates session allow/deny caches for `AllowForSession` or deny amendments, resolves and removes the pending approval entry, and finally returns the corresponding `NetworkDecision`.

**Call relations**: The network policy decider closure invokes this whenever the managed proxy needs an inline decision. Inside the method, control flows through nearly every helper in the file: key normalization, pending-approval deduplication, active-call resolution, hook evaluation, guardian/user approval, outcome recording, and cache maintenance. It is the central coordinator of the network-approval subsystem.

*Call graph*: calls 10 internal fn (run_permission_request_hooks, from_request, get_or_create_pending_approval, record_call_outcome, record_outcome_for_single_active_call, resolve_single_active_call, allows_network_approval_flow, permission_profile_allows_network_approval_flow, bash, deny); 13 external calls (active_turn_context, approval_id_for_key, format_network_target, DeniedByPolicy, guardian_rejection_message, guardian_timeout_message, review_approval_request, routes_approval_to_guardian, format!, matches! (+3 more)).


##### `build_blocked_request_observer`  (lines 674–683)

```
fn build_blocked_request_observer(
    network_approval: Arc<NetworkApprovalService>,
) -> Arc<dyn BlockedRequestObserver>
```

**Purpose**: Creates the async observer closure that the network proxy calls when it blocks a request. The closure forwards blocked-request events into the approval service.

**Data flow**: Consumes `network_approval: Arc<NetworkApprovalService>` → returns `Arc<dyn BlockedRequestObserver>` wrapping a closure that clones the service and asynchronously calls `record_blocked_request(blocked)`.

**Call relations**: Proxy setup code uses this to connect low-level blocked-request notifications to approval bookkeeping. The closure’s only delegated work is the service method that records policy denials.

*Call graph*: 1 external calls (new).


##### `build_network_policy_decider`  (lines 685–701)

```
fn build_network_policy_decider(
    network_approval: Arc<NetworkApprovalService>,
    network_policy_decider_session: Arc<RwLock<std::sync::Weak<Session>>>,
) -> Arc<dyn NetworkPolicyDecider>
```

**Purpose**: Creates the async policy-decider closure used by the network proxy to ask for allow/deny decisions. It upgrades a weak session reference and delegates request handling to the approval service.

**Data flow**: Consumes `network_approval: Arc<NetworkApprovalService>` and `network_policy_decider_session: Arc<RwLock<Weak<Session>>>` → returns `Arc<dyn NetworkPolicyDecider>` wrapping a closure that clones both, upgrades the weak session under a read lock, returns `NetworkDecision::ask("not_allowed")` if the session is gone, otherwise awaits `network_approval.handle_inline_policy_request(session, request)`.

**Call relations**: Network proxy initialization installs this closure as the decider. It is the bridge from proxy callbacks into the service’s main inline-policy state machine.

*Call graph*: 1 external calls (new).


##### `begin_network_approval`  (lines 703–738)

```
async fn begin_network_approval(
    session: &Session,
    turn_id: &str,
    managed_network_active: bool,
    spec: Option<NetworkApprovalSpec>,
) -> Option<ActiveNetworkApproval>
```

**Purpose**: Starts network-approval tracking for a tool attempt when managed networking is active and the tool supplied a network-approval spec. It registers the call and returns an `ActiveNetworkApproval` handle carrying mode and cancellation state.

**Data flow**: Reads `session`, `turn_id`, `managed_network_active`, and optional `spec` → returns `None` immediately if `spec` is absent, managed networking is inactive, or `spec.network` is `None` → otherwise generates a UUID registration ID, creates a new `CancellationToken`, registers the call in `session.services.network_approval` with turn ID, trigger, command, and token, and returns `Some(ActiveNetworkApproval { registration_id: Some(...), mode, cancellation_token })`.

**Call relations**: The orchestrator calls this at the start of each tool attempt before invoking the runtime. It sets up the registration that later blocked requests, inline approvals, and finish paths rely on.

*Call graph*: called by 1 (run_attempt); 2 external calls (new, new_v4).


##### `finish_immediate_network_approval`  (lines 740–753)

```
async fn finish_immediate_network_approval(
    session: &Session,
    active: ActiveNetworkApproval,
) -> Result<(), ToolError>
```

**Purpose**: Completes immediate-mode network approval after a tool attempt finishes. It consumes the active handle and returns any recorded denial as a `ToolError`.

**Data flow**: Consumes `session` and `active: ActiveNetworkApproval` → if `active.registration_id` is `None`, returns `Ok(())` → otherwise calls `session.services.network_approval.finish_call(registration_id).await` and returns that result.

**Call relations**: The orchestrator uses this when `ActiveNetworkApproval::mode()` is `Immediate`. It delegates all cleanup and outcome translation to the service’s `finish_call` method.

*Call graph*: called by 1 (run_attempt).


##### `finish_deferred_network_approval`  (lines 755–763)

```
async fn finish_deferred_network_approval(
    session: &Session,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), ToolError>
```

**Purpose**: Completes deferred-mode network approval when a deferred handle is available. Missing deferred state is treated as a no-op success.

**Data flow**: Consumes `session` and `deferred: Option<DeferredNetworkApproval>` → returns `Ok(())` if `deferred` is `None` → otherwise calls `deferred.finish(&session.services.network_approval).await` and returns the result.

**Call relations**: The orchestrator and later session-level cleanup paths call this when deferred network approval must be resolved. It delegates the actual once-only finish behavior to `DeferredNetworkApproval::finish`.

*Call graph*: called by 3 (run_attempt, finish_deferred_network_approval_for_session, network_denial_message_for_session).


### `network-proxy/src/network_policy.rs`

`domain_logic` · `request handling and audit emission`

This file is the bridge between low-level host blocking in `NetworkProxyState` and higher-level policy outcomes consumed by HTTP/SOCKS handlers. It defines `NetworkProtocol` string mappings for audit fields, `NetworkPolicyDecision` (`Deny` vs `Ask`) and `NetworkDecisionSource` (`BaselinePolicy`, `ModeGuard`, `ProxyState`, `Decider`) so callers can distinguish hard baseline denials from interactive or runtime-originated decisions. `NetworkPolicyRequest` packages the concrete request context the decider may need: normalized host, port, optional client address, HTTP method, command, and exec-policy hint.

The core flow is `evaluate_host_policy`. It first asks `state.host_blocked(host, port)` for the baseline domain/IP decision. If the baseline says `Allowed`, the result is immediately `Allow`. If the baseline says `Blocked(NotAllowed)`, an optional external `NetworkPolicyDecider` may override that specific allowlist miss; other baseline reasons such as explicit denylist hits or local/private-network blocks are never delegated. Any decider denial is rewritten to source `Decider` via `map_decider_decision`, preserving whether it was `Deny` or `Ask`. After deciding, the function emits a single structured tracing event with audit metadata from `NetworkProxyState`, including scope (`domain` vs `non_domain`), protocol, server address/port, fallback method/client placeholders, and whether a decider overrode baseline policy.

The test support module installs a custom `tracing::Subscriber` that records event fields into `BTreeMap<String, String>`, letting tests assert exact emitted telemetry and verify legacy event names are no longer produced.

#### Function details

##### `NetworkProtocol::as_policy_protocol`  (lines 31–38)

```
fn as_policy_protocol(self) -> &'static str
```

**Purpose**: Converts the internal protocol enum into the exact lowercase string written into audit telemetry.

**Data flow**: Reads `self` and matches each variant to a static string (`http`, `https_connect`, `socks5_tcp`, `socks5_udp`). Returns that borrowed string without mutating state.

**Call relations**: Used when policy decisions are serialized into tracing fields so downstream audit consumers see stable protocol labels.

*Call graph*: called by 1 (proxy_disabled_response).


##### `NetworkPolicyDecision::as_str`  (lines 49–54)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps a policy decision enum to its wire/audit string form.

**Data flow**: Consumes `self` by copy and returns either `deny` or `ask` as a `&'static str`.

**Call relations**: Called when blocked requests and audit events need the decision encoded as text rather than as an enum.


##### `NetworkDecisionSource::as_str`  (lines 67–74)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps the source of a decision to the exact snake_case string used in logs and telemetry.

**Data flow**: Reads the enum variant and returns one of `baseline_policy`, `mode_guard`, `proxy_state`, or `decider`.

**Call relations**: Used by audit emission and blocked-request recording so callers can attribute a denial to baseline config, runtime guards, proxy state, or an external decider.


##### `NetworkPolicyRequest::new`  (lines 99–118)

```
fn new(args: NetworkPolicyRequestArgs) -> Self
```

**Purpose**: Builds a `NetworkPolicyRequest` from the parallel `NetworkPolicyRequestArgs` struct without additional normalization or validation.

**Data flow**: Takes ownership of all fields from `NetworkPolicyRequestArgs`, destructures them, and reassembles them into `NetworkPolicyRequest`. Returns the populated request object.

**Call relations**: Invoked by HTTP and SOCKS request handlers before they call `evaluate_host_policy`, and by tests constructing representative requests.

*Call graph*: called by 9 (http_connect_accept, http_plain_proxy, evaluate_host_policy_emits_domain_event_for_baseline_deny, evaluate_host_policy_emits_domain_event_for_decider_allow_override, evaluate_host_policy_emits_domain_event_for_decider_ask, evaluate_host_policy_emits_metadata_fields, evaluate_host_policy_still_denies_not_allowed_local_without_decider_override, handle_socks5_tcp, inspect_socks5_udp).


##### `NetworkDecision::deny`  (lines 132–134)

```
fn deny(reason: impl Into<String>) -> Self
```

**Purpose**: Creates a deny decision attributed to the external decider source by default.

**Data flow**: Accepts any `Into<String>` reason, forwards it to `deny_with_source` with `NetworkDecisionSource::Decider`, and returns the resulting `NetworkDecision`.

**Call relations**: Used by higher-level policy adapters that want a simple decider-originated denial without specifying the source explicitly.

*Call graph*: called by 2 (handle_inline_policy_request, to_network_decision); 1 external calls (deny_with_source).


##### `NetworkDecision::ask`  (lines 136–138)

```
fn ask(reason: impl Into<String>) -> Self
```

**Purpose**: Creates an `Ask` decision, represented internally as the `Deny` variant carrying `decision: Ask` and source `Decider`.

**Data flow**: Accepts a reason, forwards it to `ask_with_source` with `NetworkDecisionSource::Decider`, and returns the constructed decision.

**Call relations**: Used by decider-facing code and tests to represent a soft denial that should surface as `ask` in telemetry and blocked-request details.

*Call graph*: 1 external calls (ask_with_source).


##### `NetworkDecision::deny_with_source`  (lines 140–152)

```
fn deny_with_source(reason: impl Into<String>, source: NetworkDecisionSource) -> Self
```

**Purpose**: Constructs a deny decision with an explicit source and guarantees a non-empty reason string.

**Data flow**: Consumes an arbitrary reason input, converts it to `String`, replaces an empty string with `REASON_POLICY_DENIED`, and returns `NetworkDecision::Deny { reason, source, decision: Deny }`.

**Call relations**: Called by `evaluate_host_policy` when baseline policy blocks a host and by the convenience constructor `deny`.

*Call graph*: called by 1 (evaluate_host_policy); 2 external calls (into, is_empty).


##### `NetworkDecision::ask_with_source`  (lines 154–166)

```
fn ask_with_source(reason: impl Into<String>, source: NetworkDecisionSource) -> Self
```

**Purpose**: Constructs an ask decision with an explicit source while enforcing the same non-empty-reason invariant as hard denies.

**Data flow**: Converts the input reason into `String`, substitutes `REASON_POLICY_DENIED` if empty, and returns `NetworkDecision::Deny { ..., decision: Ask }`.

**Call relations**: Used by `ask` and available for callers that need non-default source attribution on an interactive/soft denial.

*Call graph*: 2 external calls (into, is_empty).


##### `emit_block_decision_audit_event`  (lines 179–184)

```
fn emit_block_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Emits a non-domain audit event for a blocked request path such as mode guards or proxy-disabled checks.

**Data flow**: Takes `NetworkProxyState` plus `BlockDecisionAuditEventArgs`, fixes the decision string to `deny`, and forwards all fields to `emit_non_domain_policy_decision_audit_event`.

**Call relations**: Called by HTTP and SOCKS transport code when a request is rejected before or outside domain allow/deny evaluation.

*Call graph*: calls 1 internal fn (emit_non_domain_policy_decision_audit_event); called by 2 (emit_http_block_decision_audit_event, emit_socks_block_decision_audit_event).


##### `emit_allow_decision_audit_event`  (lines 186–191)

```
fn emit_allow_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Emits a non-domain audit event for an explicit allow outcome outside domain policy evaluation.

**Data flow**: Accepts the same audit args as the block emitter, fixes the decision string to `allow`, and delegates to `emit_non_domain_policy_decision_audit_event`.

**Call relations**: Used by HTTP-side code paths that want to audit a transport-level allow decision with the same field schema as denials.

*Call graph*: calls 1 internal fn (emit_non_domain_policy_decision_audit_event); called by 1 (emit_http_allow_decision_audit_event).


##### `emit_non_domain_policy_decision_audit_event`  (lines 193–213)

```
fn emit_non_domain_policy_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
    decision: &'static str,
)
```

**Purpose**: Normalizes transport-level allow/deny events into the common policy audit schema with scope `non_domain`.

**Data flow**: Reads the supplied block/allow args, converts the source enum to text, sets `policy_override` to `false`, wraps everything in `PolicyAuditEventArgs`, and passes it to `emit_policy_audit_event`.

**Call relations**: Shared helper behind both non-domain allow and block emitters so HTTP and SOCKS transport guards produce identical telemetry structure.

*Call graph*: calls 1 internal fn (emit_policy_audit_event); called by 2 (emit_allow_decision_audit_event, emit_block_decision_audit_event).


##### `emit_policy_audit_event`  (lines 228–255)

```
fn emit_policy_audit_event(state: &NetworkProxyState, args: PolicyAuditEventArgs<'_>)
```

**Purpose**: Writes the canonical structured tracing event for all network policy decisions.

**Data flow**: Reads audit metadata from `state.audit_metadata()`, computes a timestamp via `audit_timestamp()`, merges metadata with request/policy fields, substitutes `DEFAULT_METHOD` and `DEFAULT_CLIENT_ADDRESS` when optional values are absent, and emits a `tracing::event!` at INFO level to target `codex_otel.network_proxy`.

**Call relations**: This is the final sink for both domain decisions from `evaluate_host_policy` and non-domain decisions from the helper emitters.

*Call graph*: calls 1 internal fn (audit_metadata); called by 2 (emit_non_domain_policy_decision_audit_event, evaluate_host_policy); 1 external calls (event!).


##### `audit_timestamp`  (lines 257–259)

```
fn audit_timestamp() -> String
```

**Purpose**: Generates the event timestamp string in the exact RFC3339 UTC-with-milliseconds format expected by tests and telemetry consumers.

**Data flow**: Reads the current UTC time from `Utc::now()` and formats it with `to_rfc3339_opts(SecondsFormat::Millis, true)`. Returns the owned `String`.

**Call relations**: Used only by `emit_policy_audit_event` to stamp each audit event.

*Call graph*: 1 external calls (now).


##### `Arc::decide`  (lines 274–276)

```
fn decide(&self, req: NetworkPolicyRequest) -> NetworkPolicyDeciderFuture<'_>
```

**Purpose**: Lets `Arc<dyn NetworkPolicyDecider>` itself satisfy the `NetworkPolicyDecider` trait by forwarding through the inner object.

**Data flow**: Takes `&Arc<D>` and a `NetworkPolicyRequest`, creates a boxed async future, awaits the inner decider’s `decide`, and returns the resulting `NetworkDecision`.

**Call relations**: Enables callers like `evaluate_host_policy` and builder APIs to store deciders behind `Arc` without extra wrapper types.

*Call graph*: 1 external calls (pin).


##### `F::decide`  (lines 284–286)

```
fn decide(&self, req: NetworkPolicyRequest) -> NetworkPolicyDeciderFuture<'_>
```

**Purpose**: Implements `NetworkPolicyDecider` for async closures/functions so tests and embedding code can pass plain lambdas.

**Data flow**: Consumes the request, invokes the closure `F`, boxes the returned future, and yields its `NetworkDecision` output.

**Call relations**: Used heavily in tests and by builder-style APIs that accept generic deciders.

*Call graph*: 1 external calls (pin).


##### `evaluate_host_policy`  (lines 289–359)

```
async fn evaluate_host_policy(
    state: &NetworkProxyState,
    decider: Option<&Arc<dyn NetworkPolicyDecider>>,
    request: &NetworkPolicyRequest,
) -> Result<NetworkDecision>
```

**Purpose**: Evaluates baseline host policy, optionally consults an external decider for allowlist misses, and emits the domain-scoped audit event describing the final outcome.

**Data flow**: Inputs are `state`, optional decider, and a borrowed `NetworkPolicyRequest`. It awaits `state.host_blocked(host, port)`, maps `Allowed` directly to `NetworkDecision::Allow`, maps baseline deny reasons to `deny_with_source(..., BaselinePolicy)`, and only for `HostBlockReason::NotAllowed` may clone the request and await `decider.decide(...)`. A decider `Allow` sets `policy_override = true`; decider denials are normalized through `map_decider_decision`. It then derives audit strings (`allow`, `deny`, or `ask`), source, and reason, emits a domain-scoped policy event, and returns `Result<NetworkDecision>`.

**Call relations**: Called by HTTP CONNECT, plain HTTP proxying, SOCKS5 TCP, and SOCKS5 UDP inspection whenever a destination host must be checked against policy. It delegates baseline checks to `NetworkProxyState::host_blocked`, optional overrides to the decider, and final telemetry to `emit_policy_audit_event`.

*Call graph*: calls 4 internal fn (deny_with_source, emit_policy_audit_event, map_decider_decision, host_blocked); called by 5 (http_connect_accept, http_plain_proxy, evaluate_host_policy_still_denies_not_allowed_local_without_decider_override, handle_socks5_tcp, inspect_socks5_udp); 2 external calls (matches!, clone).


##### `map_decider_decision`  (lines 361–372)

```
fn map_decider_decision(decision: NetworkDecision) -> NetworkDecision
```

**Purpose**: Rewrites any decider-produced denial so its source is always recorded as `Decider` while preserving the reason and deny-vs-ask subtype.

**Data flow**: Matches the incoming `NetworkDecision`; returns `Allow` unchanged, or reconstructs the `Deny` variant with the same `reason` and `decision` but `source: NetworkDecisionSource::Decider`.

**Call relations**: Used only inside `evaluate_host_policy` after awaiting the external decider, ensuring telemetry and blocked-request records attribute the result consistently.

*Call graph*: called by 1 (evaluate_host_policy).


##### `test_support::CapturedEvent::field`  (lines 402–404)

```
fn field(&self, name: &str) -> Option<&str>
```

**Purpose**: Looks up a captured tracing field by name and returns it as `&str` for assertions.

**Data flow**: Reads the `fields: BTreeMap<String, String>` map, fetches the named entry if present, and converts `&String` to `&str`.

**Call relations**: Used by test helpers and assertions to inspect emitted audit events without exposing the map directly.


##### `test_support::EventCollector::events`  (lines 414–419)

```
fn events(&self) -> Vec<CapturedEvent>
```

**Purpose**: Returns a cloned snapshot of all tracing events captured so far by the test subscriber.

**Data flow**: Locks the internal `Mutex<Vec<CapturedEvent>>`, recovers from poisoning by taking the inner value, clones the vector, and returns it.

**Call relations**: Called by `capture_events` after the async test body finishes so assertions can inspect the full event stream.


##### `test_support::EventCollector::enabled`  (lines 423–425)

```
fn enabled(&self, _metadata: &Metadata<'_>) -> bool
```

**Purpose**: Reports that every tracing callsite is enabled for this test subscriber.

**Data flow**: Ignores metadata and returns `true` unconditionally.

**Call relations**: Part of the `Subscriber` implementation so no audit event is filtered out during tests.


##### `test_support::EventCollector::register_callsite`  (lines 427–429)

```
fn register_callsite(&self, _metadata: &'static Metadata<'static>) -> Interest
```

**Purpose**: Marks every tracing callsite as always interesting.

**Data flow**: Ignores metadata and returns `Interest::always()`.

**Call relations**: Works with `enabled` to ensure the collector receives all events emitted during tests.

*Call graph*: 1 external calls (always).


##### `test_support::EventCollector::max_level_hint`  (lines 431–433)

```
fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter>
```

**Purpose**: Advertises TRACE as the maximum enabled level.

**Data flow**: Returns `Some(LevelFilter::TRACE)`.

**Call relations**: Supports the permissive subscriber behavior used by `capture_events`.


##### `test_support::EventCollector::new_span`  (lines 435–437)

```
fn new_span(&self, _span: &Attributes<'_>) -> Id
```

**Purpose**: Allocates monotonically increasing synthetic span IDs for tracing spans, even though tests mainly care about events.

**Data flow**: Atomically increments `next_span_id` with relaxed ordering, adds one, wraps it in `tracing::Id`, and returns it.

**Call relations**: Required by the `Subscriber` trait; spans are not otherwise recorded in this helper.

*Call graph*: 1 external calls (from_u64).


##### `test_support::EventCollector::record`  (lines 439–439)

```
fn record(&self, _span: &Id, _values: &Record<'_>)
```

**Purpose**: Ignores span field updates because the test collector only stores events.

**Data flow**: Accepts span ID and values and performs no mutation or output.

**Call relations**: Trait boilerplate for the minimal subscriber implementation.


##### `test_support::EventCollector::record_follows_from`  (lines 441–441)

```
fn record_follows_from(&self, _span: &Id, _follows: &Id)
```

**Purpose**: Ignores follows-from relationships between spans.

**Data flow**: Accepts IDs and performs no work.

**Call relations**: Another no-op required by the `Subscriber` trait.


##### `test_support::EventCollector::event`  (lines 443–453)

```
fn event(&self, event: &Event<'_>)
```

**Purpose**: Captures a tracing event’s target and all recorded fields into a test-friendly struct.

**Data flow**: Creates a default `FieldVisitor`, asks the event to record into it, locks the shared event vector, and pushes a `CapturedEvent { target, fields }` built from the event metadata target and collected field map.

**Call relations**: This is the core of the test subscriber; every emitted audit event flows through here when wrapped by `capture_events`.

*Call graph*: 3 external calls (default, metadata, record).


##### `test_support::EventCollector::enter`  (lines 455–455)

```
fn enter(&self, _span: &Id)
```

**Purpose**: Ignores span entry notifications.

**Data flow**: Accepts a span ID and does nothing.

**Call relations**: No-op trait method for the test subscriber.


##### `test_support::EventCollector::exit`  (lines 457–457)

```
fn exit(&self, _span: &Id)
```

**Purpose**: Ignores span exit notifications.

**Data flow**: Accepts a span ID and does nothing.

**Call relations**: No-op trait method for the test subscriber.


##### `test_support::FieldVisitor::insert`  (lines 466–468)

```
fn insert(&mut self, field: &Field, value: impl Into<String>)
```

**Purpose**: Stores one tracing field/value pair into the visitor’s ordered map.

**Data flow**: Reads the field name, converts the supplied value into `String`, and inserts it into `fields: BTreeMap<String, String>` under the field name key.

**Call relations**: Shared by all `Visit` callbacks so every primitive/debug field ends up in the same captured representation.

*Call graph*: called by 9 (record_bool, record_debug, record_error, record_f64, record_i128, record_i64, record_str, record_u128, record_u64); 2 external calls (name, into).


##### `test_support::FieldVisitor::record_str`  (lines 472–474)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Captures string-valued tracing fields.

**Data flow**: Receives a `Field` and `&str`, forwards them to `insert`, and updates the visitor map.

**Call relations**: Invoked by tracing when an event field is recorded as a string.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_bool`  (lines 476–478)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Captures boolean tracing fields as strings.

**Data flow**: Converts the bool to text and inserts it under the field name.

**Call relations**: Used during event capture for fields like `network.policy.override`.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_i64`  (lines 480–482)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Captures signed 64-bit integer tracing fields.

**Data flow**: Formats the integer with `to_string()` and inserts it into the field map.

**Call relations**: Used for numeric event fields such as ports when tracing records them as signed values.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_u64`  (lines 484–486)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Captures unsigned 64-bit integer tracing fields.

**Data flow**: Stringifies the value and stores it by field name.

**Call relations**: Part of the generic event-field capture path.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_i128`  (lines 488–490)

```
fn record_i128(&mut self, field: &Field, value: i128)
```

**Purpose**: Captures signed 128-bit integer tracing fields.

**Data flow**: Converts the integer to `String` and inserts it into the map.

**Call relations**: Completes numeric coverage for tracing field capture.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_u128`  (lines 492–494)

```
fn record_u128(&mut self, field: &Field, value: u128)
```

**Purpose**: Captures unsigned 128-bit integer tracing fields.

**Data flow**: Stringifies the value and inserts it into the visitor map.

**Call relations**: Completes numeric coverage for tracing field capture.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_f64`  (lines 496–498)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Captures floating-point tracing fields.

**Data flow**: Formats the `f64` as text and stores it under the field name.

**Call relations**: Generic support for any float-valued event fields.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_error`  (lines 500–502)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Captures error-valued tracing fields using their display text.

**Data flow**: Calls `to_string()` on the error trait object and inserts the resulting string.

**Call relations**: Allows tests to inspect error fields if any are emitted.

*Call graph*: calls 1 internal fn (insert); 1 external calls (to_string).


##### `test_support::FieldVisitor::record_debug`  (lines 504–506)

```
fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug)
```

**Purpose**: Captures arbitrary debug-formatted tracing fields.

**Data flow**: Formats the debug value with `format!("{value:?}")` and inserts it into the map.

**Call relations**: Fallback path for fields not emitted as primitive tracing types.

*Call graph*: calls 1 internal fn (insert); 1 external calls (format!).


##### `test_support::capture_events`  (lines 509–519)

```
async fn capture_events(f: F) -> (T, Vec<CapturedEvent>)
```

**Purpose**: Runs an async closure under the custom subscriber and returns both its output and the events emitted during execution.

**Data flow**: Creates a default `EventCollector`, installs it as the thread-local default subscriber for the duration of the async body, awaits the closure result, snapshots collected events via `collector.events()`, and returns `(output, events)`.

**Call relations**: Used by audit-event tests throughout this module and other modules to assert exact tracing output.

*Call graph*: 2 external calls (default, set_default).


##### `test_support::find_event_by_name`  (lines 521–528)

```
fn find_event_by_name(
        events: &'a [CapturedEvent],
        event_name: &str,
    ) -> Option<&'a CapturedEvent>
```

**Purpose**: Finds the first captured event whose `event.name` field matches a requested value.

**Data flow**: Iterates over a slice of `CapturedEvent`, calls `field("event.name")` on each, and returns the first matching reference or `None`.

**Call relations**: Convenience helper used by tests to locate the policy decision event among all captured tracing output.

*Call graph*: 1 external calls (iter).


##### `tests::StaticReloader::maybe_reload`  (lines 565–567)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Test reloader implementation that never reports a pending config reload.

**Data flow**: Returns a boxed async future resolving to `Ok(None)`.

**Call relations**: Used by test-created `NetworkProxyState` instances so policy evaluation is deterministic and does not mutate underfoot.

*Call graph*: 1 external calls (pin).


##### `tests::StaticReloader::reload_now`  (lines 569–571)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Test reloader implementation that always returns its stored `ConfigState` clone on forced reload.

**Data flow**: Clones `self.state` inside a boxed async future and returns `Ok(clone)`.

**Call relations**: Supports tests that need a concrete reloader object satisfying the runtime trait.

*Call graph*: 2 external calls (pin, clone).


##### `tests::StaticReloader::source_label`  (lines 573–575)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a stable human-readable label for test reload logging.

**Data flow**: Returns the fixed string `static test reloader` as an owned `String`.

**Call relations**: Used indirectly by runtime reload paths if invoked during tests.


##### `tests::state_with_metadata`  (lines 578–590)

```
fn state_with_metadata(metadata: NetworkProxyAuditMetadata) -> NetworkProxyState
```

**Purpose**: Builds a `NetworkProxyState` configured for tests with supplied audit metadata attached.

**Data flow**: Constructs enabled full-mode `NetworkProxySettings`, wraps them in `NetworkProxyConfig`, compiles a `ConfigState` via `build_config_state`, creates a `StaticReloader`, and returns `NetworkProxyState::with_reloader_and_audit_metadata(...)`.

**Call relations**: Used by metadata-focused tests to verify `emit_policy_audit_event` copies audit metadata fields into tracing output.

*Call graph*: calls 3 internal fn (default, with_reloader_and_audit_metadata, build_config_state); 2 external calls (new, default).


##### `tests::is_rfc3339_utc_millis`  (lines 592–608)

```
fn is_rfc3339_utc_millis(timestamp: &str) -> bool
```

**Purpose**: Performs a lightweight structural check that a timestamp string matches the expected RFC3339 UTC millisecond layout.

**Data flow**: Reads the input bytes, checks fixed positions for separators and trailing `Z`, verifies all other positions are ASCII digits, and returns `true` or `false`.

**Call relations**: Used by audit-event tests to validate the timestamp emitted by `audit_timestamp` without depending on exact wall-clock values.


##### `tests::evaluate_host_policy_emits_domain_event_for_decider_allow_override`  (lines 611–675)

```
async fn evaluate_host_policy_emits_domain_event_for_decider_allow_override()
```

**Purpose**: Verifies that a decider can override a baseline `not_allowed` result to `Allow` and that the emitted domain audit event marks the override correctly.

**Data flow**: Builds default policy state, installs a counting closure decider returning `Allow`, constructs a request, runs `evaluate_host_policy` under `capture_events`, and asserts the returned decision, decider call count, event target, scope, decision/source/reason fields, default method/client placeholders, override flag, timestamp shape, and absence of legacy event names.

**Call relations**: Exercises the `evaluate_host_policy` branch where baseline policy denies only because the host is not allowlisted and an external decider grants an override.

*Call graph*: calls 2 internal fn (default, new); 7 external calls (new, new, assert!, assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_emits_domain_event_for_baseline_deny`  (lines 678–721)

```
async fn evaluate_host_policy_emits_domain_event_for_baseline_deny()
```

**Purpose**: Checks that an explicit denylist hit produces a baseline-policy deny decision and corresponding audit fields.

**Data flow**: Creates state with allowed and denied domains, builds a request carrying client and method, captures `evaluate_host_policy`, and asserts the returned `NetworkDecision::Deny` plus event fields for decision, source, reason, override flag, method, and client address.

**Call relations**: Covers the baseline deny path where no decider is consulted.

*Call graph*: calls 2 internal fn (default, new); 5 external calls (assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name, vec!).


##### `tests::evaluate_host_policy_emits_domain_event_for_decider_ask`  (lines 724–762)

```
async fn evaluate_host_policy_emits_domain_event_for_decider_ask()
```

**Purpose**: Ensures a decider-originated `Ask` result is preserved and audited as `ask` rather than `deny`.

**Data flow**: Builds default state, installs a decider closure returning `NetworkDecision::ask(REASON_NOT_ALLOWED)`, evaluates a request under event capture, and asserts both the returned decision struct and the emitted event fields.

**Call relations**: Exercises the decider branch of `evaluate_host_policy` where the external policy does not allow the request but requests an interactive/soft denial.

*Call graph*: calls 2 internal fn (default, new); 5 external calls (new, assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_emits_metadata_fields`  (lines 765–806)

```
async fn evaluate_host_policy_emits_metadata_fields()
```

**Purpose**: Verifies that audit metadata stored in `NetworkProxyState` is copied into every emitted policy decision event.

**Data flow**: Creates a metadata-rich state via `state_with_metadata`, evaluates a request under `capture_events`, finds the policy event, and asserts each metadata field value in the captured event map.

**Call relations**: Tests the metadata-reading portion of `emit_policy_audit_event`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, capture_events, find_event_by_name, state_with_metadata).


##### `tests::emit_block_decision_audit_event_emits_non_domain_event`  (lines 809–854)

```
async fn emit_block_decision_audit_event_emits_non_domain_event()
```

**Purpose**: Checks that the non-domain block helper emits the unified policy decision event with the expected scope and defaults.

**Data flow**: Creates default state, calls `emit_block_decision_audit_event` under `capture_events` with mode-guard arguments, then asserts target, scope, decision, source, reason, protocol, address, port, method, default client address, override flag, and absence of the legacy block event name.

**Call relations**: Covers the transport-level audit helper used by HTTP and SOCKS code before domain policy evaluation.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_still_denies_not_allowed_local_without_decider_override`  (lines 857–885)

```
async fn evaluate_host_policy_still_denies_not_allowed_local_without_decider_override()
```

**Purpose**: Confirms that local/private-network blocks remain baseline denials and are not overridable when no decider is present.

**Data flow**: Builds state with local binding disabled and an allowlist, evaluates a localhost IP request, and asserts the returned decision is `Deny` with reason `REASON_NOT_ALLOWED_LOCAL`, source `BaselinePolicy`, and decision subtype `Deny`.

**Call relations**: Documents the invariant in `evaluate_host_policy`: only `NotAllowed` allowlist misses are eligible for decider override, not local/private-network protections.

*Call graph*: calls 3 internal fn (default, new, evaluate_host_policy); 3 external calls (assert_eq!, network_proxy_state_for_policy, vec!).


##### `tests::ask_uses_decider_source_and_ask_decision`  (lines 888–897)

```
fn ask_uses_decider_source_and_ask_decision()
```

**Purpose**: Verifies the convenience constructor `NetworkDecision::ask` produces the expected internal representation.

**Data flow**: Calls `NetworkDecision::ask(REASON_NOT_ALLOWED)` and compares it to the explicit `NetworkDecision::Deny { ... decision: Ask, source: Decider }` value.

**Call relations**: Unit test for the constructor semantics used by decider implementations.

*Call graph*: 1 external calls (assert_eq!).


### `network-proxy/src/runtime.rs`

`domain_logic` · `cross-cutting runtime state, policy checks, reloads, and telemetry buffering`

This file owns the mutable runtime state behind the proxy. `ConfigState` packages the current `NetworkProxyConfig`, compiled allow/deny `GlobSet`s, optional `MitmState`, compiled MITM hooks, managed constraints, and a bounded FIFO buffer of recent `BlockedRequest` telemetry. `NetworkProxyState` wraps that in `Arc<RwLock<_>>`, pairs it with a `ConfigReloader`, an optional async `BlockedRequestObserver`, and immutable audit metadata.

Most public methods begin with `reload_if_needed`, making the state a live view over config rather than a static snapshot. `force_reload` and `replace_config_state` preserve buffered blocked-request history across config swaps and log allowlist/denylist diffs via `log_policy_changes` instead of dumping whole configs.

The most security-sensitive logic is `host_blocked`. It normalizes the host through `Host::parse`, then enforces a strict decision order: explicit denylist match wins first; local/private-network protection runs second when `allow_local_binding` is false; allowlist enforcement runs last. Local/private protection is defense-in-depth: explicit loopback/private literals are blocked unless exactly allowlisted, and hostnames are DNS-resolved with a 2-second timeout via `host_resolves_to_non_public_ip`; lookup failure or timeout is treated as blocked rather than allowed. Scoped IPv6 literals are matched both with and without scope where appropriate.

The file also records blocked requests. `record_blocked` appends to the bounded buffer, increments a saturating total counter, emits a structured debug log line prefixed with `CODEX_NETWORK_POLICY_VIOLATION`, and notifies any observer asynchronously. Additional helpers expose snapshots/drains of blocked telemetry, runtime mode toggles constrained by managed policy, MITM hook lookup, and unix-socket allowlist checks with absolute-path and best-effort canonicalization rules.

#### Function details

##### `HostBlockReason::as_str`  (lines 68–74)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps a host-block reason enum to the canonical reason string constant used throughout telemetry and responses.

**Data flow**: Matches `self` and returns `REASON_DENIED`, `REASON_NOT_ALLOWED`, or `REASON_NOT_ALLOWED_LOCAL`.

**Call relations**: Used by display formatting and by higher-level policy code when constructing deny decisions.

*Call graph*: called by 1 (fmt).


##### `HostBlockReason::fmt`  (lines 78–80)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a host-block reason using its canonical string form.

**Data flow**: Calls `self.as_str()` and writes the result into the formatter.

**Call relations**: Supports logging and error/reporting paths that display `HostBlockReason`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `BlockedRequest::new`  (lines 119–143)

```
fn new(args: BlockedRequestArgs) -> Self
```

**Purpose**: Constructs a blocked-request telemetry record and stamps it with the current Unix timestamp.

**Data flow**: Consumes `BlockedRequestArgs`, moves all fields into `BlockedRequest`, computes `timestamp` via `unix_timestamp()`, and returns the populated struct.

**Call relations**: Called by HTTP, SOCKS, proxy-disabled, and MITM denial paths before `record_blocked` buffers the event.

*Call graph*: calls 1 internal fn (unix_timestamp); called by 9 (denied_blocked_request, http_connect_accept, http_plain_proxy, proxy_disabled_response, evaluate_mitm_policy, blocked_snapshot_does_not_consume_entries, drain_blocked_returns_buffered_window, handle_socks5_tcp, inspect_socks5_udp).


##### `blocked_request_violation_log_line`  (lines 146–157)

```
fn blocked_request_violation_log_line(entry: &BlockedRequest) -> String
```

**Purpose**: Serializes a blocked request into the structured debug log line format used for policy-violation telemetry.

**Data flow**: Attempts `serde_json::to_string(entry)`; on success prefixes it with `CODEX_NETWORK_POLICY_VIOLATION `, on failure logs a debug message and falls back to a simpler `host=... reason=...` line. Returns the final `String`.

**Call relations**: Used by `NetworkProxyState::record_blocked` before emitting debug logs.

*Call graph*: called by 1 (record_blocked); 3 external calls (debug!, format!, to_string).


##### `Arc::on_blocked_request`  (lines 191–193)

```
fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_>
```

**Purpose**: Lets `Arc<dyn BlockedRequestObserver>` satisfy the observer trait by forwarding to the inner observer.

**Data flow**: Takes ownership of a `BlockedRequest`, boxes an async future, awaits the inner observer’s `on_blocked_request`, and returns `()`.

**Call relations**: Enables state to store observers behind `Arc` without extra wrappers.

*Call graph*: 1 external calls (pin).


##### `F::on_blocked_request`  (lines 201–203)

```
fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_>
```

**Purpose**: Implements `BlockedRequestObserver` for async closures/functions.

**Data flow**: Invokes the closure with the `BlockedRequest`, boxes the returned future, and yields its completion.

**Call relations**: Allows tests or embedding code to install lightweight closure observers.

*Call graph*: 1 external calls (pin).


##### `NetworkProxyState::fmt`  (lines 214–218)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the runtime state without exposing internal config or compiled policy details.

**Data flow**: Writes a non-exhaustive debug struct named `NetworkProxyState`.

**Call relations**: Used implicitly by debugging/logging code.

*Call graph*: 1 external calls (debug_struct).


##### `NetworkProxyState::clone`  (lines 222–229)

```
fn clone(&self) -> Self
```

**Purpose**: Clones the shared runtime state handle, preserving shared ownership of locks and reloader while cloning audit metadata.

**Data flow**: Clones the internal `Arc<RwLock<ConfigState>>`, reloader `Arc`, observer lock `Arc`, and `audit_metadata`, then returns a new `NetworkProxyState` handle.

**Call relations**: Used widely when spawning tasks or passing state into handlers.

*Call graph*: 1 external calls (clone).


##### `NetworkProxyState::with_reloader`  (lines 233–239)

```
fn with_reloader(state: ConfigState, reloader: Arc<dyn ConfigReloader>) -> Self
```

**Purpose**: Constructs runtime state with a config reloader and default empty audit metadata.

**Data flow**: Delegates to `with_reloader_and_audit_metadata` with `NetworkProxyAuditMetadata::default()`.

**Call relations**: Primary constructor used by production setup and many tests.

*Call graph*: called by 8 (build_network_proxy_state, test_network_proxy, network_proxy_state_for_policy, add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed, add_allowed_domain_succeeds_when_managed_baseline_allows_expansion, add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed, state_for_settings, create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths); 2 external calls (with_reloader_and_audit_metadata, default).


##### `NetworkProxyState::with_reloader_and_blocked_observer`  (lines 241–252)

```
fn with_reloader_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    ) -> Self
```

**Purpose**: Constructs runtime state with a reloader, optional blocked-request observer, and default audit metadata.

**Data flow**: Delegates to `with_reloader_and_audit_metadata_and_blocked_observer` with default metadata.

**Call relations**: Used when callers need blocked-request callbacks but no custom audit metadata.

*Call graph*: 2 external calls (with_reloader_and_audit_metadata_and_blocked_observer, default).


##### `NetworkProxyState::with_reloader_and_audit_metadata`  (lines 254–265)

```
fn with_reloader_and_audit_metadata(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
    ) -> Self
```

**Purpose**: Constructs runtime state with explicit audit metadata and no blocked-request observer.

**Data flow**: Delegates to `with_reloader_and_audit_metadata_and_blocked_observer` with `None` observer.

**Call relations**: Used by tests and setup code that need audit metadata attached to emitted events.

*Call graph*: called by 2 (build_state_with_audit_metadata, state_with_metadata); 1 external calls (with_reloader_and_audit_metadata_and_blocked_observer).


##### `NetworkProxyState::with_reloader_and_audit_metadata_and_blocked_observer`  (lines 267–279)

```
fn with_reloader_and_audit_metadata_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
        blocked_requ
```

**Purpose**: Fully initializes the shared runtime state wrapper.

**Data flow**: Wraps the supplied `ConfigState` in `Arc<RwLock<_>>`, stores the reloader, wraps the optional observer in its own `Arc<RwLock<_>>`, stores audit metadata, and returns `NetworkProxyState`.

**Call relations**: Underlying constructor used by all other `with_*` constructors.

*Call graph*: 2 external calls (new, new).


##### `NetworkProxyState::set_blocked_request_observer`  (lines 281–287)

```
async fn set_blocked_request_observer(
        &self,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    )
```

**Purpose**: Replaces the optional blocked-request observer at runtime.

**Data flow**: Acquires the observer write lock and overwrites the stored `Option<Arc<dyn BlockedRequestObserver>>`.

**Call relations**: Called by `NetworkProxyBuilder::build` before the proxy starts.


##### `NetworkProxyState::audit_metadata`  (lines 289–291)

```
fn audit_metadata(&self) -> &NetworkProxyAuditMetadata
```

**Purpose**: Returns the immutable audit metadata attached to this state handle.

**Data flow**: Borrows and returns `&self.audit_metadata`.

**Call relations**: Used by audit-event emission in `network_policy.rs`.

*Call graph*: called by 1 (emit_policy_audit_event).


##### `NetworkProxyState::current_cfg`  (lines 293–299)

```
async fn current_cfg(&self) -> Result<NetworkProxyConfig>
```

**Purpose**: Returns the current live config after applying any pending reload.

**Data flow**: Awaits `reload_if_needed()`, reads the state lock, clones `guard.config`, and returns it.

**Call relations**: Used by proxy orchestration and other callers that need the latest config snapshot.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::current_patterns`  (lines 301–308)

```
async fn current_patterns(&self) -> Result<(Vec<String>, Vec<String>)>
```

**Purpose**: Returns the current allowlist and denylist pattern vectors after reload.

**Data flow**: Reloads if needed, reads the state lock, clones `allowed_domains()` and `denied_domains()` from config with empty defaults, and returns the pair.

**Call relations**: Used by tests and management code inspecting live policy patterns.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::enabled`  (lines 310–314)

```
async fn enabled(&self) -> Result<bool>
```

**Purpose**: Returns whether network proxying is currently enabled.

**Data flow**: Reloads if needed, reads `guard.config.network.enabled`, and returns the boolean.

**Call relations**: Called by HTTP and SOCKS handlers before serving requests.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::force_reload`  (lines 316–342)

```
async fn force_reload(&self) -> Result<()>
```

**Purpose**: Forces a config reload through the reloader, preserving blocked-request telemetry and logging policy diffs.

**Data flow**: Clones the previous config, awaits `reloader.reload_now()`, and on success logs policy changes, copies the existing blocked buffer into the new state, swaps it into the write lock, logs the source label, and returns `Ok(())`. On failure it logs a warning with the source label and returns the error.

**Call relations**: Explicit reload path for management code; differs from `reload_if_needed` by always asking the reloader for a fresh state.

*Call graph*: calls 1 internal fn (log_policy_changes); 2 external calls (info!, warn!).


##### `NetworkProxyState::replace_config_state`  (lines 344–353)

```
async fn replace_config_state(&self, mut new_state: ConfigState) -> Result<()>
```

**Purpose**: Atomically replaces the compiled config state while preserving blocked-request history and logging policy diffs.

**Data flow**: Reloads if needed first, acquires the write lock, logs changes from old to new config, copies `blocked` and `blocked_total` into `new_state`, swaps it into place, logs success, and returns `Ok(())`.

**Call relations**: Called by `NetworkProxy::replace_config_state` after higher-level runtime invariants are checked.

*Call graph*: calls 2 internal fn (reload_if_needed, log_policy_changes); 1 external calls (info!).


##### `NetworkProxyState::host_blocked`  (lines 355–430)

```
async fn host_blocked(&self, host: &str, port: u16) -> Result<HostBlockDecision>
```

**Purpose**: Evaluates whether a destination host/port is allowed, denied by policy, or blocked as local/private networking.

**Data flow**: Reloads if needed, parses and normalizes the host with `Host::parse` (invalid hosts become `Blocked(NotAllowed)`), clones the compiled allow/deny sets and relevant config flags, and then applies ordered checks: denylist match via `globset_matches_host_or_unscoped`; local/private protection when `allow_local_binding` is false, using literal checks (`is_loopback_host`, `is_non_public_ip`, `unscoped_ip_literal`) and DNS-based checks via `host_resolves_to_non_public_ip`; explicit local literals may pass only if `is_explicit_local_allowlisted` returns true; finally, if the allowlist is empty or the host does not match it, returns `Blocked(NotAllowed)`, else `Allowed`.

**Call relations**: This is the baseline policy engine called by `evaluate_host_policy`; its result determines whether an external decider may be consulted.

*Call graph*: calls 8 internal fn (parse, is_loopback_host, is_non_public_ip, unscoped_ip_literal, reload_if_needed, globset_matches_host_or_unscoped, host_resolves_to_non_public_ip, is_explicit_local_allowlisted); called by 1 (evaluate_host_policy); 1 external calls (Blocked).


##### `NetworkProxyState::record_blocked`  (lines 432–465)

```
async fn record_blocked(&self, entry: BlockedRequest) -> Result<()>
```

**Purpose**: Buffers a blocked-request telemetry entry, logs it, increments counters, and notifies any observer.

**Data flow**: Reloads if needed, clones the entry for observer delivery, snapshots the current observer, builds the violation log line, extracts key fields for debug logging, pushes the entry into the `blocked` deque under a write lock, increments `blocked_total` with saturation, trims the deque to `MAX_BLOCKED_EVENTS`, emits debug logs, then awaits `observer.on_blocked_request(...)` if an observer is installed.

**Call relations**: Called by transport and policy-denial paths whenever a request is rejected.

*Call graph*: calls 2 internal fn (reload_if_needed, blocked_request_violation_log_line); called by 1 (proxy_disabled_response); 2 external calls (debug!, clone).


##### `NetworkProxyState::blocked_snapshot`  (lines 469–473)

```
async fn blocked_snapshot(&self) -> Result<Vec<BlockedRequest>>
```

**Purpose**: Returns a non-consuming snapshot of buffered blocked-request entries.

**Data flow**: Reloads if needed, reads the state lock, clones each entry from the deque into a `Vec`, and returns it.

**Call relations**: Used by diagnostics/tests that want to inspect recent blocked requests without draining them.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::drain_blocked`  (lines 476–483)

```
async fn drain_blocked(&self) -> Result<Vec<BlockedRequest>>
```

**Purpose**: Drains and returns the buffered blocked-request window in FIFO order.

**Data flow**: Reloads if needed, takes the entire `blocked` deque out of the write-locked state with `std::mem::take`, converts it into a `Vec`, and returns it.

**Call relations**: Used by diagnostics/tests that want to consume the buffered blocked-request history.

*Call graph*: calls 1 internal fn (reload_if_needed); 1 external calls (take).


##### `NetworkProxyState::is_unix_socket_allowed`  (lines 485–535)

```
async fn is_unix_socket_allowed(&self, path: &str) -> Result<bool>
```

**Purpose**: Checks whether a requested unix socket path is permitted by runtime policy on supported platforms.

**Data flow**: Reloads if needed, immediately returns false if unix-socket permissions are unsupported or the path is not absolute, reads config, returns true if `dangerously_allow_all_unix_sockets` is set, otherwise validates the requested path as `AbsolutePathBuf`, best-effort canonicalizes it, iterates configured allowlist entries parsed as `ValidatedUnixSocketPath`, ignores unix-style-only or invalid entries, compares raw absolute paths first and canonicalized paths second, and returns true on the first match or false otherwise.

**Call relations**: Called by HTTP plain-proxy unix-socket routing and platform capability checks.

*Call graph*: calls 4 internal fn (parse, reload_if_needed, unix_socket_permissions_supported, from_absolute_path); 3 external calls (new, canonicalize, warn!).


##### `NetworkProxyState::method_allowed`  (lines 537–541)

```
async fn method_allowed(&self, method: &str) -> Result<bool>
```

**Purpose**: Checks whether the current network mode permits a given HTTP method.

**Data flow**: Reloads if needed, reads `guard.config.network.mode`, calls `allows_method(method)`, and returns the boolean.

**Call relations**: Used by HTTP request handling to enforce limited-mode method restrictions.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::allow_upstream_proxy`  (lines 543–547)

```
async fn allow_upstream_proxy(&self) -> Result<bool>
```

**Purpose**: Returns whether upstream proxy chaining is allowed by current config.

**Data flow**: Reloads if needed, reads `guard.config.network.allow_upstream_proxy`, and returns it.

**Call relations**: Used by upstream/MITM code deciding whether to honor environment-configured upstream proxies.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::allow_local_binding`  (lines 549–553)

```
async fn allow_local_binding(&self) -> Result<bool>
```

**Purpose**: Returns whether local/private destinations are allowed by current config.

**Data flow**: Reloads if needed, reads `guard.config.network.allow_local_binding`, and returns it.

**Call relations**: Used by callers that need the live policy value rather than the proxy’s cached runtime snapshot.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::network_mode`  (lines 555–559)

```
async fn network_mode(&self) -> Result<NetworkMode>
```

**Purpose**: Returns the current network mode (`Limited` or `Full`).

**Data flow**: Reloads if needed, reads `guard.config.network.mode`, and returns it.

**Call relations**: Used by HTTP/SOCKS handlers and startup logging.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::set_network_mode`  (lines 561–584)

```
async fn set_network_mode(&self, mode: NetworkMode) -> Result<()>
```

**Purpose**: Updates the live network mode while respecting managed constraints and concurrent config changes.

**Data flow**: Loops until successful: reloads if needed, clones the current config and constraints, modifies the candidate mode, validates it with `validate_policy_against_constraints`, then acquires the write lock and retries if constraints changed concurrently. On success it writes the new mode into the live config, logs the update, and returns `Ok(())`.

**Call relations**: Management mutation path for mode changes; uses optimistic retry to avoid racing concurrent reloads.

*Call graph*: calls 2 internal fn (reload_if_needed, validate_policy_against_constraints); 1 external calls (info!).


##### `NetworkProxyState::mitm_state`  (lines 586–590)

```
async fn mitm_state(&self) -> Result<Option<Arc<MitmState>>>
```

**Purpose**: Returns the optional compiled MITM state after reload.

**Data flow**: Reloads if needed, reads the state lock, clones `guard.mitm`, and returns it.

**Call relations**: Used by SOCKS and HTTP MITM paths to decide whether interception is available.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::evaluate_mitm_hook_request`  (lines 592–600)

```
async fn evaluate_mitm_hook_request(
        &self,
        host: &str,
        req: &rama_http::Request,
    ) -> Result<HookEvaluation>
```

**Purpose**: Evaluates configured MITM hooks for a specific host and HTTP request.

**Data flow**: Reloads if needed, reads the state lock, calls `evaluate_mitm_hooks(&guard.mitm_hooks, host, req)`, and returns the `HookEvaluation`.

**Call relations**: Used by MITM request handling when deciding whether a hooked HTTPS request should be allowed or denied.

*Call graph*: calls 2 internal fn (evaluate_mitm_hooks, reload_if_needed).


##### `NetworkProxyState::host_has_mitm_hooks`  (lines 602–606)

```
async fn host_has_mitm_hooks(&self, host: &str) -> Result<bool>
```

**Purpose**: Checks whether any MITM hooks are configured for a normalized host.

**Data flow**: Reloads if needed, normalizes the host with `normalize_host`, checks `guard.mitm_hooks.contains_key(...)`, and returns the boolean.

**Call relations**: Used by SOCKS and HTTP code to decide whether HTTPS traffic must be intercepted.

*Call graph*: calls 2 internal fn (normalize_host, reload_if_needed).


##### `NetworkProxyState::add_allowed_domain`  (lines 608–610)

```
async fn add_allowed_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the live allowlist.

**Data flow**: Delegates to `update_domain_list(host, DomainListKind::Allow).await`.

**Call relations**: Public mutation wrapper used by management code and tests.

*Call graph*: calls 1 internal fn (update_domain_list).


##### `NetworkProxyState::add_denied_domain`  (lines 612–614)

```
async fn add_denied_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the live denylist.

**Data flow**: Delegates to `update_domain_list(host, DomainListKind::Deny).await`.

**Call relations**: Public mutation wrapper used by management code and tests.

*Call graph*: calls 1 internal fn (update_domain_list).


##### `NetworkProxyState::update_domain_list`  (lines 616–673)

```
async fn update_domain_list(&self, host: &str, target: DomainListKind) -> Result<()>
```

**Purpose**: Atomically updates either the allowlist or denylist, recompiles config state, and retries on concurrent changes while respecting managed constraints.

**Data flow**: Parses and normalizes the host, derives target metadata from `DomainListKind`, then loops: reloads if needed, snapshots current config/constraints/blocked telemetry, checks whether the normalized host is already present only in the target list, otherwise updates the candidate config via `upsert_domain_permission`, validates against constraints, recompiles a fresh `ConfigState` with `build_config_state`, restores blocked telemetry into it, acquires the write lock, retries if config or constraints changed concurrently, logs policy changes, swaps in the new state, logs success, and returns.

**Call relations**: Shared implementation behind `add_allowed_domain` and `add_denied_domain`.

*Call graph*: calls 10 internal fn (parse, constraint_field, entries, list_name, opposite_entries, permission, reload_if_needed, log_policy_changes, build_config_state, validate_policy_against_constraints); called by 2 (add_allowed_domain, add_denied_domain); 1 external calls (info!).


##### `NetworkProxyState::reload_if_needed`  (lines 675–699)

```
async fn reload_if_needed(&self) -> Result<()>
```

**Purpose**: Applies a reloader-provided config update if one is pending, preserving blocked-request telemetry.

**Data flow**: Awaits `reloader.maybe_reload()`. If it returns `None`, does nothing. If it returns `Some(new_state)`, snapshots previous config and blocked telemetry, logs policy changes, copies blocked data into the new state, swaps it into the write lock, logs the source label, and returns `Ok(())`.

**Call relations**: Called at the start of nearly every state accessor/mutator so the state behaves like a live config view.

*Call graph*: calls 1 internal fn (log_policy_changes); called by 18 (allow_local_binding, allow_upstream_proxy, blocked_snapshot, current_cfg, current_patterns, drain_blocked, enabled, evaluate_mitm_hook_request, host_blocked, host_has_mitm_hooks (+8 more)); 1 external calls (info!).


##### `DomainListKind::list_name`  (lines 709–714)

```
fn list_name(self) -> &'static str
```

**Purpose**: Returns the human-readable list name for logging and error context.

**Data flow**: Matches `self` and returns `allowlist` or `denylist`.

**Call relations**: Used by `update_domain_list` when building log and error messages.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::constraint_field`  (lines 716–721)

```
fn constraint_field(self) -> &'static str
```

**Purpose**: Returns the config field name associated with the target list for constraint errors.

**Data flow**: Matches `self` and returns `network.allowed_domains` or `network.denied_domains`.

**Call relations**: Used by `update_domain_list` when wrapping constraint-validation failures.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::permission`  (lines 723–728)

```
fn permission(self) -> NetworkDomainPermission
```

**Purpose**: Maps the target list kind to the corresponding `NetworkDomainPermission` enum.

**Data flow**: Returns `Allow` for `Allow` and `Deny` for `Deny`.

**Call relations**: Used by `update_domain_list` when calling `upsert_domain_permission` on config.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::entries`  (lines 730–735)

```
fn entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String>
```

**Purpose**: Extracts the current entries for the targeted domain list from network settings.

**Data flow**: Reads `allowed_domains()` or `denied_domains()` from the supplied settings and returns a `Vec<String>` with empty default.

**Call relations**: Used by `update_domain_list` to inspect whether the normalized host is already present.

*Call graph*: calls 2 internal fn (allowed_domains, denied_domains); called by 1 (update_domain_list).


##### `DomainListKind::opposite_entries`  (lines 737–742)

```
fn opposite_entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String>
```

**Purpose**: Extracts the entries from the opposite domain list.

**Data flow**: For `Allow`, returns denied domains; for `Deny`, returns allowed domains, each with empty default.

**Call relations**: Used by `update_domain_list` to detect whether adding to one list should remove a matching entry from the other.

*Call graph*: calls 2 internal fn (allowed_domains, denied_domains); called by 1 (update_domain_list).


##### `unix_socket_permissions_supported`  (lines 745–747)

```
fn unix_socket_permissions_supported() -> bool
```

**Purpose**: Reports whether unix-socket allowlist enforcement is supported on the current platform.

**Data flow**: Returns the compile-time result of `cfg!(target_os = "macos")`.

**Call relations**: Used by proxy startup warnings, HTTP plain-proxy routing, and unix-socket permission checks.

*Call graph*: called by 3 (http_plain_proxy, run, is_unix_socket_allowed); 1 external calls (cfg!).


##### `host_resolves_to_non_public_ip`  (lines 749–788)

```
async fn host_resolves_to_non_public_ip(
    host: &str,
    port: u16,
    lookup_timeout: Duration,
    lookup: F,
) -> bool
```

**Purpose**: Performs a best-effort DNS resolution check that treats private/local resolutions, lookup errors, and timeouts as blocked.

**Data flow**: If `host` parses directly as `IpAddr`, returns `is_non_public_ip(ip)`. Otherwise runs the supplied async lookup under `tokio::time::timeout`; on lookup error or timeout it logs a debug message and returns true. On success it iterates resolved `SocketAddr`s and returns true if any IP is non-public, else false.

**Call relations**: Called by `host_blocked` for hostname-based local/private-network protection; tests inject fake lookup closures to cover timeout/error/public/private cases.

*Call graph*: calls 1 internal fn (is_non_public_ip); called by 5 (host_blocked, host_resolves_to_non_public_ip_allows_public_resolution, host_resolves_to_non_public_ip_blocks_on_dns_lookup_error, host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout, host_resolves_to_non_public_ip_blocks_private_resolution); 2 external calls (debug!, timeout).


##### `log_policy_changes`  (lines 790–801)

```
fn log_policy_changes(previous: &NetworkProxyConfig, next: &NetworkProxyConfig)
```

**Purpose**: Logs additions and removals between previous and next allowlist/denylist configs.

**Data flow**: Extracts previous and next allowed/denied domain vectors from both configs and delegates each pair to `log_domain_list_changes`.

**Call relations**: Used whenever config state is reloaded or replaced so policy changes are auditable.

*Call graph*: calls 1 internal fn (log_domain_list_changes); called by 4 (force_reload, reload_if_needed, replace_config_state, update_domain_list).


##### `log_domain_list_changes`  (lines 803–837)

```
fn log_domain_list_changes(list_name: &str, previous: &[String], next: &[String])
```

**Purpose**: Computes case-insensitive additions and removals for one domain list and logs each unique changed entry in original order.

**Data flow**: Builds lowercase `HashSet`s for previous and next entries, computes added and removed sets, then iterates `next` and `previous` with `seen_*` sets to log each unique added or removed entry once via `info!`.

**Call relations**: Internal helper behind `log_policy_changes`.

*Call graph*: called by 1 (log_policy_changes); 2 external calls (new, info!).


##### `globset_matches_host_or_unscoped`  (lines 839–841)

```
fn globset_matches_host_or_unscoped(set: &GlobSet, host: &str) -> bool
```

**Purpose**: Matches a host against a compiled globset, also trying the unscoped form of scoped IP literals.

**Data flow**: Returns `set.is_match(host)` or, if `unscoped_ip_literal(host)` yields an IP prefix, `set.is_match(ip)`.

**Call relations**: Used by `host_blocked` so scoped IPv6 literals can match unscoped allow/deny entries.

*Call graph*: calls 1 internal fn (unscoped_ip_literal); called by 1 (host_blocked); 1 external calls (is_match).


##### `is_explicit_local_allowlisted`  (lines 843–858)

```
fn is_explicit_local_allowlisted(allowed_domains: &[String], host: &Host) -> bool
```

**Purpose**: Determines whether a local/private literal host is explicitly allowlisted by an exact non-wildcard pattern.

**Data flow**: Reads the normalized host and optional unscoped form, iterates allowed-domain patterns, rejects global and wildcard patterns, normalizes each remaining pattern with `normalize_host`, and returns true if it equals the normalized host or its unscoped IP form.

**Call relations**: Used by `host_blocked` to allow exact local/private literals only when explicitly listed.

*Call graph*: calls 2 internal fn (as_str, unscoped_ip_literal); called by 1 (host_blocked).


##### `unix_timestamp`  (lines 860–862)

```
fn unix_timestamp() -> i64
```

**Purpose**: Returns the current UTC Unix timestamp in seconds.

**Data flow**: Calls `OffsetDateTime::now_utc().unix_timestamp()` and returns the `i64`.

**Call relations**: Used by `BlockedRequest::new`.

*Call graph*: called by 1 (new); 1 external calls (now_utc).


##### `network_proxy_state_for_policy`  (lines 865–888)

```
fn network_proxy_state_for_policy(
    mut network: crate::config::NetworkProxySettings,
) -> NetworkProxyState
```

**Purpose**: Test helper that builds a minimal enabled `NetworkProxyState` from `NetworkProxySettings` without a real reloader.

**Data flow**: Forces `network.enabled = true`, wraps settings in `NetworkProxyConfig`, compiles allow/deny globsets and MITM hooks, constructs a `ConfigState` with empty blocked telemetry and default constraints, and returns `NetworkProxyState::with_reloader(state, Arc::new(NoopReloader))`.

**Call relations**: Widely used by tests across modules to obtain deterministic policy state.

*Call graph*: calls 4 internal fn (compile_mitm_hooks, compile_allowlist_globset, compile_denylist_globset, with_reloader); called by 39 (http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host, http_plain_proxy_attempts_allowed_unix_socket_proxy, http_plain_proxy_blocks_unix_socket_when_method_not_allowed, http_plain_proxy_rejects_absolute_uri_host_header_mismatch, http_plain_proxy_rejects_unix_socket_when_not_allowlisted, http_proxy_listener_accepts_plain_http1_connect_requests, mitm_policy_allows_matching_hooked_write_in_full_mode (+15 more)); 3 external calls (new, new, default).


##### `NoopReloader::source_label`  (lines 895–897)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a stable source label for the test no-op reloader.

**Data flow**: Returns `test config state` as an owned `String`.

**Call relations**: Used indirectly by reload logging in tests.


##### `NoopReloader::maybe_reload`  (lines 899–901)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Test reloader implementation that never reports pending changes.

**Data flow**: Returns a boxed async future resolving to `Ok(None)`.

**Call relations**: Used by `network_proxy_state_for_policy`.

*Call graph*: 1 external calls (pin).


##### `NoopReloader::reload_now`  (lines 903–905)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Test reloader implementation that rejects forced reloads.

**Data flow**: Returns a boxed async future resolving to an `anyhow!` error stating force reload is unsupported in tests.

**Call relations**: Used only in test-created states.

*Call graph*: 2 external calls (pin, anyhow!).


##### `tests::strings`  (lines 921–923)

```
fn strings(entries: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of `&str` into owned `Vec<String>` values for test setup.

**Data flow**: Iterates the input slice, clones each entry into a `String`, collects into a vector, and returns it.

**Call relations**: Used by test config-construction helpers.


##### `tests::network_settings`  (lines 925–934)

```
fn network_settings(allowed_domains: &[&str], denied_domains: &[&str]) -> NetworkProxySettings
```

**Purpose**: Builds `NetworkProxySettings` with optional allowed and denied domain lists for tests.

**Data flow**: Starts from `NetworkProxySettings::default()`, conditionally sets allowed and denied domains using `strings`, and returns the settings.

**Call relations**: Shared fixture helper for many runtime tests.

*Call graph*: calls 1 internal fn (default); 1 external calls (strings).


##### `tests::network_settings_with_unix_sockets`  (lines 936–946)

```
fn network_settings_with_unix_sockets(
        allowed_domains: &[&str],
        denied_domains: &[&str],
        unix_sockets: &[String],
    ) -> NetworkProxySettings
```

**Purpose**: Builds test settings with domain lists plus an optional unix-socket allowlist.

**Data flow**: Starts from `network_settings`, conditionally sets `allow_unix_sockets`, and returns the settings.

**Call relations**: Used by unix-socket permission tests.

*Call graph*: 1 external calls (network_settings).


##### `tests::host_blocked_denied_wins_over_allowed`  (lines 949–960)

```
async fn host_blocked_denied_wins_over_allowed()
```

**Purpose**: Verifies explicit denylist entries override allowlist entries for the same host.

**Data flow**: Builds state with `example.com` in both lists, calls `host_blocked`, and asserts `Blocked(Denied)`.

**Call relations**: Covers the first branch in `host_blocked`’s decision order.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_allowlist_match`  (lines 963–979)

```
async fn host_blocked_requires_allowlist_match()
```

**Purpose**: Checks that allowlisted hosts pass and non-allowlisted public IPs are blocked as `NotAllowed`.

**Data flow**: Builds state with only `example.com` allowed, evaluates `example.com` and `8.8.8.8`, and asserts `Allowed` then `Blocked(NotAllowed)`.

**Call relations**: Covers allowlist enforcement after deny/local checks.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::add_allowed_domain_removes_matching_deny_entry`  (lines 982–997)

```
async fn add_allowed_domain_removes_matching_deny_entry()
```

**Purpose**: Verifies adding an allowed domain removes a matching deny entry and recompiles policy accordingly.

**Data flow**: Starts with `example.com` denied, calls `add_allowed_domain("ExAmPlE.CoM")`, reads current patterns, and asserts the allowlist contains normalized `example.com`, denylist is empty, and `host_blocked` now allows it.

**Call relations**: Exercises `update_domain_list` for allowlist mutation.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, assert_eq!, network_settings).


##### `tests::add_denied_domain_removes_matching_allow_entry`  (lines 1000–1015)

```
async fn add_denied_domain_removes_matching_allow_entry()
```

**Purpose**: Verifies adding a denied domain removes a matching allow entry and forces denial.

**Data flow**: Starts with `example.com` allowed, calls `add_denied_domain("EXAMPLE.COM")`, inspects patterns, and asserts the allowlist is empty, denylist contains normalized `example.com`, and `host_blocked` returns `Blocked(Denied)`.

**Call relations**: Exercises `update_domain_list` for denylist mutation.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, assert_eq!, network_settings).


##### `tests::add_denied_domain_forces_block_with_global_wildcard_allowlist`  (lines 1018–1036)

```
async fn add_denied_domain_forces_block_with_global_wildcard_allowlist()
```

**Purpose**: Checks that a specific deny entry still overrides a global wildcard allowlist.

**Data flow**: Starts with allowlist `*`, confirms `8.8.8.8` is initially allowed, adds it to the denylist, then asserts patterns and final `Blocked(Denied)` result.

**Call relations**: Documents denylist precedence even under broad allowlists.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::add_allowed_domain_succeeds_when_managed_baseline_allows_expansion`  (lines 1039–1068)

```
async fn add_allowed_domain_succeeds_when_managed_baseline_allows_expansion()
```

**Purpose**: Verifies allowlist expansion succeeds when managed constraints explicitly permit it.

**Data flow**: Builds constrained state with managed `managed.example.com` and `allowlist_expansion_enabled: true`, adds `user.example.com`, then asserts both entries are present and denylist remains empty.

**Call relations**: Covers the constraint-validation branch permitting allowlist expansion.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 6 external calls (new, assert!, assert_eq!, network_settings, default, vec!).


##### `tests::add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed`  (lines 1071–1098)

```
async fn add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed()
```

**Purpose**: Checks that allowlist expansion is rejected when managed constraints fix the allowlist exactly.

**Data flow**: Builds constrained state with `allowlist_expansion_enabled: false`, attempts to add `user.example.com`, captures the error, and asserts the message mentions `network.allowed_domains constrained by managed config`.

**Call relations**: Exercises the fixed-allowlist constraint path in `update_domain_list`.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 5 external calls (new, assert!, network_settings, default, vec!).


##### `tests::add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed`  (lines 1101–1128)

```
async fn add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed()
```

**Purpose**: Checks that denylist expansion is rejected when managed constraints fix the denylist exactly.

**Data flow**: Builds constrained state with `denylist_expansion_enabled: false`, attempts to add `user.example.com`, captures the error, and asserts the message mentions `network.denied_domains constrained by managed config`.

**Call relations**: Exercises the fixed-denylist constraint path.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 5 external calls (new, assert!, network_settings, default, vec!).


##### `tests::blocked_snapshot_does_not_consume_entries`  (lines 1131–1167)

```
async fn blocked_snapshot_does_not_consume_entries()
```

**Purpose**: Verifies snapshotting blocked requests leaves them available for later draining.

**Data flow**: Records one blocked request, calls `blocked_snapshot` and asserts its contents, then calls `drain_blocked` and asserts the same entry is still present with matching fields.

**Call relations**: Covers non-consuming vs consuming blocked-request accessors.

*Call graph*: calls 3 internal fn (default, new, network_proxy_state_for_policy); 1 external calls (assert_eq!).


##### `tests::drain_blocked_returns_buffered_window`  (lines 1170–1193)

```
async fn drain_blocked_returns_buffered_window()
```

**Purpose**: Checks that the blocked-request buffer retains only the most recent `MAX_BLOCKED_EVENTS` entries.

**Data flow**: Records `MAX_BLOCKED_EVENTS + 5` blocked requests, drains the buffer, and asserts the length is capped and the oldest retained host is `example5.com`.

**Call relations**: Documents the bounded FIFO behavior in `record_blocked`.

*Call graph*: calls 3 internal fn (default, new, network_proxy_state_for_policy); 2 external calls (assert_eq!, format!).


##### `tests::blocked_request_violation_log_line_serializes_payload`  (lines 1196–1214)

```
fn blocked_request_violation_log_line_serializes_payload()
```

**Purpose**: Verifies the structured violation log line format for a serializable blocked request.

**Data flow**: Constructs a `BlockedRequest` with fixed fields and timestamp, calls `blocked_request_violation_log_line`, and asserts the exact prefixed JSON string.

**Call relations**: Regression test for the debug log format consumed by telemetry tooling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_blocked_subdomain_wildcards_exclude_apex`  (lines 1217–1231)

```
async fn host_blocked_subdomain_wildcards_exclude_apex()
```

**Purpose**: Checks that `*.domain` allowlist patterns match subdomains but not the apex.

**Data flow**: Builds state with `*.openai.com`, evaluates `api.openai.com` and `openai.com`, and asserts `Allowed` then `Blocked(NotAllowed)`.

**Call relations**: Covers wildcard semantics inherited from compiled globsets.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_global_wildcard_allowlist_allows_public_hosts_except_denylist`  (lines 1234–1258)

```
async fn host_blocked_global_wildcard_allowlist_allows_public_hosts_except_denylist()
```

**Purpose**: Verifies a global wildcard allowlist permits public hosts while explicit denylist entries still block.

**Data flow**: Builds state with allowlist `*` and denylist `evil.example`, evaluates several hosts, and asserts public hosts are allowed while the denylisted host is blocked.

**Call relations**: Covers broad allowlist behavior plus deny precedence.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_loopback_when_local_binding_disabled`  (lines 1261–1272)

```
async fn host_blocked_rejects_loopback_when_local_binding_disabled()
```

**Purpose**: Checks loopback literals and localhost names are blocked as local/private when local binding is disabled.

**Data flow**: Builds state with local binding disabled, evaluates `127.0.0.1` and `localhost`, and asserts `Blocked(NotAllowedLocal)` for both.

**Call relations**: Covers literal local-address protection.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_loopback_when_explicitly_allowlisted_and_local_binding_disabled`  (lines 1275–1282)

```
async fn host_blocked_allows_loopback_when_explicitly_allowlisted_and_local_binding_disabled()
```

**Purpose**: Verifies an exact localhost allowlist entry can override the local-literal block.

**Data flow**: Builds state with allowlist `localhost`, evaluates `localhost`, and asserts `Allowed`.

**Call relations**: Exercises `is_explicit_local_allowlisted` for loopback hostnames.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_private_ip_literal_when_explicitly_allowlisted`  (lines 1285–1292)

```
async fn host_blocked_allows_private_ip_literal_when_explicitly_allowlisted()
```

**Purpose**: Verifies an exact private IP literal allowlist entry can override the local-literal block.

**Data flow**: Builds state with allowlist `10.0.0.1`, evaluates that host, and asserts `Allowed`.

**Call relations**: Exercises explicit allowlisting for private IPv4 literals.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_scoped_ipv6_literal_when_not_allowlisted`  (lines 1295–1305)

```
async fn host_blocked_rejects_scoped_ipv6_literal_when_not_allowlisted()
```

**Purpose**: Checks scoped IPv6 local literals are blocked when not explicitly allowlisted.

**Data flow**: Builds state without a matching allowlist entry, evaluates `fe80::1%lo0`, and asserts `Blocked(NotAllowedLocal)`.

**Call relations**: Covers scoped IPv6 handling in local/private checks.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_scoped_ipv6_literal_when_explicitly_allowlisted`  (lines 1308–1318)

```
async fn host_blocked_allows_scoped_ipv6_literal_when_explicitly_allowlisted()
```

**Purpose**: Verifies an unscoped allowlist entry can allow a scoped IPv6 literal during local-binding checks.

**Data flow**: Builds state with allowlist `fe80::1`, evaluates `fe80::1%lo0`, and asserts `Allowed`.

**Call relations**: Exercises unscoped matching in `is_explicit_local_allowlisted`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_exact_scoped_ipv6_allowlist_match`  (lines 1321–1341)

```
async fn host_blocked_requires_exact_scoped_ipv6_allowlist_match()
```

**Purpose**: Checks that once local binding is allowed, scoped IPv6 allowlist matching becomes exact by scope.

**Data flow**: Builds state with `allow_local_binding: true` and allowlist `fe80::1%eth0`, evaluates `%eth0` and `%eth1`, and asserts allowed then `Blocked(NotAllowed)`.

**Call relations**: Documents the distinction between local-binding protection and ordinary allowlist matching.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_denies_scoped_ipv6_literal_before_local_binding`  (lines 1344–1357)

```
async fn host_blocked_denies_scoped_ipv6_literal_before_local_binding()
```

**Purpose**: Verifies denylist matching on scoped IPv6 literals happens before local-binding checks and matches normalized forms.

**Data flow**: Builds state with allowlist `*`, denylist `fd00::1`, and local binding allowed, then evaluates several scoped/bracketed forms and asserts `Blocked(Denied)` for each.

**Call relations**: Covers `globset_matches_host_or_unscoped` precedence and normalization.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_exact_scoped_ipv6_denylist_match`  (lines 1360–1380)

```
async fn host_blocked_requires_exact_scoped_ipv6_denylist_match()
```

**Purpose**: Checks that a scoped IPv6 denylist entry matches only the exact scope when ordinary allow/deny matching is used.

**Data flow**: Builds state with allowlist `*`, denylist `fd00::1%eth0`, and local binding allowed, then evaluates `%eth0` and `%eth1`, asserting denied then allowed.

**Call relations**: Documents exact-scope denylist semantics.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_private_ip_literals_when_local_binding_disabled`  (lines 1383–1390)

```
async fn host_blocked_rejects_private_ip_literals_when_local_binding_disabled()
```

**Purpose**: Verifies private IPv4 literals are blocked as local/private when local binding is disabled.

**Data flow**: Builds state with local binding disabled, evaluates `10.0.0.1`, and asserts `Blocked(NotAllowedLocal)`.

**Call relations**: Covers non-loopback private literal classification.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_loopback_when_allowlist_empty`  (lines 1393–1400)

```
async fn host_blocked_rejects_loopback_when_allowlist_empty()
```

**Purpose**: Checks that loopback is still blocked when there is no allowlist at all.

**Data flow**: Builds default state, evaluates `127.0.0.1`, and asserts `Blocked(NotAllowedLocal)`.

**Call relations**: Documents that local/private protection is independent of allowlist emptiness.

*Call graph*: calls 2 internal fn (default, network_proxy_state_for_policy); 1 external calls (assert_eq!).


##### `tests::host_blocked_rejects_allowlisted_hostname_when_dns_lookup_fails`  (lines 1403–1415)

```
async fn host_blocked_rejects_allowlisted_hostname_when_dns_lookup_fails()
```

**Purpose**: Verifies an allowlisted hostname is still blocked as local/private if the DNS safety check cannot resolve it.

**Data flow**: Builds state with `does-not-resolve.invalid` allowlisted, evaluates that host, and asserts `Blocked(NotAllowedLocal)`.

**Call relations**: Covers the fail-closed DNS branch in `host_resolves_to_non_public_ip`.

*Call graph*: calls 2 internal fn (default, network_proxy_state_for_policy); 2 external calls (assert_eq!, vec!).


##### `tests::host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout`  (lines 1418–1430)

```
async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout()
```

**Purpose**: Checks that DNS timeout causes the non-public-IP check to fail closed.

**Data flow**: Calls `host_resolves_to_non_public_ip` with a 1ms timeout and a never-completing lookup future, then asserts the result is true.

**Call relations**: Unit test for the timeout branch.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_blocks_on_dns_lookup_error`  (lines 1433–1448)

```
async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_error()
```

**Purpose**: Checks that DNS lookup errors cause the non-public-IP check to fail closed.

**Data flow**: Calls `host_resolves_to_non_public_ip` with a lookup closure returning an I/O error and asserts the result is true.

**Call relations**: Unit test for the lookup-error branch.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_blocks_private_resolution`  (lines 1451–1461)

```
async fn host_resolves_to_non_public_ip_blocks_private_resolution()
```

**Purpose**: Verifies that resolving to a private/loopback address is treated as blocked.

**Data flow**: Calls `host_resolves_to_non_public_ip` with a lookup closure returning `127.0.0.1:80` and asserts true.

**Call relations**: Unit test for the resolved-private-address branch.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_allows_public_resolution`  (lines 1464–1474)

```
async fn host_resolves_to_non_public_ip_allows_public_resolution()
```

**Purpose**: Verifies that resolving only to public addresses passes the non-public-IP check.

**Data flow**: Calls `host_resolves_to_non_public_ip` with a lookup closure returning `8.8.8.8:80` and asserts false.

**Call relations**: Unit test for the resolved-public-address branch.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::validate_policy_against_constraints_disallows_widening_allowed_domains`  (lines 1477–1492)

```
fn validate_policy_against_constraints_disallows_widening_allowed_domains()
```

**Purpose**: Checks managed constraints reject adding allowlist entries outside the managed baseline.

**Data flow**: Builds constraints allowing only `example.com`, constructs config with `example.com` and `evil.com`, and asserts validation fails.

**Call relations**: Regression test for constraint logic implemented in `state.rs` but exercised from runtime tests.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_allows_expanding_allowed_domains_when_enabled`  (lines 1495–1511)

```
fn validate_policy_against_constraints_allows_expanding_allowed_domains_when_enabled()
```

**Purpose**: Verifies allowlist expansion is accepted when the corresponding managed flag is enabled.

**Data flow**: Builds constraints with `allowlist_expansion_enabled: true`, constructs a widened config, and asserts validation succeeds.

**Call relations**: Covers the permissive expansion branch.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_widening_mode`  (lines 1514–1529)

```
fn validate_policy_against_constraints_disallows_widening_mode()
```

**Purpose**: Checks managed mode constraints reject widening from limited to full mode.

**Data flow**: Builds constraints fixing mode to `Limited`, constructs a config with `Full`, and asserts validation fails.

**Call relations**: Regression test for mode ranking in constraint validation.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_allows_narrowing_wildcard_allowlist`  (lines 1532–1547)

```
fn validate_policy_against_constraints_allows_narrowing_wildcard_allowlist()
```

**Purpose**: Verifies a concrete host can be accepted as a subset of a managed wildcard allowlist.

**Data flow**: Builds constraints with `*.example.com`, constructs config allowing only `api.example.com`, and asserts validation succeeds.

**Call relations**: Covers semantic subset checks using `DomainPattern::allows`.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_widening_wildcard_allowlist`  (lines 1550–1565)

```
fn validate_policy_against_constraints_rejects_widening_wildcard_allowlist()
```

**Purpose**: Checks that widening `*.example.com` to `**.example.com` is rejected.

**Data flow**: Builds managed wildcard constraints, constructs a broader candidate config, and asserts validation fails.

**Call relations**: Regression test for wildcard subset semantics.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_global_wildcard_in_managed_allowlist`  (lines 1568–1583)

```
fn validate_policy_against_constraints_rejects_global_wildcard_in_managed_allowlist()
```

**Purpose**: Verifies managed allowlist constraints reject global wildcard patterns.

**Data flow**: Builds constraints containing `*`, constructs a candidate config, and asserts validation fails.

**Call relations**: Covers non-global-wildcard validation for managed patterns.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_bracketed_global_wildcard_in_managed_allowlist`  (lines 1586–1602)

```
fn validate_policy_against_constraints_rejects_bracketed_global_wildcard_in_managed_allowlist()
```

**Purpose**: Verifies bracketed global wildcard patterns are also rejected in managed allowlists.

**Data flow**: Builds constraints containing `[*]`, constructs a candidate config, and asserts validation fails.

**Call relations**: Regression test for wildcard normalization/detection.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_double_wildcard_bracketed_global_wildcard_in_managed_allowlist`  (lines 1605–1621)

```
fn validate_policy_against_constraints_rejects_double_wildcard_bracketed_global_wildcard_in_managed_allowlist()
```

**Purpose**: Checks that `**.[*]` is treated as an invalid managed global wildcard pattern.

**Data flow**: Builds constraints containing `**.[*]`, constructs a candidate config, and asserts validation fails.

**Call relations**: Further regression coverage for wildcard detection.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_requires_managed_denied_domains_entries`  (lines 1624–1638)

```
fn validate_policy_against_constraints_requires_managed_denied_domains_entries()
```

**Purpose**: Verifies managed denylist entries must remain present in candidate config.

**Data flow**: Builds constraints requiring `evil.com`, constructs a config with no denylist entries, and asserts validation fails.

**Call relations**: Covers required-entry semantics for managed deny lists.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_expanding_denied_domains_when_fixed`  (lines 1641–1657)

```
fn validate_policy_against_constraints_disallows_expanding_denied_domains_when_fixed()
```

**Purpose**: Checks fixed managed denylist constraints reject extra deny entries.

**Data flow**: Builds constraints with `denylist_expansion_enabled: false`, constructs a config with an extra deny entry, and asserts validation fails.

**Call relations**: Covers the exact-match denylist branch.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_enabling_when_managed_disabled`  (lines 1660–1674)

```
fn validate_policy_against_constraints_disallows_enabling_when_managed_disabled()
```

**Purpose**: Verifies managed constraints can force the proxy to remain disabled.

**Data flow**: Builds constraints with `enabled: Some(false)`, constructs an enabled config, and asserts validation fails.

**Call relations**: Regression test for boolean constraint enforcement.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_local_binding_when_managed_disabled`  (lines 1677–1692)

```
fn validate_policy_against_constraints_disallows_allow_local_binding_when_managed_disabled()
```

**Purpose**: Checks managed constraints can forbid enabling local/private destination access.

**Data flow**: Builds constraints with `allow_local_binding: Some(false)`, constructs a config enabling it, and asserts validation fails.

**Call relations**: Regression test for local-binding constraint enforcement.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_all_unix_sockets_without_managed_opt_in`  (lines 1695–1711)

```
fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_without_managed_opt_in()
```

**Purpose**: Verifies the dangerous allow-all-unix-sockets flag is rejected unless managed constraints permit it.

**Data flow**: Builds constraints with `dangerously_allow_all_unix_sockets: Some(false)`, constructs a config enabling the flag, and asserts validation fails.

**Call relations**: Covers unix-socket safety constraints.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_all_unix_sockets_when_allowlist_is_managed`  (lines 1714–1730)

```
fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_when_allowlist_is_managed()
```

**Purpose**: Checks allow-all-unix-sockets is rejected when a managed unix-socket allowlist exists.

**Data flow**: Builds constraints with a managed allowlist, constructs a config enabling the dangerous flag, and asserts validation fails.

**Call relations**: Documents the interaction between explicit allowlists and the dangerous bypass flag.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, default, vec!).


##### `tests::validate_policy_against_constraints_allows_allow_all_unix_sockets_with_managed_opt_in`  (lines 1733–1748)

```
fn validate_policy_against_constraints_allows_allow_all_unix_sockets_with_managed_opt_in()
```

**Purpose**: Verifies the dangerous allow-all-unix-sockets flag is accepted when managed constraints explicitly allow it.

**Data flow**: Builds constraints with `dangerously_allow_all_unix_sockets: Some(true)`, constructs a config enabling the flag, and asserts validation succeeds.

**Call relations**: Covers the permissive branch for that flag.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_allows_allow_all_unix_sockets_when_unmanaged`  (lines 1751–1763)

```
fn validate_policy_against_constraints_allows_allow_all_unix_sockets_when_unmanaged()
```

**Purpose**: Checks the dangerous allow-all-unix-sockets flag is accepted when there are no managing constraints.

**Data flow**: Builds default constraints, constructs a config enabling the flag, and asserts validation succeeds.

**Call relations**: Documents unmanaged behavior.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::compile_globset_is_case_insensitive`  (lines 1766–1771)

```
fn compile_globset_is_case_insensitive()
```

**Purpose**: Verifies compiled globsets match hostnames case-insensitively.

**Data flow**: Compiles a deny globset from mixed-case `ExAmPle.CoM` and asserts matches for lowercase and uppercase forms.

**Call relations**: Regression test for `GlobBuilder::case_insensitive(true)`.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_excludes_apex_for_subdomain_patterns`  (lines 1774–1780)

```
fn compile_globset_excludes_apex_for_subdomain_patterns()
```

**Purpose**: Checks `*.openai.com` matches only subdomains, not the apex or lookalikes.

**Data flow**: Compiles the pattern and asserts matches/non-matches for representative hosts.

**Call relations**: Documents the `?*.` expansion trick.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_includes_apex_for_double_wildcard_patterns`  (lines 1783–1789)

```
fn compile_globset_includes_apex_for_double_wildcard_patterns()
```

**Purpose**: Checks `**.openai.com` matches both apex and subdomains but not lookalikes.

**Data flow**: Compiles the pattern and asserts expected matches.

**Call relations**: Regression test for apex-inclusive wildcard expansion.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_global_wildcard`  (lines 1792–1795)

```
fn compile_globset_rejects_global_wildcard()
```

**Purpose**: Verifies denylist compilation rejects a bare global wildcard.

**Data flow**: Attempts to compile `*` as a denylist and asserts an error.

**Call relations**: Covers denylist wildcard validation.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_allows_global_wildcard_when_enabled`  (lines 1798–1804)

```
fn compile_globset_allows_global_wildcard_when_enabled()
```

**Purpose**: Verifies allowlist compilation accepts a bare global wildcard.

**Data flow**: Compiles `*` as an allowlist and asserts it matches representative hosts including localhost.

**Call relations**: Covers allowlist-specific wildcard policy.

*Call graph*: calls 1 internal fn (compile_allowlist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_bracketed_global_wildcard`  (lines 1807–1810)

```
fn compile_globset_rejects_bracketed_global_wildcard()
```

**Purpose**: Checks denylist compilation rejects bracketed global wildcard syntax.

**Data flow**: Attempts to compile `[*]` as a denylist and asserts an error.

**Call relations**: Regression test for wildcard detection after normalization.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_double_wildcard_bracketed_global_wildcard`  (lines 1813–1816)

```
fn compile_globset_rejects_double_wildcard_bracketed_global_wildcard()
```

**Purpose**: Checks denylist compilation rejects `**.[*]` as a global wildcard form.

**Data flow**: Attempts to compile that pattern and asserts an error.

**Call relations**: Further wildcard-validation coverage.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_dedupes_patterns_without_changing_behavior`  (lines 1819–1825)

```
fn compile_globset_dedupes_patterns_without_changing_behavior()
```

**Purpose**: Verifies duplicate patterns are deduplicated without affecting matching behavior.

**Data flow**: Compiles a denylist containing `example.com` twice and asserts expected matches/non-matches.

**Call relations**: Covers the `seen` set in globset compilation.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_invalid_patterns`  (lines 1828–1831)

```
fn compile_globset_rejects_invalid_patterns()
```

**Purpose**: Checks invalid glob syntax is rejected during compilation.

**Data flow**: Attempts to compile `[` as a denylist pattern and asserts an error.

**Call relations**: Regression test for glob-builder validation.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::build_config_state_allows_global_wildcard_allowed_domains`  (lines 1834–1844)

```
fn build_config_state_allows_global_wildcard_allowed_domains()
```

**Purpose**: Verifies config-state construction accepts a global wildcard in allowed domains.

**Data flow**: Builds a config with allowlist `*` and asserts `build_config_state` succeeds.

**Call relations**: Covers interaction between config-state building and allowlist wildcard policy.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_allows_bracketed_global_wildcard_allowed_domains`  (lines 1847–1857)

```
fn build_config_state_allows_bracketed_global_wildcard_allowed_domains()
```

**Purpose**: Verifies config-state construction also accepts bracketed global wildcard syntax in allowed domains.

**Data flow**: Builds a config with allowlist `[*]` and asserts `build_config_state` succeeds.

**Call relations**: Regression test for normalized wildcard handling.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_rejects_global_wildcard_denied_domains`  (lines 1860–1870)

```
fn build_config_state_rejects_global_wildcard_denied_domains()
```

**Purpose**: Checks config-state construction rejects a global wildcard in denied domains.

**Data flow**: Builds a config with denylist `*` and asserts `build_config_state` fails.

**Call relations**: Covers denylist wildcard validation during state construction.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_rejects_bracketed_global_wildcard_denied_domains`  (lines 1873–1883)

```
fn build_config_state_rejects_bracketed_global_wildcard_denied_domains()
```

**Purpose**: Checks config-state construction rejects bracketed global wildcard syntax in denied domains.

**Data flow**: Builds a config with denylist `[*]` and asserts `build_config_state` fails.

**Call relations**: Further denylist wildcard-validation coverage.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::unix_socket_allowlist_is_respected_on_macos`  (lines 1887–1902)

```
async fn unix_socket_allowlist_is_respected_on_macos()
```

**Purpose**: Verifies unix-socket allowlist checks succeed for listed paths and fail for others on macOS.

**Data flow**: Builds state with one allowed socket path, calls `is_unix_socket_allowed` for the allowed and a different path, and asserts true then false.

**Call relations**: macOS-only test for unix-socket permission enforcement.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, network_settings_with_unix_sockets, from_ref).


##### `tests::unix_socket_allowlist_resolves_symlinks`  (lines 1906–1931)

```
async fn unix_socket_allowlist_resolves_symlinks()
```

**Purpose**: Checks unix-socket allowlist matching uses canonicalized paths so symlinked paths are accepted.

**Data flow**: Creates a real file and symlink, allowlists the real path, then asserts `is_unix_socket_allowed` returns true for the symlink path.

**Call relations**: Covers best-effort canonicalization in unix-socket checks.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 4 external calls (assert!, network_settings_with_unix_sockets, write, from_ref).


##### `tests::unix_socket_allow_all_flag_bypasses_allowlist`  (lines 1935–1944)

```
async fn unix_socket_allow_all_flag_bypasses_allowlist()
```

**Purpose**: Verifies the dangerous allow-all-unix-sockets flag bypasses the explicit allowlist but still requires absolute paths.

**Data flow**: Builds state with the dangerous flag enabled, asserts an absolute path is allowed and a relative path is rejected.

**Call relations**: Covers the bypass branch and absolute-path invariant.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert!, network_settings).


##### `tests::unix_socket_allowlist_is_rejected_on_non_macos`  (lines 1948–1961)

```
async fn unix_socket_allowlist_is_rejected_on_non_macos()
```

**Purpose**: Verifies unix-socket requests are rejected entirely on unsupported platforms even if config would otherwise allow them.

**Data flow**: Builds state with an allowlist and dangerous flag, calls `is_unix_socket_allowed` on a listed path, and asserts false.

**Call relations**: Documents platform gating via `unix_socket_permissions_supported`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, network_settings_with_unix_sockets, from_ref).


### Sandbox filesystem protections
These files manage Windows sandbox filesystem access by applying extra read grants, preserving deny-read state, and tightening workspace ACLs.

### `core/src/windows_sandbox_read_grants.rs`

`domain_logic` · `sandbox permission update`

This file contains a single focused helper for extending read access in the non-elevated Windows sandbox flow. `grant_read_root_non_elevated` accepts the current `PermissionProfile`, workspace roots, command working directory, environment map, Codex home, and a candidate `read_root`. Before touching sandbox setup, it enforces three concrete filesystem invariants on the requested path: it must be absolute, it must exist, and it must be a directory. Each failure path returns an `anyhow` error whose message includes the offending path via `display()`, which the companion tests assert against.

If validation succeeds, the function canonicalizes the directory with `dunce::canonicalize`, producing a normalized `PathBuf` suitable for stable sandbox configuration even on Windows path variants. It then calls `run_setup_refresh_with_extra_read_roots`, passing through the existing sandbox context and a one-element vector containing the canonicalized root. The helper returns that canonical path to the caller, making the exact granted directory explicit. The design keeps policy narrow: this function does not decide whether a grant is allowed semantically, only that the path is structurally valid and then asks the sandbox layer to refresh its read-root configuration.

#### Function details

##### `grant_read_root_non_elevated`  (lines 9–37)

```
fn grant_read_root_non_elevated(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Pa
```

**Purpose**: Checks that a requested read root is an absolute existing directory, canonicalizes it, and refreshes non-elevated sandbox setup to include that root.

**Data flow**: Reads the supplied `read_root` path and rejects it with `bail!` if `is_absolute` is false, `exists` is false, or `is_dir` is false. On success it canonicalizes the path with `dunce::canonicalize`, clones that canonical `PathBuf` into a single-element vector, passes all sandbox context plus that vector to `run_setup_refresh_with_extra_read_roots`, and returns `Ok(canonical_root)`.

**Call relations**: This is the only function in the file. It delegates the actual sandbox refresh to `run_setup_refresh_with_extra_read_roots` in `windows_sandbox.rs` after performing all local filesystem validation.

*Call graph*: calls 1 internal fn (run_setup_refresh_with_extra_read_roots); 6 external calls (exists, is_absolute, is_dir, bail!, canonicalize, vec!).


### `windows-sandbox-rs/src/deny_read_state.rs`

`orchestration` · `persistent ACL sync during sandbox setup/update`

This file adds persistence around deny-read ACL application so long-lived or elevated sandbox sessions can leave ACLs in place across runs without accumulating stale entries. The persisted state is a JSON file under the sandbox directory, keyed by principal SID string and storing the list of paths previously applied for that principal.

`sync_persistent_deny_read_acls` is the reconciliation routine. It computes the state file path from `sandbox_dir`, loads prior state, and extracts the previous path list for the current principal. It then applies the new desired ACL set first by calling `apply_deny_read_acls`; this ordering is deliberate so profile changes do not create a window where old denies are removed before new ones are established. After application, it derives a `HashSet` of normalized lexical keys from the returned applied paths and revokes ACEs from any previously stored path whose normalized key is no longer desired.

Finally, it updates the in-memory state map: removing the principal entry entirely when no paths remain, or replacing it with the newly applied path list. `load_state` treats a missing file as empty state, while parse and I/O failures are annotated with the state file path. `store_state` writes pretty-printed JSON, making the persisted ACL inventory inspectable during debugging.

#### Function details

##### `sync_persistent_deny_read_acls`  (lines 32–68)

```
fn sync_persistent_deny_read_acls(
    codex_home: &Path,
    principal_sid: &str,
    desired_paths: &[PathBuf],
    psid: *mut c_void,
) -> Result<Vec<PathBuf>>
```

**Purpose**: Reconciles the persisted deny-read ACL set for one sandbox principal with a newly desired path set. It applies new ACLs first, revokes stale ones second, and then rewrites the persisted state file.

**Data flow**: It takes `codex_home`, a principal SID string, desired `PathBuf` slice, and an unsafe SID pointer `psid`. It computes the JSON state path via `sandbox_dir`, loads `PersistentDenyReadAclState`, clones any previous paths for the principal, applies the desired ACLs with `apply_deny_read_acls`, normalizes the resulting applied paths into a `HashSet` using `lexical_path_key`, revokes ACEs on previously stored paths whose normalized key is absent, updates or removes the principal entry in the `BTreeMap`, stores the new state with `store_state`, and returns the applied path list.

**Call relations**: This function is called from legacy session ACL setup when persistent deny-read behavior is needed. It orchestrates the lower-level ACL application and revocation helpers plus JSON state load/store to keep cross-run ACL state consistent.

*Call graph*: calls 6 internal fn (revoke_ace, apply_deny_read_acls, lexical_path_key, load_state, store_state, sandbox_dir); called by 1 (apply_legacy_session_acl_rules).


##### `load_state`  (lines 70–81)

```
fn load_state(path: &Path) -> Result<PersistentDenyReadAclState>
```

**Purpose**: Reads and deserializes the persisted deny-read ACL state file, defaulting to an empty state when the file does not exist. It centralizes error annotation for state-file reads and JSON parsing.

**Data flow**: It accepts a `&Path`, attempts `std::fs::read`, and on success deserializes bytes into `PersistentDenyReadAclState` with `serde_json::from_slice`. If the read error is `NotFound`, it returns `PersistentDenyReadAclState::default()`; otherwise it returns an `anyhow::Result` enriched with the file path context.

**Call relations**: Used only by `sync_persistent_deny_read_acls` at the start of reconciliation to recover prior per-principal ACL ownership.

*Call graph*: called by 1 (sync_persistent_deny_read_acls); 3 external calls (from_slice, read, default).


##### `store_state`  (lines 83–87)

```
fn store_state(path: &Path, state: &PersistentDenyReadAclState) -> Result<()>
```

**Purpose**: Serializes the persistent deny-read ACL state to pretty JSON and writes it to disk. It is the final commit step after reconciliation.

**Data flow**: It takes the destination `&Path` and a borrowed `PersistentDenyReadAclState`, converts the state to bytes with `serde_json::to_vec_pretty`, writes them with `std::fs::write`, and returns success or a contextualized error.

**Call relations**: This function is called by `sync_persistent_deny_read_acls` after ACL application/revocation decisions have been made, persisting the new authoritative path set for the principal.

*Call graph*: called by 1 (sync_persistent_deny_read_acls); 2 external calls (to_vec_pretty, write).


### `windows-sandbox-rs/src/workspace_acl.rs`

`domain_logic` · `sandbox/session ACL setup`

This file contains a tiny slice of workspace-specific ACL policy. `is_command_cwd_root` compares the configured workspace root against an already-canonical command working directory by canonicalizing only the root side, letting callers decide whether root-level rules should apply. The remaining functions focus on two special subdirectories, `.codex` and `.agents`, which should receive a deny-write ACE when they exist.

Both public protection functions are marked `unsafe` because they accept a raw SID pointer (`psid: *mut c_void`) and rely on the caller to guarantee that pointer is valid for the duration of the ACL operation. They simply delegate to the shared `protect_workspace_subdir`, passing the fixed subdirectory name. The shared helper joins the subdirectory onto the provided current working directory, checks `path.is_dir()`, and only then calls `add_deny_write_ace`; if the directory is absent, it returns `Ok(false)` rather than treating absence as an error. That return value lets higher-level ACL orchestration distinguish between "nothing to protect" and "protection applied" without probing the filesystem twice.

#### Function details

##### `is_command_cwd_root`  (lines 7–9)

```
fn is_command_cwd_root(root: &Path, canonical_command_cwd: &Path) -> bool
```

**Purpose**: Determines whether the command's canonical working directory is exactly the workspace root. It is used to gate root-specific ACL behavior.

**Data flow**: Takes `root: &Path` and `canonical_command_cwd: &Path`, canonicalizes `root` with `canonicalize_path`, compares the result to `canonical_command_cwd`, and returns the boolean equality result.

**Call relations**: Called by `apply_legacy_session_acl_rules` before deciding which workspace ACL rules to apply. It delegates path normalization to `canonicalize_path`.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_codex_dir`  (lines 13–15)

```
fn protect_workspace_codex_dir(cwd: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Applies deny-write protection to the `.codex` subdirectory under the workspace if that directory exists. It is a thin named wrapper for the shared subdirectory helper.

**Data flow**: Accepts `cwd: &Path` and raw SID pointer `psid`, forwards them with the literal subdirectory name `.codex` to `protect_workspace_subdir`, and returns that helper's `Result<bool>`.

**Call relations**: Invoked by `apply_legacy_session_acl_rules` when workspace protections are being installed. It exists to make the caller's intent explicit while reusing the common implementation.

*Call graph*: calls 1 internal fn (protect_workspace_subdir); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_agents_dir`  (lines 19–21)

```
fn protect_workspace_agents_dir(cwd: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Applies deny-write protection to the `.agents` subdirectory under the workspace if present. Like the `.codex` variant, it is a named wrapper over the shared helper.

**Data flow**: Accepts `cwd: &Path` and raw SID pointer `psid`, forwards them with the literal subdirectory name `.agents` to `protect_workspace_subdir`, and returns the resulting `Result<bool>`.

**Call relations**: Also called by `apply_legacy_session_acl_rules` during workspace ACL setup. It shares all actual filesystem and ACL work with `protect_workspace_subdir`.

*Call graph*: calls 1 internal fn (protect_workspace_subdir); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_subdir`  (lines 23–30)

```
fn protect_workspace_subdir(cwd: &Path, psid: *mut c_void, subdir: &str) -> Result<bool>
```

**Purpose**: Implements the common logic for protecting a named workspace subdirectory with a deny-write ACE. It only mutates ACLs when the target path already exists as a directory.

**Data flow**: Takes `cwd`, raw SID pointer `psid`, and `subdir: &str`, computes `cwd.join(subdir)`, checks `path.is_dir()`, and if true calls `add_deny_write_ace(&path, psid)`; otherwise it returns `Ok(false)` to indicate no ACL change was needed.

**Call relations**: Called by both `protect_workspace_codex_dir` and `protect_workspace_agents_dir`. It delegates the actual ACL modification to `add_deny_write_ace`.

*Call graph*: calls 1 internal fn (add_deny_write_ace); called by 2 (protect_workspace_agents_dir, protect_workspace_codex_dir); 1 external calls (join).


### WFP network blocking setup
These files install and safely wrap persistent Windows Filtering Platform protections used to enforce approval-gated network restrictions.

### `windows-sandbox-rs/src/wfp.rs`

`domain_logic` · `elevated setup`

This file is the concrete WFP installer for the Windows sandbox. Its top-level path, `install_wfp_filters_for_account`, opens the filtering engine, starts a transaction, ensures a persistent provider and sublayer exist under fixed GUID identities, builds an ALE user-match condition for the target account, then iterates the static `FILTER_SPECS` table to replace each filter by key. The replacement strategy is deliberate: each known filter is deleted if present and then re-added, making repeated setup idempotent while allowing spec changes to take effect without accumulating stale filters.

The file owns several unsafe Win32 resources behind RAII structs. `Engine` closes the WFP engine handle on drop; `Transaction` aborts unless `commit` succeeded; `UserMatchCondition` allocates a security descriptor with `BuildSecurityDescriptorW`, exposes it as an `FWP_BYTE_BLOB` for `FWPM_CONDITION_ALE_USER_ID`, and frees it with `LocalFree`. Filter construction is explicit: every filter is persistent, attached to the Codex provider and sublayer, uses `FWP_ACTION_BLOCK`, and derives its condition array from compact `ConditionSpec` values (`User`, protocol byte, remote port). Helper functions normalize Win32 status handling, including tolerated codes such as `FWP_E_ALREADY_EXISTS` for provider/sublayer creation and not-found codes during delete. The tests enforce an important invariant of the static spec table: filter GUID keys and human-readable names must both be unique.

#### Function details

##### `install_wfp_filters_for_account`  (lines 79–95)

```
fn install_wfp_filters_for_account(account: &str) -> Result<usize>
```

**Purpose**: Installs the full persistent Codex filter set scoped to one Windows account and returns how many filter specs were applied. It treats the static filter spec list as the source of truth and recreates each filter inside one WFP transaction.

**Data flow**: Takes `account: &str`, opens a WFP `Engine`, begins a `Transaction`, ensures the persistent provider and sublayer exist, then builds a `UserMatchCondition` security-descriptor blob for that account. It loops over `FILTER_SPECS`, deleting any existing filter by stable GUID and adding a fresh `FWPM_FILTER0` for each spec, increments a local count, commits the transaction, and returns `Ok(installed_filter_count)`; any failing Win32/WFP call becomes an `anyhow::Error`.

**Call relations**: This is the file's public entry into WFP installation. It drives the whole sequence by invoking `Engine::open`, `ensure_provider`, `ensure_sublayer`, `UserMatchCondition::for_account`, `delete_filter_if_present`, and `add_filter`; if any step errors before commit, `Transaction::drop` aborts automatically.

*Call graph*: calls 6 internal fn (open, for_account, add_filter, delete_filter_if_present, ensure_provider, ensure_sublayer).


##### `Engine::open`  (lines 103–124)

```
fn open() -> Result<Self>
```

**Purpose**: Creates a new WFP engine session and wraps the resulting `HANDLE` in an `Engine` RAII object. The session is named and configured with an infinite transaction wait timeout.

**Data flow**: Builds a UTF-16 session name from `SESSION_NAME`, zero-initializes `FWPM_SESSION0`, fills its `displayData.name` and `txnWaitTimeoutInMSec`, then calls `FwpmEngineOpen0` with default RPC authentication and no server name or security descriptor. On success it returns `Engine { handle }`; on nonzero status it routes through `ensure_success` to produce an error.

**Call relations**: Called only by `install_wfp_filters_for_account` at the start of setup. It delegates status checking to `ensure_success`, and the returned handle is later consumed by transaction, provider, sublayer, filter add, and filter delete operations before `Engine::drop` closes it.

*Call graph*: calls 1 internal fn (ensure_success); called by 1 (install_wfp_filters_for_account); 7 external calls (default, new, to_wide, zeroed, null, null_mut, FwpmEngineOpen0).


##### `Engine::begin_transaction`  (lines 126–133)

```
fn begin_transaction(&self) -> Result<Transaction<'_>>
```

**Purpose**: Starts a WFP transaction on an already-open engine and returns a guard that will abort unless committed. This gives the installer all-or-nothing behavior across provider, sublayer, and filter updates.

**Data flow**: Reads `self.handle`, calls `FwpmTransactionBegin0(self.handle, 0)`, validates the result with `ensure_success`, and returns `Transaction { engine: self, committed: false }`.

**Call relations**: Invoked by `install_wfp_filters_for_account` immediately after opening the engine. Its returned guard controls later commit/abort flow: `Transaction::commit` marks success, while `Transaction::drop` rolls back if the caller exits early.

*Call graph*: calls 1 internal fn (ensure_success); 1 external calls (FwpmTransactionBegin0).


##### `Engine::drop`  (lines 137–141)

```
fn drop(&mut self)
```

**Purpose**: Closes the underlying WFP engine handle when the `Engine` leaves scope. It ensures native engine resources are released even on error paths.

**Data flow**: Reads `self.handle` and passes it to `FwpmEngineClose0`; it returns no value and does not surface close failures.

**Call relations**: Runs implicitly after `install_wfp_filters_for_account` finishes or unwinds. It is the final cleanup step after transaction completion or abort.

*Call graph*: 1 external calls (FwpmEngineClose0).


##### `Transaction::commit`  (lines 151–156)

```
fn commit(&mut self) -> Result<()>
```

**Purpose**: Commits the active WFP transaction and disables the drop-time abort path. This is the point where all provider/sublayer/filter changes become durable.

**Data flow**: Uses `self.engine.handle` to call `FwpmTransactionCommit0`, checks the status with `ensure_success`, then sets `self.committed = true` and returns `Ok(())`.

**Call relations**: Called by `install_wfp_filters_for_account` only after every filter has been deleted and re-added successfully. If this is not reached or fails, `Transaction::drop` still aborts the transaction.

*Call graph*: calls 1 internal fn (ensure_success); 1 external calls (FwpmTransactionCommit0).


##### `Transaction::drop`  (lines 160–166)

```
fn drop(&mut self)
```

**Purpose**: Aborts an uncommitted WFP transaction during scope exit. It provides rollback semantics for all early returns and panics after transaction start.

**Data flow**: Checks `self.committed`; if false, it calls `FwpmTransactionAbort0(self.engine.handle)`. It writes no Rust-visible state and ignores abort errors.

**Call relations**: Triggered implicitly whenever a `Transaction` guard is dropped. It is the safety net behind `install_wfp_filters_for_account`, complementing `Transaction::commit`.

*Call graph*: 1 external calls (FwpmTransactionAbort0).


##### `UserMatchCondition::for_account`  (lines 176–213)

```
fn for_account(account: &str) -> Result<Self>
```

**Purpose**: Builds the security-descriptor blob used in `FWPM_CONDITION_ALE_USER_ID` so filters match only traffic from one account. It converts an account name into an access descriptor granting `FWP_ACTRL_MATCH_FILTER`.

**Data flow**: Takes `account: &str`, converts it to UTF-16, zero-initializes `EXPLICIT_ACCESS_W`, fills it via `BuildExplicitAccessWithNameW`, then calls `BuildSecurityDescriptorW` to allocate a `PSECURITY_DESCRIPTOR` and length. It returns `UserMatchCondition` containing both the raw descriptor pointer and an `FWP_BYTE_BLOB { size, data }` view over that allocation.

**Call relations**: Called by `install_wfp_filters_for_account` once per target account before filter creation. The resulting blob is later referenced by `build_conditions` when translating `ConditionSpec::User`, and `UserMatchCondition::drop` frees the allocation afterward.

*Call graph*: calls 1 internal fn (ensure_success); called by 1 (install_wfp_filters_for_account); 7 external calls (new, to_wide, zeroed, null, null_mut, BuildExplicitAccessWithNameW, BuildSecurityDescriptorW).


##### `UserMatchCondition::drop`  (lines 217–223)

```
fn drop(&mut self)
```

**Purpose**: Frees the security descriptor allocated for the user-match condition. It prevents leaking the `BuildSecurityDescriptorW` buffer.

**Data flow**: Checks whether `self.security_descriptor` is null; if not, casts it to `HLOCAL` and passes it to `LocalFree`. It returns nothing.

**Call relations**: Runs implicitly after `install_wfp_filters_for_account` finishes using the account-scoping blob. It pairs with `UserMatchCondition::for_account`.

*Call graph*: 2 external calls (is_null, LocalFree).


##### `ensure_provider`  (lines 227–243)

```
fn ensure_provider(engine: HANDLE) -> Result<()>
```

**Purpose**: Creates the persistent Codex WFP provider if it does not already exist. The provider is identified by the stable `PROVIDER_KEY` GUID and carries human-readable display metadata.

**Data flow**: Builds UTF-16 name and description strings, constructs an `FWPM_PROVIDER0` with `providerKey = PROVIDER_KEY`, persistent flag, empty provider data, and null service name, then calls `FwpmProviderAdd0`. It accepts both success and `FWP_E_ALREADY_EXISTS` through `ensure_success_or`.

**Call relations**: Called by `install_wfp_filters_for_account` before sublayer and filter creation. It delegates blob construction to `empty_blob` and status normalization to `ensure_success_or` so repeated setup remains harmless.

*Call graph*: calls 2 internal fn (empty_blob, ensure_success_or); called by 1 (install_wfp_filters_for_account); 4 external calls (new, to_wide, null_mut, FwpmProviderAdd0).


##### `ensure_sublayer`  (lines 246–264)

```
fn ensure_sublayer(engine: HANDLE) -> Result<()>
```

**Purpose**: Creates the persistent Codex sublayer under the Codex provider if it is missing. Filters added later are attached to this sublayer and inherit its stable identity.

**Data flow**: Builds UTF-16 display strings, constructs an `FWPM_SUBLAYER0` with `subLayerKey = SUBLAYER_KEY`, persistent flag, `providerKey` pointing at `PROVIDER_KEY`, empty provider data, and weight `0x8000`, then calls `FwpmSubLayerAdd0`. It returns success when the sublayer is newly created or already present.

**Call relations**: Invoked by `install_wfp_filters_for_account` after `ensure_provider`. It uses `empty_blob` and `ensure_success_or` for the same idempotent setup pattern as provider creation.

*Call graph*: calls 2 internal fn (empty_blob, ensure_success_or); called by 1 (install_wfp_filters_for_account); 4 external calls (new, to_wide, null_mut, FwpmSubLayerAdd0).


##### `add_filter`  (lines 267–305)

```
fn add_filter(
    engine: HANDLE,
    spec: &FilterSpec,
    user_condition: &UserMatchCondition,
) -> Result<()>
```

**Purpose**: Materializes one `FilterSpec` into a persistent blocking `FWPM_FILTER0` and adds it to WFP. The filter is attached to the Codex provider/sublayer and scoped by the supplied user condition plus any protocol/port conditions from the spec.

**Data flow**: Consumes `engine: HANDLE`, `spec: &FilterSpec`, and `user_condition: &UserMatchCondition`. It converts the spec's name and description to UTF-16, builds a mutable `Vec<FWPM_FILTER_CONDITION0>` via `build_conditions`, then fills an `FWPM_FILTER0` with the spec GUID, layer key, persistent flag, provider key, sublayer key, empty provider data, empty weight/effective weight, action type `FWP_ACTION_BLOCK`, and raw context 0. It calls `FwpmFilterAdd0`, stores the returned numeric filter id in a local `u64`, and returns `Ok(())` or an error annotated with the filter name.

**Call relations**: Called inside the `FILTER_SPECS` loop in `install_wfp_filters_for_account`, always after `delete_filter_if_present` for the same key. It delegates condition translation to `build_conditions` and uses `empty_blob`, `empty_value`, `zero_guid`, and `ensure_success` to assemble and validate the native structure.

*Call graph*: calls 5 internal fn (build_conditions, empty_blob, empty_value, ensure_success, zero_guid); called by 1 (install_wfp_filters_for_account); 5 external calls (new, to_wide, format!, null_mut, FwpmFilterAdd0).


##### `build_conditions`  (lines 308–343)

```
fn build_conditions(
    specs: &[ConditionSpec],
    user_condition: &UserMatchCondition,
) -> Vec<FWPM_FILTER_CONDITION0>
```

**Purpose**: Translates compact internal `ConditionSpec` values into the exact WFP condition records expected by `FWPM_FILTER0`. It centralizes the mapping from semantic filter constraints to native field keys and value unions.

**Data flow**: Takes a slice of `ConditionSpec` and a `UserMatchCondition`, iterates over the specs, and maps each variant to an `FWPM_FILTER_CONDITION0`: `User` becomes `FWPM_CONDITION_ALE_USER_ID` with `FWP_SECURITY_DESCRIPTOR_TYPE` pointing at `user_condition.blob`; `Protocol(u8)` becomes `FWPM_CONDITION_IP_PROTOCOL` with `FWP_UINT8`; `RemotePort(u16)` becomes `FWPM_CONDITION_IP_REMOTE_PORT` with `FWP_UINT16`. It collects and returns the resulting vector.

**Call relations**: Used only by `add_filter` while constructing each native filter. Its output vector is passed directly into the `filterCondition` pointer and `numFilterConditions` fields of `FWPM_FILTER0`.

*Call graph*: called by 1 (add_filter); 1 external calls (iter).


##### `delete_filter_if_present`  (lines 346–353)

```
fn delete_filter_if_present(engine: HANDLE, key: &GUID) -> Result<()>
```

**Purpose**: Removes a previously installed filter by GUID key, tolerating the case where no such filter exists. This supports the file's replace-in-place installation strategy.

**Data flow**: Accepts `engine: HANDLE` and `key: &GUID`, calls `FwpmFilterDeleteByKey0`, and treats success, `FWP_E_FILTER_NOT_FOUND`, and `FWP_E_NOT_FOUND` as non-errors via `ensure_success_or`.

**Call relations**: Called by `install_wfp_filters_for_account` before every `add_filter` invocation. It ensures stale copies are cleared without making first-time installation fail.

*Call graph*: calls 1 internal fn (ensure_success_or); called by 1 (install_wfp_filters_for_account); 1 external calls (FwpmFilterDeleteByKey0).


##### `ensure_success`  (lines 355–357)

```
fn ensure_success(result: u32, operation: &str) -> Result<()>
```

**Purpose**: Checks a Win32/WFP status code and fails unless it is exactly zero. It is the strict success path used for operations that do not admit tolerated alternate codes.

**Data flow**: Takes `result: u32` and `operation: &str`, forwards them to `ensure_success_or` with an empty allowed-code slice, and returns the resulting `Result<()>`.

**Call relations**: Used by engine open, transaction begin/commit, user condition creation, and filter add. It is a thin wrapper over `ensure_success_or` for the common no-exceptions case.

*Call graph*: calls 1 internal fn (ensure_success_or); called by 5 (begin_transaction, open, commit, for_account, add_filter).


##### `ensure_success_or`  (lines 359–368)

```
fn ensure_success_or(result: u32, operation: &str, allowed: &[u32]) -> Result<()>
```

**Purpose**: Normalizes native status codes into `Result<()>`, optionally allowing specific nonzero codes. It is the file's central error-policy helper for WFP and security API calls.

**Data flow**: Receives a raw `result`, operation name, and slice of allowed status codes. If `result == 0` or appears in `allowed`, it returns `Ok(())`; otherwise it formats the code with `format_error_code` and returns an `anyhow` error containing the operation name and hexadecimal status.

**Call relations**: Called by `ensure_success`, `ensure_provider`, `ensure_sublayer`, and `delete_filter_if_present`. It encodes the file's idempotency rules by permitting already-exists and not-found statuses where appropriate.

*Call graph*: called by 4 (delete_filter_if_present, ensure_provider, ensure_sublayer, ensure_success); 1 external calls (anyhow!).


##### `format_error_code`  (lines 370–372)

```
fn format_error_code(result: u32) -> String
```

**Purpose**: Formats a numeric status code as an eight-digit hexadecimal string. This keeps WFP/Win32 failures readable in propagated errors.

**Data flow**: Takes `result: u32` and returns `String` in the form `0xXXXXXXXX`.

**Call relations**: Used only by `ensure_success_or` when constructing error messages for failed native calls.

*Call graph*: 1 external calls (format!).


##### `empty_blob`  (lines 374–379)

```
fn empty_blob() -> FWP_BYTE_BLOB
```

**Purpose**: Constructs an empty `FWP_BYTE_BLOB` value for native structures that require provider data fields but do not use them. It avoids repeating null-pointer boilerplate.

**Data flow**: Returns `FWP_BYTE_BLOB { size: 0, data: null_mut() }`.

**Call relations**: Used by `ensure_provider`, `ensure_sublayer`, and `add_filter` when populating provider-data fields.

*Call graph*: called by 3 (add_filter, ensure_provider, ensure_sublayer); 1 external calls (null_mut).


##### `empty_value`  (lines 381–386)

```
fn empty_value() -> FWP_VALUE0
```

**Purpose**: Constructs an `FWP_VALUE0` tagged as `FWP_EMPTY`. It is used for filter weight fields that should be left unspecified.

**Data flow**: Returns `FWP_VALUE0` with `type = FWP_EMPTY` and a zeroed anonymous union payload.

**Call relations**: Used by `add_filter` for both `weight` and `effectiveWeight` initialization.

*Call graph*: called by 1 (add_filter); 1 external calls (zeroed).


##### `zero_guid`  (lines 388–390)

```
fn zero_guid() -> GUID
```

**Purpose**: Returns the all-zero GUID used in the filter action union. This supplies a neutral `filterType` value for the block action structure.

**Data flow**: Creates and returns `GUID::from_u128(0)`.

**Call relations**: Used only by `add_filter` while filling `FWPM_ACTION0_0.filterType`.

*Call graph*: called by 1 (add_filter); 1 external calls (from_u128).


##### `tests::filter_keys_are_unique`  (lines 399–412)

```
fn filter_keys_are_unique()
```

**Purpose**: Verifies that every static filter spec has a distinct GUID key. This protects the installer's delete-and-readd logic from collisions.

**Data flow**: Reads `FILTER_SPECS`, projects each GUID into a tuple of its fields, collects them into a `BTreeSet`, and asserts that the set length equals the original spec count.

**Call relations**: This test exercises only the static spec inventory and does not participate in runtime installation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::filter_names_are_unique`  (lines 415–421)

```
fn filter_names_are_unique()
```

**Purpose**: Verifies that every static filter spec has a distinct display name. This keeps diagnostics and WFP object listings unambiguous.

**Data flow**: Reads `FILTER_SPECS`, collects `spec.name` values into a `BTreeSet`, and asserts the set length matches the number of specs.

**Call relations**: Like the key-uniqueness test, this is a static invariant check for the filter spec table.

*Call graph*: 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/wfp_setup.rs`

`orchestration` · `elevated setup`

This file is the orchestration layer around the lower-level WFP installer. Its public function, `install_wfp_filters`, invokes `install_wfp_filters_for_account` inside `catch_unwind`, converts success, ordinary errors, and panics into a uniform `WfpSetupMetric` record, and logs a human-readable message in every case. The design choice is explicit in the log text: WFP setup is best-effort and setup continues even when installation fails or panics.

Telemetry is isolated behind a second safety boundary. `build_wfp_metrics_provider` constructs a minimal `codex_otel::OtelProvider` configured only for Statsig metrics, using the caller-provided resolved Statsig environment and the helper-specific service name `codex-windows-sandbox-setup`; tracing and other exporters are intentionally disabled because this helper cannot depend on the main core OTEL builder. `emit_wfp_setup_metric` emits either a success counter tagged with sanitized target account and installed filter count, or a failure counter tagged with sanitized account and optional sanitized error message. `emit_wfp_setup_metric_safely` wraps that emission in another `catch_unwind` and logs metric failures instead of surfacing them. A small helper, `panic_payload_to_string`, normalizes panic payloads from either `String` or `&'static str`, ensuring panic diagnostics can be logged and attached to failure metrics.

#### Function details

##### `panic_payload_to_string`  (lines 28–36)

```
fn panic_payload_to_string(panic_payload: Box<dyn std::any::Any + Send>) -> String
```

**Purpose**: Converts a caught panic payload into a readable string for logs and metrics. It recognizes the common `String` and `&'static str` payload forms and falls back to a generic message otherwise.

**Data flow**: Takes `Box<dyn Any + Send>`, first attempts `downcast::<String>()`, then if that fails attempts `downcast::<&'static str>()`; it returns the owned message string or `"unknown panic payload"`.

**Call relations**: Used by both `emit_wfp_setup_metric_safely` and `install_wfp_filters` when `catch_unwind` captures a panic. It sits on the error-reporting path rather than the normal success path.

*Call graph*: called by 2 (emit_wfp_setup_metric_safely, install_wfp_filters).


##### `build_wfp_metrics_provider`  (lines 38–62)

```
fn build_wfp_metrics_provider(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
) -> Result<Option<OtelProvider>>
```

**Purpose**: Builds an OTEL provider configured specifically for WFP setup metrics, or returns `None` when metrics settings are absent. It intentionally enables only Statsig metrics export for this helper process.

**Data flow**: Accepts `codex_home: &Path` and optional `StatsigMetricsSettings`. If `otel` is `None`, it returns `Ok(None)`. Otherwise it constructs an `OtelSettings` value using the passed environment, fixed service name, crate version from `env!("CARGO_PKG_VERSION")`, `codex_home.to_path_buf()`, `OtelExporter::None` for traces/general exporter, `OtelExporter::Statsig` for metrics, disabled runtime metrics, and empty `BTreeMap`s for attributes and tracestate; it then calls `OtelProvider::from` and wraps initialization failures with context.

**Call relations**: Called only by `emit_wfp_setup_metric` before any counter emission. It isolates provider construction so the emission path can short-circuit cleanly when telemetry is disabled.

*Call graph*: calls 1 internal fn (from); called by 1 (emit_wfp_setup_metric); 3 external calls (new, to_path_buf, env!).


##### `emit_wfp_setup_metric`  (lines 64–98)

```
fn emit_wfp_setup_metric(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
    metric: &WfpSetupMetric,
) -> Result<()>
```

**Purpose**: Emits one success or failure metric describing the WFP setup attempt, then shuts down the provider. It sanitizes tag values before sending them to the metrics backend.

**Data flow**: Takes `codex_home`, optional Statsig settings, and a `WfpSetupMetric`. It first calls `build_wfp_metrics_provider`; if that returns `None`, it exits successfully. If the provider exposes a metrics handle, it sanitizes `metric.target_account`, then matches on `metric.outcome`: success emits `WFP_SETUP_SUCCESS_METRIC` with tags `target_account` and stringified `installed_filter_count`; failure builds a tag vector starting with `target_account`, optionally adds a sanitized `message` tag from `metric.error`, and emits `WFP_SETUP_FAILURE_METRIC`. Finally it calls `provider.shutdown()` and returns `Ok(())`.

**Call relations**: This is the core telemetry path, invoked only through `emit_wfp_setup_metric_safely`. It depends on `build_wfp_metrics_provider` for setup and `sanitize_setup_metric_tag_value` to keep tag values acceptable for metrics ingestion.

*Call graph*: calls 2 internal fn (sanitize_setup_metric_tag_value, build_wfp_metrics_provider); 1 external calls (vec!).


##### `emit_wfp_setup_metric_safely`  (lines 100–124)

```
fn emit_wfp_setup_metric_safely(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
    offline_username: &str,
    metric: &WfpSetupMetric,
    log: &mut F,
)
```

**Purpose**: Runs metric emission behind panic and error containment so telemetry cannot break setup. It logs any emission failure using the caller-provided logger callback.

**Data flow**: Receives `codex_home`, optional Statsig settings, `offline_username`, a `WfpSetupMetric`, and mutable logger closure `log`. It executes `emit_wfp_setup_metric(...)` inside `std::panic::catch_unwind(AssertUnwindSafe(...))`, then matches the nested result: successful emission does nothing, an `Err` from emission logs a formatted failure message, and a panic is converted with `panic_payload_to_string` and logged as a panic message.

**Call relations**: Called at the end of `install_wfp_filters` after the installation outcome has already been determined. It delegates actual metric creation to `emit_wfp_setup_metric` but deliberately swallows both ordinary errors and panics.

*Call graph*: calls 1 internal fn (panic_payload_to_string); called by 1 (install_wfp_filters); 3 external calls (format!, AssertUnwindSafe, catch_unwind).


##### `install_wfp_filters`  (lines 126–175)

```
fn install_wfp_filters(
    codex_home: &Path,
    offline_username: &str,
    otel: Option<&StatsigMetricsSettings>,
    mut log: F,
)
```

**Purpose**: Performs best-effort WFP setup for one offline account, logs the outcome, and emits a corresponding metric without ever propagating failure. It is the public helper-facing wrapper around the lower-level installer.

**Data flow**: Takes `codex_home`, `offline_username`, optional Statsig settings, and a logger closure. It runs `install_wfp_filters_for_account(offline_username)` inside `catch_unwind(AssertUnwindSafe(...))`, then converts the result into a `WfpSetupMetric`: on success it logs installed filter count and records `Success`; on ordinary error it logs the error and records `Failure` with `installed_filter_count = 0`; on panic it stringifies the payload, logs that setup panicked but setup will continue, and records `Failure` with an error prefixed by `panic:`. It then passes the metric to `emit_wfp_setup_metric_safely`.

**Call relations**: This is the file's public orchestration entrypoint, called by elevated setup code. It wraps both the actual installer and the telemetry path in separate containment layers so neither can abort the broader setup flow.

*Call graph*: calls 2 internal fn (emit_wfp_setup_metric_safely, panic_payload_to_string); 3 external calls (format!, AssertUnwindSafe, catch_unwind).
