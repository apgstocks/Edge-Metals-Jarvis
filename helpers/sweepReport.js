// helpers/sweepReport.js - the morning integrity-sweep email, made readable.
// Apsara, 2026-11-07, on "Jarvis: 138 things to look at": "This is also ugly". Same standard as the Ledger agent email: one heading per
// reason, items listed compactly under it, the full list in an attached CSV, dependencies as one line each. Pure functions over the
// sweep result; integritySweep.reportText is untouched (other callers and tests use it).
const SHOW_ITEMS = 6;      // names shown per group
const MAX_GROUPS = 4;      // groups shown per check before it falls back to a short flat list

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (d) => String(d || '').replace(/SALE_[A-Za-z0-9_]+/g, '#').replace(/\d[\d,.]*/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// "TLLU2110739 — Mazariegos" -> "TLLU2110739 Mazariegos"
const short = (what) => String(what || '').replace(/\s+—\s+/, ' ').trim();

// The reason, with the per-item numbers/ids taken out when a group has several items (so the first item's figures are not shown as if
// they applied to all).
const generic = (d) => String(d || '').replace(/SALE_[A-Za-z0-9_]+/g, '…').replace(/\d[\d,.]*/g, '…').replace(/(…[,\s]*){2,}/g, '… ').replace(/\s+/g, ' ').trim();
// "TLLU2110739 — Mazariegos" -> party "Mazariegos"
const partyOf = (what) => { const m = /\s—\s(.+)$/.exec(String(what || '')); return m ? m[1].trim() : null; };

// A check's items, grouped by what is wrong. Few distinct reasons -> grouped; many -> a short flat list. Within a big group the WHO matters
// more than the container numbers, so it is tallied by party.
function groupFinding(f) {
    const by = new Map();
    for (const it of f.items) {
        const k = norm(it.detail);
        if (!by.has(k)) by.set(k, { reason: it.detail, items: [] });
        by.get(k).items.push(it);
    }
    const groups = [...by.values()].sort((a, b) => b.items.length - a.items.length);
    if (groups.length > MAX_GROUPS) return { mode: 'list', shown: f.items.slice(0, SHOW_ITEMS), rest: f.items.length - Math.min(SHOW_ITEMS, f.items.length) };
    return { mode: 'groups', groups: groups.map((g) => {
        const n = g.items.length;
        const parties = g.items.map((i) => partyOf(i.what));
        const tally = new Map(); for (const p of parties) if (p) tally.set(p, (tally.get(p) || 0) + 1);
        const byParty = n > SHOW_ITEMS && parties.filter(Boolean).length >= n * 0.7
            ? { top: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, c]) => `${p} ${c}`), more: Math.max(0, tally.size - 6) } : null;
        const gen = generic(g.reason);
        return { reason: ((gen.match(/[A-Za-z]/g) || []).length < 6 || (n > 1 && gen.startsWith('\u2026'))) ? '' : (n > 1 ? gen : g.reason), count: n, few: n <= 3 ? g.items : null, byParty,
            names: g.items.slice(0, SHOW_ITEMS).map((i) => short(i.what)), rest: Math.max(0, n - SHOW_ITEMS) };
    }) };
}

function depLines(dep) {
    if (!dep || !dep.findings || !dep.findings.length) return [];
    return dep.findings.map((d) => ({ sev: d.severity, line: `${d.what}${d.action ? ' — ' + d.action : ''}` }));
}

function compactText(res, dep, { csvName = null } = {}) {
    if (!res.findings.length && !(dep && dep.findings && dep.findings.length) && !res.broken.length) return `Nothing to report. ${res.checks} checks, no discrepancies.`;
    const out = [];
    out.push(`${res.total} thing${res.total === 1 ? '' : 's'} to look at, in ${res.findings.length} area${res.findings.length === 1 ? '' : 's'}.${csvName ? ` Every line is in the attached ${csvName}.` : ''}`);
    for (const f of res.findings) {
        out.push('', `${f.title.toUpperCase()} — ${f.count}`, `  ${f.why}`);
        const g = groupFinding(f);
        if (g.mode === 'list') {
            for (const i of g.shown) out.push(`  · ${short(i.what)}: ${clip(i.detail, 70)}`);
            if (g.rest > 0) out.push(`  …and ${g.rest} more`);
        } else {
            for (const x of g.groups) {
                if (x.few) { for (const i of x.few) out.push(`  \u00b7 ${short(i.what)}: ${clip(i.detail, 70)}`); continue; }
                if (x.reason) out.push(`  ${clip(x.reason, 80)} (${x.count})`);
                out.push(x.byParty ? `    ${x.byParty.top.join(' \u00b7 ')}${x.byParty.more ? ` \u00b7 +${x.byParty.more} more` : ''}` : `    ${x.names.join(' \u00b7 ')}${x.rest ? ` \u00b7 +${x.rest} more` : ''}`);
            }
        }
    }
    const dl = depLines(dep);
    if (dl.length) { out.push('', 'SOFTWARE'); for (const d of dl) out.push(`  [${d.sev}] ${d.line}`); }
    if (res.broken.length) { out.push('', 'A CHECK DID NOT RUN'); for (const b of res.broken) out.push(`  ${b.title}: ${b.error}`); }
    return out.join('\n');
}

