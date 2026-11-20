# Building the check

The check is a command. Its last line of output is the score as a bare number.
Exit non-zero only when the check itself broke, not when the score is bad.
Everything else it prints is for you to read when a step fails.

Before you write one, run `climb.py kits "<goal words>"`. A kit from an
earlier climb is often most of the check you need.

Write what the check produces, like screenshots or reports, under
`.hill-climb/<name>/`, and overwrite it each run. `try` commits every other new
file on a kept step and deletes it on an undone one. Big inputs, like a copy
of real data, go under `.hill-climb/<name>/data/`, which kits skip.

`$JUDGE` below is the absolute path of `scripts/judge.py`, next to `climb.py`.

## Exact match: ports, rewrites, clones

This is the strongest check there is. Run the same inputs through the real
tool and through yours and compare.

1. Pin the reference tool's version. A moving reference makes a moving target.
2. Collect real inputs, the more boring and varied the better. Real projects
   beat toy files. Add broken inputs too, like real code with random errors
   injected, so the error output must match as well.
3. Record the reference outputs once into `fixtures/expected/`. Lock that folder.
4. Score: the percent of cases whose output matches byte for byte, after you
   normalize only what truly doesn't matter, like absolute paths or timestamps.
   Write the normalizer before the climb and lock it with the check.
5. Keep about 20% of the inputs as the holdout.

```sh
#!/bin/sh
pass=0; total=0
for input in fixtures/inputs/*; do
  total=$((total + 1))
  name=$(basename "$input")
  ./target/release/mytool "$input" 2>&1 | ./scripts/normalize |
    cmp -s - "fixtures/expected/$name.txt" && pass=$((pass + 1))
done
echo "$pass of $total match"
awk "BEGIN { print 100 * $pass / $total }"
```

When it matches, climb speed next, with the match check as a guard.

## Tests: bugs and features

Write the tests from the spec or the bug report before you look at a fix.
Tests written after the fix tend to test the fix and nothing more. Score with
the count of failing tests, since a bare pass or fail gives the climb nothing
to climb. Read the count from the runner's own summary with `--score`, so no
wrapper is needed:

| Runner | `--score` |
| --- | --- |
| pytest, vitest, jest, rspec | `'(\d+) failed'` |
| Python unittest | `'failures=(\d+)\|errors=(\d+)'` |
| node --test | `'ℹ fail (\d+)'` |
| cargo test | `'(\d+) failed;'` |

Run the suite once and look at its summary line before you pick one. When
a runner prints one line per failure and no total, like `go test`, count
the lines instead, without `--score`:
`--check "go test ./... 2>&1 | grep -c '^--- FAIL' ; true"`. The `; true`
keeps a count of 0 from failing the check.

Init with `--direction min --target 0`. A passing run with no match scores
0. A run that exits non-zero and prints no match breaks the step. But a
crash can still print a smaller count, like one import error in place of
five failures. So always guard with the tests that pass today, kept apart
from the new failing tests, or with a build or typecheck. `init` warns
when a failing count has no guard.

**Audits and "make it stable".** The same check works for an open goal. The
list of tests grows as the climb finds bugs:

1. Write the scenarios the goal covers into `notes.md`, as a checklist.
2. Send read-only helpers to hunt, one area each. Each real finding becomes
   one failing test, in the locked test folder.
3. `relock --why "found <bug>"` after you add tests. The score rises for an
   honest reason, and the log records why.
4. Fix one finding per step with `try`.
5. Stop when the count is 0 and a last hunt finds nothing new.

Keep each step's check to the affected tests, and the full suites as guards.

## Benchmarks: speed, memory, size

- First see if a count can stand in for the clock. See "Fast checks".
- Measure the real workload, not a micro benchmark that is easy to game.
- Measure in the conditions I named. For "fast on bad wifi", put a proxy
  with fixed latency, loss, and bandwidth between client and server, like
  `toxiproxy` or a small script. A fast local network hides every round trip.
  Count the round trips and bytes through that proxy as the per-step score,
  and keep the timed run for the holdout.
- Vary the input each run, for example shuffle or reseed it, so the answer
  can't be memorized. Check the result against the reference in the same run.
- Init with `--runs 3` or more. The script discards one warm-up run and takes
  the median. Set `--min-gain` above the spread init reports.
- On a shared machine, add `--paired`.
- Always add the correctness check as a guard. A faster wrong answer is a loss.

```sh
#!/bin/sh
./build.sh >/dev/null 2>&1 || exit 1
start=$(python3 -c 'import time; print(time.time())')
./build.sh >/dev/null 2>&1 || exit 1
python3 -c "import time; print(round(time.time() - $start, 3))"
```

## Several goals at once

When I ask for several things, like "sync 3x faster and reconnect 2x faster",
build one check that times all of them in one run. Score each as its time
over its bar and print the worst one. A step then wins only when it helps the
goal that is furthest behind:

