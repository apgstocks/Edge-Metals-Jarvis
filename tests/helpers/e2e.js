// ── tests/helpers/e2e.js ──────────────────────────────────────────────────
// Apsara, 2026-09-07: "test it end to end. set up testing environment."
//
// WHY THIS IS NEEDED, stated plainly: everything built today is tested with
// the module under test loaded directly and its neighbours replaced by stubs.
// That catches logic errors and it caught a lot of them. What it CANNOT catch
// is the class of bug that has actually reached her all day — the pieces not
// fitting together. The numbers that never reached the preview. The variable
// that did not exist on the one path that reopens the microphone. The
// acknowledgement that borrowed the other assistant's words. Every one of
// those passed its own unit tests.
//
// So this boots the REAL Express app from createApi(), over a real socket,
// and talks to /api/voice/ask the way the browser does — one HTTP request per
// utterance, with the server keeping its own memory between them. Nothing is
// reached into. If a conversation works here, the parts fit.
//
// WHAT IS AND IS NOT FAKED, and the line is deliberate:
//   FAKED  — Gemini. A test that calls a paid API is a test nobody runs
//            twice, and a non-deterministic one is worse than none. The stub
//            is installed at the MODULE boundary (require.cache), so every
//            caller reaches it exactly as it reaches the real thing.
//   REAL   — the router, the referent memory, the centering, the repair
//            classifier, the proforma draft, answerCards, followUp, the
//            pending machinery, JSON persistence with its file locks, auth.
//
// AND IT RUNS TWICE. Once with the model answering, once with it dead. The
// second pass is not a bonus: Gemini is genuinely unreachable for her
// sometimes, and "works only when the model is up" is a feature that fails on
// the day it matters.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

// ── FIXTURE ──────────────────────────────────────────────────────────────
// Four bookings, two of them Houston, with the shape her real data has —
// verified against data/bookings.json on 2026-09-07, which carries erd_date
// and cutoff_date on 4/4 rows. Dates are relative to today so "next
// Wednesday" and "in N days" mean something whenever this is run; a fixture
// with hardcoded 2026 dates would go stale and start asserting nonsense.
function ymd(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function fixtures(dir) {
    fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({
        // Soonest cutoff first is what answerCards sorts to, so THIS is the
        // one "the first one" and the discourse center should land on.
        HOU111: {
            booking_number: 'HOU111', carrier: 'MSC',
            port_of_loading: 'HOUSTON', port_of_discharge: 'BUSAN',
            erd_date: ymd(3), cutoff_date: ymd(7), vessel_voyage: 'MSC ANNA / 512W',
            containers: [{ seq: 1, size: '40HC', supplier: 'Eccomelt' }],
        },
        HOU222: {
            booking_number: 'HOU222', carrier: 'Maersk',
            port_of_loading: 'HOUSTON', port_of_discharge: 'BUSAN',
            erd_date: ymd(9), cutoff_date: ymd(14), vessel_voyage: 'MAERSK KOWLOON / 118E',
            // A supplier, because forwardBooking refuses without one and the
            // "trucker unreachable" branch would never be reached — it would
            // stop at an earlier gate and the test would pass for the wrong
            // reason, which is how a green suite hides a bug.
            containers: [{ seq: 1, size: '40HC', supplier: 'Eccomelt' }],
        },
        OAK333: {
            booking_number: 'OAK333', carrier: 'ONE',
            port_of_loading: 'OAKLAND', port_of_discharge: 'BUSAN',
            erd_date: ymd(5), cutoff_date: ymd(11),
            containers: [{ seq: 1, size: '40HC' }],
        },
        LGB444: {
            booking_number: 'LGB444', carrier: 'CMA',
            port_of_loading: 'LONG BEACH', port_of_discharge: 'BUSAN',
            erd_date: ymd(2), cutoff_date: ymd(6),
            containers: [{ seq: 1, size: '40HC' }],
        },
    }, null, 2));
    // A trucker and a supplier, so the forward flow — the one with a real
    // driver at the end of it — can actually be walked end to end. Without
    // these, forwardBooking refuses at the first gate and the interesting
    // path is never reached.
    for (const [f, v] of [
        ['workflow.json', {}], ['brain.json', { pending_actions: {}, pending_queue: {} }],
        ['truckers.json', [{ name: 'Sher Trucking', number: '15551230001' }]],
        ['suppliers.json', [{ name: 'Eccomelt', number: '15551230002' }]],
        ['contacts.json', []],
    ]) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
}

