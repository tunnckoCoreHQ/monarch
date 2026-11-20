#!/usr/bin/env python3
"""Keep score for a hill climb.

The agent edits code. This script runs the check, decides keep or undo,
commits kept steps, and writes the log. The model never grades itself.
"""

import argparse
import fcntl
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tarfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
NUMBER = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")
BARS = "▁▂▃▄▅▆▇█"
PLATEAU = 5
FILE_LIMIT = 512_000
KIT_LIMIT = 2_000_000
COMMIT_LIMIT = 10_000_000
STATE_WARN = 200_000_000
KIT_KEYS = ("name", "goal", "check", "direction", "guards", "holdout", "lock", "runs", "paired", "min_gain", "timeout", "after", "max_steps", "max_hours", "hard", "repos", "score", "baseline")
SLOW_STEP = 120
MORE = "Stop and report. If the user gives more, run: climb.py budget --hours N, --steps N, or --off"


class Fail(Exception):
    pass


def git(*args, check=True, cwd=None, index=None):
    env = {**os.environ, "GIT_INDEX_FILE": index} if index else None
    result = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd, env=env)
    if check and result.returncode:
        raise Fail(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def repo():
    return Path(git("rev-parse", "--show-toplevel"))


def climbs_dir():
    return repo() / ".hill-climb"


def checkouts(card):
    return [repo(), *(Path(extra["path"]) for extra in card.get("repos", []))]


def resolve(name):
    if name:
        folder = climbs_dir() / name
        if not (folder / "card.json").is_file():
            raise Fail(f"No climb named {name!r}. Run: climb.py list")
        return folder
    found = sorted(path.parent for path in climbs_dir().glob("*/card.json"))
    if len(found) != 1:
        raise Fail("Name the climb. Run: climb.py list" if found else "No climb yet. Run: climb.py init")
    return found[0]


def load(folder):
    card = json.loads((folder / "card.json").read_text())
    if isinstance(card["check"], str):
        card["check"] = [card["check"]]
    card["score"] = card.get("score") or []
    return card


def save(folder, card):
    (folder / "card.json").write_text(json.dumps(card, indent=2) + "\n")


def append(folder, row):
    row = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), **row}
    with (folder / "log.jsonl").open("a") as handle:
        handle.write(json.dumps(row) + "\n")


def rows(folder):
    path = folder / "log.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def tail(text, lines=15):
    return "\n".join(text.strip().splitlines()[-lines:])


def run(command, timeout):
    process = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        stdout = None
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if stdout is None:
        process.communicate()
        return None
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def together(commands, timeout):
    with ThreadPoolExecutor() as pool:
        return list(pool.map(lambda command: run(command, timeout), commands))


def read_score(result, pattern):
    text = ANSI.sub("", result.stdout + result.stderr)
    if pattern:
        lines = [line for line in text.splitlines() if re.search(pattern, line)]
        if lines:
            found = [group for match in re.finditer(pattern, lines[-1])
                     for group in (match.groups() if match.re.groups else [match.group()]) if group is not None]
            values = [value.replace(",", "") for value in found]
            if not all(NUMBER.fullmatch(value) for value in values):
                raise Fail(f"--score matched {found!r} in {lines[-1].strip()!r}, which is not a number")
            return sum(float(value) for value in values)
        if not result.returncode:
            return 0.0
        raise Fail(f"check exited {result.returncode} and printed nothing that matches --score\n{tail(text)}")
    if result.returncode:
        raise Fail(f"check exited {result.returncode}\n{tail(text)}")
    lines = ANSI.sub("", result.stdout).strip().splitlines()
    if not lines or not NUMBER.fullmatch(lines[-1].strip()):
        raise Fail(f"the last line of check output must be the score\n{tail(text)}")
    return float(lines[-1])


def measure(checks, runs, timeout, output=None, patterns=None):
    patterns = patterns or [None]
    if len(patterns) not in (1, len(checks)):
        raise Fail(f"Give one --score for all checks, or one per check: {len(patterns)} for {len(checks)} checks.")
    patterns = patterns * len(checks) if len(patterns) == 1 else patterns
    scores, seconds = [], []
    for attempt in range(runs + (runs > 1)):
        start = time.monotonic()
        results = together(checks, timeout)
        seconds.append(time.monotonic() - start)
        if output:
            output.write_text("\n".join(f"$ {command}\n{result.stdout}{result.stderr}" for command, result in zip(checks, results) if result))
        if None in results:
            raise Fail(f"check timed out after {timeout}s: {checks[results.index(None)]}")
        score = sum(read_score(result, pattern) for result, pattern in zip(results, patterns))
        if runs > 1 and attempt == 0:
            seconds.pop()
            continue
        scores.append(score)
    return statistics.median(scores), max(scores) - min(scores), sum(seconds) / len(seconds)


def switch_trees(trees):
    for path, tree in trees.items():
        git("clean", "-fdq", cwd=path)
        git("read-tree", "-u", "--reset", tree, cwd=path)


