// helpers/userAccounts.js — user IDs, passwords and custom roles for a Y.A.R.D. trial/product copy.
//
// This file exists ONLY in the copy that scripts/make-trial.js builds (it lives in scripts/trial-users/ in the live
// repo, which never loads it). The live app keeps its three shared passwords and is not changed by any of this.
//
// What a user is: an ID, a name, a password (scrypt, per-user salt) and ONE role. What a role is: a list of PAGES.
// The two built-in roles cannot be edited: Manager (every page, plus Users and Settings, and the same power as the
// owner password) and Yard staff (Loads, Petty Cash, Trucker Bills: exactly what the old shared staff login had).
// Managers can add custom roles by ticking pages.
//
// Pages are enforced on the SERVER. The menu hides what a role cannot open, but the real boundary is the path list
// below, checked on every request in api.js (see make-trial.js, which patches the copy's api.js).
//
// Every request re-reads the user (current()), so removing a user, changing a role or changing a password takes
// effect on their very next click. There is no stale session to revoke.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const FILE = process.env.YARD_USERS_FILE || path.join(__dirname, '..', 'data', 'users.json');

// ── PAGES A CUSTOM ROLE CAN BE GIVEN ────────────────────────────────────────────────────────────────────────
// `prefixes`  the API paths the page needs (measured by loading each page with a real browser, not guessed).
// `adminGrant` the page's routes are manager-only in the app. A role holding the page is let through that one gate for
//             THESE prefixes only; everything else manager-only stays shut to it.
// Left out ON PURPOSE: Settings and Users (managers only), and Documents (it spans many manager-only routes that have
// not been opened up one by one; opening a few and missing one would give a page that half works).
const PAGES = [
    { id: 'loads', label: 'Loads', note: 'Record purchases and sales, weigh and price them',
      prefixes: ['/api/loads', '/api/load-drafts', '/api/outbound-loads', '/api/vision/read-weight', '/api/vision/check-photo-quality', '/api/item-types', '/api/address-book', '/api/verify-admin-password'] },
    { id: 'inventory', label: 'Inventory', note: 'See what is on hand, by item',
      prefixes: ['/api/loads/inventory', '/api/loads/stock', '/api/item-types'] },
    { id: 'petty', label: 'Petty Cash', note: 'See the balance (only managers can change it)',
      prefixes: ['/api/petty-cash'] },
    { id: 'trucker-bills', label: 'Trucker Bills', note: 'Record and edit bills (only managers record payments)',
      prefixes: ['/api/trucker-bills'] },
    { id: 'expenses', label: 'Expenses', note: 'Record and view yard expenses',
      prefixes: ['/api/expenses'], adminGrant: true },
    { id: 'address-book', label: 'Address Book', note: 'Suppliers, buyers and truckers',
      prefixes: ['/api/address-book'] },
];
const ALWAYS = ['/api/me'];                           // every signed-in user: who am I, change my own password
const PAGE_IDS = PAGES.map((p) => p.id);
const MANAGER_PAGES = [...PAGE_IDS, 'documents', 'settings', 'users'];   // what a manager's menu shows

const BUILTIN_ROLES = [
    { id: 'manager', name: 'Manager', builtin: true, manager: true, pages: MANAGER_PAGES },
    { id: 'yard-staff', name: 'Yard staff', builtin: true, manager: false, pages: ['loads', 'petty', 'trucker-bills'] },
];
// IDs that already mean something in the app's own code (role strings and audit names). A person called "admin" would
// make an audit line ambiguous, so they cannot be taken.
const RESERVED = new Set(['admin', 'staff', 'user', 'jarvis', 'unknown', 'owner', 'root', 'system', 'manager', 'me']);

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

let state = null;
function load() {
    if (state) return state;
    let raw = null;
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { raw = null; }
    state = { roles: [], users: [] };
    if (raw) {
        try {
            const j = JSON.parse(raw);
            state.roles = Array.isArray(j.roles) ? j.roles : [];
            state.users = Array.isArray(j.users) ? j.users : [];
        } catch (e) {
            // never overwrite a file we could not read: keep it aside so nothing is lost, then start empty
            try { fs.copyFileSync(FILE, FILE + '.unreadable-' + Date.now()); } catch (e2) { /* best effort */ }
            console.error('[USERS] users.json could not be read; kept a copy beside it and starting empty:', e.message);
        }
    }
    return state;
}
function save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
}
function reset() { state = null; }                    // tests only: forget the in-memory copy

