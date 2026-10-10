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
const crypto = require('crypto');
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

    // ── THE SAME DOCUMENT ARRIVES AGAIN AND AGAIN ──────────────────────────
    // A mail thread re-attaches its surveyor report on every reply, so a claim
    // with five replies would file the same PDF five times. The file id cannot
    // catch that — each upload is a new Drive file — so the check has to be on
    // the BYTES, and it has to happen before the upload, not after.
    const sha256 = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    const already = (Array.isArray(c.evidence) ? c.evidence : []).find((e) => e && e.sha256 === sha256);
    if (already) return { claim: c, entry: already, already: true };

    const key = c.container_no || c.invoice_no || c.id;
    const up = await drive.uploadClaimDocument(key, data, mt, name || '');

    const entry = {
        fileId: up.id || up.fileId || '',
        // Shared Drive link. INTERNAL — see the header of this file.
        url: up.webViewLink || '',
        name: up.name || clean(name, 120) || 'document',
        mimeType: mt,
        bytes,
        sha256,
        added_at: new Date().toISOString(),
        added_by: clean(by, 40) || 'manager',
    };

    const existing = Array.isArray(c.evidence) ? c.evidence.filter((e) => e && typeof e === 'object') : [];
    if (existing.some((e) => e.fileId && e.fileId === entry.fileId)) return { claim: c, entry, already: true };

    const rec = await claims.update(claimId, { evidence: [...existing, entry] }, entry.added_by,
        `supporting document added: ${entry.name}`);
    return { claim: rec, entry, already: false };
}

// ── ATTACHMENTS ON A CLAIM EMAIL ────────────────────────────────────────────
// Apsara, 2026-10-10. The scan path only catches a claim she photographs. Most
// of them arrive as mail with the surveyor's report already attached, and that
// attachment was being read for its NAME and then dropped (replyWatch's
// collectAttachmentNames). This files it against the claim the mail created.
//
// NOTHING IS DOWNLOADED UNLESS A CLAIM WAS ACTUALLY MADE OR MATCHED. The mail
// loop reads every message in the mailbox; downloading attachments from all of
// them to find the few that are claims would be most of a Gmail quota and a
// large bill for nothing. workflow/claimWatch.js calls this only after the
// claim exists, and passes a fetcher rather than bytes so the download happens
// here, last, for the parts that survive the filter below.

// Signature logos and tracking pixels are attachments too. Every one of them
// would land on a claim as "evidence" and the real report would be the fourth
// item in the list.
const MIN_MAIL_BYTES = 20 * 1024;
const MAX_PER_MAIL = 6;
const MAX_MAIL_TOTAL = 40 * 1024 * 1024;

const looksLikeDoc = (filename, mimeType) => {
    const mt = String(mimeType || '').toLowerCase();
    if (OK_TYPES.some((re) => re.test(mt))) return true;
    return /\.(jpe?g|png|heic|webp|tiff?|pdf)$/i.test(String(filename || ''));
};

// Which parts of a Gmail payload are worth fetching. Walks the tree; returns
// the parts, not their contents — the caller decides whether to spend the
// round trips.
function evidenceParts(payload) {
    const out = [];
    (function walk(part) {
        if (!part || out.length >= MAX_PER_MAIL * 3) return;
        const filename = String(part.filename || '').trim();
        const id = part.body && part.body.attachmentId;
        // No filename means an inline body part, not an attachment.
        if (filename && id) {
            const size = Number(part.body.size) || 0;
            if (looksLikeDoc(filename, part.mimeType)) {
                out.push({ filename, mimeType: String(part.mimeType || ''), attachmentId: id, size });
            }
        }
        (part.parts || []).forEach(walk);
    })(payload);

    // A PDF is a document whatever its size; an image has to be big enough to
    // be a photograph of a page rather than a logo in a signature block.
    const kept = out.filter((p) => /pdf/i.test(p.mimeType) || /\.pdf$/i.test(p.filename) || p.size >= MIN_MAIL_BYTES);

    // Biggest first: if a mail carries more than the cap, the scan of the
    // report is the one worth having, not the three-pixel spacer gif.
    kept.sort((a, b) => b.size - a.size);
    const picked = [];
    let total = 0;
    for (const p of kept) {
        if (picked.length >= MAX_PER_MAIL) break;
        if (p.size > MAX_BYTES) continue;
        if (total + p.size > MAX_MAIL_TOTAL) break;
        picked.push(p); total += p.size;
    }
    return picked;
}

// ── FILE WHAT THE MAIL BROUGHT ──────────────────────────────────────────────
// `fetchPart(part)` is supplied by the caller and returns { base64 }: only
// workflow/replyWatch.js holds a Gmail client, and this helper must stay
// testable without one.
//
// IT NEVER THROWS. This runs inside the mail loop, which Apsara depends on
// daily, and a claim's photograph is not worth a digest. Every failure is
// counted and returned, and the claim is already created by the time this is
// called, so the worst case is a claim with no attachment and a line in the log.
async function fromMail(claimId, { payload, fetchPart, by = 'email' } = {}) {
    const result = { considered: 0, filed: 0, duplicate: 0, failed: 0, names: [], why: '' };
    try {
        if (typeof fetchPart !== 'function') { result.why = 'no way to fetch attachments'; return result; }
        if (!claims.get(claimId)) { result.why = 'no such claim'; return result; }

        const parts = evidenceParts(payload || {});
        result.considered = parts.length;
        if (!parts.length) { result.why = 'nothing attached that looks like a document'; return result; }

        for (const part of parts) {
            try {
                const got = await fetchPart(part);
                const base64 = got && (got.base64 || got.data);
                if (!base64) { result.failed += 1; continue; }
                const r = await attach(claimId, {
                    base64, mimeType: part.mimeType || '', name: got.filename || part.filename, by,
                });
                if (r.already) result.duplicate += 1;
                else { result.filed += 1; result.names.push(r.entry.name); }
            } catch (e) {
                result.failed += 1;
                console.warn('[CLAIMS] could not file an attachment:', part.filename, '-', e.message);
            }
        }
    } catch (e) {
        result.failed += 1;
        result.why = e.message;
        console.warn('[CLAIMS] attachment pass failed, carrying on:', e.message);
    }
    return result;
}

// What the page may show. Nothing here is for a supplier.
function list(claim) {
    const e = (claim && Array.isArray(claim.evidence)) ? claim.evidence : [];
    return e.filter((x) => x && typeof x === 'object' && (x.url || x.fileId));
}

module.exports = { attach, fromMail, evidenceParts, list, hold, take,
    OK_TYPES, MAX_BYTES, MIN_MAIL_BYTES, MAX_PER_MAIL, MAX_MAIL_TOTAL, HOLD_TTL, HOLD_MAX };
