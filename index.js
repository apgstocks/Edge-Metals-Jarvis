// ── index.js — Single-process boot ───────────────────────────────────────────
// One VM, one process: WhatsApp client + Express (API + dashboard) + cron.
// Boot order matters: data seed → module wiring → HTTP up (dashboard works
// even if WhatsApp is still scanning QR) → WhatsApp client last.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const waState = require('./helpers/wa-state');
const { sendCapture } = waState;

const brain     = require('./workflow/brain');
const actions   = require('./workflow/actions');
const alerts    = require('./alerts');
const scheduler = require('./scheduler');
const { createApi } = require('./api');
const { loadJson, saveJson } = require('./helpers/json');

// ── Seed migration: root bookings.json → data/ on first boot only ─────────────
(function seedData() {
    const seedFile = path.join(cfg.ROOT, 'bookings.json');
    const existing = loadJson(cfg.BOOKINGS_FILE, null);
    if ((!existing || !Object.keys(existing).length) && fs.existsSync(seedFile)) {
        const seed = loadJson(seedFile, {});
        if (Object.keys(seed).length) {
            fs.copyFileSync(seedFile, cfg.BOOKINGS_FILE);
            console.log(`[BOOT] Seeded ${Object.keys(seed).length} bookings from root bookings.json → data/`);
        }
    }
})();

// ── WhatsApp client ────────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: cfg.SESSION_PATH }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
});

let waReady = false;

// ── Messaging primitives (everything sends through these) ─────────────────────
async function sendMessage(chatId, text, media = null) {
    // Per-request web interception: if this call is inside a bot-command
    // request AND destined for the manager chat, buffer the reply for the
    // web response instead of sending to WhatsApp. Other destinations
    // (truckers, suppliers, team groups) still fire for real — user chose
    // "Real fire" for the web bot command surface.
    const capture = sendCapture.getStore();
    if (capture) {
        const managerChatId = (cfg.getSettings().manager_number || cfg.MANAGER_NUMBER) + '@c.us';
        if (chatId === managerChatId) {
            capture.replies.push({ chatId, text: text || null, media: media ? { filename: media.filename, mimetype: media.mimetype } : null });
            return true;
        }
        // else: falls through to real WhatsApp send below
    }
    if (!waReady) { console.warn(`[SEND] WA not ready — dropped message to ${chatId}`); return false; }
    if (!chatId)  { console.warn('[SEND] No chatId'); return false; }
    try {
        if (media) {
            const m = new MessageMedia(media.mimetype, media.base64, media.filename);
            await client.sendMessage(chatId, m, text ? { caption: text } : {});
        } else if (text) {
            await client.sendMessage(chatId, text);
        }
        return true;
    } catch (err) {
        console.error(`[SEND] Failed → ${chatId}:`, err.message);
        return false;
    }
}

async function sendToManager(text) {
    const num = cfg.getManagerNumber();
    if (!num) { console.warn('[SEND] No manager number configured'); return false; }
    return sendMessage(num + '@c.us', text);
}

async function sendToTeam(text) {
    const group = cfg.getTeamGroupId();
    if (group) return sendMessage(group, text);
    return sendToManager(text); // no team group → manager is the team
}

// ── Wire modules ───────────────────────────────────────────────────────────────
alerts.init({ sendToManager });
actions.init({ sendMessage, sendToManager, sendToTeam, pushAlert: alerts.pushAlert });

// Bridge for the /api/bot/command endpoint — brain.process() takes a sendMessage
// argument, and api.js needs to pass the SAME sendMessage that has the capture
// logic. Global bridge avoids circular require (api ← index).
global.__jarvisSendMessage = sendMessage;
scheduler.init({ sendToManager, sendToTeam, sendMessage });

// ── HTTP up first — dashboard usable while WA scans QR ─────────────────────────
const app = createApi();
app.listen(cfg.API_PORT, () => console.log(`[BOOT] API + dashboard on :${cfg.API_PORT}`));

// ── WhatsApp events ────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('[WA] Scan this QR (or use the WhatsApp tab in the dashboard):');
    qrcode.generate(qr, { small: true });
    waState.setStatus('qr', { qr });
});

client.on('ready', () => {
    waReady = true;
    console.log('[WA] Client ready');
    waState.setStatus('ready');
    scheduler.start();
});

client.on('disconnected', (reason) => {
    waReady = false;
    waState.setStatus('disconnected', { error: String(reason) });
    console.error('[WA] Disconnected:', reason, '— reinitializing in 10s');
    setTimeout(() => client.initialize().catch(e => console.error('[WA] Reinit failed:', e.message)), 10000);
});

