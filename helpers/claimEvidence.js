// ── helpers/claimEvidence.js — the documents behind a claim ──────────────────
//
// Apsara, 2026-10-03, asked where the supporting photos were. They were
// nowhere: helpers/claimScan.js sent a photograph to the model, read the
// figures off it and threw the image away. The claim record has carried an
// `evidence` array since the first version and nothing has ever filled it.
//
// That is a waste of the one artefact that settles an argument. A supplier who
// queries a line does not want the figure repeated; he wants the surveyor's
// report. This keeps it, against the claim, where it is findable in seconds.
//
// ── IT IS INTERNAL, AND THAT IS THE POINT ───────────────────────────────────
// The link stored here is a Shared Drive webViewLink. It is NOT public —
// nothing in helpers/drive.js ever calls permissions.create — and it must never
// be printed on a document that leaves the building, because these pages carry
// the CUSTOMER's name. Apsara, same day: "if there is any company name
// mentioned in claim email of customer, then it should be hided." A supplier
// who learns which buyer the metal reached can go to them directly.
//
// Redacting a photographed document automatically is not something I will
// pretend to do: a name hides in a letterhead, a rubber stamp, handwriting in a
// margin, a signature. OCR finds some of them, which produces a document that
// LOOKS redacted and is not — worse than sending nothing, because you stop
// checking. So evidence stays on Edge's side, and a document that genuinely has
// to go out is redacted by eye, once, deliberately.
//
// ── FAILING SOFT ────────────────────────────────────────────────────────────
// Drive being unreachable must never lose a claim, and never lose the reading
// that came off the photograph. attach() throws; every caller creates the claim
// FIRST and attaches after, so the worst case is a claim with no photo and a
// message saying so.
const claims = require('./claims');
// Reached on the module object, not destructured: a destructured binding is
// captured at load and a stubbing test is silently ignored. That cost four fake
// passes and a real API bill on 2026-10-02.
const drive = require('./drive');

const OK_TYPES = [/^image\//, /^application\/pdf$/];
const MAX_BYTES = 25 * 1024 * 1024;

const clean = (s, n) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// ── A SHORT-LIVED HOLD FOR A SCANNED FILE ───────────────────────────────────
// The page already sent the bytes once, to be read. Posting the same 8MB
// photograph a second time to keep it is a minute of a phone's cellular upload
// for nothing, so the scan route parks it here and the create references an id.
// Bounded both ways — a TTL and a cap — exactly as the import plans in
// helpers/claims/routes.js are, and for the same reason: otherwise this grows
// for as long as she keeps pressing the button.
const held = new Map();
const HOLD_TTL = 20 * 60 * 1000;
const HOLD_MAX = 4;

function sweep() {
    const cut = Date.now() - HOLD_TTL;
    for (const [id, v] of held) if (v.at < cut) held.delete(id);
    while (held.size > HOLD_MAX) held.delete(held.keys().next().value);
}

function hold({ base64, mimeType, name } = {}) {
    if (!base64) return null;
    sweep();
    const id = 'scan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    held.set(id, { base64, mimeType: mimeType || 'image/jpeg', name: clean(name, 120), at: Date.now() });
    return id;
}

function take(id) {
    const v = held.get(String(id || ''));
    if (v) held.delete(String(id));
    return v || null;
}

// ── ATTACH ──────────────────────────────────────────────────────────────────
// Uploads, then records. In that order: a record pointing at a file that was
// never uploaded is worse than no record, because it reads as evidence that
// exists.
async function attach(claimId, { base64, mimeType, name, by = 'manager' } = {}) {
    const c = claims.get(claimId);
    if (!c) throw new Error('no such claim');

    const data = String(base64 || '').replace(/^data:[^,]+,/, '');
    if (!data) throw new Error('no file was sent');

    const mt = clean(mimeType, 80) || 'image/jpeg';
    if (!OK_TYPES.some((re) => re.test(mt))) {
        throw new Error(`${mt} is not a document I can keep — photograph the page, or send it as a PDF`);
    }
    // base64 is 4 characters per 3 bytes; checked before the upload, not after.
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > MAX_BYTES) throw new Error('that file is too big — photograph the page rather than the whole report');

    const key = c.container_no || c.invoice_no || c.id;
    const up = await drive.uploadClaimDocument(key, data, mt, name || '');

    const entry = {
        fileId: up.id || up.fileId || '',
        // Shared Drive link. INTERNAL — see the header of this file.
        url: up.webViewLink || '',
        name: up.name || clean(name, 120) || 'document',
        mimeType: mt,
        bytes,
        added_at: new Date().toISOString(),
        added_by: clean(by, 40) || 'manager',
    };

    const existing = Array.isArray(c.evidence) ? c.evidence.filter((e) => e && typeof e === 'object') : [];
    if (existing.some((e) => e.fileId && e.fileId === entry.fileId)) return { claim: c, entry, already: true };

    const rec = await claims.update(claimId, { evidence: [...existing, entry] }, entry.added_by,
        `supporting document added: ${entry.name}`);
    return { claim: rec, entry, already: false };
}

// What the page may show. Nothing here is for a supplier.
function list(claim) {
    const e = (claim && Array.isArray(claim.evidence)) ? claim.evidence : [];
    return e.filter((x) => x && typeof x === 'object' && (x.url || x.fileId));
}

module.exports = { attach, list, hold, take, OK_TYPES, MAX_BYTES, HOLD_TTL, HOLD_MAX };
