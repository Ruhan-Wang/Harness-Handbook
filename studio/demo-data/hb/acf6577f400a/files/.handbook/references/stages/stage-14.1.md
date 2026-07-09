# Approval, guardian, and hook mediation  `stage-14.1`

This stage is the system’s safety and permission hub. It sits mostly in the main work loop, just before the assistant does something with side effects, such as running a command, editing files, using the network, calling an external tool, or stopping a session.

Its policy engines are the rulebook. They read configured rules and decide whether an action is allowed, denied, or needs a prompt. Guardian review is the careful supervisor: for risky requests, it can run a separate review session and turn that review into a clear yes, no, timeout, or abort. Hook mediation is the checkpoint network. It discovers trusted user hooks, runs them at moments like prompt submit or tool use, and turns their output into “continue,” “block,” “warn,” or “change this” decisions.

Permission ingress is the front desk for “may I?” requests from the model or connected MCP tools. Tool orchestration and the approval UI then show requests to the user and route answers back. Finally, enforcement runtimes make decisions real by limiting network access and sandbox behavior while commands run.

## Sub-stages

- [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files
- [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files
- [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files
- [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files
- [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files
- [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files
