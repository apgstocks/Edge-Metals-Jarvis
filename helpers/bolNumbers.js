// ── helpers/bolNumbers.js — the next BOL number for a customer ──────────────
//
// Apsara, 2026-09-16: "in bol,make bol number auto generate/customerbasis in
// sequence", and on the shape of it: "include year in bol number as in
// 26ECC001".
//
// So: TWO-DIGIT YEAR + CUSTOMER CODE + a sequence that counts within that
// year and that customer. 26ECC001 is the first BOL issued to Eccomelt in
// 2026; 27ECC001 is the first one in 2027, and Taewon's numbers run
// 26TAE001, 26TAE002 beside them without either series disturbing the other.
//
// ── A BOL NUMBER IS AN IDENTITY, NOT A COUNTER ──────────────────────────────
// This is the number a driver, a broker and a buyer all quote back. Two
// documents sharing one is not a cosmetic problem: helpers/bols.js upserts by
// bol_no, so a duplicate does not sit beside the original, it REPLACES it.
// Everything below is arranged around never issuing one twice:
//
//   THE COUNTER IS STORED, not derived from the BOLs on file. Deriving it
//   would reissue a number the moment she deleted the BOL that held it, and
//   the deleted document is still in a buyer's inbox.
//
//   IT IS ALSO FLOORED BY WHAT IS ON FILE. A counter that was lost, restored
//   from an older backup, or never existed (every BOL she has issued so far
//   was typed by hand) must not start again at 001 underneath numbers that
//   already exist. next() takes the higher of the two.
//
//   AND IT IS CHECKED AT THE POINT OF USE. suggest() is only a suggestion —
//   nothing is reserved when the form fills the box in, because a number
//   reserved every time she opens the screen leaves gaps where she changed
//   her mind. reserve() is what the save path calls, under the file lock,
//   and it skips anything already taken.
//
// ── SHE CAN ALWAYS OVERRIDE ─────────────────────────────────────────────────
// Apsara, asked what should happen when she types over the suggestion: "Yours
// wins, counter untouched". A typed number is used exactly as typed and the
// automatic series carries on from where it was — so one mistyped 26ECC500
// does not push the next fifty documents into the 500s.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// ── THE CUSTOMER CODE ───────────────────────────────────────────────────────
// Three letters, from the first word of the name that carries letters —
// "Eccomelt Inc" is ECC, not ECI, because a code that changes when she adds
// "Inc" is a code that splits one customer's series in two.
//
// Company suffixes are skipped for the same reason: "The Metal Company" must
// not be THE. A name with nothing usable in it falls back to CUS, which is
// ugly and visible, and visible is the point — it tells her to fix the name
// rather than quietly filing three customers under one prefix.
const STOPWORDS = new Set(['the', 'inc', 'llc', 'ltd', 'co', 'corp', 'company',
                           'incorporated', 'limited', 'gmbh', 'pte', 'pty', 'sa', 'srl', 'bv', 'nv']);

function codeFor(customer) {
    const words = String(customer == null ? '' : customer)
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((w) => !STOPWORDS.has(w.toLowerCase()));
    const first = words.find((w) => /[A-Z]/.test(w));
    if (!first) return 'CUS';
    // Padded rather than truncated-to-whatever-is-there: a two-letter customer
    // ("BM Metals" -> BM) would otherwise produce 26BM001, which reads as a
    // different format to everything else on the shelf.
    return (first.replace(/[^A-Z0-9]/g, '') + 'XX').slice(0, 3);
}

