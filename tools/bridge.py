#!/usr/bin/env python3
"""
Bridge CLI: the host half of SillyTavern-Bridge. Design: DESIGN.md.

    bridge.py status                       next_seq, ack, pending and failed items, live tabs
    bridge.py pull                         personas (settings.json) and presets (OpenAI Settings/) -> workspace/
    bridge.py push persona <file.md>       workspace persona -> persona-set inbox item
    bridge.py push preset <name>           workspace prompt modules -> preset file + preset-changed inbox item
    bridge.py push card <avatar.png>       card-changed inbox item (after a card was edited on disk)

Never writes settings.json (ST owns it and rewrites it from the open tab). Writes user/files/bridge-inbox.json,
user/files/bridge-base-*.json, preset files and workspace/**, each atomically (temp file in the same folder,
then rename). Other tools may write the same inbox format; dedupe and seq rules are below.

ST data folder: --st-data, else $ST_DATA, else auto-detected when this file sits in
<data>/extensions/SillyTavern-Bridge/tools/.

Exit codes: 0 ok, 1 error, 3 pull blocked by pending workspace items (the timer treats 3 as "skip today").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True  # extension code may be read-only for the account running this

INBOX = "bridge-inbox.json"
ACK = "bridge-ack.json"
TABS = "bridge-tabs.json"
TAB_STALE_S = 90
WORKSPACE_TYPES = {"persona-set", "preset-changed"}  # items whose apply changes what pull would export
PERSONA_KEYS = ["avatar", "name", "title", "position", "depth", "role", "lorebook"]
PERSONA_INTS = {"position", "depth", "role"}
EXIT_BLOCKED = 3
PRESET_DIR = "OpenAI Settings"
PRESET_META = "_preset.json"
GLOBAL_ORDER_ID = 100001  # ST's prompt manager runs the 'global' strategy with this dummy character id
PROMPT_FM_EXTRA = ("order", "enabled")  # front matter keys that live in prompt_order, not in the prompt


class BridgeError(Exception):
    pass


# --------------------------------------------------------------------------------------
# Paths and file I/O
# --------------------------------------------------------------------------------------
def find_st_data(cli_value: str | None) -> Path:
    candidates = [cli_value, os.environ.get("ST_DATA")]
    here = Path(__file__).absolute()  # not resolve(): keep a symlinked/junctioned install path
    if len(here.parents) > 3 and here.parents[2].name == "extensions":
        candidates.append(str(here.parents[3]))
    for c in candidates:
        if c and (Path(c) / "settings.json").is_file():
            return Path(c)
    raise BridgeError("ST data folder not found: pass --st-data <data/default-user> or set ST_DATA")


def read_json(path: Path, default=None):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")  # *.tmp: ignored by the content repo if left behind
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def write_json_atomic(path: Path, obj) -> None:
    write_atomic(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def kebab(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "unnamed"


# --------------------------------------------------------------------------------------
# Inbox
# --------------------------------------------------------------------------------------
def acked_seq(files: Path) -> int:
    try:
        ack = read_json(files / ACK, {}) or {}
        return int(ack.get("acked_seq") or ack.get("seq") or 0)
    except (ValueError, json.JSONDecodeError):
        return 0


def inbox_state(files: Path) -> tuple[list[dict], int, int]:
    """Returns (pending items, next_seq, acked seq). Items at or below the ack are dropped."""
    acked = acked_seq(files)
    data = read_json(files / INBOX, {}) or {}
    items = [it for it in data.get("items", []) if isinstance(it, dict)]
    top = max((int(it.get("seq", 0)) for it in items), default=0)
    next_seq = max(int(data.get("next_seq") or 1), top + 1, acked + 1)
    pending = sorted((it for it in items if int(it.get("seq", 0)) > acked), key=lambda it: it["seq"])
    return pending, next_seq, acked


def item_key(item: dict) -> tuple:
    t = item.get("type")
    if t in ("card-changed", "persona-set"):
        return (t, item.get("avatar"))
    if t == "preset-changed":
        return (t, item.get("api"), item.get("name"))
    return (t, item.get("seq"))  # unknown types never dedupe


def emit_item(files: Path, payload: dict) -> dict:
    """Queue one item. A pending item with the same key is replaced: the newest carries the full state."""
    if not files.is_dir():
        raise BridgeError(f"{files} does not exist")
    pending, next_seq, _ = inbox_state(files)
    key = item_key(payload)
    pending = [it for it in pending if item_key(it) != key]
    item = {"seq": next_seq, **payload}
    pending.append(item)
    write_json_atomic(files / INBOX, {"next_seq": next_seq + 1, "items": pending})
    cleanup_bases(files)
    return item


def cleanup_bases(files: Path) -> list[str]:
    """Remove bridge-base-*.json copies that no pending item names (acked, or replaced by a newer base)."""
    pending, _, _ = inbox_state(files)
    keep = {it.get("base") for it in pending}
    removed = []
    for f in files.glob("bridge-base-*.json"):
        if f.name not in keep:
            f.unlink()
            removed.append(f.name)
    return removed


# --------------------------------------------------------------------------------------
# Front matter: a tiny subset of YAML. Values are JSON scalars (strings always quoted on write).
# --------------------------------------------------------------------------------------
def dump_front_matter(meta: dict, body: str) -> str:
    lines = ["---", *(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items()), "---"]
    return "\n".join(lines) + "\n" + body + "\n"


def parse_front_matter(text: str, source: str) -> tuple[dict, str]:
    text = text.replace("\r\n", "\n")
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise BridgeError(f"{source}: missing front matter (--- ... ---)")
    meta = {}
    for n, line in enumerate(m.group(1).split("\n"), start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        k, sep, v = line.partition(":")
        if not sep:
            raise BridgeError(f"{source}:{n}: expected 'key: value'")
        v = v.strip()
        try:
            meta[k.strip()] = json.loads(v)
        except json.JSONDecodeError:
            meta[k.strip()] = v  # bare string, as a human might type it
    body = text[m.end():]
    if body.endswith("\n"):
        body = body[:-1]  # the writer adds exactly one
    return meta, body


# --------------------------------------------------------------------------------------
# Personas
# --------------------------------------------------------------------------------------
def load_settings(st: Path) -> dict:
    return read_json(st / "settings.json", {}) or {}


def persona_records(settings: dict) -> list[tuple[dict, str]]:
    pu = settings.get("power_user", {})
    names = pu.get("personas", {}) or {}
    descs = pu.get("persona_descriptions", {}) or {}
    out = []
    for avatar, name in names.items():
        d = descs.get(avatar, {}) or {}
        meta = {
            "avatar": avatar, "name": name, "title": d.get("title", ""),
            "position": d.get("position", 0), "depth": d.get("depth", 2), "role": d.get("role", 0),
            "lorebook": d.get("lorebook", ""),
        }
        out.append((meta, d.get("description", "") or ""))
    return out


def persona_filenames(avatars: list[str]) -> dict[str, str]:
    used, out = set(), {}
    for avatar in sorted(avatars):
        base = kebab(Path(avatar).stem)
        name, n = f"{base}.md", 2
        while name in used:
            name, n = f"{base}-{n}.md", n + 1
        used.add(name)
        out[avatar] = name
    return out


def pull_personas(st: Path) -> list[str]:
    folder = st / "workspace" / "personas"
    records = persona_records(load_settings(st))
    names = persona_filenames([m["avatar"] for m, _ in records])
    written = []
    for meta, body in records:
        path = folder / names[meta["avatar"]]
        text = dump_front_matter(meta, body)
        if not path.is_file() or path.read_text(encoding="utf-8") != text:
            write_atomic(path, text)
            written.append(path.name)
    orphans = sorted(p.name for p in folder.glob("*.md") if p.name not in names.values())
    for o in orphans:
        print(f"note: workspace/personas/{o} has no persona in settings.json (not deleted)")
    return written


def push_persona(st: Path, file: Path) -> dict:
    meta, body = parse_front_matter(file.read_text(encoding="utf-8"), str(file))
    avatar = meta.get("avatar")
    if not avatar:
        raise BridgeError(f"{file}: front matter needs avatar")
    personas = load_settings(st).get("power_user", {}).get("personas", {}) or {}
    if avatar not in personas:
        raise BridgeError(f"{file}: no persona with avatar {avatar} in settings.json (v1 edits existing personas only)")
    fields = {"description": body}
    for k in PERSONA_KEYS[1:]:
        if k in meta:
            v = meta[k]
            if k in PERSONA_INTS:
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    raise BridgeError(f"{file}: {k} must be an integer") from None
            elif not isinstance(v, str):
                v = str(v)
            fields[k] = v
    return emit_item(st / "user" / "files", {"type": "persona-set", "avatar": avatar, "fields": fields})


# --------------------------------------------------------------------------------------
# Presets (prompt modules). The preset file is the source of truth; push writes it, then queues an item.
# --------------------------------------------------------------------------------------
def canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def prompts_hash(preset: dict) -> str:
    """Hash of the parts the workspace edits. Push refuses if the file moved since pull."""
    return hashlib.sha256(canon([preset.get("prompts", []), preset.get("prompt_order", [])]).encode()).hexdigest()


def dump_preset(preset: dict) -> str:
    return json.dumps(preset, indent=4, ensure_ascii=False)  # matches ST: JSON.stringify(preset, null, 4)


def global_order(preset: dict) -> dict | None:
    orders = preset.get("prompt_order", []) or []
    return next((o for o in orders if o.get("character_id") == GLOBAL_ORDER_ID), orders[0] if orders else None)


def base_name(api: str, name: str) -> str:
    return f"bridge-base-{hashlib.sha1(f'{api}/{name}'.encode()).hexdigest()[:12]}.json"


def prompt_filenames(prompts: list[dict]) -> dict[str, str]:
    used, out = set(), {}
    for p in prompts:
        ident = p["identifier"]
        base = kebab(p.get("name") or ident)
        name = f"{base}.md"
        if name in used:
            name = f"{base}-{kebab(ident)}.md"
        used.add(name)
        out[ident] = name
    return out


def pull_preset(st: Path, file: Path) -> tuple[str, list[str]]:
    preset = json.loads(file.read_text(encoding="utf-8"))
    prompts = [p for p in preset.get("prompts", []) if isinstance(p, dict) and p.get("identifier")]
    order = global_order(preset)
    position = {o["identifier"]: (i + 1, o.get("enabled", True)) for i, o in enumerate(order.get("order", []))} if order else {}
    folder = st / "workspace" / "prompts" / kebab(file.stem)
    names = prompt_filenames(prompts)
    written = []
    for p in prompts:
        ident = p["identifier"]
        meta = {"identifier": ident}
        if ident in position:
            meta["order"], meta["enabled"] = position[ident]
        meta.update({k: v for k, v in p.items() if k not in ("identifier", "content")})
        path = folder / names[ident]
        text = dump_front_matter(meta, p.get("content", "") or "")
        if not path.is_file() or path.read_text(encoding="utf-8") != text:
            write_atomic(path, text)
            written.append(path.name)
    meta_obj = {"api": "openai", "name": file.stem, "order_character_id": order.get("character_id") if order else None,
                "source_sha256": prompts_hash(preset)}
    meta_path = folder / PRESET_META
    if read_json(meta_path) != meta_obj:
        write_json_atomic(meta_path, meta_obj)
    for o in sorted(f.name for f in folder.glob("*.md") if f.name not in names.values()):
        print(f"note: workspace/prompts/{folder.name}/{o} matches no prompt in {file.name} (not deleted)")
    return folder.name, written


def preset_drift(st: Path) -> str | None:
    """Live prompts in settings.json vs the active preset file: unsaved UI edits show up here."""
    oai = load_settings(st).get("oai_settings", {}) or {}
    name = oai.get("preset_settings_openai")
    path = st / PRESET_DIR / f"{name}.json"
    if not name or not path.is_file():
        return None
    preset = json.loads(path.read_text(encoding="utf-8"))
    if canon(oai.get("prompts", [])) != canon(preset.get("prompts", [])) or \
            canon(global_order(oai) or {}) != canon(global_order(preset) or {}):
        return name
    return None


def push_preset(st: Path, target: str, remove_missing: bool) -> dict | None:
    folder = st / "workspace" / "prompts" / kebab(target)
    meta = read_json(folder / PRESET_META)
    if not meta:
        raise BridgeError(f"{folder}/{PRESET_META} not found: run pull first")
    name, api = meta["name"], meta.get("api", "openai")
    path = st / PRESET_DIR / f"{name}.json"
    current = json.loads(path.read_text(encoding="utf-8"))
    if prompts_hash(current) != meta.get("source_sha256"):
        raise BridgeError(f"{path.name} changed since the last pull (saved from the UI?). Run pull, redo the edit, push again.")

    modules = {}
    for f in sorted(folder.glob("*.md")):
        fm, body = parse_front_matter(f.read_text(encoding="utf-8"), str(f))
        ident = fm.get("identifier")
        if not ident:
            raise BridgeError(f"{f.name}: front matter needs identifier")
        if ident in modules:
            raise BridgeError(f"{f.name}: identifier {ident} also in {modules[ident][2]}")
        modules[ident] = (fm, body, f.name)

    old_prompts = [p for p in current.get("prompts", []) if isinstance(p, dict)]
    missing = [p["identifier"] for p in old_prompts if p.get("identifier") not in modules]
    if missing and not remove_missing:
        raise BridgeError(f"no workspace file for {', '.join(missing)}; pass --remove-missing to delete them from the preset")

    def build(fm: dict, body: str, old: dict | None) -> dict:
        p = dict(old) if old else {}
        p.update({k: v for k, v in fm.items() if k not in PROMPT_FM_EXTRA})
        if body or (old and "content" in old) or not old:
            p["content"] = body
        return p

    by_id = {p.get("identifier"): p for p in old_prompts}
    new_prompts = [build(*modules[i][:2], by_id[i]) for i in (p["identifier"] for p in old_prompts) if i in modules]
    new_prompts += [build(fm, body, None) for i, (fm, body, _) in modules.items() if i not in by_id]

    ordered = sorted(((fm["order"], fname, i, fm.get("enabled", True)) for i, (fm, _, fname) in modules.items()
                      if fm.get("order") is not None), key=lambda t: (float(t[0]), t[1]))
    new_order_list = [{"identifier": i, "enabled": bool(en)} for _, _, i, en in ordered]
    new_prompt_order = []
    for o in current.get("prompt_order", []) or []:
        if o.get("character_id") == meta.get("order_character_id"):
            o = {**o, "order": new_order_list}
        new_prompt_order.append(o)

    new = {**current, "prompts": new_prompts, "prompt_order": new_prompt_order}
    if canon(new) == canon(current):
        return None

    files = st / "user" / "files"
    pending, _, _ = inbox_state(files)
    base = base_name(api, name)
    if not any(item_key(it) == ("preset-changed", api, name) for it in pending) or not (files / base).is_file():
        write_atomic(files / base, path.read_text(encoding="utf-8"))  # what live was derived from
    write_atomic(path, dump_preset(new))
    item = emit_item(files, {"type": "preset-changed", "api": api, "name": name, "base": base})
    write_json_atomic(folder / PRESET_META, {**meta, "source_sha256": prompts_hash(new)})
    return item


# --------------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------------
def cmd_status(st: Path) -> int:
    files = st / "user" / "files"
    pending, next_seq, acked = inbox_state(files)
    ack = read_json(files / ACK, {}) or {}
    print(f"next_seq {next_seq}, acked {acked}" + (f" (by tab {ack['tab']} at {ack['at']})" if ack.get("at") else ""))
    print(f"pending: {len(pending)}")
    for it in pending:
        target = it.get("avatar") or it.get("name") or ""
        print(f"  {it['seq']}: {it.get('type')} {target}")
    for f in ack.get("failed", []):
        print(f"failed: {f.get('seq')}: {f.get('type')}: {f.get('error')}")
    tabs = (read_json(files / TABS, {}) or {}).get("tabs", {})
    now = datetime.now(timezone.utc)
    live = [t for t, at in tabs.items() if (now - datetime.fromisoformat(at.replace("Z", "+00:00"))).total_seconds() < TAB_STALE_S]
    print(f"live tabs: {len(live)}")
    return 0


def cmd_pull(st: Path) -> int:
    pending, _, _ = inbox_state(st / "user" / "files")
    blocking = [it for it in pending if it.get("type") in WORKSPACE_TYPES]
    if blocking:
        seqs = ", ".join(str(it["seq"]) for it in blocking)
        print(f"pull skipped: workspace items still pending (seq {seqs}). They apply when an ST tab is open.")
        return EXIT_BLOCKED
    written = pull_personas(st)
    print(f"personas: {len(written)} file(s) written" + (f" ({', '.join(written)})" if written else ", no changes"))
    for f in sorted((st / PRESET_DIR).glob("*.json")):
        folder, written = pull_preset(st, f)
        print(f"prompts/{folder}: {len(written)} file(s) written" + (f" ({', '.join(written)})" if written else ", no changes"))
    drift = preset_drift(st)
    if drift:
        print(f"warning: live prompts in settings.json differ from preset {drift!r} (unsaved UI edits); workspace has the preset file's version")
    cleanup_bases(st / "user" / "files")
    return 0


def cmd_push(st: Path, kind: str, target: str, remove_missing: bool) -> int:
    if kind == "persona":
        path = Path(target)
        if not path.is_file():
            path = st / "workspace" / "personas" / target
        item = push_persona(st, path)
        print(f"queued seq {item['seq']}: persona-set {item['avatar']} ({', '.join(item['fields'])})")
        return 0
    if kind == "preset":
        item = push_preset(st, target, remove_missing)
        print(f"queued seq {item['seq']}: preset-changed {item['name']} (base {item['base']})" if item else "no changes")
        return 0
    if kind == "card":
        if not (st / "characters" / target).is_file():
            raise BridgeError(f"no card characters/{target}")
        item = emit_item(st / "user" / "files", {"type": "card-changed", "avatar": target})
        print(f"queued seq {item['seq']}: card-changed {target}")
        return 0
    raise BridgeError(f"push {kind}: not supported")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bridge.py", description="SillyTavern-Bridge host CLI")
    p.add_argument("--st-data", help="ST user data folder (data/default-user)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("pull")
    pp = sub.add_parser("push")
    pp.add_argument("kind", choices=["persona", "preset", "card"])
    pp.add_argument("target", help="persona: .md file (path, or name under workspace/personas/); preset: preset name; card: avatar file name (after editing a card on disk)")
    pp.add_argument("--remove-missing", action="store_true", help="preset: delete prompts that have no workspace file")
    args = p.parse_args(argv)
    try:
        st = find_st_data(args.st_data)
        if args.cmd == "status":
            return cmd_status(st)
        if args.cmd == "pull":
            return cmd_pull(st)
        return cmd_push(st, args.kind, args.target, args.remove_missing)
    except BridgeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
