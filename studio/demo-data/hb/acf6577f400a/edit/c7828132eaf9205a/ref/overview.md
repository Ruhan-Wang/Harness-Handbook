# System Handbook

## 🗺️ System Overview

This system is best pictured as one shared engine with several front doors. You can use it as a command-line tool, a full-screen text app in the terminal, or a background server that other programs talk to. No matter which door you enter, the same core runtime does the real work: managing conversations, calling models, running tools, saving results, and streaming updates back.

When the program starts, it first figures out which mode you asked for. Then it does early safety setup, chooses secure networking defaults, starts its async runtime, and works out its local home folder, install layout, and nearby helper tools. After that it gathers settings from built-in defaults, user files, project files, and command-line options, and turns those into exact rules about features, permissions, file access, and sandbox limits.

Next it checks who you are. If the system needs an account or token, it loads or refreshes that identity. It opens its local databases, repairs them if needed, and fetches fresh remote facts such as cloud settings, available models, plugins, and connectors. If this run needs server features, it opens communication channels such as standard input/output, local sockets, or WebSockets.

Then the user-facing session begins. In the terminal app, it prepares the screen and any onboarding steps. In one-shot exec mode, it builds a single request and runs it. From there, the system settles into a loop: accept input, route it to the right conversation thread, assemble the right context, ask a model for the next step, and, if needed, safely run commands or other tools with approvals and guardrails. It can also spin up helper agents for background or delegated tasks.

As work happens, it keeps a durable record in files and SQLite, updates live views, and sends notifications to clients. Underneath, shared networking, schemas, logging, tracing, analytics, caches, and utility libraries keep everything consistent. When it is time to stop, it blocks new work, lets active tasks finish, cleans up connections, saves final state, and shuts down cleanly.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
