# SillyTavern Bridge: design

What the bridge does, the decisions behind it, and what testing found. The short version is in
[README.md](README.md).

## The problem

SillyTavern (ST) owns `data/<user>/settings.json` and rewrites the whole file from the open tab on every
save (a new file, then a rename). Anything an outside tool writes there is lost on the tab's next save.
Personas, prompt modules and the live state of cards live in that tab. So an outside tool never writes
`settings.json`; it asks the bridge, a UI extension running **inside the tab**, which applies the change
through ST's own functions and lets the tab save normally.

Constraints that shape everything below: a tab can read a known file under `user/files/` but can't list a
folder, and can write only through ST's upload API, which takes **flat names only** (`^[a-zA-Z0-9_\-.]+$`)
and overwrites silently.

## Two halves, one repo

| Half | Runs where | Writes |
|------|-----------|--------|
| **Extension** (`manifest.json`, `index.js`) | Inside the ST tab | `user/files/bridge-ack.json`, `user/files/bridge-tabs.json` (upload API), and live ST state through ST's own functions |
| **CLI** (`tools/bridge.py`, Python 3 stdlib only) | On the server, run by an agent, a person or a scheduled job | `user/files/bridge-inbox.json`, `user/files/bridge-base-*.json`, `workspace/**`, `OpenAI Settings/<preset>.json`. **Never** `settings.json` (read only) |

Why the CLI exists: the tab can't write `workspace/`, and `workspace/` isn't served over HTTP, so the tab
can neither write nor read it. The server side does both. Installing the extension also puts the CLI on
disk at `data/<user>/extensions/SillyTavern-Bridge/tools/bridge.py`, so a scheduled pull needs no second
install. The CLI sets `sys.dont_write_bytecode`, so it also runs where extension code is read-only.

## Inbox: one writer per file

- `user/files/bridge-inbox.json`: sequence-numbered items plus `next_seq`. **Only the CLI side writes
  it**, atomically (temp file, then rename).
- `user/files/bridge-ack.json`: the last sequence number applied. **Only the extension writes it.**
- Writers drop items at or below the ack and keep `next_seq`, so numbers never go backwards.
- **Every item is idempotent** ("set persona X's description to Y", never "append"): two tabs applying the
  same item end in the same state.

```json
{
  "next_seq": 8,
  "items": [
    {"seq": 5, "type": "card-changed", "avatar": "Seraphina.png"},
    {"seq": 6, "type": "persona-set", "avatar": "user-default.png",
     "fields": {"name": "Alex", "description": "...", "title": "", "position": 0, "depth": 2, "role": 0, "lorebook": ""}},
    {"seq": 7, "type": "preset-changed", "api": "openai", "name": "my-preset", "base": "bridge-base-1a2b3c4d5e6f.json"}
  ]
}
```

- `card-changed`: a card was edited on disk; reload it. Any tool that edits cards can emit it
  (`bridge.py push card <avatar>` does).
- `persona-set`: sets each field present in `fields` on the persona keyed by its avatar file. Absent fields
  are left alone. Content is **inline**, because the tab can't read `workspace/`. Edits existing personas
  only (a new persona needs an avatar image upload; out of scope).
- `preset-changed`: the preset file on disk already holds the new content (the preset file is the source of
  truth). The item only says "reload it". Content is fetched through `POST /api/settings/get`, which returns
  every preset file. `base` names a copy of the preset **before** the edit, written by `push preset` (only
  the CLI writes `bridge-base-*.json`). It is the merge base (below). While an item for that preset is
  still pending, a second push keeps the first base, because the tab's live state was derived from that
  one. The CLI removes base copies no pending item names (on every push, pull and status), so `user/files/`
  doesn't accumulate them.
- Writers dedupe by key (`avatar` for cards and personas, `api`+`name` for presets): a new item replaces any
  pending item with the same key. The newest item carries the full desired state, so nothing is lost.

## Applying, in the tab