client.on('auth_failure', (msg) => {
    waReady = false;
    waState.setStatus('auth_failure', { error: String(msg) });
    console.error('[WA] Auth failure:', msg);
});

// Called by POST /api/whatsapp/find-groups — case-insensitive substring match on group names.
// Only returns groups where Jarvis is currently a member (getChats returns only member chats).
waState.setGroupsLookupHandler(async (nameFragment) => {
    if (!waReady) throw new Error('WhatsApp not ready');
    const q = String(nameFragment || '').toLowerCase().trim();
    if (!q) return [];
    const chats = await client.getChats();
    const groups = chats
        .filter(c => c.isGroup && (c.name || '').toLowerCase().includes(q))
        .map(c => ({ id: c.id?._serialized, name: c.name, participants: c.groupMetadata?.participants?.length || null }))
        .slice(0, 20); // safety cap; a real workspace can have hundreds of groups
    return groups;
});

// Called by POST /api/whatsapp/verify-number — checks a number has a WhatsApp account.
// Returns { registered, contactId, formatted } — contactId is what getCommonGroups needs.
waState.setVerifyNumberHandler(async (phoneNum) => {
    if (!waReady) throw new Error('WhatsApp not ready');
    const digits = String(phoneNum || '').replace(/\D/g, '');
    if (digits.length < 8) throw new Error('phone number too short');
    // getNumberId returns null if not a WhatsApp user; also normalises to WhatsApp's ID format.
    const numberId = await client.getNumberId(digits);
    if (!numberId) return { registered: false, contactId: null, formatted: null };
    return {
        registered : true,
        contactId  : numberId._serialized,           // e.g. "14155551234@c.us"
        formatted  : await client.getFormattedNumber(numberId._serialized).catch(() => digits),
    };
});

// Called by POST /api/whatsapp/common-groups — groups Jarvis AND this contact share.
// WhatsApp privacy: we cannot enumerate all groups a contact is in, only overlap with us.
waState.setCommonGroupsHandler(async (contactId) => {
    if (!waReady) throw new Error('WhatsApp not ready');
    if (!contactId) return [];
    const chatIds = await client.getCommonGroups(contactId);
    // getCommonGroups returns an array of ChatId serialisations. Enrich each with name + size.
    const groups = [];
    for (const cid of chatIds.slice(0, 30)) {
        try {
            const chat = await client.getChatById(cid._serialized || cid);
            groups.push({
                id           : chat.id?._serialized || (cid._serialized || cid),
                name         : chat.name || '(unnamed group)',
                participants : chat.groupMetadata?.participants?.length || null,
            });
        } catch (e) {
            console.warn('[WA] common-groups: could not fetch chat', cid, e.message);
        }
    }
    return groups;
});

// Called by POST /api/whatsapp/reset — logs out, wipes session cache, then exits
// so pm2 respawns a fresh Client. Re-initializing the same Client after
// destroy() hangs forever in "initializing" — puppeteer is already dead.
waState.setLogoutHandler(async () => {
    console.log('[WA] Logout requested — wiping session and restarting process');
    waReady = false;
    waState.setStatus('initializing');
    try { await client.logout(); } catch (e) { console.warn('[WA] Logout error (ignoring):', e.message); }
    try { await client.destroy(); } catch (e) { console.warn('[WA] Destroy error (ignoring):', e.message); }
    try {
        const rimraf = require('fs').rmSync;
        rimraf(cfg.SESSION_PATH, { recursive: true, force: true });
    } catch (e) { console.warn('[WA] Cache wipe error (ignoring):', e.message); }
    // Delay exit so the HTTP response to /api/whatsapp/reset flushes first.
    console.log('[WA] Exiting in 1.5s — pm2 will respawn with a fresh QR');
    setTimeout(() => process.exit(0), 1500);
    return { ok: true };
});

client.on('message', async (msg) => {
    try {
        if (msg.fromMe) return;
        const chat    = await msg.getChat();
        const contact = await msg.getContact();

        await brain.process({
            messageId   : msg.id?._serialized,
            chatId      : chat.id?._serialized,
            senderNumber: contact.id?._serialized || msg.author || msg.from,
            senderName  : contact.pushname || contact.name || contact.number || 'Unknown',
            text        : msg.body || '',
            hasMedia    : msg.hasMedia,
            mediaType   : msg.type,
            isGroup     : chat.isGroup,
        }, sendMessage);
    } catch (err) {
        console.error('[WA] Message handler crashed:', err);
    }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`[BOOT] ${signal} — shutting down`);
    try { await client.destroy(); } catch {}
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[BOOT] Unhandled rejection:', err));

console.log('[BOOT] Initializing WhatsApp client…');
client.initialize().catch(e => console.error('[BOOT] WA init failed:', e.message));