function compactHtml(res, dep, { csvName = null } = {}) {
    const ink = '#1f2937', mute = '#6b7280', line = '#e5e7eb', accent = '#b45309';
    const h = (t, n) => `<div style="font:600 12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${mute};margin:22px 0 4px">${esc(t)} <span style="color:${accent}">${n == null ? '' : n}</span></div>`;
    const out = [`<div style="font:14px/1.5 Arial,sans-serif;color:${ink};max-width:680px">`];
    out.push(`<div style="font:600 20px Arial,sans-serif;margin-bottom:2px">${res.total} thing${res.total === 1 ? '' : 's'} to look at</div>`);
    out.push(`<div style="color:${mute};margin-bottom:6px">${res.findings.length} area${res.findings.length === 1 ? '' : 's'}.${csvName ? ` Every line is in the attached list (${esc(csvName)}).` : ''}</div>`);
    if (res.findings.length > 1) {
        out.push('<table style="border-collapse:collapse;width:100%;margin:8px 0">');
        for (const f of res.findings) out.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid ${line};width:52px;font-weight:700;color:${accent};text-align:right">${f.count}</td><td style="padding:5px 10px;border-bottom:1px solid ${line}">${esc(f.title)}</td></tr>`);
        out.push('</table>');
    }
    for (const f of res.findings) {
        out.push(h(f.title, f.count), `<div style="color:${mute};font-size:13px;margin-bottom:6px">${esc(f.why)}</div>`);
        const g = groupFinding(f);
        if (g.mode === 'list') {
            for (const i of g.shown) out.push(`<div style="padding:3px 0"><b>${esc(short(i.what))}</b> <span style="color:${mute}">${esc(clip(i.detail, 90))}</span></div>`);
            if (g.rest > 0) out.push(`<div style="color:${mute}">…and ${g.rest} more</div>`);
        } else {
            for (const x of g.groups) {
                if (x.few) { for (const i of x.few) out.push(`<div style="padding:3px 0"><b>${esc(short(i.what))}</b> <span style="color:${mute}">${esc(clip(i.detail, 90))}</span></div>`); continue; }
                if (x.reason) out.push(`<div style="font-weight:600;margin-top:8px">${esc(clip(x.reason, 90))} <span style="color:${mute};font-weight:400">(${x.count})</span></div>`);
                if (x.byParty) { out.push(`<div style="line-height:1.9">${x.byParty.top.map((t) => `<span style="display:inline-block;background:#f3f4f6;border-radius:4px;padding:1px 8px;margin:0 4px 4px 0;font-size:13px">${esc(t)}</span>`).join('')}${x.byParty.more ? `<span style="color:${mute}">+${x.byParty.more} more</span>` : ''}</div>`); continue; }
                out.push(`<div style="line-height:1.9">${x.names.map((n) => `<span style="display:inline-block;background:#f3f4f6;border-radius:4px;padding:1px 8px;margin:0 4px 4px 0;font-size:13px">${esc(n)}</span>`).join('')}${x.rest ? `<span style="color:${mute}">+${x.rest} more</span>` : ''}</div>`);
            }
        }
    }
    const dl = depLines(dep);
    if (dl.length) { out.push(h('Software', dl.length)); for (const d of dl) out.push(`<div style="padding:3px 0"><b style="color:${d.sev === 'critical' ? '#b91c1c' : d.sev === 'high' ? accent : mute}">${esc(d.sev)}</b> ${esc(d.line)}</div>`); }
    if (res.broken.length) { out.push(h('A check did not run')); for (const b of res.broken) out.push(`<div style="color:#b91c1c">${esc(b.title)}: ${esc(b.error)}</div>`); }
    out.push('</div>');
    return out.join('');
}

function fullCsv(res) {
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const rows = ['area,item,detail'];
    for (const f of res.findings) for (const i of f.items) rows.push([f.title, i.what, i.detail].map(q).join(','));
    return rows.join('\n');
}

module.exports = { compactText, compactHtml, fullCsv, groupFinding, SHOW_ITEMS, MAX_GROUPS };
