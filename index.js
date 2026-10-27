// Bridge: applies changes Claude queues in user/files/bridge-inbox.json inside this tab, through ST's own
// functions, so the tab's normal settings save carries them instead of overwriting them. Design: DESIGN.md.
// - Each tab tracks the last seq it applied in extension_settings.bridge.applied_seq. That value is saved in
//   the same settings.json write as the change itself, so a freshly loaded tab knows exactly what its state
//   already holds, and a second open tab still applies items the first one acked.
// - bridge-ack.json is Claude's view only: the highest seq any tab has applied AND saved, plus failures.
// - bridge-tabs.json holds per-tab heartbeats, used only to warn when more than one tab is open.
import {
    characters, chat, chat_metadata, eventSource, event_types, getOneCharacter, getCharacters,
    getRequestHeaders, saveSettings, select_selected_character, setUserName, this_chid,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { selected_group } from '../../../group-chats.js';
import { getChatCompletionPreset, oai_settings, openai_setting_names, openai_settings, promptManager } from '../../../openai.js';
import { getUserAvatars, retriggerFirstMessageOnEmptyChat, setPersonaDescription, user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { escapeHtml } from '../../../utils.js';

const INBOX = 'bridge-inbox.json';
const ACK = 'bridge-ack.json';
const TABS = 'bridge-tabs.json';
const POLL_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const TAB_STALE_MS = 90_000;
const MAX_FAILED = 20;
const STALL_MS = 30_000;
const TITLE = 'Bridge';

const TAB_ID = (() => {
    try {
        let id = sessionStorage.getItem('bridge:tabId');
        if (!id) sessionStorage.setItem('bridge:tabId', id = Math.random().toString(36).slice(2, 10));
        return id;
    } catch { return Math.random().toString(36).slice(2, 10); }
})();

const state = () => (extension_settings.bridge ??= { applied_seq: 0 });
const warned = new Set(); // one warning per distinct problem, per page load

function warnOnce(key, msg, opts = {}) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[Bridge] ${msg}`);
    toastr.warning(msg, TITLE, { timeOut: 0, extendedTimeOut: 0, closeButton: true, ...opts });
}

// ======================================================================================
// user/files I/O: read over HTTP (cache-busted), write through ST's upload API (flat names only)
// ======================================================================================
async function readFile(name) {
    const res = await fetch(`/user/files/${name}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${name}: HTTP ${res.status}`);
    return JSON.parse(await res.text());
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

async function writeFile(name, obj) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(JSON.stringify(obj, null, 2) + '\n') }),
    });
    if (!res.ok) throw new Error(`upload ${name}: HTTP ${res.status}`);
}

// ======================================================================================
// Item handlers. Each returns { status: 'ok' | 'noop' | 'failed' | 'halt', msg }.
//   ok: applied, toast it. noop: already in that state (re-apply), no toast.
//   failed: bad target; recorded in the ack and skipped. halt: stop the queue here.
// ======================================================================================
const PERSONA_FIELDS = { description: 'string', title: 'string', lorebook: 'string', position: 'number', depth: 'number', role: 'number' };

async function applyPersonaSet(item) {
    const { avatar, fields } = item;
    if (typeof avatar !== 'string' || !fields || typeof fields !== 'object') return { status: 'failed', msg: 'persona-set needs avatar and fields' };
    if (!(avatar in power_user.personas)) return { status: 'failed', msg: `no persona with avatar ${avatar}` };
    if ('name' in fields && (typeof fields.name !== 'string' || !fields.name.trim())) return { status: 'failed', msg: 'name must be a non-empty string' };
    for (const [k, type] of Object.entries(PERSONA_FIELDS)) {
        if (k in fields && typeof fields[k] !== type) return { status: 'failed', msg: `${k} must be a ${type}` };
    }

    const desc = power_user.persona_descriptions[avatar] ??= { description: '', position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: '' };
    const changed = [];
    if ('name' in fields && power_user.personas[avatar] !== fields.name) {
        power_user.personas[avatar] = fields.name;
        changed.push('name');
    }
    for (const k of Object.keys(PERSONA_FIELDS)) {
        if (k in fields && desc[k] !== fields[k]) {
            desc[k] = fields[k];
            changed.push(k);
        }
    }
    if (!changed.length) return { status: 'noop' };

    // The active persona is also mirrored into power_user.persona_* fields and the name1 global.
    if (avatar === user_avatar) {
        if (changed.includes('name')) setUserName(fields.name, { toastPersonaNameChange: false });
        power_user.persona_description = desc.description ?? '';
        power_user.persona_description_position = desc.position;
        power_user.persona_description_depth = desc.depth;
        power_user.persona_description_role = desc.role;
        power_user.persona_description_lorebook = desc.lorebook ?? '';
        setPersonaDescription();
    }
    await getUserAvatars(true, avatar);
    await eventSource.emit(event_types.PERSONA_UPDATED, avatar);
    return { status: 'ok', msg: `Persona ${power_user.personas[avatar]} updated (${changed.join(', ')})` };
}

async function applyCardChanged(item) {
    const { avatar } = item;
    if (typeof avatar !== 'string') return { status: 'failed', msg: 'card-changed needs avatar' };

    let idx = characters.findIndex(c => c.avatar === avatar);
    if (idx === -1) {
        await getCharacters(); // a card ST hasn't listed yet
        idx = characters.findIndex(c => c.avatar === avatar);
        if (idx === -1) return { status: 'failed', msg: `no character with avatar ${avatar}` };
        return { status: 'ok', msg: `Character ${characters[idx].name} added to the list` };
    }

    const before = characters[idx];
    const isOpen = !selected_group && this_chid !== undefined && String(this_chid) === String(idx);
    await getOneCharacter(avatar);
    const after = characters[idx];
    // The card's `chat` field is the tab's pointer to the open chat file. A card written outside the tab can
    // carry an older value; taking it would point this tab at a different chat than the one it shows, and its
    // next save would hit ST's integrity check (or, if overridden, overwrite that other chat).
    after.chat = before.chat;
    if (!isOpen) return { status: 'ok', msg: `Character ${after.name} reloaded` };

    // Refresh the editor form from the fresh card: ST saves cards from the form, so a stale form is how an
    // open tab writes the old card back over an outside edit.
    select_selected_character(this_chid, { switchMenu: false });

    // An untouched greeting-only chat shows the new greeting. ST's own path for this re-saves the card from
    // the (now fresh) form, so only take it when the greetings actually changed.
    const greetingsChanged = before.first_mes !== after.first_mes ||
        JSON.stringify(before.data?.alternate_greetings ?? []) !== JSON.stringify(after.data?.alternate_greetings ?? []);
    const untouched = chat.length === 1 && !chat[0]?.is_user && !chat_metadata.tainted;
    if (greetingsChanged && untouched) {
        await retriggerFirstMessageOnEmptyChat();
        return { status: 'ok', msg: `Character ${after.name} reloaded, greeting refreshed` };
    }
    return { status: 'ok', msg: `Character ${after.name} reloaded` };
}

// Preset: three-way merge of base (the preset before Claude's edit), next (the preset file now) and live
// (oai_settings), per prompt by identifier and per prompt_order entry. Claude edits only prompts and
// prompt_order, so only those merge. An entry Claude changed applies when live still matches base; when live
// matches neither, the user edited it in the UI too: that is a conflict, and the user picks a side.
const canon = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);
const promptKey = p => p?.identifier;
const orderKey = o => String(o?.character_id);
const resolutions = new Map(); // seq -> 'mine' | 'theirs', chosen in the conflict toast or /bridge mine|theirs
let conflictSeq = null;
let $conflictToast = null;

function planMerge(live, base, next, keyOf) {
    const L = new Map(live.map(x => [keyOf(x), x]));
    const B = new Map(base.map(x => [keyOf(x), x]));
    const N = new Map(next.map(x => [keyOf(x), x]));
    const plan = [];
    for (const key of new Set([...B.keys(), ...N.keys()])) {
        const b = B.get(key), n = N.get(key), l = L.get(key);
        // Compare only the fields the file side has: ST adds defaults to its live copies.
        const fields = [...new Set([...Object.keys(b ?? {}), ...Object.keys(n ?? {})])];
        const eq = (x, y) => (x === undefined || y === undefined) ? x === y : fields.every(f => canon(x[f]) === canon(y[f]));
        if (eq(b, n) || eq(l, n)) continue; // Claude didn't change it, or this tab already has it
        plan.push({ key, next: n, label: n?.name ?? b?.name ?? l?.name ?? key, conflict: !eq(l, b) });
    }
    return plan;
}

function applyPlan(live, plan, keyOf) {
    for (const p of plan) {
        const i = live.findIndex(x => keyOf(x) === p.key);
        if (p.next === undefined) { if (i !== -1) live.splice(i, 1); }
        else if (i !== -1) live[i] = structuredClone(p.next);
        else live.push(structuredClone(p.next));
    }
}

function replaceInPlace(target, source) {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, structuredClone(source));
}

function showConflict(item, labels) {
    conflictSeq = item.seq;
    if (warned.has(`conflict:${item.seq}`)) return;
    warned.add(`conflict:${item.seq}`);
    const html = `<div>Preset <b>${escapeHtml(item.name)}</b>: you have unsaved edits to <b>${labels.map(escapeHtml).join(', ')}</b>, and Claude changed ${labels.length > 1 ? 'them' : 'it'} too. Later bridge changes wait until you pick.</div>
        <div class="bridge-toast-actions"><button class="menu_button" data-bridge-choice="mine">Keep mine (save to preset)</button>
        <button class="menu_button" data-bridge-choice="theirs">Use Claude's</button></div>`;
    $conflictToast = toastr.warning(html, TITLE, { timeOut: 0, extendedTimeOut: 0, escapeHtml: false, tapToDismiss: false, closeButton: true });
    $conflictToast.find('[data-bridge-choice]').on('click', e => resolve(item.seq, e.currentTarget.dataset.bridgeChoice));
}

function resolve(seq, choice) {
    resolutions.set(seq, choice);
    if ($conflictToast) toastr.clear($conflictToast);
    $conflictToast = null;
    return tick();
}

// Same request ST's own preset Save button makes (saveOpenAIPreset), without re-applying the preset.
async function savePresetFromLive(name, idx) {
    const preset = getChatCompletionPreset(oai_settings);
    const res = await fetch('/api/presets/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ apiId: 'openai', name, preset }) });
    if (!res.ok) throw new Error(`preset save: HTTP ${res.status}`);
    Object.assign(openai_settings[idx], preset);
}

async function applyPresetChanged(item) {
    const { api, name, base } = item;
    if (api !== 'openai' || typeof name !== 'string') return { status: 'failed', msg: 'preset-changed supports api "openai" with a name' };

    const res = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
    if (!res.ok) throw new Error(`settings/get: HTTP ${res.status}`);
    const data = await res.json();
    const fileIdx = data.openai_setting_names.indexOf(name);
    if (fileIdx === -1) return { status: 'failed', msg: `no preset file ${name}` };
    const next = JSON.parse(data.openai_settings[fileIdx]);

    const idx = openai_setting_names[name];
    if (idx === undefined) return { status: 'failed', msg: `preset ${name} isn't in this tab's list; reload the tab to load it` };
    const loaded = openai_settings[idx];

    if (oai_settings.preset_settings_openai !== name) {
        if (canon(loaded) === canon(next)) return { status: 'noop' };
        replaceInPlace(loaded, next);
        return { status: 'ok', msg: `Preset ${name} reloaded (not the active preset)` };
    }

    // The base copy is removed once acked; a tab that missed it merges against its own loaded copy instead.
    const baseP = (base ? await readFile(base).catch(() => null) : null) ?? loaded;
    oai_settings.prompts ??= [];
    oai_settings.prompt_order ??= [];
    const prompts = planMerge(oai_settings.prompts, baseP.prompts ?? [], next.prompts ?? [], promptKey);
    const orders = planMerge(oai_settings.prompt_order, baseP.prompt_order ?? [], next.prompt_order ?? [], orderKey);
    const conflicts = [...prompts, ...orders].filter(p => p.conflict);
    const choice = resolutions.get(item.seq);
    if (conflicts.length && !choice) {
        showConflict(item, conflicts.map(p => (orders.includes(p) ? 'prompt order' : p.label)));
        return { status: 'halt' };
    }

    const take = choice === 'mine' ? p => !p.conflict : () => true;
    applyPlan(oai_settings.prompts, prompts.filter(take), promptKey);
    applyPlan(oai_settings.prompt_order, orders.filter(take), orderKey);
    replaceInPlace(loaded, next); // the tab's copy of the file now matches the file
    if (choice === 'mine' && conflicts.length) await savePresetFromLive(name, idx);
    resolutions.delete(item.seq);
    conflictSeq = null;
    promptManager?.render(false);

    const changed = prompts.filter(take).length;
    const orderChanged = orders.some(take);
    if (!changed && !orderChanged && !conflicts.length) return { status: 'noop' };
    const parts = [];
    if (changed) parts.push(`${changed} prompt${changed > 1 ? 's' : ''} updated`);
    if (orderChanged) parts.push('order updated');
    if (choice === 'mine' && conflicts.length) parts.push(`kept your edit${conflicts.length > 1 ? 's' : ''} to ${conflicts.map(p => p.label).join(', ')} and saved the preset`);
    return { status: 'ok', msg: `Preset ${name}: ${parts.join(', ')}` };
}

const HANDLERS = {
    'persona-set': applyPersonaSet,
    'card-changed': applyCardChanged,
    'preset-changed': applyPresetChanged,
};

// ======================================================================================
// Apply loop
// ======================================================================================
let busy = false;
let ready = false;

async function tick() {
    if (!ready || busy) return;
    busy = true;
    try {
        let inbox;
        try {
            inbox = await readFile(INBOX);
        } catch (err) {
            warnOnce(`inbox:${err.message}`, `Can't read ${INBOX}: ${err.message}. Retrying.`, { timeOut: 8000 });
            return;
        }
        if (!inbox || !Array.isArray(inbox.items)) return;

        const s = state();
        const pending = inbox.items
            .filter(it => it && Number.isInteger(it.seq) && it.seq > s.applied_seq)
            .sort((a, b) => a.seq - b.seq);
        if (!pending.length) return;

        // Items this tab never saw were pruned after another tab acked them: this tab's state is stale.
        if (s.applied_seq > 0 && pending[0].seq > s.applied_seq + 1) {
            warnOnce(`gap:${s.applied_seq}`, `This tab missed bridge changes ${s.applied_seq + 1} to ${pending[0].seq - 1}. Reload it from the address bar (not F5) before editing anything.`);
        }

        let last = s.applied_seq;
        const failed = [];
        for (const item of pending) {
            const handler = HANDLERS[item.type];
            let result;
            if (!handler) {
                result = { status: 'halt', msg: `Unknown item type "${item.type}" at seq ${item.seq}. Update the Bridge extension; later items wait.` };
            } else {
                // A handler can block behind an ST dialog; say so instead of stalling silently.
                const stall = setTimeout(() => warnOnce(`stall:${item.seq}`, `Still applying item ${item.seq} (${item.type}). Check for an open SillyTavern dialog.`), STALL_MS);
                try {
                    result = await handler(item);
                } catch (err) {
                    console.error('[Bridge] handler error', item, err);
                    result = { status: 'failed', msg: `${item.type}: ${err.message}` };
                } finally {
                    clearTimeout(stall);
                }
            }

            if (result.status === 'halt') {
                if (result.msg) warnOnce(`halt:${item.seq}`, result.msg);
                break;
            }
            if (result.status === 'failed') {
                failed.push({ seq: item.seq, type: item.type, error: result.msg });
                toastr.error(result.msg, `${TITLE}: item ${item.seq} skipped`, { timeOut: 15000 });
            } else if (result.status === 'ok') {
                toastr.success(result.msg, TITLE);
            }
            last = item.seq;
        }

        if (last === s.applied_seq) return;
        s.applied_seq = last;
        await saveSettings(); // the change and applied_seq land in settings.json together, before the ack
        await writeAck(last, failed);
    } finally {
        busy = false;
    }
}

async function writeAck(seq, newFailures) {
    let prev = null;
    try { prev = await readFile(ACK); } catch { /* treat as missing */ }
    const failed = [...(prev?.failed ?? []), ...newFailures]
        .filter((f, i, all) => all.findIndex(g => g.seq === f.seq) === i)
        .sort((a, b) => a.seq - b.seq)
        .slice(-MAX_FAILED);
    await writeFile(ACK, {
        acked_seq: Math.max(Number(prev?.acked_seq) || 0, seq),
        failed,
        tab: TAB_ID,
        at: new Date().toISOString(),
    });
}

// ======================================================================================
// Heartbeats: warn when another tab is open (that tab can save stale state over this one's)
// ======================================================================================
async function liveTabs() {
    const data = await readFile(TABS).catch(() => null);
    const now = Date.now();
    return Object.fromEntries(Object.entries(data?.tabs ?? {}).filter(([, at]) => now - Date.parse(at) < TAB_STALE_MS));
}

async function heartbeat() {
    try {
        const tabs = await liveTabs();
        tabs[TAB_ID] = new Date().toISOString();
        await writeFile(TABS, { tabs });
        const others = Object.keys(tabs).filter(id => id !== TAB_ID);
        if (others.length) {
            warnOnce(`tabs:${others.sort().join(',')}`, `${others.length + 1} SillyTavern tabs are open. Close the extras: an older tab can save stale settings over newer ones.`, { timeOut: 20000, extendedTimeOut: 5000 });
        }
    } catch (err) {
        console.warn('[Bridge] heartbeat failed', err);
    }
}

// ======================================================================================
// Slash command: /bridge [status|apply]
// ======================================================================================
async function status() {
    const [inbox, ack, tabs] = await Promise.all([readFile(INBOX).catch(() => null), readFile(ACK).catch(() => null), liveTabs()]);
    const s = state();
    const pending = (inbox?.items ?? []).filter(it => it.seq > s.applied_seq).length;
    return [
        `This tab: applied seq ${s.applied_seq}, ${pending} pending, tab ${TAB_ID}.`,
        `Inbox next_seq ${inbox?.next_seq ?? 'none'}. Ack ${ack?.acked_seq ?? 'none'}${ack?.failed?.length ? `, ${ack.failed.length} failed` : ''}.`,
        `Live tabs: ${Object.keys(tabs).length}.`,
    ].join(' ');
}

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'bridge',
    helpString: 'Bridge: <code>/bridge status</code> shows applied/ack/pending state; <code>/bridge apply</code> checks the inbox now; <code>/bridge mine</code> or <code>/bridge theirs</code> answers a preset conflict (keep my edits and save them to the preset, or use Claude\'s).',
    unnamedArgumentList: [SlashCommandArgument.fromProps({
        description: 'status | apply | mine | theirs', typeList: [ARGUMENT_TYPE.STRING], enumList: ['status', 'apply', 'mine', 'theirs'], defaultValue: 'status',
    })],
    callback: async (_args, value) => {
        const action = String(value || 'status').trim();
        if (action === 'mine' || action === 'theirs') {
            if (conflictSeq === null) {
                toastr.info('No preset conflict is waiting.', TITLE);
                return '';
            }
            await resolve(conflictSeq, action);
        } else if (action === 'apply') {
            await tick();
        }
        const text = await status();
        toastr.info(text, TITLE, { timeOut: 10000 });
        return text;
    },
}));

// ======================================================================================
// Boot: settings (and so applied_seq) are loaded by APP_READY
// ======================================================================================
eventSource.on(event_types.APP_READY, () => {
    ready = true;
    tick();
    heartbeat();
    setInterval(tick, POLL_MS);
    setInterval(heartbeat, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
});