// ── THE MODEL STUB ───────────────────────────────────────────────────────
// One function, routed on what the prompt is asking for, so a single stub
// serves draftIntent, repair and followUp without any of them knowing.
// `mode: 'down'` makes every call throw, which is the offline pass.
function installGemini(mode, log) {
    const p = require.resolve(path.join(ROOT, 'helpers/gemini.js'));
    const real = require.cache[p];
    const callGeminiJSON = async (prompt) => {
        log.push(prompt);
        if (mode === 'down') throw new Error('ECONNREFUSED (stubbed offline)');
        const said = (/SHE SAID: (.*)/.exec(prompt) || [])[1] || '';

        // draftIntent — park / resume / amend / none
        if (/what she wants to do with the proforma/i.test(prompt)) {
            if (/\b(hold|leave|park|one sec|put .* down)\b/i.test(said)) return { label: 'park', why: 'stub' };
            if (/\b(back to|carry on|get on with|where were we)\b/i.test(said)) return { label: 'resume', why: 'stub' };
            if (/(trade terms|payment terms|the rate is|consignee is|CIF|FOB)/i.test(said)
                && /THE DOCUMENT IS FINISHED/.test(prompt)) return { label: 'amend', why: 'stub' };
            return { label: 'none', why: 'stub' };
        }
        // repair — undo / cancel / restart / none
        if (/TAKING SOMETHING BACK/i.test(prompt)) {
            if (/(start again|from the top|start over)/i.test(said)) return { label: 'restart', why: 'stub' };
            if (/(ignore that|forget|mistake|wrong|drop it)/i.test(said)) return { label: 'cancel', why: 'stub' };
            if (/(not that one|take that back)/i.test(said)) return { label: 'undo', why: 'stub' };
            return { label: 'none', why: 'stub' };
        }
        // followUp — answers from the rows already on screen.
        if (/DATA \(the bookings currently on her screen\)/.test(prompt)) {
            const asked = (/SHE ASKED: (.*)/.exec(prompt) || [])[1] || '';
            const about = (/SHE IS ASKING ABOUT booking (\S+)/.exec(prompt) || [])[1] || '';
            const rows = JSON.parse((/DATA[^\n]*\n(\[.*\])/s.exec(prompt) || [])[1] || '[]');
            // `booking`, NOT `booking_number`. followUp.forModel() renames the
            // field on the way to the model, and my first stub read the
            // original name — so it answered "ERD on undefined is...". The
            // stub was wrong, not the code, but it is exactly the boundary-
            // rename hazard that makes an e2e worth having: a unit test with
            // a hand-built row would never have crossed forModel at all.
            const row = rows.filter((r) => r.booking === about)[0] || rows[0];
            if (!row) return { answer: '', have_data: false };
            if (/\berd\b/i.test(asked)) {
                return { answer: `ERD on ${row.booking} is ${row.erd || 'not set'}.`, have_data: true };
            }
            if (/vessel/i.test(asked)) {
                return { answer: `${row.booking} is on ${row.vessel || 'no vessel yet'}.`, have_data: true };
            }
            return { answer: '', have_data: false };
        }
        return null;
    };
    require.cache[p] = {
        id: p, filename: p, loaded: true,
        // Everything else the real module exports is preserved, so a caller
        // reaching for extractPdfFields does not get undefined and throw a
        // TypeError that reads like a bug in the code under test.
        exports: Object.assign({}, real ? real.exports : {}, { callGeminiJSON }),
    };
}

// ── SUPABASE ─────────────────────────────────────────────────────────────
// Truckers and suppliers do NOT live in DATA_DIR — they are Supabase tables.
// Found the hard way: a truckers.json fixture sat there doing nothing while
// "Trucker 'sher trucking' not found" came back, because nothing reads that
// file. An end-to-end harness that only fakes the filesystem is not
// end-to-end for the half of the data that is in a database.
//
// A tiny in-memory stand-in rather than a real Supabase: the query surface
// actually used across the repo is four tables and a handful of chained
// calls, and every one of them is here. It is thenable, because the real
// client is awaited directly without calling .then().
function installSupabase(tables) {
    const p = require.resolve(path.join(ROOT, 'helpers/supabase.js'));
    const real = require.cache[p];
    const q = (name) => {
        let rows = (tables[name] || []).slice();
        const api = {
            select: () => api,
            order: (col) => { rows.sort((a, b) => String(a[col] || '').localeCompare(String(b[col] || ''))); return api; },
            eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return api; },
            ilike: (c, v) => { const re = new RegExp('^' + String(v).replace(/%/g, '.*') + '$', 'i');
                               rows = rows.filter((r) => re.test(String(r[c] || ''))); return api; },
            insert: (r) => { (tables[name] = tables[name] || []).push(r); return api; },
            upsert: () => api,
            delete: () => { tables[name] = (tables[name] || []).filter((r) => !rows.includes(r)); return api; },
            then: (res) => res({ data: rows, error: null }),
        };
        return api;
    };
    require.cache[p] = {
        id: p, filename: p, loaded: true,
        exports: Object.assign({}, real ? real.exports : {}, {
            getSupabase: () => ({
                from: q,
                rpc: async () => ({ data: [], error: null }),
            }),
        }),
    };
}

