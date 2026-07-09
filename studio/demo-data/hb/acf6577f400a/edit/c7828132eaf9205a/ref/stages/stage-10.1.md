# Interactive event dispatch  `stage-10.1`

This stage is the terminal app’s live switchboard during normal use. After startup, while the user is typing, clicking through popups, switching conversations, and receiving backend updates, this is the part that catches each event and sends it to the right place.

At the bottom, `event_stream.rs` is the shared input broker: it gathers raw terminal events such as key presses, paste bursts, and redraw nudges into one common event stream the app can read. From there, app-level dispatch acts like traffic control. It interprets app-wide shortcuts, redraw requests, server messages, and background-task results, and routes them to the correct conversation thread or screen.

The bottom-pane composer and popup layer handle what the user is actively editing: normal message text, slash commands, “@” mention search, temporary overlays, and requests for extra user input. The chat widget then turns those interactions into concrete actions like sending a message, opening a command flow, restoring a draft, or showing warnings and approvals from the backend. Around that, smaller helper flows provide pickers, previews, imports, clipboard support, and platform-specific behavior. Together, these parts make the interface feel responsive and organized instead of chaotic.

## Sub-stages

- [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files
- [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files
- [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files
- [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

## Files in this stage

### Interactive event dispatch
### `tui/src/tui/event_stream.rs`

`io_transport` · `main loop`

This file contains the TUI’s event transport layer. `EventSource` abstracts a pollable source of `std::io::Result<crossterm::event::Event>`, with `CrosstermEventSource` as the production implementation and a fake source used in tests. `EventBroker` owns a `Mutex<EventBrokerState<S>>` plus a `watch::Sender<()>` used to wake paused consumers when input is resumed. Its state machine has three states: `Paused` means the underlying event source has been dropped to fully relinquish stdin, `Start` means a fresh source should be created on the next poll, and `Running(S)` holds the active source.

`TuiEventStream` combines three inputs: the shared brokered crossterm stream, a per-instance `BroadcastStream<()>` for draw requests, and a `WatchStream<()>` that wakes paused or pending polls when `resume_events` is called. `poll_crossterm_event` loops until it either maps a crossterm event into a `TuiEvent`, reaches `Pending`, or sees EOF/error. Unused events such as mouse input are skipped. Focus events update the shared `terminal_focused` atomic; focus gain also triggers a palette requery and yields `Draw`. On Unix, Ctrl-Z handling is embedded here: the stream pauses brokered input, calls `SuspendContext::suspend`, resumes input, logs failures, and emits a redraw. `poll_next` alternates whether draw or input is polled first, giving approximate fairness so neither source starves the other.

#### Function details

##### `EventBrokerState::active_event_source_mut`  (lines 65–77)

```
fn active_event_source_mut(&mut self) -> Option<&mut S>
```

**Purpose**: Returns a mutable reference to the active event source, lazily creating one when the broker is in `Start` state and returning none when paused.

**Data flow**: Mutably matches on `self`: `Paused` yields `None`; `Start` replaces itself with `Running(S::default())` and then returns `Some(&mut S)`; `Running(events)` returns `Some(events)` directly.

**Call relations**: Used by broker consumers and tests whenever they need access to the underlying source. It is the state-transition point from dormant `Start` into active polling.

*Call graph*: 3 external calls (default, Running, unreachable!).


##### `EventBroker::new`  (lines 81–87)

```
fn new() -> Self
```

**Purpose**: Constructs a broker with no active source yet and a watch channel for resume notifications.

**Data flow**: Creates a watch channel carrying unit values, initializes `state` to `EventBrokerState::Start`, stores the sender, and returns `Self`.

**Call relations**: Called by `Tui::new` in production and by test setup. Consumers later subscribe to its resume channel through `resume_events_rx`.

*Call graph*: called by 2 (new, setup); 2 external calls (new, channel).


##### `EventBroker::pause_events`  (lines 90–96)

```
fn pause_events(&self)
```

**Purpose**: Drops the underlying event source by switching broker state to paused.

**Data flow**: Locks the broker mutex, replacing the current `EventBrokerState` with `Paused`, and returns `()`. Any existing source is dropped when the state is overwritten.

**Call relations**: Called by `Tui::pause_events`, by Unix suspend handling inside event mapping, and by tests. It is the mechanism that fully relinquishes stdin.


##### `EventBroker::resume_events`  (lines 99–106)

```
fn resume_events(&self)
```

**Purpose**: Marks the broker to recreate its event source on the next poll and wakes paused listeners.

**Data flow**: Locks the state mutex, sets state to `Start`, sends `()` on `resume_events_tx`, and returns `()`. The send result is ignored.

**Call relations**: Called by `Tui::resume_events` and by Unix suspend handling after resume. Paused `TuiEventStream` instances poll the watch stream so this wakeup is observed.

*Call graph*: 1 external calls (send).


##### `EventBroker::resume_events_rx`  (lines 112–114)

```
fn resume_events_rx(&self) -> watch::Receiver<()>
```

**Purpose**: Creates a watch receiver that notifies consumers whenever input is resumed.

**Data flow**: Calls `self.resume_events_tx.subscribe()` and returns the new `watch::Receiver<()>`.

**Call relations**: Used by `TuiEventStream::new` to build its `resume_stream` wakeup source.

*Call graph*: 1 external calls (subscribe).


##### `CrosstermEventSource::default`  (lines 121–123)

```
fn default() -> Self
```

**Purpose**: Creates the production event source backed by `crossterm::event::EventStream`.

**Data flow**: Constructs `crossterm::event::EventStream::new()`, wraps it in `CrosstermEventSource`, and returns it.

**Call relations**: Used when `EventBrokerState::active_event_source_mut` transitions from `Start` to `Running` in production.

*Call graph*: 1 external calls (new).


##### `CrosstermEventSource::poll_next`  (lines 127–129)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<EventResult>>
```

**Purpose**: Forwards polling to the wrapped crossterm event stream.

**Data flow**: Pins the inner `EventStream` and returns its `Poll<Option<EventResult>>` unchanged.

**Call relations**: Called by `TuiEventStream::poll_crossterm_event` through the `EventSource` trait abstraction.

*Call graph*: 1 external calls (new).


##### `TuiEventStream::new`  (lines 152–171)

```
fn new(
        broker: Arc<EventBroker<S>>,
        draw_rx: broadcast::Receiver<()>,
        terminal_focused: Arc<AtomicBool>,
        #[cfg(unix)] suspend_context: crate::tui::job_control::Suspend
```

**Purpose**: Builds a merged event stream instance from a shared broker, a draw receiver, and shared focus/suspend state.

**Data flow**: Consumes the broker, draw receiver, terminal focus atomic, and on Unix suspend/alt-screen state; wraps the draw receiver in `BroadcastStream`, converts the broker’s resume watch receiver into a `WatchStream::from_changes`, initializes `poll_draw_first` to false, and returns `Self`.

**Call relations**: Constructed by `Tui::event_stream` in production and by `make_stream` in tests.

*Call graph*: called by 2 (event_stream, make_stream); 2 external calls (new, from_changes).


##### `TuiEventStream::poll_crossterm_event`  (lines 178–222)

```
fn poll_crossterm_event(&mut self, cx: &mut Context<'_>) -> Poll<Option<TuiEvent>>
```

**Purpose**: Polls the shared terminal input source until it yields a mapped `TuiEvent`, pauses cleanly, or terminates on EOF/error.

**Data flow**: Locks broker state, obtains an active source via `active_event_source_mut`; if paused, it polls `resume_stream` and returns `Pending` or retries on wake. If a source exists, it polls it: successful events are temporarily captured, errors/EOF reset broker state to `Start` and return `Ready(None)`, and pending also polls `resume_stream` so resume can wake the task. Captured events are passed through `map_crossterm_event`; unmapped events are skipped by looping again.

**Call relations**: Called by `poll_next` as one half of the merged stream. It is the key bridge between broker state management and event mapping.

*Call graph*: called by 1 (poll_next); 2 external calls (new, Ready).


##### `TuiEventStream::poll_draw_event`  (lines 225–234)

```
fn poll_draw_event(&mut self, cx: &mut Context<'_>) -> Poll<Option<TuiEvent>>
```

**Purpose**: Polls the draw-notification broadcast stream and maps any received signal into `TuiEvent::Draw`.

**Data flow**: Polls `draw_stream`; `Ok(())` becomes `Ready(Some(TuiEvent::Draw))`, lagged broadcast errors also become `Draw`, stream closure becomes `Ready(None)`, and pending stays pending.

**Call relations**: Called by `poll_next` as the other half of the merged stream. Treating lagged notifications as a single draw preserves redraw semantics without replaying every missed tick.

*Call graph*: called by 1 (poll_next); 2 external calls (new, Ready).


##### `TuiEventStream::map_crossterm_event`  (lines 237–269)

```
fn map_crossterm_event(&mut self, event: Event) -> Option<TuiEvent>
```

**Purpose**: Converts raw crossterm events into the smaller `TuiEvent` set used by the app, while updating shared focus state and handling Unix suspend.

**Data flow**: Matches on `Event`: `Key` becomes `TuiEvent::Key`, except on Unix when it matches `SUSPEND_KEY`, in which case the broker is paused, `suspend_context.suspend` is run, broker input is resumed, failures are logged, and `TuiEvent::Draw` is returned. `Resize` maps to `Resize`, `Paste` to `Paste`, `FocusGained` stores `true` in `terminal_focused`, re-queries default colors, and returns `Draw`; `FocusLost` stores `false` and returns `None`; all other events return `None`.

**Call relations**: Used only by `poll_crossterm_event`. It encapsulates all protocol-to-app event translation and side effects associated with focus and suspend.

*Call graph*: calls 1 internal fn (suspend); 4 external calls (requery_default_colors, warn!, Key, Paste).


##### `TuiEventStream::poll_next`  (lines 277–299)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements the merged stream’s polling strategy with simple round-robin fairness between draw and input sources.

**Data flow**: Reads and flips `poll_draw_first`, then polls draw first and input second or vice versa depending on the toggle. If either returns `Ready`, that result is returned immediately; if both are pending, it returns `Poll::Pending`.

**Call relations**: This is the `Stream` trait entrypoint used by the app loop. It delegates actual source polling to `poll_draw_event` and `poll_crossterm_event`.

*Call graph*: calls 2 internal fn (poll_crossterm_event, poll_draw_event); 1 external calls (Ready).


##### `tests::FakeEventSource::new`  (lines 329–332)

```
fn new() -> Self
```

**Purpose**: Creates a fake event source backed by an unbounded MPSC channel for deterministic tests.

**Data flow**: Creates an unbounded channel, stores the receiver and sender in `FakeEventSource`, and returns it.

**Call relations**: Used by test setup and by the fake source’s `Default` implementation.

*Call graph*: 1 external calls (unbounded_channel).


##### `tests::FakeEventSource::default`  (lines 336–338)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor required by the generic broker/stream test setup.

**Data flow**: Delegates to `FakeEventSource::new()` and returns the new fake source.

**Call relations**: Allows `EventBrokerState::active_event_source_mut` to lazily instantiate fake sources in tests.

*Call graph*: 1 external calls (new).


##### `tests::FakeEventSourceHandle::new`  (lines 342–344)

```
fn new(broker: Arc<EventBroker<FakeEventSource>>) -> Self
```

**Purpose**: Builds a handle object that can inject events into the broker’s currently running fake source.

**Data flow**: Stores the provided `Arc<EventBroker<FakeEventSource>>` in `Self` and returns it.

**Call relations**: Created by test setup and used by individual tests to feed synthetic events.


##### `tests::FakeEventSourceHandle::send`  (lines 346–356)

```
fn send(&self, event: EventResult)
```

**Purpose**: Injects an event into the active fake source if the broker currently has one running.

**Data flow**: Locks broker state, asks for `active_event_source_mut()`, returns early if paused, otherwise sends the provided `EventResult` through the fake source’s internal sender.

**Call relations**: Used by tests to simulate crossterm input without touching real stdin.


##### `tests::FakeEventSource::poll_next`  (lines 360–362)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<EventResult>>
```

**Purpose**: Implements `EventSource` for the fake source by polling its receiver.

**Data flow**: Pins the internal `UnboundedReceiver<EventResult>` and returns the result of `poll_recv(cx)`.

**Call relations**: Used by the generic `TuiEventStream` test instances in place of the real crossterm stream.

*Call graph*: 1 external calls (new).


##### `tests::make_stream`  (lines 365–379)

```
fn make_stream(
        broker: Arc<EventBroker<FakeEventSource>>,
        draw_rx: broadcast::Receiver<()>,
        terminal_focused: Arc<AtomicBool>,
    ) -> TuiEventStream<FakeEventSource>
```

**Purpose**: Constructs a `TuiEventStream<FakeEventSource>` with the right shared state for tests.

**Data flow**: Consumes the fake broker, draw receiver, and focus atomic; on Unix also creates a fresh `SuspendContext` and alt-screen atomic; then calls `TuiEventStream::new` and returns the stream.

**Call relations**: Helper used by all async tests in this module.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (new, new).


##### `tests::setup`  (lines 389–398)

```
fn setup() -> SetupState
```

**Purpose**: Creates a fully wired fake broker, injection handle, draw channel, and focus state for event-stream tests.

**Data flow**: Creates a `FakeEventSource`, a new broker, forcibly installs the source into broker state as `Running`, creates a `FakeEventSourceHandle`, allocates a broadcast draw channel, initializes `terminal_focused` to true, and returns the tuple.

**Call relations**: Shared fixture builder for the module’s async tests.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, channel, Running, new, new).


##### `tests::key_event_skips_unmapped`  (lines 401–418)

```
async fn key_event_skips_unmapped()
```

**Purpose**: Tests that unmapped events are skipped and the next mapped key event is yielded.

**Data flow**: Builds test state, sends `FocusLost` followed by a key event, awaits `stream.next()`, and asserts the yielded event is the expected `TuiEvent::Key`.

**Call relations**: Exercises the loop in `poll_crossterm_event` plus the `FocusLost -> None` mapping in `map_crossterm_event`.

*Call graph*: 7 external calls (Char, new, assert_eq!, panic!, Key, make_stream, setup).


##### `tests::draw_and_key_events_yield_both`  (lines 421–448)

```
async fn draw_and_key_events_yield_both()
```

**Purpose**: Tests that draw notifications and key input are both delivered, regardless of ordering.

**Data flow**: Creates a stream, sends one draw signal and one key event, awaits two items, then asserts one is `Draw` and the other is the expected key.

**Call relations**: Validates the merged-stream behavior and the round-robin polling strategy.

*Call graph*: 8 external calls (Char, new, assert!, assert_eq!, panic!, Key, make_stream, setup).


##### `tests::lagged_draw_maps_to_draw`  (lines 451–461)

```
async fn lagged_draw_maps_to_draw()
```

**Purpose**: Tests that a lagged broadcast receiver still produces a single draw event.

**Data flow**: Creates a resubscribed draw receiver, sends enough draw signals to force lag, awaits one stream item, and asserts it matches `Some(TuiEvent::Draw)`.

**Call relations**: Covers the `BroadcastStreamRecvError::Lagged` branch in `poll_draw_event`.

*Call graph*: 3 external calls (assert!, make_stream, setup).


##### `tests::resize_event_maps_to_resize`  (lines 464–472)

```
async fn resize_event_maps_to_resize()
```

**Purpose**: Tests that crossterm resize events are translated into `TuiEvent::Resize`.

**Data flow**: Injects `Event::Resize(80, 24)`, awaits the next stream item, and asserts it is `Some(TuiEvent::Resize)`.

**Call relations**: Directly exercises the resize branch of `map_crossterm_event`.

*Call graph*: 4 external calls (assert!, Resize, make_stream, setup).


##### `tests::error_or_eof_ends_stream`  (lines 475–483)

```
async fn error_or_eof_ends_stream()
```

**Purpose**: Tests that an event-source error causes the stream to terminate.

**Data flow**: Injects an `Err(io::Error::other("boom"))`, awaits the next item, and asserts it is `None`.

**Call relations**: Covers the error/EOF handling path in `poll_crossterm_event` that resets broker state and ends the current stream.

*Call graph*: 4 external calls (assert!, other, make_stream, setup).


##### `tests::resume_wakes_paused_stream`  (lines 486–507)

```
async fn resume_wakes_paused_stream()
```

**Purpose**: Tests that a stream blocked while paused wakes up after `resume_events` and can receive subsequent input.

**Data flow**: Pauses the broker, spawns a task awaiting `stream.next()`, yields to let it block, resumes events, injects a key event, waits with timeout for task completion, and asserts the resumed event is the expected key.

**Call relations**: Exercises the paused-state wakeup path through `resume_stream` in `poll_crossterm_event`.

*Call graph*: 11 external calls (from_millis, Char, new, assert_eq!, panic!, Key, spawn, yield_now, timeout, make_stream (+1 more)).


##### `tests::resume_wakes_pending_stream`  (lines 510–530)

```
async fn resume_wakes_pending_stream()
```

**Purpose**: Tests that a stream already pending on input also wakes correctly across a pause/resume cycle.

**Data flow**: Spawns a task awaiting `stream.next()`, yields so it reaches pending, then pauses and resumes the broker, injects a key event, waits with timeout, and asserts the task returns that key event.

**Call relations**: Covers the branch where `poll_crossterm_event` is pending on stdin and must still be woken by the resume watch stream.

*Call graph*: 11 external calls (from_millis, Char, new, assert_eq!, panic!, Key, spawn, yield_now, timeout, make_stream (+1 more)).