def paired(folder, card, snap):
    trees = {path: tree for path, (tree, _) in snap.items()}
    (folder / "pending-tree").write_text(json.dumps(trees) + "\n")
    heads = {path: git("rev-parse", "HEAD", cwd=path) for path in trees}
    old = {path: git("rev-parse", "HEAD^{tree}", cwd=path) for path in trees}
    base, new, seconds = [], [], []
    for turn in range(card["runs"] + card["runs"] % 2):
        order = [(trees, new), (old, base)]
        for side, scores in order if turn % 2 == 0 else order[::-1]:
            switch_trees(side)
            score, _, took = measure(card["check"], 1, card["timeout"], folder / "last.txt" if side is trees else None, card["score"])
            if any(git("rev-parse", "HEAD", cwd=path) != head for path, head in heads.items()):
                for path, head in heads.items():
                    git("reset", "--hard", "-q", head, cwd=path)
                raise Fail("the check moved HEAD")
            fixed = side_index(side)
            try:
                edited = written(fixed)[0]
                if edited:
                    raise Fail(edited_while_scoring(edited, card["lock"]))
                drop_new(fixed)
            finally:
                forget(fixed)
            if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
                raise Fail("the check changed a locked file")
            scores.append(score)
            seconds.append(took)
    switch_trees(trees)
    for path in trees:
        git("read-tree", "HEAD", cwd=path)
    (folder / "pending-tree").unlink()
    new, base = statistics.median(new), statistics.median(base)
    if base == 0:
        raise Fail("--paired needs a score that is never 0")
    return card["best"]["score"] * new / base, [base, new], sum(seconds) / len(seconds)


def failing_guards(guards, timeout):
    for command in guards:
        result = run(command, timeout)
        if result is None:
            return command, f"timed out after {timeout}s"
        if result.returncode:
            return command, tail(result.stdout + result.stderr)
    return None


def ignored(files, folder):
    found = subprocess.run(["git", "check-ignore", "--stdin"], input="\n".join(map(str, files)), cwd=folder,
                           capture_output=True, text=True).stdout
    return set(found.splitlines())


def fingerprint(paths):
    digest = hashlib.sha256()
    root = repo()
    for name in paths:
        target = root / name
        if not target.exists():
            raise Fail(f"Locked path does not exist: {name}")
        files = [target] if target.is_file() else sorted(p for p in target.rglob("*") if p.is_file())
        skip = set() if ".hill-climb" in target.parts else ignored(files, target.parent)
        for path in files:
            digest.update(os.path.relpath(path, root).encode())
            digest.update(b"ignored" if str(path) in skip else path.read_bytes())
    return digest.hexdigest()


def threshold(min_gain, score):
    text = str(min_gain)
    if text.endswith("%"):
        return abs(score) * float(text[:-1]) / 100
    return float(text)


def better(card, new, old):
    gain = threshold(card["min_gain"], old)
    return new > old + gain if card["direction"] == "max" else new < old - gain


def reached(card, score):
    target = card["target"]
    if target is None:
        return False
    return score >= target if card["direction"] == "max" else score <= target


def bar(text, baseline, direction):
    if text is None:
        return None
    if text.endswith("x"):
        factor = float(text[:-1])
        if factor <= 1:
            raise Fail("A bar like 2x needs a factor above 1.")
        return baseline / factor if direction == "min" else baseline * factor
    return float(text)


def outside(paths, allowed):
    return [path for path in paths if not any(path == lock or path.startswith(lock.rstrip("/") + "/") for lock in allowed)]


def number(value):
    return f"{value:.6g}"


def interrupted(folder):
    trees = json.loads((folder / "pending-tree").read_text())
    restore = " && ".join(shlex.join(["git", "-C", path, "read-tree", "-u", "--reset", tree]) for path, tree in trees.items())
    return (f"A paired step was cut off and the tree may hold the old code. Restore the edit with: "
            f"{restore} && rm {folder / 'pending-tree'}")


def gaining(steps):
    kept = [row for row in steps if row["result"] == "kept" and row.get("gain", True)]
    if not kept:
        return False
    at = time.mktime(time.strptime(kept[-1]["time"], "%Y-%m-%d %H:%M:%S"))
    return time.time() - at < 3600 and len(steps) - kept[-1]["step"] < PLATEAU


def hours(card):
    return (time.time() - card["started"]) / 3600 if card.get("started") else 0


def changed_files(roots):
    root = repo()
    return sorted({
        os.path.relpath(path / name, root)
        for path in roots
        for name in git("diff", "--name-only", "HEAD", cwd=path).splitlines()
        + git("ls-files", "--others", "--exclude-standard", cwd=path).splitlines()
    })


def too_big(paths):
    return [path for path in paths if os.path.isfile(path) and os.path.getsize(path) > COMMIT_LIMIT]


def folder_size(folder):
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file() and not path.is_symlink())


def dirty(roots):
    return any(git("status", "--porcelain", cwd=path) for path in roots)


def undo(card):
    for path in checkouts(card):
        git("reset", "--hard", "-q", "HEAD", cwd=path)
        git("clean", "-fdq", cwd=path)


def snapshot(roots):
    """Record each checkout's tree before the check runs, in a private index, so the real one is untouched."""
    trees = {}
    for path in roots:
        index = str(Path(path) / git("rev-parse", "--git-path", "hill-climb.index", cwd=path))
        real = Path(path) / git("rev-parse", "--git-path", "index", cwd=path)
        if real.is_file():
            shutil.copy2(real, index)  # keep the mtime, or git's racy-file check misses same-second edits
        else:
            git("read-tree", "HEAD", cwd=path, index=index)
        git("add", "-A", cwd=path, index=index)
        trees[str(path)] = (git("write-tree", cwd=path, index=index), index)
    return trees


