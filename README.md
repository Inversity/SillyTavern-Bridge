# SillyTavern Bridge

Lets a tool outside the browser (a script, an AI agent) change SillyTavern state that lives in the open tab,
without fighting the tab over `settings.json`.

SillyTavern rewrites the whole `settings.json` from the open tab on every save, so anything written to that
file from outside is lost on the tab's next save. The bridge turns that around: the outside tool queues
changes in an inbox file, and this extension applies them **inside the tab** through SillyTavern's own
functions. The tab's normal save then carries the change instead of overwriting it.

Two halves, one repo:

| Half | Where it runs | What it does |
|------|---------------|--------------|
| Extension (`index.js`) | In the SillyTavern tab | Polls the inbox, applies items, acks them, warns when several tabs are open |
| CLI (`tools/bridge.py`) | On the server, Python 3 stdlib only | Exports personas and prompt modules to editable files, queues changes, reports status |

Design and the reasoning behind it: [DESIGN.md](DESIGN.md).

## Install

Extensions panel, **Install extension**, paste this repo's URL. Installing for one user is enough; the CLI
comes along at `data/<user>/extensions/SillyTavern-Bridge/tools/bridge.py`.

## What it can change

| Item | Applied as |
|------|------------|
| `persona-set` | Sets a persona's name, description, title, position, depth, role, lorebook |
| `preset-changed` | Reloads a Chat Completion preset's prompt modules from its file, with a three-way merge against unsaved UI edits (conflicts ask: keep mine, or take the file's) |
| `card-changed` | Reloads a character card edited on disk, refreshes the editor form, and refreshes the greeting of an untouched new chat |

Every applied item shows a toast. Items are idempotent ("set X to Y"), so two tabs applying the same item
end in the same state.

## CLI

```
python3 bridge.py status                        # inbox, ack, pending and failed items, live tabs
python3 bridge.py pull                          # personas + presets -> <data>/workspace/
python3 bridge.py push persona <file.md>        # queue a persona change
python3 bridge.py push preset <name>            # write the preset file from workspace, queue a reload
python3 bridge.py push card <avatar.png>        # after editing a card on disk: open tabs reload it
```

The data folder is auto-detected when the script runs from the installed extension; otherwise pass
`--st-data <data/default-user>` or set `ST_DATA`. `pull` exits with code 3 while persona or preset items
are still waiting for a tab, so a scheduled pull can treat 3 as "skip this run".

Workspace layout:

```
workspace/personas/<avatar>.md           front matter (avatar, name, title, position, ...) + description
workspace/prompts/<preset>/<prompt>.md   front matter (identifier, order, enabled, role, ...) + content
workspace/prompts/<preset>/_preset.json  what the files were pulled from
```

## In the tab

`/bridge status`, `/bridge apply` (check the inbox now), `/bridge mine` / `/bridge theirs` (answer a
preset conflict if its toast was closed).

## Files it uses

All in `data/<user>/user/files/` (the only folder a tab can write, through the upload API):
`bridge-inbox.json` (written by the CLI only), `bridge-ack.json` (by the extension), `bridge-tabs.json`
(tab heartbeats), `bridge-base-*.json` (temporary merge bases, removed by the CLI once applied).

SillyTavern's **Data Maid** lists these as loose files. Don't let it delete them.

## License

AGPL-3.0, same as SillyTavern. See [LICENSE](LICENSE).
