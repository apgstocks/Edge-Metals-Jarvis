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
scheduler.init({ sendToManager, sendToTeam });

// ── HTTP up first — dashboard usable while WA scans QR ─────────────────────────
const app = createApi();
app.listen(cfg.API_PORT, () => console.log(`[BOOT] API + dashboard on :${cfg.API_PORT}`));

// ── WhatsApp events ────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('[WA] Scan this QR:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    waReady = true;
    console.log('[WA] Client ready');
    scheduler.start();
});

client.on('disconnected', (reason) => {
    waReady = false;
    console.error('[WA] Disconnected:', reason, '— reinitializing in 10s');
    setTimeout(() => client.initialize().catch(e => console.error('[WA] Reinit failed:', e.message)), 10000);
});

client.on('message', async (msg) => {
    try {
        if (msg.fromMe) return;
        const chat    = await msg.getChat();
        const contact = await msg.getContact();
        console.log('[DEBUG] from:', msg.from, '| author:', msg.author, '| contact.number:', contact.number, '| contact.id:', JSON.stringify(contact.id));
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
