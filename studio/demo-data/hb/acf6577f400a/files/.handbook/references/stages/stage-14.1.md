# Approval, guardian, and hook mediation  `stage-14.1`

This stage is the system’s execution gatekeeper in the main loop: whenever a tool, hook, MCP client, or internal subsystem wants to perform a side effect, these components decide whether it may run immediately, must be reviewed, or must be blocked, then carry that decision through to UI and runtime enforcement.

Permission and elicitation ingress is the entry point, accepting request_permissions and user-input requests from tools and MCP adapters and turning them into session-level approval operations. Approval policy and request-decision engines then evaluate command, network, patch, and sandbox requests against configured rules, legacy compatibility paths, caches, and heuristics to produce concrete approval requirements. If review is needed, guardian review and mediated approval sessions package the request, open a constrained nested review session, and return an allow/deny result with retries, metrics, and circuit-breaker protection.

Hook execution and stop-continue mediation runs alongside this path, discovering applicable hooks around turns, tools, compaction, and permission events, then translating hook outputs into continue, stop, rewrite, or approval decisions. Approval-mediated tool orchestration and approval UI connect these backend decisions to actual tool execution and user-facing prompts. Finally, approval-adjacent enforcement runtimes apply approved policy live through network proxying and Windows sandbox or firewall enforcement.

## Sub-stages

- [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files
- [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files
- [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files
- [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files
- [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files
- [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files