// ── PASSWORDS ──────────────────────────────────────────────────────────────────────────────────────────────
const hashPw = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function makePw(pw) { const salt = crypto.randomBytes(16); return { salt: salt.toString('hex'), hash: (await hashPw(pw, salt)).toString('hex') }; }
async function checkPw(pw, rec) {
    const salt = rec ? Buffer.from(rec.salt, 'hex') : Buffer.alloc(16);       // same work whether or not the user exists
    const got = await hashPw(pw, salt);
    if (!rec) return false;
    const want = Buffer.from(rec.hash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function checkPolicy(pw, id) {
    if (typeof pw !== 'string' || pw.length < 8) throw err('Password must be at least 8 characters.');
    if (pw.length > 128) throw err('Password must be 128 characters or fewer.');
    if (id && pw.toLowerCase() === String(id).toLowerCase()) throw err('Password cannot be the same as the user ID.');
}

// ── ROLES ──────────────────────────────────────────────────────────────────────────────────────────────────
const allRoles = () => [...BUILTIN_ROLES, ...load().roles.map((r) => ({ ...r, builtin: false, manager: false }))];
const roleById = (id) => allRoles().find((r) => r.id === id) || null;
function cleanPages(pages) {
    if (!Array.isArray(pages)) throw err('Pick at least one page.');
    const out = [...new Set(pages.map(String))];
    if (!out.length) throw err('Pick at least one page.');
    const bad = out.filter((p) => !PAGE_IDS.includes(p));
    if (bad.length) throw err(`Not a page a role can be given: ${bad.join(', ')}.`);
    return PAGE_IDS.filter((p) => out.includes(p));                           // menu order, no duplicates
}
function cleanRoleName(name, exceptId) {
    const n = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (n.length < 2 || n.length > 40) throw err('Role name must be 2 to 40 characters.');
    if (allRoles().some((r) => r.id !== exceptId && r.name.toLowerCase() === n.toLowerCase())) throw err('A role with that name already exists.');
    return n;
}
function createRole({ name, pages }, by) {
    const s = load();
    const r = { id: 'r-' + crypto.randomBytes(4).toString('hex'), name: cleanRoleName(name), pages: cleanPages(pages), createdAt: new Date().toISOString(), createdBy: by || null };
    s.roles.push(r); save();
    return { ...r, builtin: false, manager: false };
}
function updateRole(id, { name, pages }) {
    const s = load(); const r = s.roles.find((x) => x.id === id);
    if (!r) throw err(roleById(id) ? 'Built-in roles cannot be changed.' : 'No such role.', roleById(id) ? 400 : 404);
    const nn = name !== undefined ? cleanRoleName(name, id) : r.name;
    const pp = pages !== undefined ? cleanPages(pages) : r.pages;
    r.name = nn; r.pages = pp; save();
    return { ...r, builtin: false, manager: false };
}
function deleteRole(id) {
    const s = load(); const i = s.roles.findIndex((x) => x.id === id);
    if (i < 0) throw err(roleById(id) ? 'Built-in roles cannot be removed.' : 'No such role.', roleById(id) ? 400 : 404);
    const n = s.users.filter((u) => u.roleId === id).length;
    if (n) throw err(`${n} user${n === 1 ? ' has' : 's have'} this role. Move ${n === 1 ? 'them' : 'them'} to another role first.`);
    s.roles.splice(i, 1); save();
}

// ── USERS ──────────────────────────────────────────────────────────────────────────────────────────────────
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
function shape(u) {
    const r = roleById(u.roleId);
    if (!r) return null;                              // role vanished: treated as no access, never as some default
    return { id: u.id, name: u.name, roleId: r.id, roleName: r.name, manager: !!r.manager, pages: r.pages, createdAt: u.createdAt, pwAt: u.pwAt || 0, lang: u.lang === 'es' || u.lang === 'en' ? u.lang : null };
}
const listUsers = () => load().users.map(shape).filter(Boolean);
const current = (id) => { const u = load().users.find((x) => x.id === id); return u ? shape(u) : null; };
async function createUser({ id, name, password, roleId }, by) {
    const uid = String(id || '').trim().toLowerCase();
    if (!ID_RE.test(uid)) throw err('User ID must be 3 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number.');
    if (RESERVED.has(uid)) throw err('That user ID is reserved. Pick another.');
    const nm = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (nm.length < 1 || nm.length > 60) throw err('Name must be 1 to 60 characters.');
    if (!roleById(roleId)) throw err('Pick a role.');
    checkPolicy(password, uid);
    const pw = await makePw(password);
    const s = load();
    if (s.users.some((u) => u.id === uid)) throw err('That user ID is already taken.', 409);   // checked AFTER the hash: no await between check and insert
    s.users.push({ id: uid, name: nm, roleId, pw, pwAt: Date.now(), createdAt: new Date().toISOString(), createdBy: by || null }); save();
    return current(uid);
}
async function updateUser(id, { name, roleId, password }, byId) {
    const s = load(); const u = s.users.find((x) => x.id === id);
    if (!u) throw err('No such user.', 404);
    let pw = null;
    if (password !== undefined) { checkPolicy(password, id); pw = await makePw(password); }
    if (name !== undefined) { const nm = String(name).trim().replace(/\s+/g, ' '); if (nm.length < 1 || nm.length > 60) throw err('Name must be 1 to 60 characters.'); u.name = nm; }
    if (roleId !== undefined) {
        if (!roleById(roleId)) throw err('Pick a role.');
        if (byId && byId === id && roleId !== u.roleId) throw err('You cannot change your own role. Ask another manager.');
        u.roleId = roleId;
    }
    if (pw) { u.pw = pw; u.pwAt = Date.now(); }      // a new password ends every sign-in that person already has
    save();
    return current(id);
}
function deleteUser(id, byId) {
    const s = load(); const i = s.users.findIndex((x) => x.id === id);
    if (i < 0) throw err('No such user.', 404);
    if (byId && byId === id) throw err('You cannot remove yourself. Ask another manager.');
    s.users.splice(i, 1); save();
}
async function authenticate(id, password) {
    const u = load().users.find((x) => x.id === String(id || '').trim().toLowerCase()) || null;
    const ok = await checkPw(String(password || ''), u && u.pw);
    return ok ? shape(u) : null;
}
// A person's own screen language ('en' | 'es'). Theirs alone: it follows them to any phone or computer, and never changes anyone else's.
function setLanguage(id, code) {
    if (code !== 'en' && code !== 'es') throw err('Language must be en or es.');
    const s = load(); const u = s.users.find((x) => x.id === id);
    if (!u) throw err('No such user.', 404);
    u.lang = code; save();     // not a password change: pwAt is untouched, so nobody is signed out
}
async function changeOwnPassword(id, currentPw, newPw) {
    const s = load(); const u = s.users.find((x) => x.id === id);
    if (!u) throw err('No such user.', 404);
    if (!(await checkPw(String(currentPw || ''), u.pw))) throw err('Current password is wrong.', 403);
    checkPolicy(newPw, id);
    u.pw = await makePw(newPw); u.pwAt = Date.now(); save();   // signs them out everywhere, this browser included
}

// ── WHAT A ROLE MAY CALL ───────────────────────────────────────────────────────────────────────────────────
function prefixesFor(pageIds) {
    const all = [...ALWAYS], admin = [];
    for (const p of PAGES) if ((pageIds || []).includes(p.id)) { all.push(...p.prefixes); if (p.adminGrant) admin.push(...p.prefixes); }
    return { all: [...new Set(all)], admin: [...new Set(admin)] };
}
const under = (p, list) => list.some((x) => p === x || p.startsWith(x + '/'));
const allowedPath = (pageIds, p) => under(p, prefixesFor(pageIds).all);
const adminGrant = (pageIds, p) => under(p, prefixesFor(pageIds).admin);

module.exports = {
    PAGES, PAGE_IDS, MANAGER_PAGES, BUILTIN_ROLES, RESERVED, FILE,
    allRoles, createRole, updateRole, deleteRole,
    listUsers, current, createUser, updateUser, deleteUser, authenticate, changeOwnPassword, setLanguage,
    prefixesFor, allowedPath, adminGrant, reset,
};
