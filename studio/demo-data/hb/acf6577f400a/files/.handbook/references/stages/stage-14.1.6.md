# Approval-adjacent enforcement runtimes  `stage-14.1.6`

This stage is shared execution-time protection. It sits behind tool runs and approval-gated actions, making sure decisions about network access and sandbox safety are actually enforced while commands are running.

The network proxy pieces act like a guarded doorway to the internet. The library front door exposes the proxy parts other code may use. Its state builder turns requested settings into safe live settings, rejecting anything that would break central limits. The approval code handles “unknown host” cases by asking the right reviewer, remembering session-wide answers, and returning clear errors when access is denied. The network policy code decides allow, deny, or ask, and records why. The runtime is the proxy’s live rulebook: it checks hosts, HTTP methods, Unix sockets, and interception hooks, reloads changes, and logs blocked requests.

The Windows sandbox pieces enforce similar limits at the operating-system level. One file grants safe extra read access when needed. Others track and clean up read-deny rules, make protected workspace folders read-only, and install Windows Filtering Platform firewall rules. The setup wrapper applies that network lockdown defensively and records whether it worked.

## Files in this stage

### Proxy policy interfaces
These files introduce the network proxy subsystem and define the validated policy types that feed the live enforcement engine.

### `network-proxy/src/lib.rs`

`other` · `cross-cutting`

This file is the library’s public face. The actual work of the network proxy lives in many smaller modules: certificate handling, configuration, policy decisions, HTTP and SOCKS proxying, “man-in-the-middle” inspection hooks, runtime state, and so on. This file gathers those pieces together and re-exports the types and functions that outside code is meant to use.

In plain terms, it works like the reception desk for a large office. Visitors do not need to know which room contains certificate code or which room contains policy code; they can come through this one entrance and ask for the public tools by name.

It also sets one project-wide rule: code in this library may not print directly to standard output or standard error. That matters because proxy code often runs inside larger programs where uncontrolled printing can confuse users, break machine-readable output, or leak information. Instead, messages should go through whatever logging or reporting system the wider application expects.

There are no functions defined here. Its importance is structural: without it, other crates would need to reach into private module paths, and the library would not have a clear, stable public API.


### `network-proxy/src/state.rs`

`orchestration` · `config load and configuration update`

This file exists to keep the network proxy safe and predictable. A user or configuration file may ask for broad network access, allowed domains, blocked domains, Unix socket access, or MITM behavior. MITM means “man in the middle”: the proxy can inspect or modify traffic by sitting between the client and the destination. Before any of that becomes active, this file checks the request against stricter managed constraints, like company or administrator rules.

Think of it like a venue door policy. The guest list is the user config, but the venue owner may also say “no one can enter this room” or “only these groups are allowed.” This file compares both lists and rejects anything too loose.

It defines lightweight configuration shapes for partial network settings and a `NetworkProxyConstraints` structure that describes maximum permissions. Its main work is split in two. First, `validate_policy_against_constraints` checks whether a proposed config stays inside the allowed boundaries. It catches unsafe broad wildcards, forbidden proxy options, invalid MITM hooks, and domain or Unix socket lists that are too permissive. Second, `build_config_state` compiles the approved settings into fast lookup structures and creates optional MITM runtime state. Without this file, unsafe or invalid settings could become active, or the proxy would lack the prepared state it needs to make quick allow/block decisions.

#### Function details

##### `build_config_state`  (lines 64–94)

```
fn build_config_state(
    config: NetworkProxyConfig,
    constraints: NetworkProxyConstraints,
) -> anyhow::Result<ConfigState>
```

**Purpose**: Builds the ready-to-use runtime configuration for the proxy after settings have been accepted. It prepares fast domain lookup tables, optional MITM state, compiled hooks, and the bookkeeping used to record blocked requests.

**Data flow**: It receives a full network proxy config and a set of constraints. It first checks Unix socket allowlist paths, reads the allowed and denied domain lists, rejects unsafe global wildcard deny rules, compiles domain rules into efficient matchers, compiles MITM hooks, and creates MITM state if MITM is enabled. It returns a `ConfigState`, which is the assembled package the running proxy can use directly.

**Call relations**: This function is called when the system needs a fresh proxy state, such as creating state from settings or updating domain lists. It relies on the policy and MITM helper code to validate paths, compile allow and deny lists, compile hooks, and create MITM state before handing the completed state to the runtime.

*Call graph*: calls 6 internal fn (validate_unix_socket_allowlist_paths, new, compile_mitm_hooks, compile_allowlist_globset, compile_denylist_globset, validate_non_global_wildcard_domain_patterns); called by 6 (state_with_metadata, update_domain_list, add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed, add_allowed_domain_succeeds_when_managed_baseline_allows_expansion, add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed, state_for_settings); 2 external calls (new, new).


##### `validate_policy_against_constraints`  (lines 96–386)

```
fn validate_policy_against_constraints(
    config: &NetworkProxyConfig,
    constraints: &NetworkProxyConstraints,
) -> Result<(), NetworkProxyConstraintError>
```

**Purpose**: Checks whether a proposed network policy stays within managed limits. Someone uses this before applying a config change, so a user cannot turn on access or broad permissions that an administrator has restricted.

**Data flow**: It receives the proposed proxy config and the constraints. It reads the requested network mode, proxy flags, domain lists, Unix socket list, local binding setting, and MITM hook settings. It compares each requested value with the maximum allowed value, builds temporary lowercase sets for fair comparisons, and returns success if everything is allowed. If something is too broad, missing required managed entries, or otherwise invalid, it returns a clear constraint error.

**Call relations**: This function sits in the update path for actions like changing network mode or updating domain lists. It calls MITM hook validation and the domain wildcard checker before allowing the new policy to continue toward state rebuilding.

*Call graph*: calls 2 internal fn (validate_mitm_hook_config, validate_non_global_wildcard_domain_patterns); called by 2 (set_network_mode, update_domain_list).


##### `invalid_mitm_hook_configuration`  (lines 388–394)

```
fn invalid_mitm_hook_configuration(err: anyhow::Error) -> NetworkProxyConstraintError
```

**Purpose**: Turns a MITM hook validation failure into the same kind of constraint error used for the rest of this file. This keeps error reporting consistent for callers.

**Data flow**: It receives an `anyhow::Error`, which is a general-purpose error value. It converts that error to text and wraps it as an invalid value for `network.mitm_hooks`, saying that only a valid MITM hook configuration is allowed. The output is a `NetworkProxyConstraintError`.

**Call relations**: It is used as part of the policy validation story when MITM hook configuration is checked. Instead of leaking a lower-level hook error directly, it hands back an error shaped like the other managed-config violations.

*Call graph*: 1 external calls (to_string).


##### `validate_non_global_wildcard_domain_patterns`  (lines 396–412)

```
fn validate_non_global_wildcard_domain_patterns(
    field_name: &'static str,
    patterns: &[String],
) -> Result<(), NetworkProxyConstraintError>
```

**Purpose**: Rejects domain rules that are global wildcards, such as rules that would effectively match everything. This prevents an allow or deny list from using an overbroad pattern where only exact hosts or scoped wildcards are intended.

**Data flow**: It receives the name of the config field being checked and a list of domain pattern strings. It scans the list for any pattern that counts as a global wildcard. If it finds one, it returns a constraint error naming the bad pattern and explaining the allowed form; otherwise it returns success.

**Call relations**: This helper is used both when building runtime state and when validating a proposed policy against constraints. It protects the later allowlist and denylist compilation steps from accepting patterns that are too broad for these managed lists.

*Call graph*: called by 2 (build_config_state, validate_policy_against_constraints).


##### `NetworkProxyConstraintError::into_anyhow`  (lines 425–427)

```
fn into_anyhow(self) -> anyhow::Error
```

**Purpose**: Converts this file’s specific constraint error into the project’s general error type. This is useful when a caller wants to return one common error format instead of a special network-proxy-only one.

**Data flow**: It receives a `NetworkProxyConstraintError`. It wraps that error with `anyhow`, a general Rust error container used when code does not need a highly specific error type. The result is an `anyhow::Error` carrying the same message.

**Call relations**: It is used when state-building code needs to pass a constraint failure through an API that returns general errors. In particular, it lets domain-pattern validation failures fit into the broader `build_config_state` error flow.

*Call graph*: 1 external calls (anyhow!).


##### `network_mode_rank`  (lines 430–435)

```
fn network_mode_rank(mode: NetworkMode) -> u8
```

**Purpose**: Gives each network mode a simple strictness score so the code can compare them. A lower score means a more restrictive mode, and a higher score means broader access.

**Data flow**: It receives a `NetworkMode`. It maps `Limited` to `0` and `Full` to `1`, then returns that number. The caller can then ask whether one mode is more permissive than another with a normal numeric comparison.

**Call relations**: It supports policy validation when checking a requested network mode against the maximum mode allowed by managed constraints. This keeps the comparison simple and avoids scattering mode-ordering logic through the validation code.


### Live proxy enforcement
These files implement the runtime policy engine and the approval-aware decision flow that evaluates and audits network access during tool execution.

### `core/src/tools/network_approval.rs`

`domain_logic` · `tool execution and network request handling`

This file is the “front desk” for network access approval. When a running command tries to contact a host, the network proxy can ask this service whether the request should be allowed, denied, or sent for review. Without this file, blocked network requests would either fail with no chance for approval, or be allowed without the project’s safety checks.

The main piece is NetworkApprovalService. It keeps track of active tool calls, pending host approvals, and hosts that were allowed or denied for the current session. If two requests ask about the same host, protocol, and port at the same time, it asks only once and makes the other request wait for the same answer. This is like having one person at a reception desk check with security while everyone else in the same group waits for the result.

The file supports two timing modes. Immediate approvals are finished when the tool call ends. Deferred approvals can be finished later, which is useful when a network denial needs to cancel or affect a longer-running process. Approval can come from local hooks, a human approval prompt, or a guardian review system. The result is then translated into either a network proxy decision or a tool error.

#### Function details

##### `DeferredNetworkApproval::registration_id`  (lines 64–66)

```
fn registration_id(&self) -> &str
```

**Purpose**: Returns the unique registration ID for a deferred network approval. This ID is how the service later finds the stored result for that approval.

**Data flow**: It reads the registration_id stored inside the DeferredNetworkApproval and returns it as text. Nothing is changed.

**Call relations**: Code that has kept a deferred approval can use this when it needs to refer back to the exact approval record.


##### `DeferredNetworkApproval::cancellation_token`  (lines 68–70)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Gives callers a cancellation token, which is a shared signal that can tell running work to stop. This lets a network denial interrupt a process that is still running.

**Data flow**: It reads the stored cancellation token, clones the handle, and returns the clone. The underlying cancellation signal is shared, so cancelling one handle affects all holders.

**Call relations**: terminate_process_on_network_denial calls this so it can watch for a denial and stop the related process when needed.

*Call graph*: called by 1 (terminate_process_on_network_denial); 1 external calls (clone).


##### `DeferredNetworkApproval::is_cancelled`  (lines 72–74)

```
fn is_cancelled(&self) -> bool
```

**Purpose**: Checks whether the deferred approval has been cancelled. In practice, cancellation means a denial or similar outcome has told the related work to stop.

**Data flow**: It asks the stored cancellation token whether it has been cancelled and returns true or false. It does not change any state.

**Call relations**: This is a small status check for code that already holds a DeferredNetworkApproval.

*Call graph*: 1 external calls (is_cancelled).


##### `DeferredNetworkApproval::finish`  (lines 76–83)

```
async fn finish(&self, service: &NetworkApprovalService) -> Result<(), ToolError>
```

**Purpose**: Completes a deferred approval and turns its saved outcome into success or a ToolError. It also makes sure repeated finish calls reuse the same answer.

**Data flow**: It takes the service and its own registration ID, asks the service for the final outcome once, stores that answer in a one-time cell, and converts it into Ok or a rejected ToolError.

**Call relations**: finish_deferred_network_approval calls this at the point where deferred network approval must finally be resolved. It hands the outcome conversion to network_approval_outcome_to_result.

*Call graph*: calls 1 internal fn (network_approval_outcome_to_result).


##### `ActiveNetworkApproval::mode`  (lines 94–96)

```
fn mode(&self) -> NetworkApprovalMode
```

**Purpose**: Returns whether the active approval is immediate or deferred. Callers use this to decide when the approval should be finished.

**Data flow**: It reads the mode stored inside ActiveNetworkApproval and returns it. No state changes.

**Call relations**: This is used by code that has just begun a network approval and needs to choose the right cleanup path.


##### `ActiveNetworkApproval::cancellation_token`  (lines 98–100)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Returns a shared cancellation signal for the active approval. This lets other work be stopped if the approval later becomes a denial.

**Data flow**: It clones the stored cancellation token handle and returns it. The clone points to the same shared cancellation state.

**Call relations**: This is available to code running under an active network approval, so that code can react to cancellation.

*Call graph*: 1 external calls (clone).


##### `ActiveNetworkApproval::into_deferred`  (lines 102–118)

```
fn into_deferred(self) -> Option<DeferredNetworkApproval>
```

**Purpose**: Converts an active approval into a deferred approval when the mode allows it. If the approval is not deferred, it returns nothing.

**Data flow**: It consumes the ActiveNetworkApproval, checks its mode and registration ID, and either builds a DeferredNetworkApproval with the same cancellation token or returns None.

**Call relations**: This bridges the immediate part of tool execution with later cleanup code that may need to finish the approval after the active object is gone.

*Call graph*: 2 external calls (new, new).


##### `HostApprovalKey::from_request`  (lines 129–135)

```
fn from_request(request: &NetworkPolicyRequest, protocol: NetworkApprovalProtocol) -> Self
```

**Purpose**: Builds the lookup key used to remember approval decisions for a specific network target. The key is based on host, protocol, and port.

**Data flow**: It receives a network policy request and an approval protocol, lowercases the host, converts the protocol to a stable label, copies the port, and returns a HostApprovalKey.

**Call relations**: handle_inline_policy_request uses this near the start so all later checks talk about the same normalized target. It relies on protocol_key_label for the protocol text.

*Call graph*: calls 1 internal fn (protocol_key_label); called by 1 (handle_inline_policy_request).


##### `protocol_key_label`  (lines 138–145)

```
fn protocol_key_label(protocol: NetworkApprovalProtocol) -> &'static str
```

**Purpose**: Turns a network protocol value into a short stable label such as http or socks5-tcp. These labels are used in approval keys and IDs.

**Data flow**: It receives a NetworkApprovalProtocol and returns a fixed text label for that protocol. It does not read or change shared state.

**Call relations**: HostApprovalKey::from_request calls this while building a key for caching and deduplicating approvals.

*Call graph*: called by 1 (from_request).


##### `network_approval_outcome_to_result`  (lines 160–170)

```
fn network_approval_outcome_to_result(
    outcome: Option<NetworkApprovalOutcome>,
) -> Result<(), ToolError>
```

**Purpose**: Turns a saved approval outcome into the kind of result a tool runner understands. Denials become rejected tool errors, while no denial means success.

**Data flow**: It receives an optional NetworkApprovalOutcome. If there is no outcome, it returns Ok. If the user or policy denied access, it returns a ToolError::Rejected with the right message.

**Call relations**: DeferredNetworkApproval::finish and NetworkApprovalService::finish_call use this as the final translation step from approval state to tool-level result.

*Call graph*: called by 2 (finish, finish_call); 1 external calls (Rejected).


##### `allows_network_approval_flow`  (lines 173–175)

```
fn allows_network_approval_flow(policy: AskForApproval) -> bool
```

**Purpose**: Checks whether the current approval policy permits asking for network approval. If the policy says never ask, the request must be denied instead of reviewed.

**Data flow**: It receives an AskForApproval policy and returns false only for the Never setting. It does not change anything.

**Call relations**: handle_inline_policy_request uses this before showing any prompt or guardian review, so the configured approval policy is respected.

*Call graph*: called by 1 (handle_inline_policy_request); 1 external calls (matches!).


##### `permission_profile_allows_network_approval_flow`  (lines 177–179)

```
fn permission_profile_allows_network_approval_flow(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Checks whether the current permission profile supports this managed network approval flow. Only managed profiles are allowed to request review here.

**Data flow**: It receives a PermissionProfile and returns true if it is the managed kind. No state is changed.

**Call relations**: handle_inline_policy_request uses this as another gate before asking anyone to approve network access.

*Call graph*: called by 1 (handle_inline_policy_request); 1 external calls (matches!).


##### `PendingApprovalDecision::to_network_decision`  (lines 182–187)

```
fn to_network_decision(self) -> NetworkDecision
```

**Purpose**: Converts an internal pending-approval answer into the decision format used by the network proxy. Allows become proxy allows, and denials become proxy denials.

**Data flow**: It receives a PendingApprovalDecision. AllowOnce and AllowForSession become NetworkDecision::Allow; Deny becomes a denial with the reason not_allowed.

**Call relations**: Waiting requests and the main approval path use this after a human, hook, or guardian decision has been resolved.

*Call graph*: calls 1 internal fn (deny).


##### `PendingHostApproval::new`  (lines 196–201)

```
fn new() -> Self
```

**Purpose**: Creates a shared waiting point for one host approval question. It starts with no decision and a notifier that can wake all waiters later.

**Data flow**: It creates an empty locked decision slot and a notification object, then returns a PendingHostApproval containing both.

**Call relations**: NetworkApprovalService::get_or_create_pending_approval creates these when the first request for a host arrives. Tests also use it to check that waiters receive the owner’s decision.

*Call graph*: called by 2 (get_or_create_pending_approval, pending_waiters_receive_owner_decision); 2 external calls (new, new).


##### `PendingHostApproval::wait_for_decision`  (lines 203–211)

```
async fn wait_for_decision(&self) -> PendingApprovalDecision
```

**Purpose**: Waits until the owner of a pending approval records a decision. This prevents duplicate prompts for the same host.

**Data flow**: It repeatedly checks the locked decision slot. If the slot is empty, it waits for a notification; once a decision appears, it returns that decision.

**Call relations**: handle_inline_policy_request uses this for later requests that arrive while an earlier request for the same host is already being reviewed.

*Call graph*: 1 external calls (notified).


##### `PendingHostApproval::set_decision`  (lines 213–219)

```
async fn set_decision(&self, decision: PendingApprovalDecision)
```

**Purpose**: Stores the final answer for a pending host approval and wakes every request waiting for it.

**Data flow**: It receives a decision, writes it into the locked slot, and notifies all waiters so they can continue with the same answer.

**Call relations**: handle_inline_policy_request calls this after hooks, guardian review, or user approval has produced an answer.

*Call graph*: 1 external calls (notify_waiters).


##### `NetworkApprovalService::default`  (lines 244–251)

```
fn default() -> Self
```

**Purpose**: Creates an empty NetworkApprovalService with no active calls, no pending approvals, and no session-wide host decisions. This is the clean starting state.

**Data flow**: It constructs empty collections protected by async locks and returns the service. Nothing external is read.

**Call relations**: Session setup and tests create the service through this default path before network approvals can be tracked.

*Call graph*: called by 14 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, active_call_preserves_triggering_command_context, blocked_request_policy_does_not_override_user_denial_outcome, deferred_finish_reuses_denial_result_after_first_consumer, finish_call_returns_denial_and_unregisters_active_call, pending_approvals_are_deduped_per_host_protocol_and_port, pending_approvals_do_not_dedupe_across_ports, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests (+4 more)); 4 external calls (new, new, new, default).


##### `NetworkApprovalService::sync_session_approved_hosts_to`  (lines 257–262)

```
async fn sync_session_approved_hosts_to(&self, other: &Self)
```

**Purpose**: Copies the session-approved host list from one service into another. This lets a new or related session inherit the current allowed network targets.

**Data flow**: It reads this service’s approved-host set, clears the other service’s approved-host set, and fills it with the copied entries. Denied hosts and pending approvals are not copied.

**Call relations**: This is used when approval state needs to be carried between service instances without moving the whole service.


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

**Purpose**: Records that a tool call is active and may be associated with network approval decisions. It stores enough context to cancel the call or explain the approval request later.

**Data flow**: It receives a registration ID, turn ID, trigger, command text, and cancellation token. It places a new ActiveNetworkApprovalCall into the active-calls map.

**Call relations**: The network approval start path uses this when a command begins under managed network approval. The stored call is later found by resolve_single_active_call and may receive outcomes through record_call_outcome.

*Call graph*: called by 1 (register_call_with_default_shell_trigger); 1 external calls (new).


##### `NetworkApprovalService::unregister_call`  (lines 286–288)

```
async fn unregister_call(&self, registration_id: &str)
```

**Purpose**: Removes an active call record when it is no longer needed. This prevents stale calls from being blamed for later network events.

**Data flow**: It receives a registration ID and removes that call and any saved outcome for it. It returns no value.

**Call relations**: It delegates the actual removal to remove_call, keeping the public cleanup method simple.

*Call graph*: calls 1 internal fn (remove_call).


##### `NetworkApprovalService::resolve_single_active_call`  (lines 290–300)

```
async fn resolve_single_active_call(&self) -> Option<Arc<ActiveNetworkApprovalCall>>
```

**Purpose**: Finds the active tool call that should receive a network approval outcome, but only when there is exactly one possible call. This avoids guessing when several calls are running at once.

**Data flow**: It reads the active-calls map. If there is exactly one call, it returns a shared reference to it; otherwise it returns None.

**Call relations**: handle_inline_policy_request and record_outcome_for_single_active_call use this before attaching a denial or prompt context to a tool call.

*Call graph*: called by 2 (handle_inline_policy_request, record_outcome_for_single_active_call).


##### `NetworkApprovalService::get_or_create_pending_approval`  (lines 302–314)

```
async fn get_or_create_pending_approval(
        &self,
        key: HostApprovalKey,
    ) -> (Arc<PendingHostApproval>, bool)
