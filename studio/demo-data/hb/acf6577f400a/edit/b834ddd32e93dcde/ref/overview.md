# System Handbook

## 🗺️ System Overview

This system is a Rust application that can show up in several forms: a command-line tool, a full-screen text app in the terminal, and a local server that other programs can talk to. A simple way to picture it is as one shared “engine room” with several different front doors.

When it starts, it first figures out which door you used and what mode you asked for. Then it makes the process safe, sets up secure networking, starts its async runtime, and works out where it is installed, where its home files live, and what tools and environment are available on this machine. After that, it gathers settings from defaults, files, and command-line options, turns broad rules into concrete permissions, and checks who you are by loading or refreshing sign-in details.

Next it opens its local storage, repairs or upgrades databases if needed, and fetches fresh outside information such as cloud settings, model lists, plugins, or connectors. If this run needs server features, it opens the message channels other programs use to talk to it. Then it starts the chosen user-facing session: either an interactive terminal interface or a one-shot “do this task and exit” command.

Once running, the system settles into a loop. It waits for input from the user, the terminal, or remote clients. It routes each request to the right conversation thread, rebuilds the right context, and assembles a prompt — the full briefing sent to the model. The model may answer directly or ask to use tools, such as running commands, editing files, searching, or calling outside services. Those actions go through safety checks, approval rules, and sandboxes, which are restricted environments. Results are saved, turned into visible updates, and streamed back to the screen or client.

When work ends, it stops accepting new requests, lets in-flight work finish, cleans up connections and background agents, saves final state, and shuts down cleanly. Behind all of this are shared foundations: common data formats, networking, storage, logging, tracing, analytics, utility libraries, and a large test harness that keeps the whole machine reliable.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
