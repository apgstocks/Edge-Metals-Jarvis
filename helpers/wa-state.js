// ── helpers/wa-state.js — shared WhatsApp connection state ─────────────────
// Written by index.js (client event handlers); read by api.js (/api/whatsapp/*).
// Not persisted — resets to disconnected on process start, which is correct.

const state = {
    status: 'initializing', // 'initializing' | 'qr' | 'ready' | 'disconnected' | 'auth_failure'
    qr: null,               // raw QR string, only when status === 'qr'
    lastChange: new Date().toISOString(),
    lastError: null,
    // Callable — set by index.js so api.js can trigger logout without circular require
    _logout: null,
};

function setStatus(status, extras = {}) {
    state.status = status;
    state.qr = extras.qr || null;
    state.lastError = extras.error || null;
    state.lastChange = new Date().toISOString();
    console.log(`[WA-STATE] ${status}${extras.error ? ' — ' + extras.error : ''}`);
}

function get() {
    return {
        status: state.status,
        qr: state.qr,
        lastChange: state.lastChange,
        lastError: state.lastError,
    };
}

function setLogoutHandler(fn) { state._logout = fn; }
async function triggerLogout() {
    if (typeof state._logout !== 'function') throw new Error('logout handler not registered');
    return state._logout();
}

// Groups lookup — registered by index.js, called by api.js.
// Same lazy-injection pattern as logout to avoid circular require between index and api.
function setGroupsLookupHandler(fn) { state._findGroups = fn; }
async function findGroups(nameFragment) {
    if (typeof state._findGroups !== 'function') {
        throw new Error('groups lookup not registered (WhatsApp not ready yet?)');
    }
    return state._findGroups(nameFragment);
}

// Number verification — checks a phone number has WhatsApp
function setVerifyNumberHandler(fn) { state._verifyNumber = fn; }
async function verifyNumber(phoneNum) {
    if (typeof state._verifyNumber !== 'function') {
        throw new Error('verify-number not registered (WhatsApp not ready yet?)');
    }
    return state._verifyNumber(phoneNum);
}

// Common groups — returns groups that Jarvis AND the given number both belong to
function setCommonGroupsHandler(fn) { state._commonGroups = fn; }
async function findCommonGroups(contactId) {
    if (typeof state._commonGroups !== 'function') {
        throw new Error('common-groups not registered (WhatsApp not ready yet?)');
    }
    return state._commonGroups(contactId);
}

module.exports = { setStatus, get, setLogoutHandler, triggerLogout, setGroupsLookupHandler, findGroups, setVerifyNumberHandler, verifyNumber, setCommonGroupsHandler, findCommonGroups };