```

**Purpose**: Finds or creates the shared approval question for a host. This makes multiple simultaneous requests for the same target share one review.

**Data flow**: It receives a HostApprovalKey, checks the pending-approvals map, and returns the existing PendingHostApproval with false if one exists. Otherwise it creates one, stores it, and returns it with true.

**Call relations**: handle_inline_policy_request calls this after building the host key. The returned owner flag decides whether this request asks for approval or waits for someone else’s answer.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_inline_policy_request); 2 external calls (clone, new).


##### `NetworkApprovalService::record_outcome_for_single_active_call`  (lines 316–322)

```
async fn record_outcome_for_single_active_call(&self, outcome: NetworkApprovalOutcome)
```

**Purpose**: Saves a denial outcome for the only active call, if there is exactly one. It is a safe helper for network events that do not identify which call caused them.

**Data flow**: It receives a NetworkApprovalOutcome, tries to find a single active call, and if found records that outcome under the call’s registration ID.

**Call relations**: record_blocked_request uses this when the proxy reports a blocked request. handle_inline_policy_request also uses it for early policy denials without a specific owner call.

*Call graph*: calls 2 internal fn (record_call_outcome, resolve_single_active_call); called by 2 (handle_inline_policy_request, record_blocked_request).


##### `NetworkApprovalService::take_call_outcome`  (lines 325–328)

```
async fn take_call_outcome(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Test-only helper that removes and returns a saved outcome for a call. It lets tests inspect what the service recorded.

**Data flow**: It receives a registration ID, locks the call state, removes any matching outcome from the outcome map, and returns it.

**Call relations**: This exists only under test configuration, so production approval flow does not call it.


##### `NetworkApprovalService::record_call_outcome`  (lines 330–347)

```
async fn record_call_outcome(&self, registration_id: &str, outcome: NetworkApprovalOutcome)
```

**Purpose**: Stores the outcome for a specific active call and cancels that call’s cancellation token. It also preserves a user denial if one was already recorded.

**Data flow**: It receives a registration ID and outcome, looks up the active call, writes the outcome unless it would overwrite an existing user denial, then cancels the call’s token.

**Call relations**: handle_inline_policy_request and record_outcome_for_single_active_call call this whenever a denial or policy result must be tied to an active command.

*Call graph*: called by 2 (handle_inline_policy_request, record_outcome_for_single_active_call); 1 external calls (matches!).


##### `NetworkApprovalService::remove_call`  (lines 349–353)

```
async fn remove_call(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Removes a call from active tracking and takes its saved outcome. This is the central cleanup step for finished approvals.

**Data flow**: It receives a registration ID, removes that ID from the active-call map, removes any stored outcome for the same ID, and returns the outcome if one existed.

**Call relations**: finish_call_outcome and unregister_call both use this so call cleanup behaves the same way everywhere.

*Call graph*: called by 2 (finish_call_outcome, unregister_call).


##### `NetworkApprovalService::finish_call_outcome`  (lines 355–357)

```
async fn finish_call_outcome(&self, registration_id: &str) -> Option<NetworkApprovalOutcome>
```

**Purpose**: Finishes tracking a call and returns its saved network approval outcome, if any. It is a small wrapper around the cleanup operation.

**Data flow**: It receives a registration ID and returns whatever remove_call finds for that call. The call is no longer active afterward.

**Call relations**: finish_call uses this before turning the outcome into a ToolError result.

*Call graph*: calls 1 internal fn (remove_call); called by 1 (finish_call).


##### `NetworkApprovalService::finish_call`  (lines 359–361)

```
async fn finish_call(&self, registration_id: &str) -> Result<(), ToolError>
```

**Purpose**: Completes an immediate network approval for a tool call. It turns any recorded denial into the error the tool runner should see.

**Data flow**: It receives a registration ID, removes the call and fetches its outcome, then converts that outcome into Ok or ToolError::Rejected.

**Call relations**: finish_immediate_network_approval calls this when a tool attempt ends and the approval result must be applied.

*Call graph*: calls 2 internal fn (finish_call_outcome, network_approval_outcome_to_result).


##### `NetworkApprovalService::record_blocked_request`  (lines 363–370)

```
async fn record_blocked_request(&self, blocked: BlockedRequest)
```

**Purpose**: Records that the network proxy blocked a request because of policy. If that block can be explained to the user, it attaches the denial to the active call.

**Data flow**: It receives a BlockedRequest, asks for a human-readable denial message, and if one exists stores it as a policy denial for the single active call.

**Call relations**: build_blocked_request_observer wires this into the network proxy’s blocked-request callback.

*Call graph*: calls 2 internal fn (denied_network_policy_message, record_outcome_for_single_active_call); 1 external calls (DeniedByPolicy).


##### `NetworkApprovalService::active_turn_context`  (lines 372–380)

```
async fn active_turn_context(
        session: &Session,
    ) -> Option<Arc<crate::session::turn_context::TurnContext>>
```

**Purpose**: Finds the current turn context from a session. The turn context contains the approval policy, permission profile, current working directory, and IDs needed for prompts.

**Data flow**: It reads the session’s active turn, checks whether there is an attached task, and returns a shared turn context if available.

**Call relations**: handle_inline_policy_request calls this before it can decide whether approval is allowed or send a prompt.


##### `NetworkApprovalService::format_network_target`  (lines 382–384)

```
fn format_network_target(protocol: &str, host: &str, port: u16) -> String
```

**Purpose**: Formats a protocol, host, and port as a readable network target string. This string is shown in prompts and denial messages.

**Data flow**: It receives protocol text, host text, and a port number, then returns a string like protocol://host:port.

**Call relations**: handle_inline_policy_request uses this when building the approval prompt and policy-denial message.

*Call graph*: 1 external calls (format!).


##### `NetworkApprovalService::approval_id_for_key`  (lines 386–388)

```
fn approval_id_for_key(key: &HostApprovalKey) -> String
```

**Purpose**: Builds a stable approval ID for a host key. The ID lets hooks, prompts, and guardian reviews refer to the same network approval request.

**Data flow**: It receives a HostApprovalKey and returns a string made from its protocol, host, and port.

**Call relations**: handle_inline_policy_request uses this before running hooks or creating a guardian/user approval request.

*Call graph*: 1 external calls (format!).


##### `NetworkApprovalService::handle_inline_policy_request`  (lines 390–671)

```
async fn handle_inline_policy_request(
        &self,
        session: Arc<Session>,
        request: NetworkPolicyRequest,
    ) -> NetworkDecision
```

**Purpose**: This is the main decision path for a network request that was not already allowed. It checks cached answers, deduplicates simultaneous prompts, runs hooks, asks the guardian or user when allowed, updates session caches, and returns the proxy’s final allow-or-deny decision.

**Data flow**: It receives the session and the network request. It normalizes the request into a host key, checks session-denied and session-approved caches, creates or joins a pending approval, checks whether approval is permitted by the current turn, tries permission hooks, then asks the guardian or local approval system if needed. The final review answer becomes a PendingApprovalDecision, optional session cache updates are made, waiting requests are notified, and a NetworkDecision is returned.

**Call relations**: build_network_policy_decider sends proxy policy requests here. This function pulls together HostApprovalKey::from_request, get_or_create_pending_approval, active_turn_context, approval-policy checks, hook execution, guardian or session approval calls, record_call_outcome, and PendingApprovalDecision::to_network_decision.

*Call graph*: calls 10 internal fn (run_permission_request_hooks, from_request, get_or_create_pending_approval, record_call_outcome, record_outcome_for_single_active_call, resolve_single_active_call, allows_network_approval_flow, permission_profile_allows_network_approval_flow, bash, deny); 13 external calls (active_turn_context, approval_id_for_key, format_network_target, DeniedByPolicy, guardian_rejection_message, guardian_timeout_message, review_approval_request, routes_approval_to_guardian, format!, matches! (+3 more)).


##### `build_blocked_request_observer`  (lines 674–683)

```
fn build_blocked_request_observer(
    network_approval: Arc<NetworkApprovalService>,
) -> Arc<dyn BlockedRequestObserver>
```

**Purpose**: Creates the callback object the network proxy can call when it blocks a request. The callback forwards the blocked request into NetworkApprovalService.

**Data flow**: It receives a shared NetworkApprovalService and returns a shared BlockedRequestObserver. When the observer is later called with a BlockedRequest, it clones the service handle and records the blocked request asynchronously.

**Call relations**: This connects the lower-level network proxy to record_blocked_request so policy denials can affect the active tool call.

*Call graph*: 1 external calls (new).


##### `build_network_policy_decider`  (lines 685–701)

```
fn build_network_policy_decider(
    network_approval: Arc<NetworkApprovalService>,
    network_policy_decider_session: Arc<RwLock<std::sync::Weak<Session>>>,
) -> Arc<dyn NetworkPolicyDecider>
```

**Purpose**: Creates the callback object the network proxy uses to ask whether an inline network request should be allowed. It bridges proxy requests into the session-aware approval service.

**Data flow**: It receives the NetworkApprovalService and a weak session reference protected by a read-write lock. When a request arrives, it tries to upgrade the weak reference to a live session; if that fails it asks the proxy to deny or ask with not_allowed, otherwise it calls handle_inline_policy_request.

**Call relations**: This is the adapter between codex_network_proxy and NetworkApprovalService::handle_inline_policy_request.

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

**Purpose**: Starts tracking network approval for a tool call if managed networking is active and a network proxy is present. It returns an ActiveNetworkApproval that the caller can finish later.

**Data flow**: It receives the session, turn ID, whether managed network is active, and an optional approval spec. If the spec is missing, managed networking is inactive, or no network proxy exists, it returns None. Otherwise it creates a registration ID and cancellation token, registers the call with the service, and returns the active approval object.

**Call relations**: run_attempt calls this when a tool attempt begins. The registered call is later finished by finish_immediate_network_approval or converted to a deferred approval.

*Call graph*: called by 1 (run_attempt); 2 external calls (new, new_v4).


##### `finish_immediate_network_approval`  (lines 740–753)

```
async fn finish_immediate_network_approval(
    session: &Session,
    active: ActiveNetworkApproval,
) -> Result<(), ToolError>
```

**Purpose**: Finishes an active approval that should be resolved as soon as the tool call ends. Any recorded denial becomes a ToolError.

**Data flow**: It receives the session and ActiveNetworkApproval. If the approval has no registration ID, it returns success. Otherwise it asks the session’s NetworkApprovalService to finish that call and returns the resulting success or rejection.

**Call relations**: run_attempt calls this after a command using immediate network approval completes.

*Call graph*: called by 1 (run_attempt).


##### `finish_deferred_network_approval`  (lines 755–763)

```
async fn finish_deferred_network_approval(
    session: &Session,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), ToolError>
```

**Purpose**: Finishes a deferred approval if one exists. This applies a saved network denial later than the original tool call boundary.

**Data flow**: It receives the session and an optional DeferredNetworkApproval. If there is no deferred approval, it returns success. If one exists, it calls its finish method against the session’s NetworkApprovalService and returns the resulting success or ToolError.

**Call relations**: run_attempt and helper paths such as finish_deferred_network_approval_for_session and network_denial_message_for_session call this when deferred network approval needs to be resolved.

*Call graph*: called by 3 (run_attempt, finish_deferred_network_approval_for_session, network_denial_message_for_session).


### `network-proxy/src/network_policy.rs`

`domain_logic` · `request handling`

The network proxy sits between a client and the outside network, so it needs a clear answer to a simple question: “May this request go through?” This file defines the language used for that answer. It names the kind of network request, stores the details of the request, records where a decision came from, and represents the final result as allow, deny, or ask.

The main flow is `evaluate_host_policy`. It asks the current proxy state whether the destination host and port are allowed by the baseline configuration. If the baseline allows the request, the request passes. If the baseline blocks it because it is not on the allowed list, an optional extra decider can be asked. That decider can override the baseline and allow the request, or return a deny/ask result. Other hard blocks stay denied.

Every decision is also written as a structured audit event using `tracing`, a logging system for machine-readable events. These events include the protocol, host, port, method, client address, reason, source, and optional user/session metadata. The test-only section builds a tiny event collector so tests can prove that the right audit records are produced.

#### Function details

##### `NetworkProtocol::as_policy_protocol`  (lines 31–38)

```
fn as_policy_protocol(self) -> &'static str
```

**Purpose**: Turns the internal protocol choice into the short text used in policy logs and responses, such as `http` or `socks5_tcp`. This keeps audit records and proxy messages consistent.

**Data flow**: It takes one protocol value → matches it to its public text label → returns that label as a fixed string without changing anything else.

**Call relations**: When the proxy needs to explain a disabled or policy-related response, `proxy_disabled_response` calls this to name the protocol in a standard way. The same kind of label is also used when this file emits policy audit events.

*Call graph*: called by 1 (proxy_disabled_response).


##### `NetworkPolicyDecision::as_str`  (lines 49–54)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a policy decision kind into the text used in audit records. It distinguishes a firm denial from an `ask` result, where user approval may be needed.

**Data flow**: It takes `Deny` or `Ask` → chooses `deny` or `ask` → returns that text label.

**Call relations**: After `evaluate_host_policy` has a final `NetworkDecision`, it uses this conversion for denied decisions so the audit event records the exact kind of block.


##### `NetworkDecisionSource::as_str`  (lines 67–74)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns the source of a decision into a stable audit label, such as `baseline_policy` or `decider`. This makes later audit analysis easier.

**Data flow**: It takes a source enum value → maps it to a lowercase string → returns that string without side effects.

**Call relations**: Audit helpers call this when writing policy events, so every allow, deny, or ask event says which part of the system made the call.


##### `NetworkPolicyRequest::new`  (lines 99–118)

```
fn new(args: NetworkPolicyRequestArgs) -> Self
```

**Purpose**: Builds a complete request record from named pieces like protocol, host, port, method, and optional command hints. Callers use it before asking the policy system for a decision.

**Data flow**: It receives a `NetworkPolicyRequestArgs` bundle → copies each field into a `NetworkPolicyRequest` → returns the ready-to-check request.

**Call relations**: HTTP and SOCKS proxy paths create requests with this before calling policy evaluation. The tests also use it to make clear example requests for allowed, denied, and ask cases.

*Call graph*: called by 9 (http_connect_accept, http_plain_proxy, evaluate_host_policy_emits_domain_event_for_baseline_deny, evaluate_host_policy_emits_domain_event_for_decider_allow_override, evaluate_host_policy_emits_domain_event_for_decider_ask, evaluate_host_policy_emits_metadata_fields, evaluate_host_policy_still_denies_not_allowed_local_without_decider_override, handle_socks5_tcp, inspect_socks5_udp).


##### `NetworkDecision::deny`  (lines 132–134)

```
fn deny(reason: impl Into<String>) -> Self
```

**Purpose**: Creates a normal denial that is attributed to the extra policy decider. It is a convenient shortcut for callers that do not need to specify a different source.

**Data flow**: It receives a reason text → passes it to `deny_with_source` with the default source set to `Decider` → returns a `Deny` decision.

**Call relations**: Inline policy handling and conversion from external decisions use this shortcut when they need to turn a denial reason into the file’s standard decision shape.

*Call graph*: called by 2 (handle_inline_policy_request, to_network_decision); 1 external calls (deny_with_source).


##### `NetworkDecision::ask`  (lines 136–138)

```
fn ask(reason: impl Into<String>) -> Self
```

**Purpose**: Creates a decision that blocks the request for now but marks it as something that should be asked about. This is useful when an approval step may happen elsewhere.

**Data flow**: It receives a reason text → passes it to `ask_with_source` with the default source set to `Decider` → returns a deny-shaped decision whose policy decision is `Ask`.

**Call relations**: Decider implementations can return this when they want the proxy to stop the request and signal that user approval is needed. Tests verify that it carries the expected source and decision kind.

*Call graph*: 1 external calls (ask_with_source).


##### `NetworkDecision::deny_with_source`  (lines 140–152)

```
fn deny_with_source(reason: impl Into<String>, source: NetworkDecisionSource) -> Self
```

**Purpose**: Creates a firm denial and records which part of the system caused it. If no reason is supplied, it fills in a default policy-denied reason so audit logs are never blank.

**Data flow**: It receives reason text and a decision source → turns the reason into a string → replaces an empty reason with the default denial reason → returns a `Deny` decision marked as `Deny`.

**Call relations**: `evaluate_host_policy` uses this when the baseline configuration blocks a host. `NetworkDecision::deny` also delegates here for the common decider-deny case.

*Call graph*: called by 1 (evaluate_host_policy); 2 external calls (into, is_empty).


##### `NetworkDecision::ask_with_source`  (lines 154–166)

```
fn ask_with_source(reason: impl Into<String>, source: NetworkDecisionSource) -> Self
```

**Purpose**: Creates an ask-style denial and records which part of the system requested the ask. It also protects audit records by replacing an empty reason with the default denial reason.

**Data flow**: It receives reason text and a source → normalizes the reason → returns a `Deny` value whose decision kind is `Ask`.

**Call relations**: `NetworkDecision::ask` uses this helper for the usual decider-sourced ask case. It gives other code a way to build the same shape while naming a different source if needed.

*Call graph*: 2 external calls (into, is_empty).


##### `emit_block_decision_audit_event`  (lines 179–184)

```
fn emit_block_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Writes an audit event for a non-domain policy block, such as a method or mode restriction rather than a host allow-list decision.

**Data flow**: It receives proxy state plus block details → adds the fixed decision `deny` → passes everything to the shared non-domain audit helper.

**Call relations**: HTTP and SOCKS-specific audit wrappers call this when they have already decided to block a request for reasons outside normal domain policy. It then hands the work to `emit_non_domain_policy_decision_audit_event`.

*Call graph*: calls 1 internal fn (emit_non_domain_policy_decision_audit_event); called by 2 (emit_http_block_decision_audit_event, emit_socks_block_decision_audit_event).


##### `emit_allow_decision_audit_event`  (lines 186–191)

```
fn emit_allow_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Writes an audit event for a non-domain allow decision. This records that the proxy deliberately allowed a request outside the domain-policy evaluation path.

**Data flow**: It receives proxy state plus request details → adds the fixed decision `allow` → sends the data to the shared non-domain audit helper.

**Call relations**: The HTTP allow audit wrapper calls this after an allow decision. This function keeps allow and deny audit events using the same event shape.

*Call graph*: calls 1 internal fn (emit_non_domain_policy_decision_audit_event); called by 1 (emit_http_allow_decision_audit_event).


##### `emit_non_domain_policy_decision_audit_event`  (lines 193–213)

```
fn emit_non_domain_policy_decision_audit_event(
    state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
    decision: &'static str,
)
```

**Purpose**: Prepares a policy audit event for decisions that are not about domain allow/deny lists. It fills in the non-domain scope and marks that no baseline override happened.

**Data flow**: It receives state, request/block details, and an allow-or-deny label → builds a `PolicyAuditEventArgs` record with scope `non_domain` → calls the shared audit emitter.

**Call relations**: Both non-domain allow and block audit functions use this helper. It then delegates to `emit_policy_audit_event`, which performs the actual logging.

*Call graph*: calls 1 internal fn (emit_policy_audit_event); called by 2 (emit_allow_decision_audit_event, emit_block_decision_audit_event).


##### `emit_policy_audit_event`  (lines 228–255)

```
fn emit_policy_audit_event(state: &NetworkProxyState, args: PolicyAuditEventArgs<'_>)
```

**Purpose**: Writes the final structured policy decision audit event. This is the central place where all policy decisions become machine-readable logs.

**Data flow**: It receives proxy state and prepared audit fields → reads audit metadata from the state → adds timestamp, user/session metadata, network details, reason, source, and override flag → emits a `tracing` event.

**Call relations**: `evaluate_host_policy` calls this for domain-policy decisions, and the non-domain helper calls it for other proxy decisions. It is the last stop before the decision is visible to logging and telemetry systems.

*Call graph*: calls 1 internal fn (audit_metadata); called by 2 (emit_non_domain_policy_decision_audit_event, evaluate_host_policy); 1 external calls (event!).


##### `audit_timestamp`  (lines 257–259)

```
fn audit_timestamp() -> String
```

**Purpose**: Creates the timestamp used in audit events. It formats the current UTC time with millisecond precision so logs have a consistent time shape.

**Data flow**: It reads the current clock time → formats it as an RFC 3339 UTC string ending in `Z` → returns that string.

**Call relations**: `emit_policy_audit_event` uses this whenever it writes a policy decision event. Tests check the format so audit consumers can rely on it.

*Call graph*: 1 external calls (now).


##### `Arc::decide`  (lines 274–276)

```
fn decide(&self, req: NetworkPolicyRequest) -> NetworkPolicyDeciderFuture<'_>
```

**Purpose**: Lets a shared `Arc` pointer to a decider act like the decider itself. An `Arc` is a thread-safe shared ownership wrapper, like several workers holding the same instruction sheet.

**Data flow**: It receives a policy request through the shared pointer → forwards the request to the underlying decider → returns a boxed asynchronous future that will produce the decision.

**Call relations**: Policy evaluation accepts an optional shared decider. This adapter lets that shared decider be called through the same `NetworkPolicyDecider` interface as any other decider.

*Call graph*: 1 external calls (pin).


##### `F::decide`  (lines 284–286)

```
fn decide(&self, req: NetworkPolicyRequest) -> NetworkPolicyDeciderFuture<'_>
```

**Purpose**: Lets an ordinary async-capable function or closure be used as a network policy decider. This makes tests and simple integrations easy to write.

**Data flow**: It receives a policy request → calls the function or closure with that request → boxes the resulting asynchronous work → returns a future that resolves to a network decision.

**Call relations**: Tests create small closure-based deciders that allow or ask. This implementation is what lets those closures plug into `evaluate_host_policy` without a custom struct.

*Call graph*: 1 external calls (pin).


##### `evaluate_host_policy`  (lines 289–359)

```
async fn evaluate_host_policy(
    state: &NetworkProxyState,
    decider: Option<&Arc<dyn NetworkPolicyDecider>>,
    request: &NetworkPolicyRequest,
) -> Result<NetworkDecision>
```

**Purpose**: Makes the main allow/deny/ask decision for a destination host and port. It combines the baseline proxy configuration with an optional extra decider and always records an audit event.

**Data flow**: It receives proxy state, an optional decider, and a request → asks the state whether the host and port are blocked → optionally asks the decider when the baseline says `not allowed` → normalizes the result and override flag → emits an audit event → returns the final `NetworkDecision` or an error from the state check.

**Call relations**: HTTP CONNECT, plain HTTP proxying, SOCKS TCP, and SOCKS UDP inspection call this before letting traffic continue. It calls `map_decider_decision` to keep decider results correctly attributed, and `emit_policy_audit_event` so every outcome is recorded.

*Call graph*: calls 4 internal fn (deny_with_source, emit_policy_audit_event, map_decider_decision, host_blocked); called by 5 (http_connect_accept, http_plain_proxy, evaluate_host_policy_still_denies_not_allowed_local_without_decider_override, handle_socks5_tcp, inspect_socks5_udp); 2 external calls (matches!, clone).


##### `map_decider_decision`  (lines 361–372)

```
fn map_decider_decision(decision: NetworkDecision) -> NetworkDecision
```

**Purpose**: Cleans up a decision returned by an external decider so it is always attributed to the decider. This prevents a decider from accidentally or incorrectly claiming another source.

**Data flow**: It receives a `NetworkDecision` → leaves `Allow` unchanged → for any denial or ask, keeps the reason and decision kind but rewrites the source to `Decider` → returns the normalized decision.

**Call relations**: `evaluate_host_policy` uses this immediately after awaiting the optional decider. The normalized result then feeds both the returned decision and the audit event.

*Call graph*: called by 1 (evaluate_host_policy).


##### `test_support::CapturedEvent::field`  (lines 402–404)

```
fn field(&self, name: &str) -> Option<&str>
```

**Purpose**: Looks up one named field from a captured tracing event in tests. It gives tests a simple way to ask, for example, “what was `network.policy.reason`?”

**Data flow**: It receives a field name → searches the event’s stored field map → returns the field text if present, or nothing if missing.

**Call relations**: The test assertions use this helper through `find_event_by_name` results to check that audit events contain the expected values.


##### `test_support::EventCollector::events`  (lines 414–419)

```
fn events(&self) -> Vec<CapturedEvent>
```

**Purpose**: Returns the list of tracing events captured during a test. It clones the stored events so tests can inspect them safely.

**Data flow**: It locks the shared event list with a mutex, which is a lock that prevents two tasks changing the list at once → clones the current list → returns that clone.

**Call relations**: `capture_events` calls this after the tested async code finishes. The returned events are then searched by test helpers and assertions.


##### `test_support::EventCollector::enabled`  (lines 423–425)

```
fn enabled(&self, _metadata: &Metadata<'_>) -> bool
```

**Purpose**: Tells the tracing system that this test collector wants to receive events. In tests it accepts everything.

**Data flow**: It receives tracing metadata → ignores the details → returns `true`.

**Call relations**: The tracing system calls this while deciding whether to send an event to the collector installed by `capture_events`.


##### `test_support::EventCollector::register_callsite`  (lines 427–429)

```
fn register_callsite(&self, _metadata: &'static Metadata<'static>) -> Interest
```

**Purpose**: Tells the tracing system that this collector is interested in a logging location. A callsite is a place in code that can emit tracing data.

**Data flow**: It receives metadata for a callsite → ignores the details → returns an “always interested” response.

**Call relations**: When `capture_events` installs the collector, tracing uses this method so policy audit events are not filtered out during tests.

*Call graph*: 1 external calls (always).


##### `test_support::EventCollector::max_level_hint`  (lines 431–433)

```
fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter>
```

**Purpose**: Reports that the test collector can accept very detailed tracing output. This avoids hiding events because of log level filtering.

**Data flow**: It takes no meaningful input beyond the collector → returns the maximum trace-level hint.

**Call relations**: The tracing system asks this while deciding what events may be enabled. It supports the audit-event tests by keeping the collector permissive.


##### `test_support::EventCollector::new_span`  (lines 435–437)

```
fn new_span(&self, _span: &Attributes<'_>) -> Id
```

**Purpose**: Creates an identifier for a new tracing span during tests. A span is a timed or nested section of work in tracing.

**Data flow**: It increments an atomic counter, which is a thread-safe number → converts the new number into a tracing span ID → returns it.

**Call relations**: The tracing system calls this if code under test creates spans. The collector only needs simple unique IDs so event capture can continue normally.

*Call graph*: 1 external calls (from_u64).


##### `test_support::EventCollector::record`  (lines 439–439)

```
fn record(&self, _span: &Id, _values: &Record<'_>)
```

**Purpose**: Accepts span field updates during tests but deliberately does nothing with them. The tests in this file care about events, not span updates.

**Data flow**: It receives a span ID and recorded values → ignores both → returns nothing.

**Call relations**: The tracing system may call this as part of its subscriber interface. Keeping it as a no-op makes the collector complete without adding unused storage.


##### `test_support::EventCollector::record_follows_from`  (lines 441–441)

```
fn record_follows_from(&self, _span: &Id, _follows: &Id)
```

**Purpose**: Accepts tracing relationship updates during tests but ignores them. These relationships are not needed for checking policy audit events.

**Data flow**: It receives two span IDs → does not store or change anything → returns nothing.

**Call relations**: Tracing calls this for span relationship bookkeeping. The test collector implements it only to satisfy the subscriber contract.


##### `test_support::EventCollector::event`  (lines 443–453)

```
fn event(&self, event: &Event<'_>)
```

**Purpose**: Captures one tracing event during a test. It records the event target and all event fields as strings so assertions can inspect them.

**Data flow**: It receives a tracing event → uses `FieldVisitor` to collect the event’s fields → locks the shared event list → appends a `CapturedEvent` containing the target and fields.

**Call relations**: This is the key method used by `capture_events`. When `emit_policy_audit_event` logs an audit event under test, tracing calls this method and the test can later verify the result.

*Call graph*: 3 external calls (default, metadata, record).


##### `test_support::EventCollector::enter`  (lines 455–455)

```
fn enter(&self, _span: &Id)
```

**Purpose**: Accepts notification that execution entered a tracing span, but ignores it. Span entry is not relevant to these audit-event tests.

**Data flow**: It receives a span ID → makes no changes → returns nothing.

**Call relations**: Tracing calls this through the subscriber interface. The no-op keeps the collector focused only on event capture.


##### `test_support::EventCollector::exit`  (lines 457–457)

```
fn exit(&self, _span: &Id)
```

**Purpose**: Accepts notification that execution left a tracing span, but ignores it. The tests do not need span timing or nesting.

**Data flow**: It receives a span ID → makes no changes → returns nothing.

**Call relations**: Tracing calls this through the subscriber interface. It completes the minimal subscriber behavior needed for tests.


##### `test_support::FieldVisitor::insert`  (lines 466–468)

```
fn insert(&mut self, field: &Field, value: impl Into<String>)
```

**Purpose**: Stores one captured tracing field as text. It is the shared helper used by all the field-type-specific visitor methods.

**Data flow**: It receives a field name and a value that can become a string → converts the value → stores it in the visitor’s field map under that name.

**Call relations**: Every `record_*` method in `FieldVisitor` calls this after converting its particular value type. `EventCollector::event` depends on it to turn tracing fields into easy test data.

*Call graph*: called by 9 (record_bool, record_debug, record_error, record_f64, record_i128, record_i64, record_str, record_u128, record_u64); 2 external calls (name, into).


##### `test_support::FieldVisitor::record_str`  (lines 472–474)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Captures a string field from a tracing event. This covers audit fields that are already text.

**Data flow**: It receives a tracing field and string value → passes them to `insert` → the visitor’s map gains that field.

**Call relations**: Tracing calls this while `EventCollector::event` records an event. It feeds text audit values into the captured event map.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_bool`  (lines 476–478)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Captures a true/false field from a tracing event, such as the policy override flag.

**Data flow**: It receives a field and boolean value → converts the boolean to text → stores it through `insert`.

**Call relations**: Tracing calls this for boolean audit fields. Tests later read the stored string with `CapturedEvent::field`.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_i64`  (lines 480–482)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Captures a signed 64-bit integer tracing field as text. This keeps all captured values in one simple string map.

**Data flow**: It receives a field and integer → converts the integer to text → stores it through `insert`.

**Call relations**: Tracing can call this for signed integer fields during event capture. It is part of the generic field visitor used by the test collector.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_u64`  (lines 484–486)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Captures an unsigned 64-bit integer tracing field as text, such as a port number if recorded that way.

**Data flow**: It receives a field and unsigned integer → converts it to text → stores it through `insert`.

**Call relations**: Tracing calls this when an event field is an unsigned integer. The audit tests then compare the stored text value.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_i128`  (lines 488–490)

```
fn record_i128(&mut self, field: &Field, value: i128)
```

**Purpose**: Captures a large signed integer tracing field as text. It is included so the test visitor can accept many tracing value types.

**Data flow**: It receives a field and 128-bit signed integer → converts it to text → stores it through `insert`.

**Call relations**: Tracing may call this while recording event fields. It supports the same capture path used by `EventCollector::event`.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_u128`  (lines 492–494)

```
fn record_u128(&mut self, field: &Field, value: u128)
```

**Purpose**: Captures a large unsigned integer tracing field as text. This keeps the visitor broad enough for different event field types.

**Data flow**: It receives a field and 128-bit unsigned integer → converts it to text → stores it through `insert`.

**Call relations**: Tracing may call this during event recording. It feeds the common captured-field map used by assertions.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_f64`  (lines 496–498)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Captures a floating-point tracing field as text. The audit tests mostly use strings and integers, but this keeps the collector general.

**Data flow**: It receives a field and decimal number → converts it to text → stores it through `insert`.

**Call relations**: Tracing calls this for floating-point fields. It uses the same storage path as all other field types.

*Call graph*: calls 1 internal fn (insert).


##### `test_support::FieldVisitor::record_error`  (lines 500–502)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Captures an error-valued tracing field as its message text. This lets tests inspect errors if an event includes one.

**Data flow**: It receives a field and error object → converts the error to a string → stores it through `insert`.

**Call relations**: Tracing calls this when recording error fields. The event collector then keeps the message alongside other captured fields.

*Call graph*: calls 1 internal fn (insert); 1 external calls (to_string).


##### `test_support::FieldVisitor::record_debug`  (lines 504–506)

```
fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug)
```

**Purpose**: Captures a tracing field that is only available through debug formatting. Debug formatting is a programmer-readable text representation.

**Data flow**: It receives a field and debug-printable value → formats it with debug syntax → stores it through `insert`.

**Call relations**: Tracing uses this fallback for values without a more specific recording method. It ensures `EventCollector::event` still captures those fields.

*Call graph*: calls 1 internal fn (insert); 1 external calls (format!).


##### `test_support::capture_events`  (lines 509–519)

```
async fn capture_events(f: F) -> (T, Vec<CapturedEvent>)
```

**Purpose**: Runs an async test action while capturing all tracing events it emits. It is a small test harness for checking audit logging.

**Data flow**: It receives a function that creates async work → installs an `EventCollector` as the current tracing subscriber → awaits the work → collects captured events → returns both the work’s output and the events.

**Call relations**: The audit tests wrap calls to `evaluate_host_policy` and audit emitters with this helper. They then search the returned events to verify the log contents.

*Call graph*: 2 external calls (default, set_default).


##### `test_support::find_event_by_name`  (lines 521–528)

```
fn find_event_by_name(
        events: &'a [CapturedEvent],
        event_name: &str,
    ) -> Option<&'a CapturedEvent>
```

**Purpose**: Finds the first captured event with a specific `event.name` field. This helps tests ignore unrelated tracing events.

**Data flow**: It receives a slice of captured events and a desired event name → scans the events in order → returns the matching event if one exists.

**Call relations**: Tests call this after `capture_events` to locate the policy decision audit event before checking its individual fields.

*Call graph*: 1 external calls (iter).


##### `tests::StaticReloader::maybe_reload`  (lines 565–567)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Provides a test-only config reloader that never reports a background configuration change. This keeps tests stable and predictable.

**Data flow**: It receives the test reloader → returns an async result saying there is no new config state.

**Call relations**: `state_with_metadata` uses `StaticReloader` when constructing proxy state for metadata tests. The proxy state can call this method without changing the test configuration.

*Call graph*: 1 external calls (pin).


##### `tests::StaticReloader::reload_now`  (lines 569–571)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Returns the fixed test configuration immediately when a forced reload is requested. It mimics a real reloader without reading files or external state.

**Data flow**: It receives the reloader → clones its stored config state → returns that clone in an async success result.

**Call relations**: The proxy state built in `state_with_metadata` depends on a reloader implementation. This method satisfies the reload path while keeping tests fully in memory.

*Call graph*: 2 external calls (pin, clone).


##### `tests::StaticReloader::source_label`  (lines 573–575)

```
fn source_label(&self) -> String
```

**Purpose**: Names the test reloader for messages or diagnostics. The label makes it clear that the configuration source is fake and static.

**Data flow**: It receives the reloader → returns the fixed text `static test reloader`.

**Call relations**: This completes the `ConfigReloader` behavior needed by test proxy state. It may be used if the state reports where its configuration came from.


##### `tests::state_with_metadata`  (lines 578–590)

```
fn state_with_metadata(metadata: NetworkProxyAuditMetadata) -> NetworkProxyState
```

**Purpose**: Builds a proxy state for tests that includes specific audit metadata. This lets tests prove that user, app, and session details are copied into audit events.

**Data flow**: It receives metadata → creates a full-mode enabled network config → builds config state → wraps it in a static test reloader → returns `NetworkProxyState` containing both config and metadata.

**Call relations**: The metadata audit test calls this before running `evaluate_host_policy`. The resulting state supplies metadata to `emit_policy_audit_event`.

*Call graph*: calls 3 internal fn (default, with_reloader_and_audit_metadata, build_config_state); 2 external calls (new, default).


##### `tests::is_rfc3339_utc_millis`  (lines 592–608)

```
fn is_rfc3339_utc_millis(timestamp: &str) -> bool
```

**Purpose**: Checks whether a timestamp has the exact UTC millisecond format expected in audit logs. It is a lightweight format check used by tests.

**Data flow**: It receives timestamp text → checks length, separator positions, final `Z`, and digit positions → returns true if the shape matches and false otherwise.

**Call relations**: The decider-allow audit test uses this to verify that `audit_timestamp` produced a timestamp format audit consumers can rely on.


##### `tests::evaluate_host_policy_emits_domain_event_for_decider_allow_override`  (lines 611–675)

```
async fn evaluate_host_policy_emits_domain_event_for_decider_allow_override()
```

**Purpose**: Tests the case where baseline policy blocks a host but the optional decider allows it. It proves that the returned decision is allow and the audit event marks it as a decider override.

**Data flow**: It builds default proxy state and a counting decider → creates an HTTP request → captures events while evaluating policy → checks the decision, decider call count, audit fields, timestamp format, and absence of old event names.

**Call relations**: This test exercises `NetworkPolicyRequest::new`, the closure-based decider adapter, `evaluate_host_policy`, and the test event-capture helpers together.

*Call graph*: calls 2 internal fn (default, new); 7 external calls (new, new, assert!, assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_emits_domain_event_for_baseline_deny`  (lines 678–721)

```
async fn evaluate_host_policy_emits_domain_event_for_baseline_deny()
```

**Purpose**: Tests a straightforward baseline-policy denial for a blocked domain. It confirms that no decider is needed and the audit event names the baseline policy as the source.

**Data flow**: It builds settings with allowed and denied domains → creates a request to the denied domain with method and client address → captures policy evaluation → checks the deny result and audit fields.

**Call relations**: This test focuses on the baseline branch inside `evaluate_host_policy` and verifies the audit event found through `find_event_by_name`.

*Call graph*: calls 2 internal fn (default, new); 5 external calls (assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name, vec!).


##### `tests::evaluate_host_policy_emits_domain_event_for_decider_ask`  (lines 724–762)

```
async fn evaluate_host_policy_emits_domain_event_for_decider_ask()
```

**Purpose**: Tests the case where the optional decider responds with `ask` instead of allow or hard deny. It ensures the audit event records the decision as `ask` and source as `decider`.

**Data flow**: It creates default proxy state, a closure decider returning `NetworkDecision::ask`, and a request → captures policy evaluation → checks the returned ask-shaped denial and matching audit fields.

**Call relations**: This test exercises the decider path in `evaluate_host_policy`, the `NetworkDecision::ask` helper, and the event capture/search helpers.

*Call graph*: calls 2 internal fn (default, new); 5 external calls (new, assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_emits_metadata_fields`  (lines 765–806)

```
async fn evaluate_host_policy_emits_metadata_fields()
```

**Purpose**: Tests that audit events include the extra metadata stored in proxy state, such as conversation ID, app version, user account, terminal, and model.

**Data flow**: It builds a metadata-filled proxy state → creates a request → captures policy evaluation → finds the audit event → checks each metadata field.

**Call relations**: This test uses `state_with_metadata` to feed metadata into `emit_policy_audit_event` through `evaluate_host_policy`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, capture_events, find_event_by_name, state_with_metadata).


##### `tests::emit_block_decision_audit_event_emits_non_domain_event`  (lines 809–854)

```
async fn emit_block_decision_audit_event_emits_non_domain_event()
```

**Purpose**: Tests that a non-domain block writes the same policy decision event shape with scope `non_domain`. It covers blocks such as method restrictions rather than host allow-list checks.

**Data flow**: It builds proxy state → captures a direct call to `emit_block_decision_audit_event` → finds the audit event → checks target, scope, deny decision, source, reason, protocol, address, method, defaults, and absence of the old event name.

**Call relations**: This test exercises `emit_block_decision_audit_event`, its shared non-domain helper, and the central audit emitter without going through host policy evaluation.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert_eq!, network_proxy_state_for_policy, capture_events, find_event_by_name).


##### `tests::evaluate_host_policy_still_denies_not_allowed_local_without_decider_override`  (lines 857–885)

```
async fn evaluate_host_policy_still_denies_not_allowed_local_without_decider_override()
```

**Purpose**: Tests that local network access remains denied when local binding is disabled and no decider override is present. This protects a stricter local-network safety rule.

**Data flow**: It builds settings that allow only `example.com` and disallow local binding → creates a request to `127.0.0.1` → evaluates policy without a decider → checks that the result is a baseline denial for local-not-allowed.

**Call relations**: This test directly calls `evaluate_host_policy` and verifies the branch for a baseline block reason other than the decider-overridable `not allowed` case.

*Call graph*: calls 3 internal fn (default, new, evaluate_host_policy); 3 external calls (assert_eq!, network_proxy_state_for_policy, vec!).


##### `tests::ask_uses_decider_source_and_ask_decision`  (lines 888–897)

```
fn ask_uses_decider_source_and_ask_decision()
```

**Purpose**: Tests the small `NetworkDecision::ask` constructor. It ensures an ask result is represented as a denied request with source `Decider` and decision kind `Ask`.

**Data flow**: It calls `NetworkDecision::ask` with a reason → compares the returned value to the exact expected `Deny` structure.

**Call relations**: This unit test protects the helper used by deciders and by the decider-ask policy evaluation test.

*Call graph*: 1 external calls (assert_eq!).


### `network-proxy/src/runtime.rs`

`domain_logic` · `cross-cutting: active during startup setup, config reloads, and every proxy request policy check`

The proxy needs to make fast, consistent safety decisions while the program is running: “Can this request go out?”, “Was this host explicitly denied?”, “Is this local network access?”, and “What should we remember when we block something?” This file keeps the current network policy in a shared state object, so many proxy tasks can read it safely at the same time, while updates use a lock to avoid half-written rules.

The main type, `NetworkProxyState`, is like a security desk. Before answering most questions it asks its `ConfigReloader` whether the rulebook has changed. It then checks allowlists and denylists, blocks local or private addresses unless explicitly allowed, checks HTTP method limits, and exposes MITM state and hooks. When a request is blocked, it stores a small rolling history and emits a structured log line that other systems can search for.

The file also includes careful behavior around risky cases. A deny rule wins over an allow rule. Local/private network access is checked using both the written host and a short DNS lookup, because a normal-looking name can point to a private address. Unix socket permissions are only supported on macOS here, and only absolute paths are accepted. The large test module documents these edge cases so future changes do not accidentally weaken the policy.

#### Function details

##### `HostBlockReason::as_str`  (lines 68–74)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a block reason into the short text code used in logs and blocked-request records. This keeps the public reason strings consistent everywhere.

**Data flow**: It receives one `HostBlockReason` value, matches it to the corresponding constant string, and returns that string without changing anything else.

**Call relations**: The display formatter calls this when a block reason needs to be printed, so user-facing and log-facing text both come from the same mapping.

*Call graph*: called by 1 (fmt).


##### `HostBlockReason::fmt`  (lines 78–80)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Lets a block reason be printed as plain text. This is used when the reason needs to appear in logs, messages, or formatted strings.

**Data flow**: It receives a formatter and the reason value, asks `as_str` for the reason text, then writes that text into the formatter.

**Call relations**: It is the standard Rust display path for `HostBlockReason`, and it delegates the actual wording to `HostBlockReason::as_str`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `BlockedRequest::new`  (lines 119–143)

```
fn new(args: BlockedRequestArgs) -> Self
```

**Purpose**: Builds a complete blocked-request record from the details known at the blocking point. It automatically stamps the event with the current time.

**Data flow**: It receives host, reason, client, method, mode, protocol, decision source, port, and related details. It copies those into a `BlockedRequest` and adds a Unix timestamp, then returns the finished record.

**Call relations**: Proxy code calls this when a request is denied, including HTTP, CONNECT, SOCKS, proxy-disabled, and MITM-policy paths. It calls `unix_timestamp` so callers do not need to supply the time themselves.

*Call graph*: calls 1 internal fn (unix_timestamp); called by 9 (denied_blocked_request, http_connect_accept, http_plain_proxy, proxy_disabled_response, evaluate_mitm_policy, blocked_snapshot_does_not_consume_entries, drain_blocked_returns_buffered_window, handle_socks5_tcp, inspect_socks5_udp).


##### `blocked_request_violation_log_line`  (lines 146–157)

```
fn blocked_request_violation_log_line(entry: &BlockedRequest) -> String
```

**Purpose**: Creates the searchable log line for a blocked network request. The prefix makes policy violations easy to find in logs.

**Data flow**: It receives a blocked-request entry, tries to turn it into JSON, and returns a string beginning with `CODEX_NETWORK_POLICY_VIOLATION`. If JSON serialization fails, it falls back to a simpler host-and-reason message.

**Call relations**: `NetworkProxyState::record_blocked` calls this after saving a blocked event, so every recorded violation also gets a structured log message.

*Call graph*: called by 1 (record_blocked); 3 external calls (debug!, format!, to_string).


##### `Arc::on_blocked_request`  (lines 191–193)

```
fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_>
```

**Purpose**: Allows a shared observer wrapped in `Arc` to be used wherever a blocked-request observer is expected. `Arc` is a shared ownership pointer used when several tasks need the same object.

**Data flow**: It receives a blocked request, forwards it to the observer inside the `Arc`, and returns a future that completes when the observer finishes.

**Call relations**: This adapter lets `NetworkProxyState::record_blocked` notify observers without caring whether the observer is stored directly or inside shared ownership.

*Call graph*: 1 external calls (pin).


##### `F::on_blocked_request`  (lines 201–203)

```
fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_>
```

**Purpose**: Allows a plain async function or closure to act as a blocked-request observer. This makes tests and integrations easier to write.

**Data flow**: It receives a blocked request, calls the function with that request, boxes the resulting future, and returns it.

**Call relations**: This adapter supports the observer hook used by `NetworkProxyState::record_blocked`, so callers can plug in simple callback functions instead of defining a full type.

*Call graph*: 1 external calls (pin).


##### `NetworkProxyState::fmt`  (lines 214–218)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug printout for the proxy state. It intentionally avoids dumping config details that may be noisy or sensitive.

**Data flow**: It receives a formatter and writes only a non-exhaustive `NetworkProxyState` debug structure, with no internal fields.

**Call relations**: This is used by Rust debug formatting when someone logs or inspects `NetworkProxyState`; it avoids exposing the stored config, glob patterns, or paths.

*Call graph*: 1 external calls (debug_struct).


##### `NetworkProxyState::clone`  (lines 222–229)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another handle to the same live proxy state. This lets multiple request-handling tasks share one policy view.

**Data flow**: It receives an existing state handle, clones the shared pointers and audit metadata, and returns a new `NetworkProxyState` pointing at the same underlying locks and reloader.

**Call relations**: Runtime code can pass cloned state into concurrent tasks. The clone does not copy the whole policy store; it shares it so updates are seen by all users.

*Call graph*: 1 external calls (clone).


##### `NetworkProxyState::with_reloader`  (lines 233–239)

```
fn with_reloader(state: ConfigState, reloader: Arc<dyn ConfigReloader>) -> Self
```

**Purpose**: Builds a proxy state from an initial config state and a config reloader. It uses empty audit metadata and no blocked-request observer.

**Data flow**: It receives compiled config state and a reloader, adds default audit metadata, and returns a ready-to-share `NetworkProxyState`.

**Call relations**: Startup and tests use this simple constructor. It forwards to the fuller constructor that accepts audit metadata and observers.

*Call graph*: called by 8 (build_network_proxy_state, test_network_proxy, network_proxy_state_for_policy, add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed, add_allowed_domain_succeeds_when_managed_baseline_allows_expansion, add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed, state_for_settings, create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths); 2 external calls (with_reloader_and_audit_metadata, default).


##### `NetworkProxyState::with_reloader_and_blocked_observer`  (lines 241–252)

```
fn with_reloader_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    ) -> Self
```

**Purpose**: Builds a proxy state with a callback for blocked requests. This is useful when another part of the program wants to hear about blocks as they happen.

**Data flow**: It receives compiled state, a reloader, and an optional observer, adds default audit metadata, and returns the shared state object.

**Call relations**: It is a convenience wrapper around the most complete constructor, used when blocked-request notification matters but audit metadata does not.

*Call graph*: 2 external calls (with_reloader_and_audit_metadata_and_blocked_observer, default).


##### `NetworkProxyState::with_reloader_and_audit_metadata`  (lines 254–265)

```
fn with_reloader_and_audit_metadata(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
    ) -> Self
```

**Purpose**: Builds a proxy state that carries audit metadata such as conversation or user context. That metadata can later be attached to audit events.

**Data flow**: It receives compiled state, a reloader, and audit metadata, sets no blocked-request observer, and returns the shared state object.

**Call relations**: Audit-aware setup code calls this. It forwards to the constructor that accepts both audit metadata and an observer.

*Call graph*: called by 2 (build_state_with_audit_metadata, state_with_metadata); 1 external calls (with_reloader_and_audit_metadata_and_blocked_observer).


##### `NetworkProxyState::with_reloader_and_audit_metadata_and_blocked_observer`  (lines 267–279)

```
fn with_reloader_and_audit_metadata_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
        blocked_requ
```

**Purpose**: Builds the full live proxy state object with all optional pieces supplied. This is the central constructor used by the simpler ones.

**Data flow**: It receives compiled config state, a reloader, audit metadata, and an optional observer. It wraps mutable pieces in shared asynchronous locks and returns a `NetworkProxyState`.

**Call relations**: All constructor variants lead here. The resulting object is what request paths use for live policy checks and block recording.

*Call graph*: 2 external calls (new, new).


##### `NetworkProxyState::set_blocked_request_observer`  (lines 281–287)

```
async fn set_blocked_request_observer(
        &self,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    )
```

**Purpose**: Changes the callback that is notified when requests are blocked. This lets the program attach or remove telemetry listeners while running.

**Data flow**: It receives an optional observer, takes the write lock for the observer slot, and replaces the old observer with the new one.

**Call relations**: Later, `NetworkProxyState::record_blocked` reads this observer slot and calls the observer if one is present.


##### `NetworkProxyState::audit_metadata`  (lines 289–291)

```
fn audit_metadata(&self) -> &NetworkProxyAuditMetadata
```

**Purpose**: Returns the audit context stored with this proxy state. Other code can use it when writing policy audit events.

**Data flow**: It reads the immutable metadata field and returns a reference to it without changing state.

**Call relations**: Audit event code calls this when it needs to enrich a policy event with conversation, user, model, or origin information.

*Call graph*: called by 1 (emit_policy_audit_event).


##### `NetworkProxyState::current_cfg`  (lines 293–299)

```
async fn current_cfg(&self) -> Result<NetworkProxyConfig>
```

**Purpose**: Returns the current network proxy configuration. It first checks for a config reload so callers see the latest rulebook.

**Data flow**: It asks the reloader for updates, reads the shared state, clones the config, and returns that clone.

**Call relations**: Administrative or status paths call this when they need the whole current config. It relies on `reload_if_needed` to keep the answer fresh.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::current_patterns`  (lines 301–308)

```
async fn current_patterns(&self) -> Result<(Vec<String>, Vec<String>)>
```

**Purpose**: Returns the current allowed and denied domain patterns. This is useful for showing or inspecting the active allowlist and denylist.

**Data flow**: It reloads if needed, reads the config, extracts allowed and denied domain lists, substitutes empty lists when absent, and returns both lists.

**Call relations**: Tests and callers that update lists use this to confirm what policy is currently active.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::enabled`  (lines 310–314)

```
async fn enabled(&self) -> Result<bool>
```

**Purpose**: Reports whether the network proxy policy is enabled. This lets request paths know whether policy enforcement should be active.

**Data flow**: It reloads if needed, reads the `enabled` flag from the current config, and returns it.

**Call relations**: Runtime callers use this as a quick policy status check, with freshness supplied by `reload_if_needed`.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::force_reload`  (lines 316–342)

```
async fn force_reload(&self) -> Result<()>
```

**Purpose**: Forces the config to reload even if no change was detected. This is useful after an explicit user or system action.

**Data flow**: It saves the previous config, asks the reloader for a fresh state, logs allowlist and denylist changes, preserves the blocked-request buffer, and replaces the shared state. If reload fails, it keeps the old config and returns the error.

**Call relations**: Manual reload paths call this. It uses `log_policy_changes` so sensitive policy changes are visible without dumping the entire config.

*Call graph*: calls 1 internal fn (log_policy_changes); 2 external calls (info!, warn!).


##### `NetworkProxyState::replace_config_state`  (lines 344–353)

```
async fn replace_config_state(&self, mut new_state: ConfigState) -> Result<()>
```

**Purpose**: Replaces the live compiled config state with a supplied one. It preserves blocked-request history while applying new policy data.

**Data flow**: It reloads first, takes the write lock, logs policy differences, copies over the old blocked-event buffer and count, then stores the new state.

**Call relations**: Code that has already built a new `ConfigState` uses this to install it safely. It shares logging behavior with reload and list-update paths.

*Call graph*: calls 2 internal fn (reload_if_needed, log_policy_changes); 1 external calls (info!).


##### `NetworkProxyState::host_blocked`  (lines 355–430)

```
async fn host_blocked(&self, host: &str, port: u16) -> Result<HostBlockDecision>
```

**Purpose**: Decides whether a host and port should be allowed or blocked. This is the main network destination safety check.

**Data flow**: It reloads policy, parses and normalizes the host, checks the denylist first, then checks whether local/private access is allowed, including a DNS lookup for hostnames. Finally it checks whether the allowlist is configured and matched, and returns either `Allowed` or a specific block reason.

**Call relations**: The host-policy evaluator calls this during request handling. It uses helpers for glob matching, local-address detection, DNS-based private-address checks, and explicit local allowlist checks.

*Call graph*: calls 8 internal fn (parse, is_loopback_host, is_non_public_ip, unscoped_ip_literal, reload_if_needed, globset_matches_host_or_unscoped, host_resolves_to_non_public_ip, is_explicit_local_allowlisted); called by 1 (evaluate_host_policy); 1 external calls (Blocked).


##### `NetworkProxyState::record_blocked`  (lines 432–465)

```
async fn record_blocked(&self, entry: BlockedRequest) -> Result<()>
```

**Purpose**: Records that a request was blocked and notifies observers. This creates both an in-memory recent history and a log trail.

**Data flow**: It reloads policy, copies the entry for any observer, formats a violation log line, appends the entry to the rolling buffer, increments the total counter, trims old entries beyond the limit, logs details, and calls the observer if present.

**Call relations**: Blocking paths call this after making a deny decision, such as the proxy-disabled response path. It uses `blocked_request_violation_log_line` for the structured log message.

*Call graph*: calls 2 internal fn (reload_if_needed, blocked_request_violation_log_line); called by 1 (proxy_disabled_response); 2 external calls (debug!, clone).


##### `NetworkProxyState::blocked_snapshot`  (lines 469–473)

```
async fn blocked_snapshot(&self) -> Result<Vec<BlockedRequest>>
```

**Purpose**: Returns the current buffered blocked-request entries without clearing them. This is like looking at the recent incident log without taking it away.

**Data flow**: It reloads if needed, reads the blocked-event queue, clones each entry into a vector, and returns the vector.

**Call relations**: Status or telemetry code can call this to inspect recent blocked events. Tests verify that a later drain still returns the same entries.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::drain_blocked`  (lines 476–483)

```
async fn drain_blocked(&self) -> Result<Vec<BlockedRequest>>
```

**Purpose**: Returns and clears the buffered blocked-request entries. This is useful for consumers that periodically collect and reset the recent log.

**Data flow**: It reloads if needed, takes the write lock, replaces the queue with an empty one, converts the old queue into a vector, and returns it.

**Call relations**: Telemetry collection can call this when it wants each buffered event once. It shares the same rolling buffer filled by `record_blocked`.

*Call graph*: calls 1 internal fn (reload_if_needed); 1 external calls (take).


##### `NetworkProxyState::is_unix_socket_allowed`  (lines 485–535)

```
async fn is_unix_socket_allowed(&self, path: &str) -> Result<bool>
```

**Purpose**: Checks whether a Unix socket path is allowed by policy. Unix sockets are local file-like connection endpoints, so allowing them can bypass normal host checks if not controlled.

**Data flow**: It reloads policy, rejects unsupported platforms and relative paths, allows all only if the dangerous all-sockets flag is set, then compares the requested absolute path against configured allowed socket paths. It also tries canonical path comparison to handle symlinks.

**Call relations**: HTTP proxy and startup logic call this when Unix socket proxying is requested. It uses `unix_socket_permissions_supported` and validates configured socket paths before trusting them.

*Call graph*: calls 4 internal fn (parse, reload_if_needed, unix_socket_permissions_supported, from_absolute_path); 3 external calls (new, canonicalize, warn!).


##### `NetworkProxyState::method_allowed`  (lines 537–541)

```
async fn method_allowed(&self, method: &str) -> Result<bool>
```

**Purpose**: Checks whether the current network mode permits an HTTP method such as GET, POST, or CONNECT. This limits what kinds of network actions are possible.

**Data flow**: It reloads policy, reads the network mode, asks that mode whether the method is allowed, and returns a boolean.

**Call relations**: Request-handling code calls this before forwarding HTTP traffic, so mode settings are enforced per request.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::allow_upstream_proxy`  (lines 543–547)

```
async fn allow_upstream_proxy(&self) -> Result<bool>
```

**Purpose**: Reports whether the proxy may use an upstream proxy. An upstream proxy is another proxy that this proxy forwards through.

**Data flow**: It reloads policy, reads the `allow_upstream_proxy` flag, and returns it.

**Call relations**: Connection setup code can call this before honoring upstream proxy settings from the environment or configuration.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::allow_local_binding`  (lines 549–553)

```
async fn allow_local_binding(&self) -> Result<bool>
```

**Purpose**: Reports whether local/private network binding or access is allowed by policy. This flag affects protections around localhost and private IP ranges.

**Data flow**: It reloads policy, reads the `allow_local_binding` flag, and returns it.

**Call relations**: Runtime code uses this for decisions that need to know whether local networking is permitted.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::network_mode`  (lines 555–559)

```
async fn network_mode(&self) -> Result<NetworkMode>
```

**Purpose**: Returns the current network mode. The mode controls the broad level of network capability.

**Data flow**: It reloads policy, reads the mode from the config, and returns it.

**Call relations**: Request and UI/status paths call this when they need the current mode, with `reload_if_needed` keeping it current.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::set_network_mode`  (lines 561–584)

```
async fn set_network_mode(&self, mode: NetworkMode) -> Result<()>
```

**Purpose**: Changes the live network mode if managed constraints allow it. Managed constraints are rules supplied by an administrator or controlling system.

**Data flow**: It repeatedly reloads, builds a candidate config with the new mode, validates it against constraints, then writes the mode if constraints did not change meanwhile. If constraints changed during the attempt, it retries.

**Call relations**: Control paths call this to adjust the mode. It uses `validate_policy_against_constraints` to avoid overriding managed policy.

*Call graph*: calls 2 internal fn (reload_if_needed, validate_policy_against_constraints); 1 external calls (info!).


##### `NetworkProxyState::mitm_state`  (lines 586–590)

```
async fn mitm_state(&self) -> Result<Option<Arc<MitmState>>>
```

**Purpose**: Returns the current MITM state, if configured. MITM means “man in the middle,” here referring to the proxy’s ability to inspect or modify TLS traffic when explicitly set up.

**Data flow**: It reloads policy, reads the optional MITM state, clones the shared pointer if present, and returns it.

**Call relations**: TLS interception code calls this when deciding whether it has the needed MITM material.

*Call graph*: calls 1 internal fn (reload_if_needed).


##### `NetworkProxyState::evaluate_mitm_hook_request`  (lines 592–600)

```
async fn evaluate_mitm_hook_request(
        &self,
        host: &str,
        req: &rama_http::Request,
    ) -> Result<HookEvaluation>
```

**Purpose**: Evaluates configured MITM hooks for a specific host and HTTP request. Hooks are custom rules that can inspect a request and decide special behavior.

**Data flow**: It reloads policy, reads the compiled hook table, passes the host and request into the hook evaluator, and returns the evaluation result.

**Call relations**: MITM request handling calls this during intercepted traffic processing. It delegates the hook matching and decision logic to `evaluate_mitm_hooks`.

*Call graph*: calls 2 internal fn (evaluate_mitm_hooks, reload_if_needed).


##### `NetworkProxyState::host_has_mitm_hooks`  (lines 602–606)

```
async fn host_has_mitm_hooks(&self, host: &str) -> Result<bool>
```

**Purpose**: Checks whether a host has any MITM hooks configured. This lets the proxy avoid extra MITM work when there are no relevant hooks.

**Data flow**: It reloads policy, normalizes the host name, checks whether the hook map contains that normalized host, and returns a boolean.

**Call relations**: CONNECT or TLS handling can call this before deciding whether hook-driven interception might be needed.

*Call graph*: calls 2 internal fn (normalize_host, reload_if_needed).


##### `NetworkProxyState::add_allowed_domain`  (lines 608–610)

```
async fn add_allowed_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the allowlist. This is used when policy should permit a destination that was not previously allowed.

**Data flow**: It receives a host string and calls the shared domain-list update routine with the allowlist target.

**Call relations**: User or decision flows call this to expand allowed destinations. The real validation and state replacement happen in `update_domain_list`.

*Call graph*: calls 1 internal fn (update_domain_list).


##### `NetworkProxyState::add_denied_domain`  (lines 612–614)

```
async fn add_denied_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the denylist. This is used when policy should explicitly block a destination.

**Data flow**: It receives a host string and calls the shared domain-list update routine with the denylist target.

**Call relations**: User or policy flows call this to block destinations. It relies on `update_domain_list` so allowlist and denylist updates follow the same safety checks.

*Call graph*: calls 1 internal fn (update_domain_list).


##### `NetworkProxyState::update_domain_list`  (lines 616–673)

```
async fn update_domain_list(&self, host: &str, target: DomainListKind) -> Result<()>
```

**Purpose**: Safely updates either the allowlist or denylist. It normalizes the host, removes conflicting entries from the opposite list, honors managed constraints, and rebuilds compiled matching state.

**Data flow**: It parses the host, reloads policy, copies the current config and blocked history, edits a candidate config, validates it against constraints, rebuilds `ConfigState`, and writes it only if the config and constraints have not changed during the process. If they changed, it retries.

**Call relations**: `add_allowed_domain` and `add_denied_domain` both call this. It uses `DomainListKind` helpers to know which list to edit, and `log_policy_changes` to record the resulting policy diff.

*Call graph*: calls 10 internal fn (parse, constraint_field, entries, list_name, opposite_entries, permission, reload_if_needed, log_policy_changes, build_config_state, validate_policy_against_constraints); called by 2 (add_allowed_domain, add_denied_domain); 1 external calls (info!).


##### `NetworkProxyState::reload_if_needed`  (lines 675–699)

```
async fn reload_if_needed(&self) -> Result<()>
```

**Purpose**: Keeps the live policy up to date by asking the reloader whether a new compiled state is available. Most public methods call this before answering.

**Data flow**: It asks `maybe_reload` for an optional new state. If there is one, it logs policy changes, preserves blocked-request history and totals, replaces the shared state, and logs the reload source.

**Call relations**: This is the freshness step used by host checks, method checks, snapshots, MITM checks, config reads, and update operations.

*Call graph*: calls 1 internal fn (log_policy_changes); called by 18 (allow_local_binding, allow_upstream_proxy, blocked_snapshot, current_cfg, current_patterns, drain_blocked, enabled, evaluate_mitm_hook_request, host_blocked, host_has_mitm_hooks (+8 more)); 1 external calls (info!).


##### `DomainListKind::list_name`  (lines 709–714)

```
fn list_name(self) -> &'static str
```

**Purpose**: Returns a human-readable name for the domain list being updated. It is used in logs and error context.

**Data flow**: It receives either the allow or deny variant and returns `allowlist` or `denylist`.

**Call relations**: `update_domain_list` calls this when reporting which list was updated or failed to compile.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::constraint_field`  (lines 716–721)

```
fn constraint_field(self) -> &'static str
```

**Purpose**: Returns the managed-config field name for the selected list. This makes constraint errors point to the exact policy field.

**Data flow**: It receives the allow or deny variant and returns the matching config path string.

**Call relations**: `update_domain_list` uses this string when validation fails because administrator-managed policy forbids the change.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::permission`  (lines 723–728)

```
fn permission(self) -> NetworkDomainPermission
```

**Purpose**: Returns the permission value that corresponds to the selected list. Allowlist updates use allow permission; denylist updates use deny permission.

**Data flow**: It receives the list kind and returns a `NetworkDomainPermission` value.

**Call relations**: `update_domain_list` uses this when inserting or replacing the normalized host permission in the candidate config.

*Call graph*: called by 1 (update_domain_list).


##### `DomainListKind::entries`  (lines 730–735)

```
fn entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String>
```

**Purpose**: Reads the entries from the selected domain list. This lets shared update code work for both allow and deny lists.

**Data flow**: It receives a network settings object, extracts either allowed or denied domains, and returns an empty list if none are configured.

**Call relations**: `update_domain_list` uses this to check whether the target list already contains the host.

*Call graph*: calls 2 internal fn (allowed_domains, denied_domains); called by 1 (update_domain_list).


##### `DomainListKind::opposite_entries`  (lines 737–742)

```
fn opposite_entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String>
```

**Purpose**: Reads the entries from the list opposite the one being edited. This helps remove conflicts, such as allowing a host that was denied.

**Data flow**: It receives network settings, extracts the other domain list, and returns an empty list if none are configured.

**Call relations**: `update_domain_list` uses this to decide whether a no-op is truly safe or whether the opposite list still needs cleanup.

*Call graph*: calls 2 internal fn (allowed_domains, denied_domains); called by 1 (update_domain_list).


##### `unix_socket_permissions_supported`  (lines 745–747)

```
fn unix_socket_permissions_supported() -> bool
```

**Purpose**: Reports whether this build supports Unix socket permission checks. In this file, that support is limited to macOS.

**Data flow**: It reads the compile-time target operating system and returns true only for macOS.

**Call relations**: Runtime and proxy paths call this before allowing Unix socket proxy behavior; `is_unix_socket_allowed` uses it as the first gate.

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

**Purpose**: Checks whether a host points to a local or private IP address. This protects against names that look public but resolve to internal networks.

**Data flow**: It first handles direct IP literals. For hostnames, it runs a DNS lookup with a timeout. If lookup fails or times out, it returns true to block safely; if any resolved address is non-public, it also returns true; otherwise it returns false.

**Call relations**: `host_blocked` calls this when local binding is disabled. Tests call it with fake lookup functions to cover timeout, error, private, and public cases.

*Call graph*: calls 1 internal fn (is_non_public_ip); called by 5 (host_blocked, host_resolves_to_non_public_ip_allows_public_resolution, host_resolves_to_non_public_ip_blocks_on_dns_lookup_error, host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout, host_resolves_to_non_public_ip_blocks_private_resolution); 2 external calls (debug!, timeout).


##### `log_policy_changes`  (lines 790–801)

```
fn log_policy_changes(previous: &NetworkProxyConfig, next: &NetworkProxyConfig)
```

**Purpose**: Logs changes to the allowlist and denylist between two configs. This makes policy edits traceable without printing the full config.

**Data flow**: It extracts previous and next allowed domains, then previous and next denied domains, and passes each pair to `log_domain_list_changes`.

**Call relations**: Reload, forced reload, config replacement, and domain-list update paths call this whenever policy may have changed.

*Call graph*: calls 1 internal fn (log_domain_list_changes); called by 4 (force_reload, reload_if_needed, replace_config_state, update_domain_list).


##### `log_domain_list_changes`  (lines 803–837)

```
fn log_domain_list_changes(list_name: &str, previous: &[String], next: &[String])
```

**Purpose**: Logs which domain entries were added to or removed from one list. It compares case-insensitively while preserving the original spelling in log messages.

**Data flow**: It receives a list name and two string lists, builds lowercase sets, finds added and removed entries, then logs each unique addition and removal in list order.

**Call relations**: `log_policy_changes` calls this once for the allowlist and once for the denylist.

*Call graph*: called by 1 (log_policy_changes); 2 external calls (new, info!).


##### `globset_matches_host_or_unscoped`  (lines 839–841)

```
fn globset_matches_host_or_unscoped(set: &GlobSet, host: &str) -> bool
```

**Purpose**: Checks whether a compiled pattern set matches a host, including an IPv6 address without its scope label. A scope label names a local network interface, such as `%eth0`.

**Data flow**: It receives a `GlobSet` and host string, tests the host directly, then tests the unscoped IP form if one exists, and returns whether either matched.

**Call relations**: `host_blocked` uses this for both denylist and allowlist matching, so scoped IP literals are treated consistently.

*Call graph*: calls 1 internal fn (unscoped_ip_literal); called by 1 (host_blocked); 1 external calls (is_match).


##### `is_explicit_local_allowlisted`  (lines 843–858)

```
fn is_explicit_local_allowlisted(allowed_domains: &[String], host: &Host) -> bool
```

**Purpose**: Decides whether a local or private host was explicitly allowlisted. It deliberately rejects wildcard matches for this special local-network exception.

**Data flow**: It receives allowed-domain patterns and a parsed host, normalizes exact patterns, compares them to the normalized host and any unscoped IP form, and returns true only for direct non-wildcard matches.

**Call relations**: `host_blocked` calls this when local binding is disabled but the destination is a local literal. This allows deliberate entries like `localhost` or `10.0.0.1` without letting broad wildcards open local networks.

*Call graph*: calls 2 internal fn (as_str, unscoped_ip_literal); called by 1 (host_blocked).


##### `unix_timestamp`  (lines 860–862)

```
fn unix_timestamp() -> i64
```

**Purpose**: Returns the current time as a Unix timestamp, meaning seconds since January 1, 1970 UTC. Blocked events use this compact time format.

**Data flow**: It reads the current UTC time and returns its Unix timestamp as an integer.

**Call relations**: `BlockedRequest::new` calls this so every blocked-request record gets a creation time automatically.

*Call graph*: called by 1 (new); 1 external calls (now_utc).


##### `network_proxy_state_for_policy`  (lines 865–888)

```
fn network_proxy_state_for_policy(
    mut network: crate::config::NetworkProxySettings,
) -> NetworkProxyState
```

**Purpose**: Creates a test-only `NetworkProxyState` from network settings. It lets tests exercise runtime policy decisions without loading real config files.

**Data flow**: It enables the supplied network settings, builds a config, compiles allowlist, denylist, and MITM hook state, creates empty blocked-event storage and default constraints, then returns a state with a no-op reloader.

**Call relations**: Many tests and some test helpers call this to create a predictable policy state. It uses `NetworkProxyState::with_reloader` with `NoopReloader`.

*Call graph*: calls 4 internal fn (compile_mitm_hooks, compile_allowlist_globset, compile_denylist_globset, with_reloader); called by 39 (http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host, http_plain_proxy_attempts_allowed_unix_socket_proxy, http_plain_proxy_blocks_unix_socket_when_method_not_allowed, http_plain_proxy_rejects_absolute_uri_host_header_mismatch, http_plain_proxy_rejects_unix_socket_when_not_allowlisted, http_proxy_listener_accepts_plain_http1_connect_requests, mitm_policy_allows_matching_hooked_write_in_full_mode (+15 more)); 3 external calls (new, new, default).


##### `NoopReloader::source_label`  (lines 895–897)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a simple source label for the test reloader. It identifies the config source as test state.

**Data flow**: It takes no external input and returns the string `test config state`.

**Call relations**: If test code triggers logging around reload behavior, this supplies the label expected by the `ConfigReloader` trait.


##### `NoopReloader::maybe_reload`  (lines 899–901)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements test reloading by saying no reload is needed. This keeps test state stable.

**Data flow**: It returns a future that resolves to `Ok(None)`, meaning there is no new config state.

**Call relations**: Every runtime method that calls `reload_if_needed` can use this in tests without changing the test policy.

*Call graph*: 1 external calls (pin).


##### `NoopReloader::reload_now`  (lines 903–905)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Rejects forced reloads in tests. The helper state is built directly, so there is no real source to reload from.

**Data flow**: It returns a future that resolves to an error explaining that force reload is not supported in tests.

**Call relations**: It satisfies the `ConfigReloader` trait for `NoopReloader`; tests that need forced reload behavior should use another reloader.

*Call graph*: 2 external calls (pin, anyhow!).


##### `tests::strings`  (lines 921–923)

```
fn strings(entries: &[&str]) -> Vec<String>
```

**Purpose**: Converts a small list of string slices into owned strings for test setup.

**Data flow**: It receives borrowed string entries, copies each one into a `String`, and returns the vector.

**Call relations**: The test network-settings helpers use this to build allowlist and denylist vectors.


##### `tests::network_settings`  (lines 925–934)

```
fn network_settings(allowed_domains: &[&str], denied_domains: &[&str]) -> NetworkProxySettings
```

**Purpose**: Builds test network settings with optional allowed and denied domains. This keeps individual tests short and focused on behavior.

**Data flow**: It starts with default settings, sets allowed domains if provided, sets denied domains if provided, and returns the settings.

**Call relations**: Most policy tests call this before passing the settings into `network_proxy_state_for_policy`.

*Call graph*: calls 1 internal fn (default); 1 external calls (strings).


##### `tests::network_settings_with_unix_sockets`  (lines 936–946)

```
fn network_settings_with_unix_sockets(
        allowed_domains: &[&str],
        denied_domains: &[&str],
        unix_sockets: &[String],
    ) -> NetworkProxySettings
```

**Purpose**: Builds test network settings that also include allowed Unix socket paths. This supports platform-specific socket permission tests.

**Data flow**: It creates normal network settings, copies any supplied Unix socket paths into the settings, and returns them.

**Call relations**: Unix socket tests call this, then create a test state with `network_proxy_state_for_policy`.

*Call graph*: 1 external calls (network_settings).


##### `tests::host_blocked_denied_wins_over_allowed`  (lines 949–960)

```
async fn host_blocked_denied_wins_over_allowed()
```

**Purpose**: Verifies that an explicit deny rule beats an allow rule for the same host.

**Data flow**: It builds a policy where `example.com` is both allowed and denied, asks whether the host is blocked, and asserts the result is blocked for the denied reason.

**Call relations**: This protects the decision order in `NetworkProxyState::host_blocked`, where denylist checks must happen first.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_allowlist_match`  (lines 963–979)

```
async fn host_blocked_requires_allowlist_match()
```

**Purpose**: Verifies that only allowlisted public hosts are allowed when an allowlist exists.

**Data flow**: It builds a policy allowing `example.com`, checks that `example.com` is allowed, then checks that public IP `8.8.8.8` is blocked as not allowed.

**Call relations**: This tests the allowlist portion of `host_blocked` without depending on ambient DNS behavior.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::add_allowed_domain_removes_matching_deny_entry`  (lines 982–997)

```
async fn add_allowed_domain_removes_matching_deny_entry()
```

**Purpose**: Verifies that allowing a host removes a conflicting deny entry for that host.

**Data flow**: It starts with `example.com` denied, adds it to the allowlist with mixed casing, reads current patterns, and checks that it is now allowed and no longer denied.

**Call relations**: This exercises `add_allowed_domain` and the shared `update_domain_list` conflict-removal logic.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, assert_eq!, network_settings).


##### `tests::add_denied_domain_removes_matching_allow_entry`  (lines 1000–1015)

```
async fn add_denied_domain_removes_matching_allow_entry()
```

**Purpose**: Verifies that denying a host removes a conflicting allow entry.

**Data flow**: It starts with `example.com` allowed, adds it to the denylist with uppercase input, reads current patterns, and checks that it is denied and no longer allowed.

**Call relations**: This covers the deny-side path through `add_denied_domain` and `update_domain_list`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, assert_eq!, network_settings).


##### `tests::add_denied_domain_forces_block_with_global_wildcard_allowlist`  (lines 1018–1036)

```
async fn add_denied_domain_forces_block_with_global_wildcard_allowlist()
```

**Purpose**: Verifies that a deny entry can block a host even when the allowlist permits everything public.

**Data flow**: It starts with a global wildcard allowlist, confirms `8.8.8.8` is allowed, adds that IP to the denylist, and confirms it is then denied.

**Call relations**: This protects the rule that denylist matching happens before allowlist matching in `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::add_allowed_domain_succeeds_when_managed_baseline_allows_expansion`  (lines 1039–1068)

```
async fn add_allowed_domain_succeeds_when_managed_baseline_allows_expansion()
```

**Purpose**: Verifies that a managed allowlist can be expanded when the managed constraints explicitly permit expansion.

**Data flow**: It builds config with a managed allowed domain and expansion enabled, adds a user domain, then checks both entries are present.

**Call relations**: This tests `add_allowed_domain`, `build_config_state`, and constraint validation working together.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 6 external calls (new, assert!, assert_eq!, network_settings, default, vec!).


##### `tests::add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed`  (lines 1071–1098)

```
async fn add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed()
```

**Purpose**: Verifies that a fixed managed allowlist cannot be expanded by the user.

**Data flow**: It builds config with one managed allowed domain and expansion disabled, tries to add another domain, and checks the error mentions the managed allowlist field.

**Call relations**: This protects `update_domain_list` and `validate_policy_against_constraints` from silently widening managed policy.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 5 external calls (new, assert!, network_settings, default, vec!).


##### `tests::add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed`  (lines 1101–1128)

```
async fn add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed()
```

**Purpose**: Verifies that a fixed managed denylist cannot be expanded by the user.

**Data flow**: It builds config with one managed denied domain and denylist expansion disabled, tries to add another denied domain, and checks for a managed denylist error.

**Call relations**: This covers the denylist branch of the same constraint logic used by `update_domain_list`.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 5 external calls (new, assert!, network_settings, default, vec!).


##### `tests::blocked_snapshot_does_not_consume_entries`  (lines 1131–1167)

```
async fn blocked_snapshot_does_not_consume_entries()
```

**Purpose**: Verifies that taking a snapshot of blocked requests does not clear the buffer.

**Data flow**: It records one blocked request, reads a snapshot, then drains the buffer and checks the drained entry matches the snapshot.

**Call relations**: This protects the difference between `blocked_snapshot` and `drain_blocked`.

*Call graph*: calls 3 internal fn (default, new, network_proxy_state_for_policy); 1 external calls (assert_eq!).


##### `tests::drain_blocked_returns_buffered_window`  (lines 1170–1193)

```
async fn drain_blocked_returns_buffered_window()
```

**Purpose**: Verifies that the blocked-request buffer keeps only the most recent window of events.

**Data flow**: It records more events than the maximum buffer size, drains the buffer, and checks that only the newest entries remain.

**Call relations**: This tests the trimming behavior in `record_blocked` and the clearing behavior in `drain_blocked`.

*Call graph*: calls 3 internal fn (default, new, network_proxy_state_for_policy); 2 external calls (assert_eq!, format!).


##### `tests::blocked_request_violation_log_line_serializes_payload`  (lines 1196–1214)

```
fn blocked_request_violation_log_line_serializes_payload()
```

**Purpose**: Verifies the exact structured log format for a blocked request.

**Data flow**: It builds a blocked-request entry with known values, formats it, and compares the result to the expected prefix plus JSON payload.

**Call relations**: This protects `blocked_request_violation_log_line`, which `record_blocked` uses for searchable violation logs.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_blocked_subdomain_wildcards_exclude_apex`  (lines 1217–1231)

```
async fn host_blocked_subdomain_wildcards_exclude_apex()
```

**Purpose**: Verifies that `*.openai.com` allows subdomains but not the root domain `openai.com`.

**Data flow**: It creates an allowlist with a single-subdomain wildcard, checks `api.openai.com` is allowed, and checks `openai.com` is blocked.

**Call relations**: This documents wildcard semantics used by compiled globsets and consumed by `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_global_wildcard_allowlist_allows_public_hosts_except_denylist`  (lines 1234–1258)

```
async fn host_blocked_global_wildcard_allowlist_allows_public_hosts_except_denylist()
```

**Purpose**: Verifies that a global allowlist permits public hosts but still respects explicit denies.

**Data flow**: It builds a policy with `*` allowed and one host denied, checks two public hosts are allowed, and checks the denied host is blocked.

**Call relations**: This protects the combined allowlist/denylist decision order in `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_loopback_when_local_binding_disabled`  (lines 1261–1272)

```
async fn host_blocked_rejects_loopback_when_local_binding_disabled()
```

**Purpose**: Verifies that localhost destinations are blocked when local binding is not allowed.

**Data flow**: It builds a policy allowing only `example.com`, then checks `127.0.0.1` and `localhost` are blocked for the local-network reason.

**Call relations**: This exercises the local-address protections inside `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_loopback_when_explicitly_allowlisted_and_local_binding_disabled`  (lines 1275–1282)

```
async fn host_blocked_allows_loopback_when_explicitly_allowlisted_and_local_binding_disabled()
```

**Purpose**: Verifies that an explicit `localhost` allowlist entry can permit localhost even when broad local binding is disabled.

**Data flow**: It builds a policy allowing `localhost`, asks whether `localhost` is blocked, and expects it to be allowed.

**Call relations**: This covers `is_explicit_local_allowlisted` as used by `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_private_ip_literal_when_explicitly_allowlisted`  (lines 1285–1292)

```
async fn host_blocked_allows_private_ip_literal_when_explicitly_allowlisted()
```

**Purpose**: Verifies that an explicit private IP allowlist entry can permit that exact private address.

**Data flow**: It builds a policy allowing `10.0.0.1`, checks that address, and expects it to be allowed.

**Call relations**: This protects the exact local/private IP exception path in `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_scoped_ipv6_literal_when_not_allowlisted`  (lines 1295–1305)

```
async fn host_blocked_rejects_scoped_ipv6_literal_when_not_allowlisted()
```

**Purpose**: Verifies that a scoped IPv6 local address is blocked when it is not explicitly allowed.

**Data flow**: It builds a policy allowing only `example.com`, checks `fe80::1%lo0`, and expects a local-network block.

**Call relations**: This covers scoped IPv6 normalization and local-address checks inside `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_allows_scoped_ipv6_literal_when_explicitly_allowlisted`  (lines 1308–1318)

```
async fn host_blocked_allows_scoped_ipv6_literal_when_explicitly_allowlisted()
```

**Purpose**: Verifies that a scoped IPv6 address can be allowed by listing its unscoped IP form.

**Data flow**: It allows `fe80::1`, checks `fe80::1%lo0`, and expects the request to be allowed.

**Call relations**: This tests `globset_matches_host_or_unscoped` and `is_explicit_local_allowlisted` working with `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_exact_scoped_ipv6_allowlist_match`  (lines 1321–1341)

```
async fn host_blocked_requires_exact_scoped_ipv6_allowlist_match()
```

**Purpose**: Verifies that when local binding is enabled, scoped IPv6 allowlist entries match exact scopes.

**Data flow**: It allows `fe80::1%eth0`, checks the same scoped address is allowed, and checks `fe80::1%eth1` is not allowed.

**Call relations**: This documents exact scoped-address matching in the allowlist path of `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_denies_scoped_ipv6_literal_before_local_binding`  (lines 1344–1357)

```
async fn host_blocked_denies_scoped_ipv6_literal_before_local_binding()
```

**Purpose**: Verifies that denylist matching still wins for scoped IPv6 addresses even when local binding is allowed.

**Data flow**: It allows all hosts, denies `fd00::1`, then checks several scoped or bracketed forms and expects all to be denied.

**Call relations**: This protects deny-before-local-binding order and unscoped matching in `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_requires_exact_scoped_ipv6_denylist_match`  (lines 1360–1380)

```
async fn host_blocked_requires_exact_scoped_ipv6_denylist_match()
```

**Purpose**: Verifies exact scoped IPv6 denylist matching when the denylist includes a scope.

**Data flow**: It denies `fd00::1%eth0`, checks that exact scoped address is denied, and checks the same address on `eth1` is allowed under a wildcard allowlist.

**Call relations**: This covers the denylist branch of scoped IP matching in `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_private_ip_literals_when_local_binding_disabled`  (lines 1383–1390)

```
async fn host_blocked_rejects_private_ip_literals_when_local_binding_disabled()
```

**Purpose**: Verifies that private IP literals are blocked when local/private access is disabled and not explicitly allowed.

**Data flow**: It builds a policy allowing `example.com`, checks `10.0.0.1`, and expects a local-network block.

**Call relations**: This protects `is_non_public_ip` use inside `host_blocked`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert_eq!, network_settings).


##### `tests::host_blocked_rejects_loopback_when_allowlist_empty`  (lines 1393–1400)

```
async fn host_blocked_rejects_loopback_when_allowlist_empty()
```

**Purpose**: Verifies that localhost is blocked even when there is no allowlist configured.

**Data flow**: It builds default settings, checks `127.0.0.1`, and expects a local-network block.

**Call relations**: This confirms local-network protection happens before the general not-allowed decision in `host_blocked`.

*Call graph*: calls 2 internal fn (default, network_proxy_state_for_policy); 1 external calls (assert_eq!).


##### `tests::host_blocked_rejects_allowlisted_hostname_when_dns_lookup_fails`  (lines 1403–1415)

```
async fn host_blocked_rejects_allowlisted_hostname_when_dns_lookup_fails()
```

**Purpose**: Verifies that DNS lookup failure causes an allowlisted hostname to be blocked when local binding is disabled.

**Data flow**: It allowlists a deliberately non-resolving host, checks it, and expects a local-network-style block.

**Call relations**: This protects the fail-closed behavior of `host_resolves_to_non_public_ip` as used by `host_blocked`.

*Call graph*: calls 2 internal fn (default, network_proxy_state_for_policy); 2 external calls (assert_eq!, vec!).


##### `tests::host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout`  (lines 1418–1430)

```
async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout()
```

**Purpose**: Verifies that the DNS safety check blocks when lookup times out.

**Data flow**: It calls `host_resolves_to_non_public_ip` with a fake lookup that never finishes and a tiny timeout, then asserts the result is blocked.

**Call relations**: This directly tests the timeout branch used by `host_blocked`.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_blocks_on_dns_lookup_error`  (lines 1433–1448)

```
async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_error()
```

**Purpose**: Verifies that the DNS safety check blocks when lookup returns an error.

**Data flow**: It calls `host_resolves_to_non_public_ip` with a fake lookup error and asserts the result is blocked.

**Call relations**: This protects the fail-closed DNS-error branch in the helper used by `host_blocked`.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_blocks_private_resolution`  (lines 1451–1461)

```
async fn host_resolves_to_non_public_ip_blocks_private_resolution()
```

**Purpose**: Verifies that a hostname resolving to a private or loopback address is treated as blocked.

**Data flow**: It calls the helper with a fake DNS result of `127.0.0.1:80` and asserts the result is blocked.

**Call relations**: This tests the private-address detection that prevents DNS rebinding-style bypasses.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::host_resolves_to_non_public_ip_allows_public_resolution`  (lines 1464–1474)

```
async fn host_resolves_to_non_public_ip_allows_public_resolution()
```

**Purpose**: Verifies that a hostname resolving only to a public address is not blocked by the local/private DNS check.

**Data flow**: It calls the helper with a fake DNS result of `8.8.8.8:80` and asserts the result is not blocked.

**Call relations**: This confirms the helper does not block ordinary public destinations when DNS succeeds.

*Call graph*: calls 1 internal fn (host_resolves_to_non_public_ip); 2 external calls (from_millis, assert!).


##### `tests::validate_policy_against_constraints_disallows_widening_allowed_domains`  (lines 1477–1492)

```
fn validate_policy_against_constraints_disallows_widening_allowed_domains()
```

**Purpose**: Verifies that managed constraints can prevent adding extra allowed domains.

**Data flow**: It creates constraints allowing only `example.com`, builds config that also allows `evil.com`, and asserts validation fails.

**Call relations**: Although the validator lives in another module, this runtime test protects the constraint behavior relied on by `set_network_mode` and `update_domain_list`.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_allows_expanding_allowed_domains_when_enabled`  (lines 1495–1511)

```
fn validate_policy_against_constraints_allows_expanding_allowed_domains_when_enabled()
```

**Purpose**: Verifies that allowlist expansion is accepted when the managed constraint says expansion is enabled.

**Data flow**: It creates a managed baseline plus expansion permission, builds config with an extra allowed domain, and asserts validation succeeds.

**Call relations**: This supports the allowlist update path used by `add_allowed_domain`.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_widening_mode`  (lines 1514–1529)

```
fn validate_policy_against_constraints_disallows_widening_mode()
```

**Purpose**: Verifies that managed constraints can prevent switching to a broader network mode.

**Data flow**: It constrains the mode to limited, builds config with full mode, and asserts validation fails.

**Call relations**: This protects the validation call inside `set_network_mode`.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_allows_narrowing_wildcard_allowlist`  (lines 1532–1547)

```
fn validate_policy_against_constraints_allows_narrowing_wildcard_allowlist()
```

**Purpose**: Verifies that a config can narrow a managed wildcard allowlist to a specific matching host.

**Data flow**: It constrains allowed domains to `*.example.com`, builds config allowing `api.example.com`, and asserts validation succeeds.

**Call relations**: This documents how managed allowlist constraints treat narrower user policy.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_widening_wildcard_allowlist`  (lines 1550–1565)

```
fn validate_policy_against_constraints_rejects_widening_wildcard_allowlist()
```

**Purpose**: Verifies that a config cannot widen a managed wildcard allowlist.

**Data flow**: It constrains allowed domains to `*.example.com`, builds config using broader `**.example.com`, and asserts validation fails.

**Call relations**: This protects constraint behavior used before runtime state accepts policy changes.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_global_wildcard_in_managed_allowlist`  (lines 1568–1583)

```
fn validate_policy_against_constraints_rejects_global_wildcard_in_managed_allowlist()
```

**Purpose**: Verifies that a managed global wildcard allowlist is rejected as too broad for constraint comparison.

**Data flow**: It creates constraints containing `*`, builds a narrower config, and asserts validation fails.

**Call relations**: This documents a safety rule in policy constraint validation.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_bracketed_global_wildcard_in_managed_allowlist`  (lines 1586–1602)

```
fn validate_policy_against_constraints_rejects_bracketed_global_wildcard_in_managed_allowlist()
```

**Purpose**: Verifies that a bracketed wildcard form is also rejected in managed allowlist constraints.

**Data flow**: It creates constraints containing `[*]`, builds a config, and asserts validation fails.

**Call relations**: This protects alternate wildcard syntax from bypassing managed-policy safety checks.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_rejects_double_wildcard_bracketed_global_wildcard_in_managed_allowlist`  (lines 1605–1621)

```
fn validate_policy_against_constraints_rejects_double_wildcard_bracketed_global_wildcard_in_managed_allowlist()
```

**Purpose**: Verifies that a double-wildcard bracketed global pattern is rejected in managed allowlist constraints.

**Data flow**: It creates constraints containing `**.[*]`, builds a config, and asserts validation fails.

**Call relations**: This extends wildcard safety coverage for the constraint validator used by runtime updates.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_requires_managed_denied_domains_entries`  (lines 1624–1638)

```
fn validate_policy_against_constraints_requires_managed_denied_domains_entries()
```

**Purpose**: Verifies that managed denylist entries must remain present in the active config.

**Data flow**: It constrains denied domains to include `evil.com`, builds config without that deny entry, and asserts validation fails.

**Call relations**: This protects denylist constraint behavior used before `update_domain_list` installs new policy.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_expanding_denied_domains_when_fixed`  (lines 1641–1657)

```
fn validate_policy_against_constraints_disallows_expanding_denied_domains_when_fixed()
```

**Purpose**: Verifies that a fixed managed denylist cannot be expanded when expansion is disabled.

**Data flow**: It creates constraints with one denied domain and expansion disabled, builds config with an extra denied domain, and asserts validation fails.

**Call relations**: This supports the denylist branch of runtime domain-list updates.

*Call graph*: 4 external calls (assert!, network_settings, default, vec!).


##### `tests::validate_policy_against_constraints_disallows_enabling_when_managed_disabled`  (lines 1660–1674)

```
fn validate_policy_against_constraints_disallows_enabling_when_managed_disabled()
```

**Purpose**: Verifies that managed constraints can keep the network proxy disabled.

**Data flow**: It constrains `enabled` to false, builds config with networking enabled, and asserts validation fails.

**Call relations**: This documents an administrator control that runtime config replacement must respect.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_local_binding_when_managed_disabled`  (lines 1677–1692)

```
fn validate_policy_against_constraints_disallows_allow_local_binding_when_managed_disabled()
```

**Purpose**: Verifies that managed constraints can forbid local/private network access.

**Data flow**: It constrains local binding to false, builds config with local binding true, and asserts validation fails.

**Call relations**: This protects the policy setting that affects `host_blocked` local-network decisions.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_all_unix_sockets_without_managed_opt_in`  (lines 1695–1711)

```
fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_without_managed_opt_in()
```

**Purpose**: Verifies that allowing all Unix sockets is rejected when managed policy explicitly does not allow it.

**Data flow**: It constrains the dangerous all-sockets flag to false, builds config with it true, and asserts validation fails.

**Call relations**: This supports the safety of `is_unix_socket_allowed`, where the all-sockets flag bypasses the path allowlist.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_disallows_allow_all_unix_sockets_when_allowlist_is_managed`  (lines 1714–1730)

```
fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_when_allowlist_is_managed()
```

**Purpose**: Verifies that a managed Unix socket allowlist cannot be bypassed by enabling the all-sockets flag.

**Data flow**: It creates constraints with a specific allowed socket path, builds config that allows all sockets, and asserts validation fails.

**Call relations**: This protects managed socket policy relied on by runtime socket checks.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, default, vec!).


##### `tests::validate_policy_against_constraints_allows_allow_all_unix_sockets_with_managed_opt_in`  (lines 1733–1748)

```
fn validate_policy_against_constraints_allows_allow_all_unix_sockets_with_managed_opt_in()
```

**Purpose**: Verifies that allowing all Unix sockets is accepted when managed policy explicitly opts in.

**Data flow**: It constrains the dangerous all-sockets flag to true, builds config with it true, and asserts validation succeeds.

**Call relations**: This documents the intended override path for `is_unix_socket_allowed`.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::validate_policy_against_constraints_allows_allow_all_unix_sockets_when_unmanaged`  (lines 1751–1763)

```
fn validate_policy_against_constraints_allows_allow_all_unix_sockets_when_unmanaged()
```

**Purpose**: Verifies that unmanaged policy may enable the all Unix sockets flag.

**Data flow**: It uses default constraints, builds config with all Unix sockets allowed, and asserts validation succeeds.

**Call relations**: This distinguishes unmanaged user policy from managed administrator policy.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::compile_globset_is_case_insensitive`  (lines 1766–1771)

```
fn compile_globset_is_case_insensitive()
```

**Purpose**: Verifies that domain pattern matching ignores letter case.

**Data flow**: It compiles a mixed-case deny pattern and checks lowercase and uppercase host forms both match.

**Call relations**: This protects the pattern behavior used by `host_blocked` through compiled globsets.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_excludes_apex_for_subdomain_patterns`  (lines 1774–1780)

```
fn compile_globset_excludes_apex_for_subdomain_patterns()
```

**Purpose**: Verifies that a single-star subdomain pattern matches subdomains but not the root domain.

**Data flow**: It compiles `*.openai.com`, checks a subdomain matches, and checks the apex and a lookalike host do not.

**Call relations**: This documents globset behavior that host allowlist and denylist decisions rely on.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_includes_apex_for_double_wildcard_patterns`  (lines 1783–1789)

```
fn compile_globset_includes_apex_for_double_wildcard_patterns()
```

**Purpose**: Verifies that a double-star domain pattern includes both the root domain and subdomains.

**Data flow**: It compiles `**.openai.com`, checks both `openai.com` and `api.openai.com` match, and checks a lookalike host does not.

**Call relations**: This protects wildcard semantics used by runtime domain matching.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_global_wildcard`  (lines 1792–1795)

```
fn compile_globset_rejects_global_wildcard()
```

**Purpose**: Verifies that denylist compilation rejects a global wildcard. Denying everything by wildcard is not allowed in this compiler path.

**Data flow**: It tries to compile `*` as a denylist pattern and asserts compilation fails.

**Call relations**: This protects denylist pattern validation used when building runtime config state.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_allows_global_wildcard_when_enabled`  (lines 1798–1804)

```
fn compile_globset_allows_global_wildcard_when_enabled()
```

**Purpose**: Verifies that allowlist compilation accepts a global wildcard and that it matches common hosts.

**Data flow**: It compiles `*` as an allowlist pattern and checks several hosts match.

**Call relations**: This supports the global-allow behavior tested later through `host_blocked`.

*Call graph*: calls 1 internal fn (compile_allowlist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_bracketed_global_wildcard`  (lines 1807–1810)

```
fn compile_globset_rejects_bracketed_global_wildcard()
```

**Purpose**: Verifies that an alternate bracketed global wildcard is rejected for denylist patterns.

**Data flow**: It tries to compile `[*]` as a deny pattern and asserts failure.

**Call relations**: This prevents alternate syntax from bypassing denylist wildcard restrictions.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_double_wildcard_bracketed_global_wildcard`  (lines 1813–1816)

```
fn compile_globset_rejects_double_wildcard_bracketed_global_wildcard()
```

**Purpose**: Verifies that a double-wildcard bracketed global pattern is rejected for denylist patterns.

**Data flow**: It tries to compile `**.[*]` as a deny pattern and asserts failure.

**Call relations**: This closes another wildcard spelling that could otherwise affect runtime deny matching.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::compile_globset_dedupes_patterns_without_changing_behavior`  (lines 1819–1825)

```
fn compile_globset_dedupes_patterns_without_changing_behavior()
```

**Purpose**: Verifies that duplicate patterns do not change matching behavior.

**Data flow**: It compiles two identical deny patterns and checks the intended host matches, case-insensitive matching works, and a different host does not match.

**Call relations**: This supports predictable compiled globsets used by `host_blocked`.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 2 external calls (assert!, vec!).


##### `tests::compile_globset_rejects_invalid_patterns`  (lines 1828–1831)

```
fn compile_globset_rejects_invalid_patterns()
```

**Purpose**: Verifies that invalid glob syntax is rejected during compilation.

**Data flow**: It tries to compile an invalid pattern containing `[` and asserts compilation fails.

**Call relations**: This protects runtime config building from accepting broken match patterns.

*Call graph*: 2 external calls (assert!, vec!).


##### `tests::build_config_state_allows_global_wildcard_allowed_domains`  (lines 1834–1844)

```
fn build_config_state_allows_global_wildcard_allowed_domains()
```

**Purpose**: Verifies that full config-state building accepts a global wildcard in allowed domains.

**Data flow**: It builds enabled config with `*` allowed and asserts `build_config_state` succeeds.

**Call relations**: This tests the state-building path that produces the `ConfigState` consumed by `NetworkProxyState`.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_allows_bracketed_global_wildcard_allowed_domains`  (lines 1847–1857)

```
fn build_config_state_allows_bracketed_global_wildcard_allowed_domains()
```

**Purpose**: Verifies that bracketed global wildcard syntax is accepted in allowed domains during state building.

**Data flow**: It builds enabled config with `[*]` allowed and asserts state building succeeds.

**Call relations**: This documents allowed wildcard syntax for allowlists in runtime config state.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_rejects_global_wildcard_denied_domains`  (lines 1860–1870)

```
fn build_config_state_rejects_global_wildcard_denied_domains()
```

**Purpose**: Verifies that full config-state building rejects a global wildcard in denied domains.

**Data flow**: It builds config with `*` denied and asserts `build_config_state` fails.

**Call relations**: This protects runtime startup and reload paths from accepting an unsafe denylist pattern.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::build_config_state_rejects_bracketed_global_wildcard_denied_domains`  (lines 1873–1883)

```
fn build_config_state_rejects_bracketed_global_wildcard_denied_domains()
```

**Purpose**: Verifies that bracketed global wildcard syntax is rejected in denied domains during state building.

**Data flow**: It builds config with `[*]` denied and asserts state building fails.

**Call relations**: This complements denylist wildcard validation for the config state used by `NetworkProxyState`.

*Call graph*: 2 external calls (assert!, network_settings).


##### `tests::unix_socket_allowlist_is_respected_on_macos`  (lines 1887–1902)

```
async fn unix_socket_allowlist_is_respected_on_macos()
```

**Purpose**: Verifies on macOS that only configured Unix socket paths are allowed.

**Data flow**: It creates settings with one allowed socket path, checks that path is allowed, and checks another path is rejected.

**Call relations**: This tests `is_unix_socket_allowed` on the only supported platform.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, network_settings_with_unix_sockets, from_ref).


##### `tests::unix_socket_allowlist_resolves_symlinks`  (lines 1906–1931)

```
async fn unix_socket_allowlist_resolves_symlinks()
```

**Purpose**: Verifies on macOS that Unix socket allowlist checks account for symbolic links. A symbolic link is a filesystem shortcut to another path.

**Data flow**: It creates a real file and a symlink to it, allowlists the real path, then checks that the symlink path is allowed through canonical path comparison.

**Call relations**: This protects the symlink-handling branch in `is_unix_socket_allowed`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 4 external calls (assert!, network_settings_with_unix_sockets, write, from_ref).


##### `tests::unix_socket_allow_all_flag_bypasses_allowlist`  (lines 1935–1944)

```
async fn unix_socket_allow_all_flag_bypasses_allowlist()
```

**Purpose**: Verifies on macOS that the dangerous allow-all Unix sockets flag permits absolute socket paths but still rejects relative paths.

**Data flow**: It enables the all-sockets flag, checks an absolute path is allowed, and checks a relative path is rejected.

**Call relations**: This tests both the all-sockets shortcut and the absolute-path safety gate in `is_unix_socket_allowed`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 2 external calls (assert!, network_settings).


##### `tests::unix_socket_allowlist_is_rejected_on_non_macos`  (lines 1948–1961)

```
async fn unix_socket_allowlist_is_rejected_on_non_macos()
```

**Purpose**: Verifies that Unix socket permissions are not granted on unsupported non-macOS platforms.

**Data flow**: It creates settings that would otherwise allow a socket and even allow all sockets, then checks the socket path is still rejected.

**Call relations**: This protects the platform gate shared by `unix_socket_permissions_supported` and `is_unix_socket_allowed`.

*Call graph*: calls 1 internal fn (network_proxy_state_for_policy); 3 external calls (assert!, network_settings_with_unix_sockets, from_ref).


### Sandbox filesystem protections
These files manage Windows sandbox filesystem access by applying extra read grants, preserving deny-read state, and tightening workspace ACLs.

### `core/src/windows_sandbox_read_grants.rs`

`domain_logic` · `when adding sandbox read access before running a command`

On Windows, the project can run commands inside a sandbox, which is a restricted environment that limits what files the command can touch. Sometimes the command needs read-only access to an extra folder outside the normal workspace. This file is the small gatekeeper for that case.

It accepts a requested folder path and first makes sure the request is sensible: the path must be absolute, it must exist, and it must be a directory. This prevents unclear or unsafe requests, such as “read whatever this relative path happens to mean today” or “grant access to a file instead of a folder.”

After that, it turns the folder into its canonical form, meaning the cleaned-up, real path as Windows sees it. This is like checking a street address against an official map before writing it on an access badge.

Finally, it calls the Windows sandbox setup refresh code with this folder listed as an extra read root. If the refresh succeeds, it returns the canonical folder path that was granted. If anything is wrong, it returns an error instead of silently changing sandbox permissions.

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

**Purpose**: This function grants the Windows sandbox read-only access to one extra directory. It is meant for the non-elevated path, so it refreshes sandbox permissions without requiring administrator-level setup.

**Data flow**: It receives the current permission profile, workspace roots, command working directory, environment variables, Codex home directory, and the requested read-only folder. It checks that the requested folder is an absolute path, exists on disk, and is a directory. It then canonicalizes the path into its real filesystem form, passes that path to the sandbox setup refresh as an extra read root, and returns the canonical path if everything succeeds. If any check fails, it stops early with an error message.

**Call relations**: Code that wants to add a new readable folder calls this function as the safe front door. The function performs the local checks itself, then hands the verified folder to `run_setup_refresh_with_extra_read_roots`, which does the actual sandbox refresh work. It also relies on filesystem path checks such as `is_absolute`, `exists`, `is_dir`, and `canonicalize` to make sure the sandbox is updated with a real directory rather than an ambiguous or invalid path.

*Call graph*: calls 1 internal fn (run_setup_refresh_with_extra_read_roots); 6 external calls (exists, is_absolute, is_dir, bail!, canonicalize, vec!).


### `windows-sandbox-rs/src/deny_read_state.rs`

`domain_logic` · `sandbox setup and ACL reconciliation across runs`

The sandbox can add Windows permission rules that say a particular sandbox user is not allowed to read certain paths. In Windows terms, these are ACL entries: an ACL, or access control list, is the permission list on a file or folder, and an ACE is one entry in that list. Some sandbox sessions deliberately leave these deny-read rules in place after the launcher exits, because child processes may still be running. That means the sandbox must remember what it changed so a later run can clean up rules that are no longer wanted.

This file does that bookkeeping. It stores a small JSON file named `deny_read_acl_state.json` inside the sandbox directory. The file maps each sandbox principal, identified by its SID (Windows security identifier), to the paths where deny-read rules were successfully applied.

The main flow is careful: it first loads the old saved state, then applies the new desired deny-read rules, and only after that removes stale old rules. This order matters. If the sandbox removed old rules first, there could be a short window where a still-needed path becomes readable. Paths are compared using a normalized lexical key, so the code can tell when two path strings refer to the same intended entry even if their spelling differs. Finally, it writes the updated state back to disk.

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

**Purpose**: This is the main reconciliation step for one sandbox principal. It applies the deny-read rules wanted for this run, removes older deny-read rules for the same principal that are no longer wanted, and updates the saved JSON state so the next run knows what happened.

**Data flow**: It receives the Codex home directory, the principal’s SID as text, the desired list of paths to protect, and a raw Windows SID pointer used by the permission-changing code. It finds the sandbox state file, reads the previous paths for this SID, applies deny-read rules to the desired paths, compares the successfully applied paths with the old saved paths, revokes stale permission entries, updates the in-memory state, writes that state back to disk, and returns the paths where rules were actually applied.

**Call relations**: This function is called by `apply_legacy_session_acl_rules` when sandbox ACL rules are being set up. It asks `sandbox_dir` where the state file lives, uses `load_state` and `store_state` for the JSON bookkeeping, delegates the actual permission additions to `apply_deny_read_acls`, uses `lexical_path_key` to compare paths consistently, and calls `revoke_ace` to remove old deny-read entries that no longer belong.

*Call graph*: calls 6 internal fn (revoke_ace, apply_deny_read_acls, lexical_path_key, load_state, store_state, sandbox_dir); called by 1 (apply_legacy_session_acl_rules).


##### `load_state`  (lines 70–81)

```
fn load_state(path: &Path) -> Result<PersistentDenyReadAclState>
```

**Purpose**: This reads the saved deny-read ACL state from disk. If the state file does not exist yet, it treats that as a normal first-run case and returns an empty state.

**Data flow**: It receives the path to the JSON state file. It tries to read the file’s bytes, parses them as JSON into the internal state structure, and returns that structure. If the file is missing, it returns a default empty map; if the file exists but cannot be read or parsed, it returns an error with context explaining which state file failed.

**Call relations**: This helper is used only by `sync_persistent_deny_read_acls` at the start of reconciliation. It gives the main function the previous remembered paths so the main function can decide which old ACL entries are stale.

*Call graph*: called by 1 (sync_persistent_deny_read_acls); 3 external calls (from_slice, read, default).


##### `store_state`  (lines 83–87)

```
fn store_state(path: &Path, state: &PersistentDenyReadAclState) -> Result<()>
```

**Purpose**: This writes the updated deny-read ACL state back to disk as readable JSON. It preserves the sandbox’s memory of which deny-read rules are currently believed to be installed.

**Data flow**: It receives the path to the state file and the current state object. It converts the state to pretty-printed JSON bytes, writes those bytes to the file, and returns success or an error with context if serialization or writing fails.

**Call relations**: This helper is used only by `sync_persistent_deny_read_acls` after ACLs have been applied and stale ones revoked. It is the final bookkeeping step that makes the current reconciliation visible to future sandbox runs.

*Call graph*: called by 1 (sync_persistent_deny_read_acls); 2 external calls (to_vec_pretty, write).


### `windows-sandbox-rs/src/workspace_acl.rs`

`domain_logic` · `sandbox setup before command execution`

This file contains a small set of workspace permission helpers for the Windows sandbox. Its main job is to decide when and where to add a Windows access rule that denies write access. In plain terms, it is like putting a “do not edit” sign on certain hidden folders before running an untrusted or limited command.

The file focuses on two special directories inside a workspace: `.codex` and `.agents`. If either directory exists under the current working directory, the code asks the lower-level access-control code to add a deny-write entry for a given SID. A SID, or security identifier, is Windows’ way of naming a user, group, or security principal. The caller must provide a valid SID pointer, because this file passes it directly into Windows permission logic.

There is also a helper that checks whether the command’s current directory is the workspace root. It does this by normalizing the root path first, so equivalent path spellings are compared fairly.

What matters is that this file does not create folders and does not protect missing folders. It only applies protection when the target hidden directory already exists. Without this file, legacy sandbox setup would have no focused way to lock down these workspace-private directories.

#### Function details

##### `is_command_cwd_root`  (lines 7–9)

```
fn is_command_cwd_root(root: &Path, canonical_command_cwd: &Path) -> bool
```

**Purpose**: This function checks whether the command is being run from the workspace root directory. It helps later sandbox rules decide whether root-level workspace protections should apply.

**Data flow**: It receives the workspace root path and the command’s already-normalized current directory. It normalizes the root path using `canonicalize_path`, compares the two paths, and returns `true` if they point to the same place or `false` if they do not.

**Call relations**: During legacy session access-control setup, `apply_legacy_session_acl_rules` calls this function to answer a simple location question: is the command starting at the workspace root? To answer that reliably, this function hands the root path to `canonicalize_path` before comparing it with the command directory.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_codex_dir`  (lines 13–15)

```
fn protect_workspace_codex_dir(cwd: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: This function protects the `.codex` directory inside the workspace, if that directory exists. It is used to stop the sandboxed identity from writing into Codex’s hidden workspace data.

**Data flow**: It receives the current workspace directory and a Windows SID pointer that identifies who should be denied write access. It passes those along with the fixed subdirectory name `.codex` to the shared helper. The result is a success value saying whether a protection rule was added, or an error if changing permissions failed.

**Call relations**: When `apply_legacy_session_acl_rules` is setting up legacy workspace protections, it calls this function for the Codex-specific hidden folder. This function does not change permissions itself; it delegates the common path-building and permission step to `protect_workspace_subdir`.

*Call graph*: calls 1 internal fn (protect_workspace_subdir); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_agents_dir`  (lines 19–21)

```
fn protect_workspace_agents_dir(cwd: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: This function protects the `.agents` directory inside the workspace, if that directory exists. It keeps sandboxed commands from writing into hidden agent-related workspace data.

**Data flow**: It receives the current workspace directory and a Windows SID pointer for the identity that should lose write access. It forwards both values, plus the fixed subdirectory name `.agents`, to the shared helper. It returns whether protection was applied, or an error if the permission update could not be completed.

**Call relations**: During legacy session access-control setup, `apply_legacy_session_acl_rules` calls this function for the agent-specific hidden folder. Like the `.codex` wrapper, it relies on `protect_workspace_subdir` to do the actual directory check and access-rule update.

*Call graph*: calls 1 internal fn (protect_workspace_subdir); called by 1 (apply_legacy_session_acl_rules).


##### `protect_workspace_subdir`  (lines 23–30)

```
fn protect_workspace_subdir(cwd: &Path, psid: *mut c_void, subdir: &str) -> Result<bool>
```

**Purpose**: This shared helper protects one named subdirectory under the workspace by adding a deny-write permission rule, but only if that subdirectory already exists. It keeps the public wrapper functions small and makes `.codex` and `.agents` follow the same behavior.

**Data flow**: It receives a workspace directory, a Windows SID pointer, and a subdirectory name. It builds the full path by joining the workspace path with the subdirectory name, checks whether that path is an existing directory, and if so calls `add_deny_write_ace` to add the Windows deny-write rule. If the directory is missing, it returns `Ok(false)` to say that nothing was changed.

**Call relations**: `protect_workspace_codex_dir` and `protect_workspace_agents_dir` both call this helper after choosing which hidden folder they want protected. If protection is needed, this function hands the final path and SID to `add_deny_write_ace`, which is the lower-level routine that actually edits the Windows access-control list.

*Call graph*: calls 1 internal fn (add_deny_write_ace); called by 2 (protect_workspace_agents_dir, protect_workspace_codex_dir); 1 external calls (join).


### WFP network blocking setup
These files install and safely wrap persistent Windows Filtering Platform protections used to enforce approval-gated network restrictions.

### `windows-sandbox-rs/src/wfp.rs`

`io_transport` · `setup`

This file is the bridge between the sandbox setup code and Windows Filtering Platform, or WFP, which is Windows’ built-in system for making low-level firewall decisions. Think of WFP as a security checkpoint for network traffic. This file creates the checkpoint rules that apply only to the sandbox user account.

The main public entry point opens the WFP engine, starts a transaction, makes sure Codex has a named provider and sublayer registered in Windows, builds a condition that matches the target user account, then installs each filter from a static list. A transaction means “do these changes as one batch”: if something goes wrong before commit, the unfinished changes are aborted instead of leaving a half-installed firewall setup.

The filters are persistent, so Windows remembers them after the process exits. To avoid duplicate or stale rules, each known filter is deleted first if it already exists, then added again from the current specification. The file also wraps raw Windows resources in small Rust types so handles and allocated security descriptors are cleaned up automatically. Without this file, the sandbox setup might still create a Windows account, but the network restrictions tied to that account would not be installed.

#### Function details

##### `install_wfp_filters_for_account`  (lines 79–95)

```
fn install_wfp_filters_for_account(account: &str) -> Result<usize>
```

**Purpose**: Installs all persistent WFP blocking rules for one Windows account. This is the high-level setup step that turns the project’s filter list into real Windows firewall rules.

**Data flow**: It receives an account name as text. It opens the Windows filtering engine, starts a transaction, creates or reuses the Codex provider and sublayer, builds a user-matching condition for that account, deletes any old copy of each known filter, adds the fresh filter, commits the transaction, and returns how many filters were installed. If a Windows API call fails, it returns an error instead of a count.

**Call relations**: This is the file’s main outward-facing function. It calls on Engine::open to reach WFP, UserMatchCondition::for_account to make the rules apply only to the chosen user, ensure_provider and ensure_sublayer to prepare the WFP namespace, then delete_filter_if_present and add_filter for each rule.

*Call graph*: calls 6 internal fn (open, for_account, add_filter, delete_filter_if_present, ensure_provider, ensure_sublayer).


##### `Engine::open`  (lines 103–124)

```
fn open() -> Result<Self>
```

**Purpose**: Opens a connection to the Windows Filtering Platform engine. The rest of the file needs this connection before it can add, delete, or group firewall rules.

**Data flow**: It builds a Windows-friendly session name, prepares a WFP session structure, asks Windows to open the engine, checks the returned status, and produces an Engine object containing the raw Windows handle. If Windows refuses the open request, it returns an error.

**Call relations**: install_wfp_filters_for_account uses this at the start of installation. It delegates status checking to ensure_success so Windows error codes become ordinary Rust errors.

*Call graph*: calls 1 internal fn (ensure_success); called by 1 (install_wfp_filters_for_account); 7 external calls (default, new, to_wide, zeroed, null, null_mut, FwpmEngineOpen0).


##### `Engine::begin_transaction`  (lines 126–133)

```
fn begin_transaction(&self) -> Result<Transaction<'_>>
```

**Purpose**: Starts a WFP transaction, which is a batch of changes that should either all succeed or be rolled back. This protects the system from being left with only part of the intended filter setup.

**Data flow**: It uses the open engine handle, asks Windows to begin a transaction, checks the result, and returns a Transaction object that remembers it has not yet been committed.

**Call relations**: The installation flow begins a transaction after opening the engine and before changing providers, sublayers, or filters. It uses ensure_success to turn the Windows result into success or an error.

*Call graph*: calls 1 internal fn (ensure_success); 1 external calls (FwpmTransactionBegin0).


##### `Engine::drop`  (lines 137–141)

```
fn drop(&mut self)
```

**Purpose**: Closes the WFP engine handle when the Engine object goes away. This prevents leaking an operating-system resource.

**Data flow**: It takes the handle stored inside Engine and passes it to Windows for closing. It does not return a value and does not report errors during cleanup.

**Call relations**: This runs automatically when Rust drops the Engine, including after install_wfp_filters_for_account finishes or exits early with an error.

*Call graph*: 1 external calls (FwpmEngineClose0).


##### `Transaction::commit`  (lines 151–156)

```
fn commit(&mut self) -> Result<()>
```

**Purpose**: Finalizes a WFP transaction so Windows keeps the changes made inside it. Without this commit, the transaction cleanup code will abort the batch.

**Data flow**: It reads the engine handle from the transaction, asks Windows to commit the transaction, checks the result, and marks the transaction as committed. It returns success or an error.

**Call relations**: The installation flow calls this after all provider, sublayer, and filter changes have succeeded. It uses ensure_success to interpret the Windows status.

*Call graph*: calls 1 internal fn (ensure_success); 1 external calls (FwpmTransactionCommit0).


##### `Transaction::drop`  (lines 160–166)

```
fn drop(&mut self)
```

**Purpose**: Aborts an unfinished WFP transaction automatically. This is a safety net: if setup fails midway, partial firewall changes are rolled back.

**Data flow**: It checks whether the transaction was marked as committed. If not, it asks Windows to abort the transaction. It does not return anything.

**Call relations**: This runs automatically when the Transaction object leaves scope. It complements Transaction::commit: commit marks the batch as done, while drop cleans up any uncommitted batch.

*Call graph*: 1 external calls (FwpmTransactionAbort0).


##### `UserMatchCondition::for_account`  (lines 176–213)

```
fn for_account(account: &str) -> Result<Self>
```

**Purpose**: Builds the WFP condition data that says “this filter applies to this Windows account.” This keeps the sandbox rules scoped to the sandbox user instead of affecting everyone on the machine.

**Data flow**: It receives an account name, converts it to Windows wide-character text, builds an access rule for WFP filter matching, asks Windows to turn that into a security descriptor, and stores that descriptor as a byte blob WFP can attach to a filter condition. It returns a UserMatchCondition or an error.

**Call relations**: install_wfp_filters_for_account calls this once before adding filters. Later, add_filter passes the object into build_conditions so every relevant filter can include the same user-account match.

*Call graph*: calls 1 internal fn (ensure_success); called by 1 (install_wfp_filters_for_account); 7 external calls (new, to_wide, zeroed, null, null_mut, BuildExplicitAccessWithNameW, BuildSecurityDescriptorW).


##### `UserMatchCondition::drop`  (lines 217–223)

```
fn drop(&mut self)
```

**Purpose**: Frees the Windows security descriptor allocated for a user-match condition. This avoids leaking memory provided by a Windows security API.

**Data flow**: It checks whether the stored security descriptor pointer is non-null. If there is memory to free, it gives that pointer back to Windows’ LocalFree function.

**Call relations**: This runs automatically when the UserMatchCondition is no longer needed, usually after filter installation finishes or fails.

*Call graph*: 2 external calls (is_null, LocalFree).


##### `ensure_provider`  (lines 227–243)

```
fn ensure_provider(engine: HANDLE) -> Result<()>
```

**Purpose**: Makes sure the persistent Codex WFP provider exists. A provider is the named owner Windows uses to group firewall objects created by this project.

**Data flow**: It prepares the provider’s name, description, stable identifier, and empty provider data, then asks Windows to add it. If Windows says it already exists, that is treated as success; other failures become errors.

**Call relations**: install_wfp_filters_for_account calls this before adding filters. It uses empty_blob for unused data fields and ensure_success_or because “already exists” is an acceptable result.

*Call graph*: calls 2 internal fn (empty_blob, ensure_success_or); called by 1 (install_wfp_filters_for_account); 4 external calls (new, to_wide, null_mut, FwpmProviderAdd0).


##### `ensure_sublayer`  (lines 246–264)

```
fn ensure_sublayer(engine: HANDLE) -> Result<()>
```

**Purpose**: Makes sure the persistent Codex WFP sublayer exists under the Codex provider. A sublayer is a grouping and ordering bucket for filters inside WFP.

**Data flow**: It builds the sublayer name, description, stable identifier, provider link, empty data, and ordering weight, then asks Windows to add it. If it is already present, the function still succeeds.

**Call relations**: install_wfp_filters_for_account calls this after ensuring the provider. It uses empty_blob for unused data and ensure_success_or to accept the normal “already exists” case.

*Call graph*: calls 2 internal fn (empty_blob, ensure_success_or); called by 1 (install_wfp_filters_for_account); 4 external calls (new, to_wide, null_mut, FwpmSubLayerAdd0).


##### `add_filter`  (lines 267–305)

```
fn add_filter(
    engine: HANDLE,
    spec: &FilterSpec,
    user_condition: &UserMatchCondition,
) -> Result<()>
```

**Purpose**: Adds one blocking WFP filter from the project’s static filter specification. This is where a compact project rule becomes a real Windows firewall rule.

**Data flow**: It receives the WFP engine handle, one filter specification, and the user-match condition. It converts the filter’s name and description for Windows, builds the detailed WFP conditions, fills in a filter structure that blocks matching traffic, and asks Windows to add it. It returns success or an error.

**Call relations**: install_wfp_filters_for_account calls this once for each filter after deleting any old copy. It relies on build_conditions for the match rules, empty_blob and empty_value for unused WFP fields, zero_guid for an empty action field, and ensure_success for the Windows result.

*Call graph*: calls 5 internal fn (build_conditions, empty_blob, empty_value, ensure_success, zero_guid); called by 1 (install_wfp_filters_for_account); 5 external calls (new, to_wide, format!, null_mut, FwpmFilterAdd0).


##### `build_conditions`  (lines 308–343)

```
fn build_conditions(
    specs: &[ConditionSpec],
    user_condition: &UserMatchCondition,
) -> Vec<FWPM_FILTER_CONDITION0>
```

**Purpose**: Turns the project’s small condition descriptions into the exact WFP condition structures Windows expects. Conditions are the “when this rule applies” part of a filter.

**Data flow**: It receives a list of condition specs and the prepared user condition. For each spec, it creates a WFP condition: match the sandbox user, match an IP protocol number, or match a remote port. It returns a vector of ready-to-use WFP condition records.

**Call relations**: add_filter calls this while assembling a full WFP filter. The returned conditions are attached directly to the Windows filter structure before it is submitted.

*Call graph*: called by 1 (add_filter); 1 external calls (iter).


##### `delete_filter_if_present`  (lines 346–353)

```
fn delete_filter_if_present(engine: HANDLE, key: &GUID) -> Result<()>
```

**Purpose**: Removes an existing filter with a known key before adding the current version. This keeps reinstalling filters clean and prevents stale definitions from lingering.

**Data flow**: It receives the engine handle and a filter identifier, asks Windows to delete that filter, and treats “filter not found” as success. Other unexpected failures are returned as errors.

**Call relations**: install_wfp_filters_for_account calls this before add_filter for each known specification. It uses ensure_success_or because missing old filters are normal during a first install.

*Call graph*: calls 1 internal fn (ensure_success_or); called by 1 (install_wfp_filters_for_account); 1 external calls (FwpmFilterDeleteByKey0).


##### `ensure_success`  (lines 355–357)

```
fn ensure_success(result: u32, operation: &str) -> Result<()>
```

**Purpose**: Checks a Windows API result where only zero means success. It gives the rest of the file a simple way to turn raw status codes into ordinary errors.

**Data flow**: It receives a numeric result code and an operation name. It forwards them to ensure_success_or with no extra allowed error codes, and returns success or an error.

**Call relations**: Engine::open, Engine::begin_transaction, Transaction::commit, UserMatchCondition::for_account, and add_filter use this after Windows calls that should succeed plainly.

*Call graph*: calls 1 internal fn (ensure_success_or); called by 5 (begin_transaction, open, commit, for_account, add_filter).


##### `ensure_success_or`  (lines 359–368)

```
fn ensure_success_or(result: u32, operation: &str, allowed: &[u32]) -> Result<()>
```

**Purpose**: Checks a Windows API result while allowing selected nonzero codes to count as acceptable. This is useful for idempotent setup, where “already exists” or “not found” may be fine.

**Data flow**: It receives a result code, an operation name, and a list of allowed nonzero codes. If the result is zero or on the allowed list, it returns success; otherwise it formats the code and returns an error message naming the failed operation.

**Call relations**: ensure_success uses this for strict checks. ensure_provider, ensure_sublayer, and delete_filter_if_present use it when some Windows responses are expected and should not stop setup.

*Call graph*: called by 4 (delete_filter_if_present, ensure_provider, ensure_sublayer, ensure_success); 1 external calls (anyhow!).


##### `format_error_code`  (lines 370–372)

```
fn format_error_code(result: u32) -> String
```

**Purpose**: Formats a Windows error code in a consistent hexadecimal form. This makes failure messages easier to search for in Windows documentation or logs.

**Data flow**: It receives a numeric result code and returns text like a zero-padded hexadecimal value.

**Call relations**: ensure_success_or uses this when it needs to build an error message for an unexpected Windows failure.

*Call graph*: 1 external calls (format!).


##### `empty_blob`  (lines 374–379)

```
fn empty_blob() -> FWP_BYTE_BLOB
```

**Purpose**: Creates an empty WFP byte blob for fields where Windows requires a blob structure but this project has no data to attach.

**Data flow**: It produces a blob with size zero and a null data pointer. No input is needed.

**Call relations**: ensure_provider, ensure_sublayer, and add_filter use this when filling WFP structures that include optional provider data.

*Call graph*: called by 3 (add_filter, ensure_provider, ensure_sublayer); 1 external calls (null_mut).


##### `empty_value`  (lines 381–386)

```
fn empty_value() -> FWP_VALUE0
```

**Purpose**: Creates an empty WFP value for filter fields that are intentionally left unspecified. This is a small helper for satisfying the Windows structure layout.

**Data flow**: It produces a WFP value marked as empty, with its storage zeroed. No input is needed.

**Call relations**: add_filter uses this for the filter weight fields when it wants Windows to use the default or computed behavior rather than a specific value.

*Call graph*: called by 1 (add_filter); 1 external calls (zeroed).


##### `zero_guid`  (lines 388–390)

```
fn zero_guid() -> GUID
```

**Purpose**: Returns an all-zero GUID, which is a globally unique identifier value used here as an empty placeholder. It helps fill a Windows structure field that is not meaningful for this blocking action.

**Data flow**: It takes no input and returns a GUID made from the number zero.

**Call relations**: add_filter uses this while building the WFP action structure for a blocking filter.

*Call graph*: called by 1 (add_filter); 1 external calls (from_u128).


##### `tests::filter_keys_are_unique`  (lines 399–412)

```
fn filter_keys_are_unique()
```

**Purpose**: Checks that every static filter has a unique stable identifier. Unique keys matter because Windows uses them to find, delete, and replace the right filter.

**Data flow**: It reads all filter specifications, converts each GUID into comparable pieces, stores them in a set that removes duplicates, and asserts that the set size matches the number of filters.

**Call relations**: This test protects install_wfp_filters_for_account and delete_filter_if_present from ambiguous filter identities before the code ever runs against Windows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::filter_names_are_unique`  (lines 415–421)

```
fn filter_names_are_unique()
```

**Purpose**: Checks that every static filter has a unique human-readable name. This keeps WFP entries clearer for administrators and debugging tools.

**Data flow**: It reads all filter names, stores them in a duplicate-removing set, and asserts that the number of unique names equals the number of filter specifications.

**Call relations**: This test supports add_filter by ensuring the display names it sends to Windows are not accidentally reused.

*Call graph*: 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/wfp_setup.rs`

`orchestration` · `elevated setup`

This file is about installing WFP filters, where WFP means Windows Filtering Platform, the Windows system used to allow or block network traffic. For the sandbox, these filters are important because they help control what the sandboxed account can reach on the network. Without this step, the sandbox might not get the intended network restrictions.

The main public entry point is `install_wfp_filters`. It asks another part of the crate to install the filters for a specific offline Windows account. It then turns the result into a small metric record: success with a count of installed filters, or failure with an error message. The code catches panics, which are sudden crashes inside Rust code, so a broken WFP step does not bring down the whole elevated setup helper.

After installation, the file tries to send a metric through OpenTelemetry, a standard way to report operational data. Here it sends only Statsig metrics, not traces or other exporters, because this helper runs in a limited setup path. Metric tag values are cleaned before sending so account names or error messages do not contain unsafe or overly messy values.

An important behavior is that metric reporting is also protected. If sending the metric fails or panics, the file logs that problem and moves on. In short, this file treats WFP setup as important enough to record carefully, but not important enough to stop all setup work if something goes wrong.

#### Function details

##### `panic_payload_to_string`  (lines 28–36)

```
fn panic_payload_to_string(panic_payload: Box<dyn std::any::Any + Send>) -> String
```

**Purpose**: This function turns a Rust panic payload into readable text for logs and metrics. A panic payload can be different kinds of data, so this gives the rest of the file a safe, simple error message to use.

**Data flow**: It receives the raw value carried by a panic. It first checks whether that value is an owned string, then whether it is a static string slice, and if neither fits it falls back to a generic message. It returns one plain string describing the panic as best it can.

**Call relations**: When WFP installation or metric emission panics, `install_wfp_filters` and `emit_wfp_setup_metric_safely` call this helper before logging the problem. It acts like a translator between Rust's low-level panic data and human-readable setup logs.

*Call graph*: called by 2 (emit_wfp_setup_metric_safely, install_wfp_filters).


##### `build_wfp_metrics_provider`  (lines 38–62)

```
fn build_wfp_metrics_provider(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
) -> Result<Option<OtelProvider>>
```

**Purpose**: This function creates the metrics reporting object used only for WFP setup. If metrics settings were not provided, it simply says there is no provider to use.

**Data flow**: It receives the Codex home folder path and optional Statsig metrics settings. If the settings are absent, it returns `None`. If they are present, it builds OpenTelemetry settings with the WFP setup service name, package version, Codex home path, and Statsig as the metrics exporter, then asks the telemetry library to create a provider. On success it returns that provider; on failure it returns an explanatory error.

**Call relations**: `emit_wfp_setup_metric` calls this before trying to send a success or failure counter. This function is the bridge between the small setup helper and the telemetry system, using only the limited Statsig environment passed in by the parent process.

*Call graph*: calls 1 internal fn (from); called by 1 (emit_wfp_setup_metric); 3 external calls (new, to_path_buf, env!).


##### `emit_wfp_setup_metric`  (lines 64–98)

```
fn emit_wfp_setup_metric(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
    metric: &WfpSetupMetric,
) -> Result<()>
```

**Purpose**: This function sends one metric saying whether WFP setup succeeded or failed. It includes useful labels, such as the target account and either the number of installed filters or the failure message.

**Data flow**: It receives the Codex home path, optional metrics settings, and a prepared WFP setup metric record. It builds a metrics provider if possible. If there is no provider, it returns without doing anything. If metrics are available, it cleans the target account value, chooses the success or failure counter, attaches the right tags, sends the counter, shuts the provider down, and returns success or an error from the telemetry layer.

**Call relations**: This is called by `emit_wfp_setup_metric_safely`, which wraps it in extra protection. It calls `build_wfp_metrics_provider` to get the reporting channel and `sanitize_setup_metric_tag_value` to make account names and error messages safe for metric tags.

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

**Purpose**: This function tries to send the WFP setup metric without letting metric reporting break setup. It logs metric failures or panics instead of returning them to the caller.

**Data flow**: It receives the Codex home path, optional metrics settings, the offline username, the metric record, and a logging callback. It runs `emit_wfp_setup_metric` inside a panic catcher. If sending succeeds, it does nothing else. If sending returns an error, it logs that error. If sending panics, it converts the panic into text and logs that too. It does not return a result and does not change the setup outcome.

**Call relations**: `install_wfp_filters` calls this after it has finished attempting WFP filter installation. This function sits between setup work and telemetry, making sure the optional reporting step cannot derail the main elevated setup flow.

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

**Purpose**: This is the public function that attempts to install Windows Filtering Platform rules for the sandbox account and records the outcome. It is designed to keep the broader elevated setup moving even if the WFP step fails or panics.

**Data flow**: It receives the Codex home path, the offline Windows username to configure, optional metrics settings, and a logging callback. It runs the actual filter installer inside a panic catcher. If installation succeeds, it logs success and creates a success metric with the number of filters installed. If installation returns an error, it logs the error and creates a failure metric. If installation panics, it converts the panic to text, logs it, and creates a failure metric marked as a panic. Finally, it asks `emit_wfp_setup_metric_safely` to report the metric without risking another crash.

**Call relations**: This is the main entry point in this file and is called by the surrounding elevated setup code when the sandbox account needs network filters. It delegates the real filter installation to `install_wfp_filters_for_account`, uses `panic_payload_to_string` when something crashes, and hands the final success-or-failure record to `emit_wfp_setup_metric_safely` for reporting.

*Call graph*: calls 2 internal fn (emit_wfp_setup_metric_safely, panic_payload_to_string); 3 external calls (format!, AssertUnwindSafe, catch_unwind).