- **When:** on `APP_READY`, then every 10 s, and on `visibilitychange` to visible. Hidden tabs poll too
  (Chrome throttles them to about once a minute): a hidden tab that never applied a change could still
  save its stale copy. Fetch `/user/files/bridge-inbox.json?t=<now>` with `cache: 'no-store'`.
- **Order:** items apply in `seq` order. The ack is the highest seq applied **contiguously**.
- **Per-tab position:** each tab applies items above its **own** `applied_seq`, kept in
  `extension_settings.bridge` and saved in the same `settings.json` write as the change. Filtering by the
  shared ack instead would let tab A apply and ack an item that tab B then never applies, and B's next save
  would write the stale state back. A freshly loaded tab knows exactly what its loaded state holds. The ack
  is written only after that save. If a tab's next pending item is above `applied_seq + 1` (items pruned
  after another tab acked them), it warns "reload this tab".
- **Persona:** write `power_user.personas[avatar]` and `power_user.persona_descriptions[avatar]`, refresh
  the active persona's live fields if it is the current one, re-render the persona list. The loop then
  awaits `saveSettings()`. The change lives in the tab's own state, so the tab's next save carries it
  instead of overwriting it.
- **Preset (three-way merge):** base = the `base` copy (or, if it is already gone, the tab's own loaded
  copy of the file), next = the file now, live = `oai_settings`. Only `prompts` (per `identifier`) and
  `prompt_order` (per `character_id`) merge, because that is all the workspace edits. For each entry the
  edit changed (base != next): live already equals next, skip; live equals base, apply; otherwise the user
  edited it in the UI too, a **conflict**. Entries compare only on the fields the file side has (ST adds
  defaults to live copies).
  - Not the active preset: replace the tab's loaded copy with the file. Done.
  - No conflict: apply, replace the loaded copy, re-render the prompt manager. Unsaved UI edits to other
    prompts stay unsaved; the bridge does **not** save the preset (that would quietly save them too).
  - Conflict: halt and show a sticky toast naming the prompts. **"Keep mine (save to preset)"** applies the
    rest, keeps the UI version of the conflicting entries, and saves the preset the way ST's own Save does
    (`getChatCompletionPreset()` → `/api/presets/save`). **"Use Claude's"** applies everything.
    `/bridge mine` and `/bridge theirs` do the same if the toast was closed. Later items wait.
  - After "Keep mine" the preset file differs from the workspace, so the next `push preset` refuses until a
    pull (by design: the file moved).
- **Card:** `getOneCharacter()` refreshes the character in memory. If it is the open character, the editor
  form is refreshed too (`select_selected_character()`): ST saves cards from the form, so a stale form is
  how an open tab writes an old card back over an outside edit. If the open chat is an untouched
  greeting-only chat and the greetings changed, ST's own `retriggerFirstMessageOnEmptyChat()` shows the new
  greeting (it re-saves the card from the now fresh form).
  **Keep the tab's `chat` field:** the card's `chat` is the tab's pointer to the open chat file. A card
  packed outside the tab can carry an older value. Taking it pointed a test tab at an older chat while it
  showed a new one; ST's chat integrity check then refused the save. The bridge keeps the tab's value.
- **Toast** for every applied item ("Bridge: Persona Alex updated (description)").

### Failure policy

| Case | Behavior |
|------|----------|
| Unknown item type | **Halt** at that item, warn "update the bridge". Acking would silently drop it (version skew). |
| Known type, bad target (no such avatar or preset) | Record in `failed`, ack past it, error toast. A dead item must not block the queue forever. |
| Preset conflict | Halt and ask (above). |
| Handler blocked (an ST dialog) | After 30 s, warn "check for an open dialog". |
| Inbox unreadable or malformed JSON | Warn once, retry next tick. The writer is atomic, so this means a bug, not a race. |

## Ack and heartbeat state

- `user/files/bridge-ack.json`:
  `{"acked_seq": 7, "failed": [{"seq": 4, "error": "no persona x.png"}], "tab": "<id>", "at": "<iso>"}`.
  With two tabs, each one re-reads the ack and writes `max(theirs, mine)` before uploading. A lost race can
  move the ack back one step; the cost is a repeat of an idempotent item, which is harmless.