def side_index(side):
    trees = {}
    for path, tree in side.items():
        index = str(Path(path) / git("rev-parse", "--git-path", "hill-climb-side.index", cwd=path))
        git("read-tree", tree, cwd=path, index=index)
        git("update-index", "-q", "--refresh", check=False, cwd=path, index=index)
        trees[path] = (tree, index)
    return trees


def written(trees):
    """Files the check or a guard changed since the snapshot, and new files they made."""
    root, changed, made = repo(), [], []
    for path, (_, index) in trees.items():
        changed += [os.path.relpath(Path(path) / name, root) for name in git("diff", "--name-only", cwd=path, index=index).splitlines()]
        made += [os.path.relpath(Path(path) / name, root)
                 for name in git("ls-files", "--others", "--exclude-standard", cwd=path, index=index).splitlines()]
    return sorted(changed), sorted(made)


def drop_new(trees):
    for path, (_, index) in trees.items():
        git("clean", "-fdq", cwd=path, index=index)


def forget(trees):
    for _, index in trees.values():
        Path(index).unlink(missing_ok=True)


def listed(names):
    return ", ".join(names[:5]) + (f" and {len(names) - 5} more" if len(names) > 5 else "")


def edited_while_scoring(changed, locks):
    if outside(changed, locks) != changed:
        return "the check or a guard changed a locked file"
    return f"the check or a guard changed {listed(changed)}, so the scored code is not what would be committed"


def commit(trees, message):
    """Commit exactly the snapshot trees, in every checkout that changed."""
    done = []
    try:
        for path, (tree, _) in trees.items():
            if tree != git("rev-parse", "HEAD^{tree}", cwd=path):
                head = git("rev-parse", "HEAD", cwd=path)
                git("read-tree", tree, cwd=path)
                git("commit", "-q", "--no-verify", "-m", message, cwd=path)
                done.append((path, head))
    except Fail:
        for path, head in done:
            git("reset", "--soft", "-q", head, cwd=path)
        raise


def keep_output(folder):
    if (folder / "last.txt").exists():
        shutil.copyfile(folder / "last.txt", folder / "best.txt")


def exclude_state(path=None):
    exclude = Path(git("rev-parse", "--git-path", "info/exclude", cwd=path))
    if not exclude.is_absolute():
        exclude = Path(path or repo()) / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text() if exclude.exists() else ""
    if "/.hill-climb/" not in text.splitlines():
        exclude.write_text(text + ("" if text.endswith("\n") or not text else "\n") + "/.hill-climb/\n")


def hold_lock():
    handle = open(git("rev-parse", "--git-path", "hill-climb.lock"), "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Fail("Another climb.py command is still running in this checkout. Wait for it to finish. "
                   "A command you interrupted can still be running.")
    return handle


def kits_dir():
    return Path(os.environ.get("HILL_CLIMB_HOME") or Path.home() / ".hill-climb") / "kits"


def repo_key():
    url = git("remote", "get-url", "origin", check=False)
    name = url.rstrip("/").split("/")[-1].split(":")[-1].removesuffix(".git") if url else ""
    return name or repo().name


def save_kit(folder, card):
    root = repo()
    inside = [lock for lock in card["lock"] if not lock.startswith("..")]
    names = git("ls-files", "--", *inside).splitlines() if inside else []
    names += [str(path.relative_to(root)) for path in sorted(folder.rglob("*"))
              if path.name not in ("card.json", "log.jsonl", "last.txt", "best.txt", "pending-tree")
              and "data" not in path.relative_to(folder).parts[:1]]
    files = [name for name in dict.fromkeys(names) if (root / name).is_file() and (root / name).stat().st_size <= FILE_LIMIT]
    meta = {key: card.get(key) for key in KIT_KEYS}
    meta["repos"] = [{"path": os.path.relpath(extra["path"], root)} for extra in card.get("repos", [])]
    meta.update(repo=repo_key(), target=card.get("target_text"), best=card["best"]["score"], files=files, saved=time.strftime("%Y-%m-%d %H:%M"))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        data = json.dumps(meta, indent=2).encode()
        info = tarfile.TarInfo("kit.json")
        info.size, info.mtime = len(data), time.time()
        tar.addfile(info, io.BytesIO(data))
        for name in files:
            tar.add(root / name, arcname=f"files/{name}")
    size = len(buffer.getvalue())
    if size > KIT_LIMIT:
        return f"Kit not saved: {size // 1000} KB is over {KIT_LIMIT // 1000} KB. Keep big data out of the locked paths."
    target = kits_dir() / meta["repo"] / f"{card['name']}.tar.gz"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(buffer.getvalue())
    except OSError as error:
        return f"Kit not saved: {error}"
    return f"Saved kit {meta['repo']}/{card['name']}: {len(files)} files, {max(1, size // 1000)} KB."


def read_kit(path):
    with tarfile.open(path) as tar:
        meta = json.load(tar.extractfile("kit.json"))
        files = {}
        for member in tar.getmembers():
            if member.name == "kit.json":
                continue
            name = member.name.removeprefix("files/")
            if not member.isfile() or name == member.name or Path(name).is_absolute() or ".." in Path(name).parts:
                raise Fail(f"Kit {path.name} has an unsafe entry: {member.name}")
            files[name] = (tar.extractfile(member).read(), member.mode & 0o777)
    return meta, files


