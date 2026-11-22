# CaliTracker — calisthenics log

In calisthenics you don't progress by adding weight. You progress by moving up a
**progression ladder** (tuck → advanced tuck → straddle → full), by **needing less band
assistance**, and by **holding longer** or doing more reps. CaliTracker logs exactly those things.

## Run

```bash
python3 serve.py
```

Open http://127.0.0.1:5173. To use it on your phone over the same Wi-Fi:
`python3 serve.py --host 0.0.0.0`, then open `http://<your-mac-ip>:5173` and "Add to Home Screen".

There are no dependencies and no build step. Data is stored in the browser (`localStorage`).
Use **History → Export JSON** for backups.

## What a set records

| Field | Example |
|---|---|
| Progression level | Front lever · L2 *Advanced tuck* |
| Bands (one or more) | Red 13 mm + Yellow 6 mm |
| Band mode | Assist (easier) or Resist (harder), plus optional added kg |
| Value | Hold seconds (statics, with a built-in hold timer) or reps |

## Progress logic

- Sets are ranked by **level first**, then **net assistance** (from each band's kg range),
  then **hold time / reps**.
- Starter progressions follow the r/bodyweightfitness progression chart (v5.4).
- An exercise is **ready to level up** when its goal hold time or reps (e.g. 15 s) is reached
  in 2 of the last 3 sessions at that level.
- The progress chart shows the best set per session. Shaded columns are levels, and each dot is
  colored by the band that assisted it, so you can watch the bands get lighter and then disappear.

## Files

- `js/data.js`: default bands, progression templates (with bar/rings equipment), all editable in the app
- `js/store.js`: state, persistence, ranking and readiness logic
- `js/app.js`: UI, hold timer, rest timer
- `css/styles.css`: theme (dark by default, light via system setting)
