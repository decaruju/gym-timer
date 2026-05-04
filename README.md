# Training Timer

A simple, offline-first PWA for running gym/calisthenics workouts. Plan trainings,
schedule them on a calendar, and have a guided timer talk you through each step.

No backend — everything is stored locally in IndexedDB. Installs to your home screen.

## Terminology

The data model has three nested levels. The names are reused in the UI, so it
helps to keep them straight:

### Training
A named workout you can run end-to-end — e.g. *"Full body"*, *"Tabata"*,
*"Pull-up ladder"*. A training is a list of **exercises**, performed in order.
This is the unit you create in the **Trainings** view, schedule on the
calendar, and that shows up in **History** once completed.

### Exercise
One movement (or grouping of movements) within a training — e.g. *"Bench press"*,
*"Plank"*, *"Push / Pull Superset"*. An exercise is a list of **steps** plus a
`repeat` count, which is what most people would call **sets**:

- `repeat: 4` means the step list is performed 4 times back-to-back.
- `skipLastRest: true` drops a trailing rest step on the final repetition so
  you don't sit through a rest after the exercise ends.

So when the app says *"set 2 of 4"* during a run, it's referring to the current
iteration of the exercise's step list.

### Step (a.k.a. training step)
The atomic unit the timer ticks through. Each step has a `type`:

- **`timed`** — hold/perform for a fixed duration (e.g. 60s plank).
- **`reps`** — perform a number of repetitions; advances when you tap *Next*.
  Optionally `weighted` with a `plannedWeight` (kg).
- **`rest`** — a countdown rest period between sets or exercises.

Timed and reps steps can also enable a **Metronome**: enter a BPM (e.g. 180
for run cadence, or a tempo for lifting) and a click track plays for the
duration of that step.

A run plays steps in order: for each exercise, the step list is unrolled
`repeat` times, producing the full sequence of timed/reps/rest steps that
make up the session.

### Quick mental model

```
Training
└── Exercise            (repeat: N  ← "sets")
    └── Step            (timed | reps | rest)
```

## Views

- **Schedule** — calendar + weekly recurring slots. Tap a day to plan a
  training, or use *Next up* to jump into the next scheduled session.
  Days you've trained are marked; you can also **freeze** a day to count
  it toward your streak without training (limited use), or it gets
  un-frozen automatically if you do train that day.
- **Trainings** — list of your trainings. Create from scratch or from a
  built-in template (Tabata, 5×5, Pull-up ladder, etc.). Tap a training to
  edit its exercises and steps.
- **History** — stats, streak, achievements, recent completed sessions, and
  app settings (prep countdown, JSON export/import).
- **Run** — the guided timer. Appears while a training is in progress;
  swipe between Run / Schedule / Trainings / History. Speaks each step,
  beeps on transitions, and supports pause / next.

## Usage

1. Open `index.html` (or the deployed URL) in a modern browser.
2. **Create a training**: *Trainings → + New training*, pick a template or
   start blank, add exercises and steps, set `repeat` for each exercise.
3. **Schedule it** *(optional)*: *Schedule → + Add slot* for a weekly
   recurring slot, or tap a calendar day to plan a one-off.
4. **Run it**: from Schedule's *Next up*, or *Trainings → tap a training →
   Run*. Tap *Next / Done* to advance reps steps; timed and rest steps
   advance automatically.
5. **Enable notifications** on the Schedule view to get reminders for
   upcoming slots.
6. **Install** the PWA via the *Install* button (or your browser's
   install prompt) for a standalone app experience.

## Data & backup

All state (trainings, schedule, history, settings, frozen days) lives in
IndexedDB under the `training-timer` database. Use **History → Export JSON**
to back up, and **Import JSON** to restore or migrate to another device.

## Development

It's plain HTML/CSS/JS — no build step.

- `index.html` — markup and view containers.
- `app.js` — all logic (state, IndexedDB, rendering, run loop, TTS, beeps).
- `styles.css` — styling.
- `service-worker.js` — offline cache.
- `manifest.json` — PWA manifest.
- `tunnel.sh` — convenience script to expose a local server (handy for
  testing on a phone over the LAN / a tunnel).

To iterate, just serve the directory (e.g. `python3 -m http.server`) and
reload. The service worker auto-reloads the page when a new version takes
control; bump the `?v=` query strings in `index.html` when shipping a
breaking asset change.