def find_kit(spec):
    if "/" in spec:
        found = [kits_dir() / f"{spec}.tar.gz"]
    else:
        here = kits_dir() / repo_key() / f"{spec}.tar.gz"
        found = [here] if here.is_file() else sorted(kits_dir().glob(f"*/{spec}.tar.gz"))
    found = [path for path in found if path.is_file()]
    if len(found) != 1:
        raise Fail(f"Name one kit as repo/name. Run: climb.py kits" if found else f"No kit named {spec!r}. Run: climb.py kits")
    return found[0]


def init_command(meta):
    words = ["python3", os.path.abspath(__file__), "init", meta["name"], "--goal", meta["goal"], "--direction", meta["direction"]]
    for check in [meta["check"]] if isinstance(meta["check"], str) else meta["check"]:
        words += ["--check", check]
    for guard in meta["guards"]:
        words += ["--guard", guard]
    for extra in meta.get("repos") or []:
        words += ["--repo", extra["path"]]
    for pattern in meta.get("score") or []:
        words += ["--score", pattern]
    for flag, key in (("--target", "target"), ("--holdout", "holdout"), ("--max-steps", "max_steps"), ("--max-hours", "max_hours")):
        if meta.get(key) is not None:
            words += [flag, str(meta[key])]
    words += ["--after", meta["after"], "--runs", str(meta["runs"]), "--min-gain", str(meta["min_gain"]), "--timeout", str(meta["timeout"])]
    for flag in ("paired", "hard"):
        if meta.get(flag):
            words.append(f"--{flag}")
    for lock in meta["lock"]:
        words += ["--lock", lock]
    return shlex.join(words)


def run_holdout(folder, card, reason):
    if not card["holdout"]:
        return None
    score, _, _ = measure([card["holdout"]], card["runs"], card["timeout"])
    append(folder, {"kind": "holdout", "score": score, "visible": card["best"]["score"], "why": reason})
    return score


def cmd_init(args):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", args.name):
        raise Fail("Use a short lowercase name with dashes, like build-speed.")
    folder = climbs_dir() / args.name
    if (folder / "card.json").exists():
        raise Fail(f"Climb {args.name!r} already exists. Resume it with: climb.py status {args.name}")
    exclude_state()
    threshold(args.min_gain, 1)
    lock = [os.path.relpath(os.path.abspath(path), repo()) for path in args.lock or []]
    roots = [repo()]
    for path in args.repo or []:
        top = Path(git("rev-parse", "--show-toplevel", cwd=path))
        if top in roots:
            raise Fail(f"--repo {path} is already part of this climb.")
        roots.append(top)
    changed = changed_files(roots)
    stray = outside(changed, lock)
    if stray:
        raise Fail(
            "Commit or set aside changes outside the locked check files first: "
            + ", ".join(stray[:5])
        )
    big = too_big(changed)
    if big:
        raise Fail(f"A file is over {COMMIT_LIMIT // 1_000_000} MB and would be committed: {big[0]}. "
                   f"Move big data under .hill-climb/{args.name}/data/.")
    folder.mkdir(parents=True, exist_ok=True)
    trees = snapshot(roots)
    try:
        score, spread, seconds = measure(args.check, args.runs, args.timeout, folder / "best.txt", args.score)
        target = bar(args.target, score, args.direction)
        failed = failing_guards(args.guard or [], args.timeout)
        if failed:
            raise Fail(f"A guard already fails before the climb starts: {failed[0]}\n{failed[1]}")
        edited, made = written(trees)
        if edited:
            raise Fail(f"Can't start: {edited_while_scoring(edited, lock)}. A check and its guards must not edit files.")
        drop_new(trees)
    finally:
        forget(trees)
    locked = fingerprint(lock) if lock else None
    bases = [git("branch", "--show-current", cwd=path) for path in roots]
    if not args.here:
        for path in roots:
            git("switch", "-q", "-c", f"climb/{args.name}", cwd=path)
    commit(trees, f"climb({args.name}): add the check")
    base = bases[0]
    card = {
        "name": args.name,
        "goal": args.goal,
        "check": args.check,
        "score": args.score or [],
        "direction": args.direction,
        "guards": args.guard or [],
        "target": target,
        "target_text": args.target,
        "after": args.after,
        "runs": args.runs,
        "min_gain": args.min_gain,
        "timeout": args.timeout,
        "holdout": args.holdout,
        "lock": lock,
        "fingerprint": locked,
        "max_steps": args.max_steps,
        "paired": args.paired,
        "max_hours": args.max_hours,
        "hard": args.hard,
        "started": time.time(),
        "base": base,
        "branch": git("branch", "--show-current"),
        "start_commit": git("rev-parse", "HEAD"),
        "repos": [{"path": str(path), "base": bases[index + 1], "branch": git("branch", "--show-current", cwd=path),
                   "start_commit": git("rev-parse", "HEAD", cwd=path)} for index, path in enumerate(roots[1:])],
    }
    for path in roots[1:]:
        exclude_state(path)
        (path / ".hill-climb").mkdir(exist_ok=True)
        (path / ".hill-climb" / "home").write_text(f"{repo()}\n")
    card["baseline"] = score
    card["best"] = {"score": score, "commit": card["start_commit"], "step": 0}
    save(folder, card)
    append(folder, {"kind": "baseline", "score": score, "spread": spread, "seconds": round(seconds, 2)})
    holdout = run_holdout(folder, card, "baseline")
    also = f" in {len(roots)} repos" if len(roots) > 1 else ""
    print(f"Climb {args.name} started on {card['branch']}{also}. Check output: {folder / 'best.txt'}")
    if made:
        print(f"Not committed, written by the check or a guard: {listed(made)}")
    print(save_kit(folder, card))
    print(f"Baseline {number(score)} ({args.direction}), check takes {seconds:.1f}s.")
    if holdout is not None:
        print(f"Holdout baseline {number(holdout)}.")
    step_seconds = seconds * (2 * (args.runs + args.runs % 2) if args.paired else args.runs + (args.runs > 1))
    if step_seconds > SLOW_STEP:
        print(
            f"Warning: each step will take about {step_seconds / 60:.0f} min to score. Aim for under "
            f"{SLOW_STEP // 60} min: count the work instead of timing it, or score a sample, and move "
            f"the slow measure to --holdout. See 'Fast checks' in references/checks.md."
        )
    if args.runs > 1 and spread > threshold(args.min_gain, score):
        percent = 100 * spread / abs(score) if score else 0
        print(
            f"Warning: the score moved {number(spread)} ({percent:.1f}%) between runs with no code change. "
            f"Set --min-gain above that, or a lucky run will count as a win. A percent like "
            f"--min-gain {max(1, round(percent * 1.5))}% keeps working as the score shrinks. "
            f"If the machine's load changes the score, add --paired."
        )
    if not args.guard:
        risk = ("A crash that stops the tests can print fewer failures and win." if args.score and args.direction == "min"
                else "A kept step can break anything the check does not measure.")
        print(f"Warning: no guard. {risk} Add --guard with the tests that pass today, or a build or typecheck.")
    if target is not None:
        print(f"Bar {number(target)}, then {args.after}.")
    if target is not None and reached(card, score):
        print("Warning: the baseline already meets the bar. Pick a harder bar.")


