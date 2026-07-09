# Approval, guardian, and hook mediation  `stage-14.1`

This stage is the system’s checkpoint and referee. It sits mostly in the main work loop, whenever the agent wants to do something with real effects, like run a command, edit files, or use the network. Its job is to decide whether to allow that action, ask first, run an extra review, let custom hook programs weigh in, and then enforce the final answer.

The permission-ingress pieces are the front door. They take approval or user-input requests from tools and integrations, clean them up, and turn them into one standard form. The approval-policy engines are the rulebook: they read saved rules and current safety settings, then decide allow, ask, or block.

If a request needs a second opinion, the guardian review session takes over. It prepares a focused review prompt, opens a tightly controlled side session, and returns a structured decision.

Hook mediation adds another checkpoint. Hooks are external helper programs. The system discovers them, runs the right ones for each event, and merges their replies into a stop, continue, or modify-context result.

Finally, the approval UI and orchestration show choices to the user and carry decisions into tool execution, while enforcement runtimes make those decisions real in network proxies and Windows sandbox protections.

## Sub-stages

- [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files
- [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files
- [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files
- [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files
- [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files
- [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files