```sh
#!/bin/sh
node .hill-climb/sync/bench.mjs > .hill-climb/sync/last.json || exit 1
python3 -c '
import json
r = json.load(open(".hill-climb/sync/last.json"))
bars = {"sync": 400, "load": 250, "reconnect": 300}
for k in bars: print(k, r[k], "bar", bars[k])
print(max(r[k] / bars[k] for k in bars))'
```

Init with `--direction min --target 1`. The score reaches 1 when every goal
meets its bar. Keep each goal's number in the output, so the report can show
each one.

## Judge panel: look, feel, writing

When nothing can be checked exactly, use other models as judges. For example,
take screenshots of fixed app states and have a panel compare them with
screenshots of the reference.

1. **Fix the states.** The same seed, camera, input replay, window size, and
   page. A screenshot of a random moment can't be compared with an earlier one.
2. **Collect references.** Screenshots of the real thing in the same states,
   or the best examples of the writing or design I want.
3. **Write the rubric.** Name what to look at and what a 10, 7, and 4 look
   like. Specific beats general. "The save button reads clearly on a dark
   background" beats "it looks good".
4. **Score with `scripts/judge.py`.** It runs the judges in parallel, takes
   the median, and writes each judge's worst gap and next fix to
   `.hill-climb/judge-notes.md`. Read those notes before every step. They are
   your best source of ideas.

```sh
#!/bin/sh
node scripts/capture-states.js .hill-climb/ui/shots || exit 1
python3 "$JUDGE" --rubric .hill-climb/ui/rubric.md \
  --candidate .hill-climb/ui/shots --reference refs/ui --rounds 2
```

Rules for judges:

- Use judges from more than one provider. A model grading its own family's
  work is too kind. The default panel is `claude,codex`.
- Use `--rounds 2` or more and set `--min-gain` to at least 0.5. Judges are noisy.
- Never show judges which version is new. They grade the candidate against
  the references and the rubric, nothing else.
- Every judge call costs tokens on every step. Capture at most 1280 px wide,
  and only the states the rubric names. Pick a cheaper model with `--model`
  when it agrees with the default on 3 sample states.
- Lock the rubric and references. If the rubric is wrong, say so and relock.
- Look at the result yourself every few kept steps. Judges drift too.

When you can afford it, record real inputs once, like a click path or a
controller replay. Then replay them against both the reference and the
candidate and judge matching frames.

## Fast checks

Check time is the speed limit of the whole climb. Aim for under 2 minutes a
step. `init` warns when a step will take longer.

**Count the work instead of timing it.** A clock moves with the machine's
load. A count of the work behind the time gives the same number on every
run, takes seconds, and shows small wins a timer hides. Pick the count that
drives the time:

| Goal | Count |
| --- | --- |
| Fast on a slow or far network | Round trips on the critical path and bytes sent. Time ≈ round trips × latency + bytes ÷ bandwidth. |
| Fast page or app start | Requests, bytes of script, blocking work before the first paint |
| Fast queries or API | Queries per request, rows read, calls to other services |
| Fast compute | Instructions or allocations, from a profiler or a counter |
| Fewer renders or rebuilds | Render, rebuild, or cache-miss counts |
| Lower model cost | Tokens or model calls per task |

Write the count into the score with the same weights the real time would
give it, like `round_trips * 300 + kilobytes * 6` for 300 ms latency and 1.3
Mbit/s. Keep the real timed run as the holdout or a milestone check, so the
count can't drift away from what I want.

**Find the floor before the card.** From the counts, work out the best each
goal can reach with the current design, like "connect needs at least 4 round
trips, so 1.2 s at 300 ms". If a bar is below its floor, say so in the card
and propose a reachable bar or the design change that lowers the floor.
Don't climb toward a bar no step can reach.

**When only a clock will do**, make it fair:

- Use `--paired`. Each step then runs the best commit and the new code in
  turns (A B, B A, ...), so both see the same load, and the median of each
  side is compared. The step's score is the best score times new ÷ old, an
  estimate, so a plain rerun can differ by a few percent. This way
  the trail and the bar follow real gains, not load. Nothing needs
  remeasuring when the load changes. A step runs the check 2 × runs times,
  rounded up to even runs, and the score must never be 0. Untracked
  files are deleted before each switch, so keep caches the check needs in
  ignored paths.
- Pin what you can: one CPU core with `taskset`, a fixed seed, a warm cache.
- Time only the part that changed, not the setup around it.

Other wins:

- Run a fast sample on every step and the full suite as a guard only.
- Cache what doesn't change between steps, like the reference outputs or a
  built base. Reuse the existing dependency install. Don't copy it.
- Run independent cases in parallel.
- Split a slow build so only the changed part rebuilds.

When the check is slow because the machine is busy or small, that is a
blocker for me. Try every fix you can make first. Then ask with the question
tool, and say how long steps wait and what would fix it.