def cmd_try(args):
    folder = resolve(args.name)
    card = load(folder)
    roots = checkouts(card)
    for path, branch in zip(roots, [card["branch"], *(extra["branch"] for extra in card.get("repos", []))]):
        if git("branch", "--show-current", cwd=path) != branch:
            raise Fail(f"Switch {path} to {branch} first.")
    steps = [row for row in rows(folder) if row["kind"] == "step"]
    over = []
    if card["max_steps"] and len(steps) >= card["max_steps"]:
        over.append(f"{len(steps)} of {card['max_steps']} steps")
    if card.get("max_hours") and hours(card) >= card["max_hours"]:
        over.append(f"{hours(card):.1f} of {number(card['max_hours'])} hours")
    if over and (card.get("hard") or not gaining(steps)):
        why = "" if card.get("hard") else f" and no gain in the last hour or {PLATEAU} steps"
        raise Fail(f"Budget used: {' and '.join(over)}{why}. {MORE}")
    if over:
        print(f"Past the limit ({' and '.join(over)}), but still gaining, so the climb goes on.")
    if (folder / "pending-tree").exists():
        raise Fail(interrupted(folder))
    if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
        raise Fail(
            "Locked files changed. Undo those edits, or if the check itself is wrong, "
            "run: climb.py relock --why '<reason>'"
        )
    if not dirty(roots):
        raise Fail("No change to try. Edit the code first.")
    step = len(steps) + 1
    best = card["best"]["score"]
    row = {"kind": "step", "step": step, "idea": args.idea}
    big = too_big(changed_files(roots))
    if big:
        undo(card)
        append(folder, {**row, "result": "broke", "why": f"would commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}"})
        print(f"step {step} broke   {args.idea}\nWould commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}\n"
              f"Write big output under .hill-climb/{card['name']}/data/.\nUndone.")
        return
    trees = snapshot(roots)
    try:
        return scored_step(folder, card, args, roots, trees, step, best, row)
    finally:
        forget(trees)


def scored_step(folder, card, args, roots, trees, step, best, row):
    try:
        if card.get("paired"):
            score, row["pair"], seconds = paired(folder, card, trees)
        else:
            score, _, seconds = measure(card["check"], card["runs"], card["timeout"], folder / "last.txt", card["score"])
    except Fail as error:
        undo(card)
        (folder / "pending-tree").unlink(missing_ok=True)
        lines = str(error).splitlines()
        why = lines[0] if len(lines) == 1 else f"{lines[0]}: {lines[-1].strip()[:120]}"
        append(folder, {**row, "result": "broke", "why": why})
        print(f"step {step} broke   {args.idea}\n{error}\nUndone. Full output: {folder / 'last.txt'}")
        return
    row.update(score=score, seconds=round(seconds, 2))
    held = score >= best if card["direction"] == "max" else score <= best
    if not (better(card, score, best) or args.fix and held):
        undo(card)
        append(folder, {**row, "result": "undone", "why": "score got worse" if args.fix else "no gain"})
        print(f"step {step} undone  {number(score)} (best {number(best)})  {args.idea}\nOutput: {folder / 'last.txt'}")
        return
    failed = failing_guards(card["guards"], card["timeout"])
    if failed:
        undo(card)
        append(folder, {**row, "result": "undone", "why": f"guard failed: {failed[0]}"})
        print(f"step {step} undone  {number(score)} but guard failed: {failed[0]}\n{failed[1]}")
        return
    edited, made = written(trees)
    why = edited_while_scoring(edited, card["lock"]) if edited else None
    if not why:
        drop_new(trees)
        try:
            if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
                why = "the check or a guard changed a locked file"
        except Fail:
            why = "the check or a guard changed a locked file"
    if why:
        undo(card)
        append(folder, {**row, "result": "broke", "why": why})
        print(f"step {step} broke   {args.idea}\n{why[0].upper() + why[1:]}.\nUndone.")
        return
    commit(trees, f"climb({card['name']}): step {step} {args.idea}\n\nscore {number(score)}, was {number(best)}")
    keep_output(folder)
    card["best"] = {"score": score, "commit": git("rev-parse", "HEAD"), "step": step}
    save(folder, card)
    append(folder, {**row, "result": "kept", "gain": better(card, score, best)})
    print(f"step {step} kept    {number(score)} (was {number(best)}, start {number(card['baseline'])})  {args.idea}")
    if made:
        print(f"Not committed, written by the check or a guard: {listed(made)}")
    if reached(card, score):
        holdout = run_holdout(folder, card, "bar reached")
        print(f"BAR REACHED: {number(score)} meets {number(card['target'])}. The card says: {card['after']}.")
        if holdout is not None:
            print(f"Holdout now {number(holdout)}. Compare it with the holdout baseline before you claim a win.")


