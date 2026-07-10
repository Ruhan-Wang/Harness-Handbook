# Approval, guardian, and hook mediation  `stage-14.1`

This stage is the system’s checkpoint and referee. It sits in the main work path whenever the program wants to do something with real side effects, like run a command, reach the network, change files, or ask an outside helper program to weigh in. Its job is to decide whether to allow the action, ask someone, review it more carefully, or stop it.

One part is the policy engine. It reads approval rules, combines them with the current sandbox and permission settings, and gives the first answer: allow, ask, or block. If a human decision is needed, the request-ingress pieces turn many incoming request types into one standard approval request. Then the guardian review system prepares a clear summary, starts or reuses a focused review session, and records the result.

Hooks are like plug-in checkpoints. The hook runner discovers configured hook programs, runs the ones that match an event, and interprets replies such as continue, stop, or add context.

Around this, the tool orchestrator and UI make approval prompts understandable and keep risky tool actions paused until a decision is made. Finally, the enforcement runtime turns those decisions into real behavior by applying live network and Windows sandbox restrictions.

## Sub-stages

- [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files
- [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files
- [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files
- [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files
- [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files
- [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files
