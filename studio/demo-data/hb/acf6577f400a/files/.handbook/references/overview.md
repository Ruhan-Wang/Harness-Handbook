# System Handbook

## 🗺️ System Overview

This system is a Rust application that can wear several faces. You can use it as an interactive terminal chat app, a one-shot command-line tool, a background app server, a remote execution helper, or a set of developer utilities. A good mental picture is a workshop with one shared engine in the back and several front doors. No matter which door you enter, the system prepares the same core machinery for talking with models, running tools, saving work, and showing results.

At startup, the program first decides which mode was requested from the command name and flags. It then hardens the process, sets up secure networking, finds the user’s Codex home folder, inspects the local machine, and loads layered configuration from policy, project files, user settings, and command-line options. It checks who the user is, prepares local databases, refreshes model and plugin catalogs, and starts any needed servers or sidecar helpers. If the user opens the terminal interface, it draws the screen and resumes or creates a chat. If a script runs exec mode, it prepares one controlled session and predictable output.

During normal work, events flow through a central dispatch loop. Keyboard input, server requests, and automation messages are routed to live conversation threads. Before each model turn, the system builds a prompt from the chat history, project instructions, permissions, tools, memories, plugins, and current workspace facts. It sends that package to a model service, streams the answer back, and safely handles any requested actions. Commands, file edits, web or plugin calls, and background agents pass through approval and sandbox rules before they can affect the outside world.

As work happens, the system saves transcripts, summaries, tool results, thread state, and visible UI updates. When a session or server ends, it blocks new work, lets safe tasks finish, flushes state, stops agents, and releases connections.

Behind the scenes, shared contracts keep every part speaking the same message language. Networking, storage, telemetry, diagnostics, utilities, and tests support the whole lifecycle, like wiring, filing cabinets, gauges, and inspection tools for the workshop.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