def spark(values, direction):
    if len(values) < 2:
        return ""
    low, high = min(values), max(values)
    span = (high - low) or 1
    levels = [(value - low) / span for value in values]
    if direction == "min":
        levels = [1 - level for level in levels]
    return "".join(BARS[round(level * (len(BARS) - 1))] for level in levels)


def cmd_status(args):
    folder = resolve(args.name)
    card = load(folder)
    log = rows(folder)
    steps = [row for row in log if row["kind"] == "step"]
    kept = [row for row in steps if row["result"] == "kept"]
    trail = [card["baseline"]] + [row["score"] for row in kept]
    since = len(steps) - card["best"]["step"]
    reviews = [row for row in log if row["kind"] == "review"]
    last_review = reviews[-1]["step"] if reviews else None
    stuck = len(reviews) >= 2 and reviews[-2]["step"] >= card["best"]["step"]
    timed = [row["seconds"] for row in log if "seconds" in row]
    print(f"Climb {card['name']} on {card['branch']}: {card['goal']}")
    print(f"Score {number(card['baseline'])} -> {number(card['best']['score'])} ({card['direction']})  {spark(trail, card['direction'])}")
    goal = "none" if card["target"] is None else f"{number(card['target'])}, then {card['after']}"
    budget = f" of {card['max_steps']}" if card["max_steps"] else ""
    print(f"Bar {goal}. Steps {len(steps)}{budget}, kept {len(kept)}, {since} since the last gain.")
    limit = f" of {number(card['max_hours'])}" if card.get("max_hours") else ""
    pace = f", about {60 * hours(card) / len(steps):.1f} min a step" if steps else ""
    print(f"Time {hours(card):.1f}{limit} hours{pace}.")
    if timed:
        print(f"Check takes {sum(timed) / len(timed):.1f}s on average.")
    for row in log:
        if row["kind"] == "raise":
            print(f"Raised {row['why']}")
    holdouts = [row for row in log if row["kind"] == "holdout"]
    if holdouts:
        print("Holdout " + ", ".join(f"{number(row['score'])} ({row['why']})" for row in holdouts))
    for row in log[-args.last:]:
        if row["kind"] == "step":
            score = number(row["score"]) if "score" in row else "-"
            note = "" if row["result"] == "kept" else f"  [{row['why']}]"
            print(f"  {row['step']:>4} {row['result']:<6} {score:>10}  {row['idea']}{note}")
        elif row["kind"] != "holdout":
            print(f"  ---- {row['kind']}: {row.get('why', number(row.get('score', 0)))}")
    if (folder / "pending-tree").exists():
        print(interrupted(folder))
    if (folder / "notes.md").exists():
        print("Notes:\n" + tail((folder / "notes.md").read_text(), 40))
    size = folder_size(climbs_dir())
    if size > STATE_WARN:
        print(f"STORAGE: .hill-climb holds {size // 1_000_000} MB. Shrink or delete .hill-climb/{card['name']}/data/.")
    if card["target"] is not None and reached(card, card["best"]["score"]):
        print(f"BAR REACHED. {'Check the holdout, then ' if card['holdout'] else 'Then '}{card['after']}.")
    elif stuck:
        print("STUCK: two blocker reviews with no gain between them. Stop and report.")
    elif since >= PLATEAU and (last_review is None or len(steps) - last_review >= PLATEAU):
        print(f"PLATEAU: {since} steps with no gain. Do a blocker review, then log it with: climb.py review")


def cmd_holdout(args):
    folder = resolve(args.name)
    card = load(folder)
    if not card["holdout"]:
        raise Fail("This climb has no holdout check.")
    print(f"Holdout {number(run_holdout(folder, card, args.why))}, visible best {number(card['best']['score'])}.")


def cmd_raise(args):
    folder = resolve(args.name)
    card = load(folder)
    if not reached(card, card["best"]["score"]):
        raise Fail("Reach the current bar before you raise it.")
    old = card["target"]
    card["target"] = bar(args.target, card["best"]["score"], card["direction"])
    if reached(card, card["best"]["score"]):
        raise Fail("The new bar is already met. Pick a harder one.")
    save(folder, card)
    append(folder, {"kind": "raise", "why": f"bar {number(old)} -> {number(card['target'])}: {args.why}"})
    print(f"Bar raised to {number(card['target'])}.")


