// ── helpers/screens.js — "Jarvis, open the bills" ───────────────────────────
//
// Apsara, 2026-09-20: open screens by voice. And her standing rule, the same
// day: "yard has no scope in jarvis only scout has" — so every screen here
// belongs to a company, and an assistant only opens its own company's
// screens. Asking Jarvis for Petty Cash is answered "that's Scout's", not
// quietly obeyed.
//
// Navigation fires ONLY on an explicit navigation verb ("open", "go to",
// "take me to", "pull up", "switch to") or "show me the X screen/tab/page".
// "show me the bookings from Houston" is a QUESTION and must stay one — the
// bookings panel answers it far better than dumping her on a tab.

// company: 'metals' | 'yard' | 'both' | 'system'
// tab: dashboard tab id (index.html NAV_ITEMS); sub: sub-tab within it;
// href: a standalone page, with an optional #voice= deep link.
const SCREENS = [
    // Edge Metals
    { key: 'board', label: 'Board', company: 'metals', tab: 'board', say: ['board', 'booking board', 'pipeline'] },
    { key: 'bookings', label: 'Bookings', company: 'metals', tab: 'bookings', say: ['bookings', 'booking', 'bookings list'] },
    { key: 'truckers', label: 'Truckers', company: 'metals', tab: 'truckers', say: ['truckers', 'trucker list', 'drayage', 'drayage roster'] },
    { key: 'suppliers', label: 'Suppliers', company: 'metals', tab: 'suppliers', say: ['suppliers', 'supplier list', 'yard network'] },
    { key: 'bills', label: 'Bills', company: 'metals', tab: 'bills', sub: ['bills', 'bills'], say: ['bills', 'purchase bills', 'metals bills'] },
    { key: 'bills-trucking', label: 'Bills — Trucking', company: 'metals', tab: 'bills', sub: ['bills', 'trucking'], say: ['trucking bills', 'trucking', 'metals trucking'] },
    { key: 'invoice', label: 'Invoice — Outgoing', company: 'metals', tab: 'sales', sub: ['sales', 'outgoing'], say: ['invoice', 'invoices', 'outgoing', 'outgoing invoices', 'sales', 'sales invoices'] },
    { key: 'invoice-incoming', label: 'Invoice — Incoming', company: 'metals', tab: 'sales', sub: ['sales', 'incoming'], say: ['incoming', 'incoming invoices', 'receipts'] },
    { key: 'invoice-freight', label: 'Invoice — Freight', company: 'metals', tab: 'sales', sub: ['sales', 'freight'], say: ['freight', 'freight invoices'] },
    { key: 'invoice-commission', label: 'Invoice — Commission', company: 'metals', tab: 'sales', sub: ['sales', 'commission'], say: ['commission', 'commissions', 'commission invoices'] },
    { key: 'invoice-margin', label: 'Invoice — Margin', company: 'metals', tab: 'sales', sub: ['sales', 'margin'], say: ['margin', 'margins', 'profit margin'] },
    { key: 'documents', label: 'Documents', company: 'metals', href: '/documents', say: ['documents', 'docs'] },
    { key: 'doc-invoice', label: 'Documents — Invoice', company: 'metals', href: '/documents#voice=invoice', say: ['invoice generator', 'generate invoice', 'invoice documents'] },
    { key: 'doc-proforma', label: 'Documents — Proforma', company: 'metals', href: '/documents#voice=proforma', say: ['proforma', 'proformas', 'pro forma'] },
    { key: 'doc-bol', label: 'Documents — BOL', company: 'metals', href: '/documents#voice=bol', say: ['bol', 'bill of lading', 'bills of lading', 'b o l'] },
    { key: 'doc-packing', label: 'Documents — Packing list', company: 'metals', href: '/documents#voice=packing', say: ['packing list', 'packing lists'] },
    { key: 'verification', label: 'Verification', company: 'metals', href: '/documents#voice=verification', say: ['verification', 'verify', 'verifications'] },
    ...[['zimex', 'Zimex'], ['aj-transport', 'AJ Transport'], ['sher-trucking', 'Sher Trucking'], ['jio', 'Jio'],
        ['ntg', 'NTG'], ['tql', 'TQL'], ['schneider', 'Schneider'], ['joey', 'Joey'], ['pan-metal', 'Pan Metal']]
        .map(([id, name]) => ({ key: 'verify-' + id, label: `Verification — ${name}`, company: 'metals',
            href: `/documents#voice=verification:${id}`,
            say: [`${name.toLowerCase()} verification`, `verify ${name.toLowerCase()}`, `${name.toLowerCase()} verify`] })),
    { key: 'edge-inventory', label: 'Edge Inventory', company: 'metals', href: '/edge-inventory', say: ['edge inventory', 'metals inventory'] },
    { key: 'quote-requests', label: 'Quote Requests', company: 'metals', href: '/quote-requests', say: ['quote requests', 'quotes', 'quote request'] },
    { key: 'address-book', label: 'Address Book', company: 'metals', href: '/address-book', say: ['address book', 'addresses'] },
    { key: 'email-contacts', label: 'Email Contacts', company: 'metals', tab: 'email-contacts', say: ['email contacts', 'mail contacts'] },
    { key: 'design-bol', label: 'BOL design', company: 'metals', href: '/design/bol', say: ['bol design', 'design bol', 'bol layout'] },
    // Edge Yard — Scout's
    { key: 'loads', label: 'Loads', company: 'yard', tab: 'loads', say: ['loads', 'yard loads', 'purchase loads'] },
    { key: 'inventory', label: 'Inventory', company: 'yard', tab: 'inventory', say: ['inventory', 'stock', 'yard inventory'] },
    { key: 'petty', label: 'Petty Cash', company: 'yard', tab: 'petty', say: ['petty cash', 'cash box', 'petty'] },
    { key: 'trucker-bills', label: 'Trucker Bills', company: 'yard', tab: 'trucker-bills', say: ['trucker bills', 'haulage bills'] },
    { key: 'expenses', label: 'Expenses', company: 'yard', tab: 'expenses', say: ['expenses', 'expense'] },
    { key: 'price-lists', label: 'Price Lists', company: 'yard', tab: 'contacts', say: ['price lists', 'price list', 'pricelist'] },
    { key: 'outbound-loads', label: 'Outbound Loads', company: 'yard', href: '/outbound-loads', say: ['outbound loads', 'outbound', 'yard sales'] },
    // Both / system
    { key: 'spend', label: 'Spend Report', company: 'both', tab: 'spend', say: ['spend report', 'spending', 'spend'] },
    { key: 'tasks', label: 'Tasks', company: 'system', tab: 'tasks', say: ['tasks', 'reminders', 'scheduled tasks'] },
    { key: 'bugzilla', label: 'Bugzilla', company: 'both', tab: 'bugzilla', say: ['bugzilla', 'bugs', 'bug list', 'bug tracker', 'issues'] },
    { key: 'facts', label: 'Facts', company: 'system', tab: 'facts', say: ['facts', 'memory', 'what you remember'] },
    { key: 'bot', label: 'Bot', company: 'system', tab: 'bot', say: ['bot', 'bot log'] },
    { key: 'whatsapp', label: 'WhatsApp', company: 'system', tab: 'whatsapp', say: ['whatsapp', 'whats app', 'qr code'] },
    { key: 'settings', label: 'Settings', company: 'system', tab: 'settings', say: ['settings'] },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const LEAD = /^(?:(?:ok(?:ay)?|hey|jarvis|scout|please|can you|could you|would you)\s+)*/;
const VERB = /^(?:open(?:\s+up)?|go\s+to|goto|take\s+me\s+to|bring\s+up|pull\s+up|switch\s+to|navigate\s+to|jump\s+to|show\s+(?:me\s+)?the\s+(.+?)\s+(?:screen|tab|page|section))(?:\s+|$)/;
const TAIL = /(?:\s+(?:screen|tab|page|section|please|for\s+me|now))+$/;

// Longest alias first, so "trucker bills" beats "truckers" and
// "zimex verification" beats "verification".
const ALIASES = SCREENS.flatMap((s) => s.say.map((a) => ({ a: norm(a), s })))
    .sort((x, y) => y.a.length - x.a.length);

function match(text) {
    let t = norm(text).replace(LEAD, '');
    const v = VERB.exec(t);
    if (!v) return null;
    let rest = (v[1] || t.slice(v[0].length)).replace(/^the\s+/, '').replace(TAIL, '').trim();
    rest = rest.replace(/^(?:my|our)\s+/, '');
    if (!rest) return null;
    const hit = ALIASES.find((x) => x.a === rest);
    return hit ? hit.s : null;
}

// Who may open it. Returns null when allowed, else a sentence to say.
function refusal(screen, agent) {
    if (!screen) return null;
    if (screen.company === 'yard' && agent !== 'scout') {
        return `${screen.label} is Edge Yard — that's Scout's. Say "Hey Scout, open ${screen.label.toLowerCase()}".`;
    }
    if (screen.company === 'metals' && agent === 'scout') {
        return `${screen.label} is Edge Metals — that's Jarvis's. Say "Hey Jarvis, open ${screen.label.toLowerCase()}".`;
    }
    return null;
}

function toOpen(screen) {
    return { key: screen.key, label: screen.label, tab: screen.tab || null,
        sub: screen.sub ? { section: screen.sub[0], tab: screen.sub[1] } : null, href: screen.href || null };
}

module.exports = { SCREENS, match, refusal, toOpen };