// ── BOOT ─────────────────────────────────────────────────────────────────
// Returns { say, port, dir, prompts, stop }. `say` is one utterance, the way
// dashboard/voice.js sends it: POST /api/voice/ask { text, agent }.
async function boot(opts) {
    const o = opts || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));

    // BEFORE anything requires config.js, which captures every path at load.
    process.env.DATA_DIR = dir;
    process.env.JARVIS_TEST = '1';
    process.env.API_TOKEN = process.env.API_TOKEN || 'e2e-token';
    // No key means helpers/voice.js will not try to synthesise, and the
    // health check reports it honestly rather than hanging.
    delete process.env.GEMINI_API_KEY;
    fixtures(dir);

    // A COLD REQUIRE GRAPH PER BOOT. Without this the second pass inherits
    // the first pass's module-level state — voiceMemory's turns and
    // referents, proformaDraft's draft, config's captured paths — and the
    // "offline" run would be reading the online run's memory. That is the
    // sort of shared state that makes a suite pass in one order and fail in
    // another, which is worse than a failure.
    for (const k of Object.keys(require.cache)) {
        if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
    }

    const prompts = [];
    installGemini(o.gemini || 'up', prompts);
    installSupabase({
        // TWO truckers on purpose. Sher has a group, so a forward to it can
        // actually go and be asserted as gone. Jio has neither group nor
        // number, which is how the "could not reach them" branch gets walked
        // — the branch that used to mark a booking forwarded anyway.
        truckers: [
            { id: 1, name: 'Sher Trucking', number: '15551230001', group_id: '120363111@g.us' },
            { id: 2, name: 'Jio Transport' },
        ],
        suppliers: [{ id: 1, name: 'Eccomelt', number: '15551230002' }],
        facts: [], memory_embeddings: [],
    });

    // ── WIRE THE MESSAGING, AS index.js DOES ────────────────────────────
    // workflow/actions.js takes its senders from init(), called only by
    // index.js. Without this every action dies with "_send is not a
    // function" — which is exactly what this harness found on its first run,
    // and it is a wiring fact rather than a bug in the flow under test.
    //
    // The sender mirrors index.js's own: replies to HER chat are captured for
    // the HTTP response, anything aimed at a trucker or supplier is RECORDED
    // AND NOT SENT, so a test can assert that a real driver was never
    // messaged. That last part is the whole reason this is worth wiring
    // rather than stubbing away.
    const sent = [];
    const cfg = require(path.join(ROOT, 'config.js'));
    const managerChat = `${cfg.getSettings().manager_number || cfg.MANAGER_NUMBER}@c.us`;
    const { sendCapture } = require(path.join(ROOT, 'helpers/wa-state.js'));
    const sendMessage = async (to, text, media) => {
        const cap = sendCapture.getStore();
        if (cap && to === managerChat) {
            cap.replies.push({ chatId: to, text: text || null, media: media || null });
            return true;
        }
        // ── WHAT "WHATSAPP IS DOWN" ACTUALLY MEANS ──────────────────────
        // index.js: `if (!waReady) { console.warn('[SEND] WA not ready —
        // dropped message'); return false; }`. So a down transport returns
        // FALSE for outbound messages. Returning true here regardless was the
        // harness lying about the very state it was meant to simulate — and
        // it made the "not forwarded" assertions pass for the wrong reason.
        sent.push({ to, text: text || null, delivered: !o.noBridge });
        if (o.noBridge) return false;
        // `senderReturns: 'undefined'` models a sender that reports nothing
        // at all — several in this repo do. It must NOT be read as failure.
        return o.senderReturns === 'undefined' ? undefined : true;
    };
    require(path.join(ROOT, 'workflow/actions.js')).init({
        sendMessage,
        sendToManager: (t) => sendMessage(managerChat, t),
        sendToTeam: (t) => { sent.push({ to: 'team', text: t }); return Promise.resolve(true); },
        pushAlert: () => {},
    });
    // `noBridge` leaves global.__jarvisSendMessage unset, which is the REAL
    // degraded state: Jarvis up, WhatsApp transport gone. actions.init() is
    // still called, because that is a wiring fact rather than part of the
    // outage being simulated — conflating the two would test nothing.
    if (!o.noBridge) global.__jarvisSendMessage = sendMessage;
    else delete global.__jarvisSendMessage;

    const { createApi } = require(path.join(ROOT, 'api.js'));
    const app = createApi();
    const srv = http.createServer(app).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;

    const say = (text, agent) => new Promise((resolve, reject) => {
        const body = JSON.stringify({ text, agent: agent || 'jarvis' });
        const req = http.request({
            host: '127.0.0.1', port, path: '/api/voice/ask', method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.API_TOKEN}`,
            },
        }, (res) => {
            let raw = ''; res.on('data', (d) => { raw += d; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) { /* left null on purpose */ }
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });

    return {
        port, dir, prompts, say, sent,
        stop: () => { delete global.__jarvisSendMessage; return new Promise((r) => srv.close(r)); },
    };
}

module.exports = { boot, fixtures, ymd, installGemini, installSupabase };