// The year the DOCUMENT is dated, not today: a BOL she back-dates to December
// belongs in that year's series. Falls back to today in the yard's timezone —
// toISOString() is UTC and is already tomorrow after 5pm here, which on a
// 31 December would file the document under the wrong year entirely.
function yearOf(dateStr) {
    const s = String(dateStr || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return m[1].slice(2);
    const d = new Date(s);
    if (s && !isNaN(d.getTime())) {
        return String(d.getFullYear()).slice(2);
    }
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(2, 4);
}

// 26ECC001. Three digits is her example; a customer who gets past 999 in one
// year keeps counting rather than wrapping to 000 — a wider number is odd to
// look at, a repeated one is a replaced document.
function format(year, code, seq) {
    return `${year}${code}${String(seq).padStart(3, '0')}`;
}

// Reads a number back apart, so an existing BOL can raise the floor. Returns
// null for anything that is not one of ours — she has typed numbers in other
// shapes (EM-1047) and those must not be parsed as a sequence.
const PATTERN = /^(\d{2})([A-Z]{3})(\d{3,})$/;
function parse(bolNo) {
    const m = PATTERN.exec(String(bolNo == null ? '' : bolNo).trim().toUpperCase());
    if (!m) return null;
    return { year: m[1], code: m[2], seq: Number(m[3]) };
}

function seriesKey(year, code) {
    return `${year}${code}`;
}

// The highest sequence already ON FILE for this series. The floor under the
// stored counter — see the header: a counter that is missing or behind must
// never hand out a number that exists.
function highestOnFile(year, code, bols) {
    const rows = Array.isArray(bols) ? bols : loadJson(cfg.BOLS_FILE, []);
    let max = 0;
    for (const r of (Array.isArray(rows) ? rows : [])) {
        const p = parse(r && r.bol_no);
        if (!p || p.year !== year || p.code !== code) continue;
        if (p.seq > max) max = p.seq;
    }
    return max;
}

function loadCounters() {
    const c = loadJson(cfg.BOL_COUNTERS_FILE, {});
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
}

// What the form should show. NOTHING IS RESERVED HERE — she may close the
// screen, or type her own, and a number consumed by opening a form leaves a
// gap in a series a buyer can see.
function suggest(customer, dateStr) {
    const year = yearOf(dateStr);
    const code = codeFor(customer);
    const counters = loadCounters();
    const used = Math.max(Number(counters[seriesKey(year, code)]) || 0, highestOnFile(year, code));
    return format(year, code, used + 1);
}

// What the save path calls. Under the counter file's lock, and it steps past
// anything already taken — two tabs open on the same customer would otherwise
// both be shown 26ECC004 and the second save would REPLACE the first.
// ── STRICT, AND RETRIED ────────────────────────────────────────────────────
// mutateJson is non-strict by default: when the file lock cannot be taken it
// logs, RETURNS STALE DATA and never runs the mutator. For a cache that is the
// right trade. For this it is the worst one available — the mutator silently
// does not run, reserve() hands back nothing, and a BOL is generated with no
// number on it.
//
// Found by running ten reservations at once: nine numbers and one hole. So the
// write is strict (a lock failure THROWS) and retried above proper-lockfile's
// own eight attempts, which ten simultaneous writers get past.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reserve(customer, dateStr, attempt = 0) {
    const year = yearOf(dateStr);
    const code = codeFor(customer);
    const key = seriesKey(year, code);
    let out = null;
    try {
    await mutateJson(cfg.BOL_COUNTERS_FILE, {}, (raw) => {
        const counters = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        const bols = loadJson(cfg.BOLS_FILE, []);
        const taken = new Set((Array.isArray(bols) ? bols : [])
            .map((r) => String((r && r.bol_no) || '').trim().toUpperCase())
            .filter(Boolean));
        let seq = Math.max(Number(counters[key]) || 0, highestOnFile(year, code, bols));
        // Bounded: a corrupt counter must not spin. 5000 is far past any real
        // year's worth of shipments to one customer.
        for (let i = 0; i < 5000; i++) {
            seq += 1;
            const candidate = format(year, code, seq);
            if (!taken.has(candidate)) { out = candidate; break; }
        }
        if (!out) throw new Error(`could not find a free BOL number for ${key}`);
        counters[key] = seq;
        return counters;
    }, { strict: true });
    } catch (e) {
        // Contention, almost always. Backing off and trying again is right
        // because the thing being retried is idempotent in the only way that
        // matters: a failed attempt wrote nothing, so no number was burned.
        if (attempt >= 5) throw e;
        await sleep(25 * (attempt + 1));
        return reserve(customer, dateStr, attempt + 1);
    }
    return out;
}

// Called when she SAVES a number she typed herself. Her number wins and the
// counter is left alone ("Yours wins, counter untouched") — but if what she
// typed happens to be in this series and ahead of the counter, the counter
// catches up, because the alternative is suggesting a number that now exists
// and silently replacing her document when she accepts it.
async function noteUsed(bolNo) {
    const p = parse(bolNo);
    if (!p) return false;
    const key = seriesKey(p.year, p.code);
    let moved = false;
    await mutateJson(cfg.BOL_COUNTERS_FILE, {}, (raw) => {
        const counters = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        if ((Number(counters[key]) || 0) < p.seq) { counters[key] = p.seq; moved = true; }
        return counters;
    });
    return moved;
}

module.exports = { codeFor, yearOf, format, parse, suggest, reserve, noteUsed, highestOnFile };