def cmd_relock(args):
    folder = resolve(args.name)
    card = load(folder)
    if not card["lock"]:
        raise Fail("This climb locks no files.")
    stray = outside(changed_files(checkouts(card)), card["lock"])
    if stray:
        raise Fail("Relock changes only the locked check files. Undo or try these first: " + ", ".join(stray[:5]))
    trees = snapshot(checkouts(card))
    try:
        failed = failing_guards(card["guards"], card["timeout"])
        if failed:
            raise Fail(f"A guard fails with the changed check: {failed[0]}\n{failed[1]}")
        score, _, _ = measure(card["check"], card["runs"], card["timeout"], folder / "best.txt", card["score"])
        edited, made = written(trees)
        if edited:
            raise Fail(f"Not relocked: {edited_while_scoring(edited, card['lock'])}.")
        drop_new(trees)
    finally:
        forget(trees)
    card["fingerprint"] = fingerprint(card["lock"])
    commit(trees, f"climb({card['name']}): fix the check\n\n{args.why}")
    card["best"] = {"score": score, "commit": git("rev-parse", "HEAD"), "step": len([r for r in rows(folder) if r["kind"] == "step"])}
    save(folder, card)
    append(folder, {"kind": "relock", "why": args.why, "score": score})
    print(f"Check relocked. New best {number(score)} measured with the changed check.")
    print(save_kit(folder, card))


def cmd_budget(args):
    folder = resolve(args.name)
    card = load(folder)
    if args.off:
        card["max_hours"] = card["max_steps"] = None
    if args.hours:
        card["max_hours"] = round(hours(card) + args.hours, 2)
    if args.steps:
        card["max_steps"] = len([row for row in rows(folder) if row["kind"] == "step"]) + args.steps
    save(folder, card)
    limits = [f"{number(card['max_hours'])} hours" if card.get("max_hours") else "",
              f"{card['max_steps']} steps" if card["max_steps"] else ""]
    text = " and ".join(item for item in limits if item) or "no limit"
    append(folder, {"kind": "budget", "why": text})
    print(f"Budget now {text}.")


def cmd_review(args):
    folder = resolve(args.name)
    steps = [row for row in rows(folder) if row["kind"] == "step"]
    append(folder, {"kind": "review", "step": len(steps), "why": args.found})
    print(f"Review logged after step {len(steps)}. Climb at least {PLATEAU} more steps before the next one.")


def cmd_drop(args):
    folder = resolve(args.name)
    card = load(folder)
    if dirty(checkouts(card)):
        raise Fail("Commit or undo the current edit first.")
    if card["branch"] == card["base"]:
        raise Fail("This climb ran on its own base branch, so there is nothing to switch back to. Remove its card by hand.")
    stamp = time.strftime("%Y%m%d%H%M%S")
    kept = f"{card['branch']}-dropped-{stamp}"
    root = repo()
    restored = []
    for path, branch, base in [(root, card["branch"], card["base"])] + [
            (Path(extra["path"]), extra["branch"], extra["base"]) for extra in card.get("repos", [])]:
        if branch == base:
            continue
        old = f"{branch}-dropped-{stamp}"
        git("switch", "-q", base, cwd=path)
        git("branch", "-m", branch, old, cwd=path)
        mine = [os.path.relpath(root / lock, path) for lock in card["lock"]]
        mine = [lock for lock in mine if not lock.startswith("..") and git("ls-tree", "-r", "--name-only", old, "--", lock, cwd=path)]
        if mine:
            git("checkout", old, "--", *mine, cwd=path)
            git("reset", "-q", "--", *mine, cwd=path)
            restored += [os.path.relpath(path / lock, root) for lock in mine]
    for name in ("card.json", "log.jsonl"):
        (folder / name).unlink(missing_ok=True)
    print(f"Dropped {card['name']}. Back on {card['base']}. The old climb is on branch {kept}.")
    if restored:
        print("The check files are back in the tree, uncommitted, ready for a new init: " + ", ".join(restored))


def cmd_save(args):
    folder = resolve(args.name)
    print(save_kit(folder, load(folder)))


def cmd_kits(args):
    here = repo_key()
    found = []
    for path in kits_dir().glob("*/*.tar.gz"):
        with tarfile.open(path) as tar:
            meta = json.load(tar.extractfile("kit.json"))
        meta["check"] = " ; ".join([meta["check"]] if isinstance(meta["check"], str) else meta["check"])
        text = f"{meta['repo']} {meta['name']} {meta['goal']} {meta['check']}".lower()
        if all(word in text for word in args.words.lower().split()):
            found.append((meta["repo"] != here, -path.stat().st_mtime, str(path), meta))
    if not found:
        print("No saved kits match." if args.words else "No saved kits yet. init saves one.")
    for _, _, _, meta in sorted(found, key=lambda item: item[:3]):
        print(f"{meta['repo']}/{meta['name']:<24} {number(meta['baseline'])} -> {number(meta['best'])}  {meta['goal']}")
        print(f"    check: {meta['check']}  saved {meta['saved']}")


def cmd_reuse(args):
    path = find_kit(args.kit)
    meta, files = read_kit(path)
    root = repo()
    linked = [name for name in files if any((root / part).is_symlink() for part in [*Path(name).parents][:-1] + [Path(name)])]
    if linked:
        raise Fail("These kit paths go through a symlink. Remove it first: " + ", ".join(linked[:5]))
    clashes = [name for name, (data, _) in files.items() if (root / name).exists() and (root / name).read_bytes() != data]
    if clashes:
        raise Fail("These files exist and differ. Move them first: " + ", ".join(clashes[:5]))
    exclude_state()
    for name, (data, mode) in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode)
    print(f"Restored {len(files)} files from {meta['repo']}/{meta['name']}, saved {meta['saved']}.")
    print(f"Goal then: {meta['goal']}. Result: {number(meta['baseline'])} -> {number(meta['best'])}.")
    print("Edit what differs for this goal, then start with:")
    print(init_command(meta))


