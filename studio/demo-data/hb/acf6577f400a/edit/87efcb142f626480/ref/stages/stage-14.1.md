# Approval, guardian, and hook mediation  `stage-14.1`

This stage is the system’s gatekeeper and referee during the main work loop. Whenever the assistant wants to do something with real-world effects—run a command, edit files, use the network, or ask the user a question—this stage decides whether to allow it, pause for approval, get a second opinion, or stop it.

One part takes incoming “please ask” requests from tools and integrations and converts them into one standard form. The policy engine then checks written rules, sandbox limits (a restricted safety environment), and saved choices to decide what is allowed. If a case is sensitive, the guardian review system opens a special mini-session and asks a reviewer model to assess it safely.

Hooks are optional outside programs that can inspect key moments before or after actions. They can add warnings, block an action, or say it may continue. The orchestration and UI layer turns all of these decisions into clear approval dialogs, collects the user’s answer, and resumes the tool run with the right permissions. Finally, the enforcement runtimes make those decisions real by applying live network and Windows file-access restrictions.

## Sub-stages

- [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files
- [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files
- [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files
- [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files
- [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files
- [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files