- `user/files/bridge-tabs.json`: `{"tabs": {"<id>": "<iso last seen>"}}`. Each tab re-reads, prunes entries
  older than 90 s, writes itself every 30 s, and toasts once when it sees another live tab. This file is
  **multi-writer by design** (the one exception to one-writer-per-file): it is advisory, and a lost race
  only hides another tab for one cycle. Tab id: random, kept in `sessionStorage` so a reload keeps it.

## Workspace pull and push (CLI)

```
python3 tools/bridge.py pull   [--st-data <dir>]               # settings.json + presets -> workspace/
python3 tools/bridge.py push persona <file.md>                 # workspace persona -> persona-set item
python3 tools/bridge.py push preset <name> [--remove-missing]  # workspace modules -> preset file + item
python3 tools/bridge.py push card <avatar.png>                 # card-changed item
python3 tools/bridge.py status                                 # next_seq, ack, pending, failed, live tabs
```

- **Trigger: CLI only** (on demand, or a scheduled job). A slash command can't run the pull because the tab
  can't write `workspace/`. The tab gets `/bridge status`, `/bridge apply` (fetch now) and
  `/bridge mine|theirs` (answer a preset conflict) instead.
- **Layout:**
  - `workspace/personas/<avatar-stem>.md`: YAML front matter (`avatar`, `name`, `title`, `position`,
    `depth`, `role`, `lorebook`), body = description.
  - `workspace/prompts/<kebab-preset>/<kebab-prompt-name>.md`: one file per `prompts` entry. Front matter:
    `identifier`, `order` and `enabled` (from the global `prompt_order` entry, `character_id` 100001;
    absent when the prompt isn't in the order), then every other field of the prompt as stored. Body =
    content. The position is `order:` in front matter, not a filename prefix, so a reorder doesn't rename
    files (pull never deletes, so renamed files would pile up as orphans). Push sorts by `order` (decimals
    allowed, e.g. `1.5` to insert); pull renumbers to whole numbers.
  - `workspace/prompts/<kebab-preset>/_preset.json`: preset name, the order entry used, and a hash of the
    file's `prompts` + `prompt_order` at pull time. **Push refuses if the file moved since** (saved from
    the UI, or "Keep mine"): run pull, redo the edit, push again.
  - Push merges each module over the stored prompt, so fields the workspace doesn't show survive. A prompt
    with no workspace file is an error unless `--remove-missing`.
  - Preset files are written as ST writes them: `JSON.stringify(preset, null, 4)`, no trailing newline. (A
    default shipped in ST's repo may have CRLF and a trailing newline; the first push normalizes it.)
- **Pull safety:** pull refuses (exit code 3, says why) while `persona-set` or `preset-changed` items are
  pending. Otherwise a pull between "pushed" and "tab applied" would overwrite the workspace edit with the
  old live state. Pending `card-changed` items don't block: they don't touch `workspace/`, and one pending
  card item would otherwise stall a scheduled pull until someone opens ST. A scheduled job should treat
  exit 3 as "skip this run", not a failure.
- **Drift report:** pull exports prompts from the **preset file**, and prints a warning when the live copy in
  `settings.json` differs (UI edits not yet saved to the preset).
- **Atomic writes** everywhere: a temp file in the same folder (`.<name>.<pid>.tmp`, so a leftover matches
  common `*.tmp` ignores), then rename. Two concurrent inbox writers can still race; any writer of this
  format carries that risk.

## Decisions

1. **Prompt module format:** YAML front matter + body, as above, so modules round-trip.
2. **License:** AGPL-3.0, same as SillyTavern.
3. **Pull blocks only on workspace items** (`persona-set`, `preset-changed`), not on `card-changed`.
4. **Found while testing:** per-tab `applied_seq`; keep the tab's `chat` pointer on card reload; the
   three-way preset merge (instead of a whole-preset clean/dirty check and a preset save by the bridge);
   the CLI cleans up base copies once acked.