def cmd_list(args):
    for path in sorted(climbs_dir().glob("*/card.json")):
        card = json.loads(path.read_text())
        print(f"{card['name']:<20} {card['branch']:<28} {number(card['baseline'])} -> {number(card['best']['score'])}  {card['goal']}")


def parse(argv):
    parser = argparse.ArgumentParser(prog="climb.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="write the card, measure the baseline, start the branch")
    init.add_argument("name")
    init.add_argument("--goal", required=True)
    init.add_argument("--check", action="append", required=True,
                      help="command that prints the score (repeatable: they run at once and their scores add)")
    init.add_argument("--score", action="append",
                      help="regex for the score in the check output, like '(\\d+) failed'; one for all checks or one per check; the matches on the last matching line add up, no match is 0")
    init.add_argument("--repo", action="append", help="another git checkout the climb edits (repeatable)")
    init.add_argument("--direction", choices=["max", "min"], required=True)
    init.add_argument("--guard", action="append", help="command that must exit 0 (repeatable)")
    init.add_argument("--target", help="the bar that means done, a number or a factor like 2x")
    init.add_argument("--after", choices=["stop", "raise"], default="stop", help="what to do at the bar")
    init.add_argument("--runs", type=int, default=1, help="runs per score, median wins, plus one warm-up run")
    init.add_argument("--min-gain", default="0", help="smallest change that counts, a number or a percent like 2%%")
    init.add_argument("--timeout", type=int, default=1800, help="seconds per check run")
    init.add_argument("--holdout", help="check on cases the climber never sees")
    init.add_argument("--lock", action="append", help="file or folder the climber may not edit")
    init.add_argument("--max-steps", type=int, help="soft limit: past it, steps go on while they still gain")
    init.add_argument("--max-hours", type=float, help="soft limit in hours since init, like --max-steps")
    init.add_argument("--hard", action="store_true", help="stop exactly at --max-steps and --max-hours")
    init.add_argument("--paired", action="store_true",
                      help="score each step against the best commit in alternating runs, for checks the machine's load moves")
    init.add_argument("--here", action="store_true", help="climb on the current branch")

    attempt = sub.add_parser("try", help="score the current edit, keep it or undo it")
    attempt.add_argument("idea")
    attempt.add_argument("--fix", action="store_true", help="keep a fix that holds the score, for a break the guards missed")
    attempt.add_argument("--name")

    status = sub.add_parser("status", help="where the climb stands")
    status.add_argument("name", nargs="?")
    status.add_argument("--last", type=int, default=10)

    holdout = sub.add_parser("holdout", help="run the holdout check now")
    holdout.add_argument("name", nargs="?")
    holdout.add_argument("--why", default="milestone")

    bump = sub.add_parser("raise", help="set a harder bar after reaching this one")
    bump.add_argument("target", help="a number or a factor like 2x over the current best")
    bump.add_argument("--why", required=True)
    bump.add_argument("--name")

    relock = sub.add_parser("relock", help="accept a fixed check and measure again")
    relock.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    relock.add_argument("--why", required=True)
    relock.add_argument("--name")

    budget = sub.add_parser("budget", help="give more hours or steps, or remove the limits")
    budget.add_argument("--hours", type=float, help="hours from now")
    budget.add_argument("--steps", type=int, help="steps from now")
    budget.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    budget.add_argument("--off", action="store_true", help="remove both limits")
    budget.add_argument("--name")

    review = sub.add_parser("review", help="log a blocker review and what it found")
    review.add_argument("found")
    review.add_argument("--name")

    drop = sub.add_parser("drop", help="abandon a climb, go back to the base branch, keep the old branch")
    drop.add_argument("name", nargs="?")

    listing = sub.add_parser("list", help="show every climb in this repo")

    keep = sub.add_parser("save", help="save the check, guards, and notes as a reusable kit")
    keep.add_argument("name", nargs="?")

    kits = sub.add_parser("kits", help="list saved kits from every repo, this repo first")
    kits.add_argument("words", nargs="?", default="", help="only kits whose name, goal, or check has these words")

    reuse = sub.add_parser("reuse", help="restore a kit's files and print its init command")
    reuse.add_argument("kit", help="name, or repo/name")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse(argv)
    try:
        os.chdir(repo())
        home = Path(".hill-climb/home")
        if args.command != "init" and home.is_file() and not list(climbs_dir().glob("*/card.json")):
            os.chdir(home.read_text().strip())
        held = None if args.command in ("status", "list", "kits") else hold_lock()
    except Fail as error:
        print(error, file=sys.stderr)
        return 1
    handlers = {
        "init": cmd_init, "try": cmd_try, "status": cmd_status, "holdout": cmd_holdout,
        "raise": cmd_raise, "relock": cmd_relock, "review": cmd_review, "budget": cmd_budget, "drop": cmd_drop, "list": cmd_list,
        "save": cmd_save, "kits": cmd_kits, "reuse": cmd_reuse,
    }
    try:
        handlers[args.command](args)
    except (Fail, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
