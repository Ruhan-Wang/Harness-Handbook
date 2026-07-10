# System Handbook

## 🗺️ System Overview

This system is a Rust-based assistant platform with several faces: a command-line tool, a full-screen terminal app, and server-style components that other programs can talk to. A good mental picture is a workshop with one shared engine in the middle. Different doors lead in, but inside they all use the same machinery.

When it starts, it first figures out what kind of run you asked for. It reads the command line, notices which helper name it was launched as, and picks the right mode. Before doing anything important, it hardens the process for safety, sets up secure networking, and prepares its async runtime, which is the task system that lets it juggle many jobs at once.

Next it learns its surroundings: where it is installed, where its home folder and databases live, what operating system and terminal it is in, and which local tools are available. It then builds the final startup plan by merging settings from files, command-line options, and built-in defaults. If needed, it signs the user in and checks what account and permissions are available.

After that, it opens local storage, repairs or updates databases if needed, and refreshes information from the outside world such as model catalogs, cloud config, plugins, and local model servers. It brings up communication channels, then starts either an interactive session for a person or a one-shot execution flow for scripts.

From there, the system enters its main loop. It listens for user input, server requests, and background events. For each turn, it gathers the right context, asks the model for help, runs approved tools like shell commands or file edits, and may even spin up helper agents for side tasks. Then it saves the results, rebuilds the visible thread or session state, and updates the terminal, logs, or API clients.

When shutting down, it stops accepting new work, lets active tasks finish when possible, cleans up connections, and saves final state. Throughout all of this, shared support handles networking, data formats, storage, logging, tracing, error handling, and tests that keep the whole system reliable.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
