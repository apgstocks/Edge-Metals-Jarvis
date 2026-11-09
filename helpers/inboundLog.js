// helpers/inboundLog.js — an append-only record of every message the manager/team
// sends Jarvis, in their own words. Apsara, 2026-11-09: "every single info that we
// give to Jarvis needs to be remembered always".
//
// Why this exists: remember_fact only stores what the classifier calls a correction
// or standing rule, and its store evicts unpinned facts at 200. Everything else said
// to Jarvis was answered once and lost. This log does not decide anything and is
// never read by an action; it is only a record, so it cannot change behaviour.
//
// Rules:
//  - NEVER throws and never blocks a reply: any failure returns false.
//  - Append only. No cap, no eviction, no rewrite.
//  - Manager and team only (callers check); third-party text is not logged here.
//  - Off switch: JARVIS_INBOUND_LOG=0.
//  - Under JARVIS_TEST=1 nothing is written unless JARVIS_INBOUND_LOG_FILE is set,
//    so a test can never write into the real data folder.
//  - No company field: the app does not know the company at this point. chatId is
//    recorded so Edge Yard / Edge Metals chats can be separated when it is read.
'use strict';
const fs = require('fs');
const path = require('path');

function logFile() {
    if (process.env.JARVIS_INBOUND_LOG_FILE) return process.env.JARVIS_INBOUND_LOG_FILE;
    if (process.env.JARVIS_TEST === '1') return null;
    const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    return path.join(dir, 'inbound_log.jsonl');
}

function record(entry) {
    try {
        if (process.env.JARVIS_INBOUND_LOG === '0') return false;
        const file = logFile();
        if (!file || !entry) return false;
        const text = typeof entry.text === 'string' ? entry.text : '';
        if (!text.trim()) return false;
        const line = JSON.stringify({
            at: new Date().toISOString(),
            chatId: String(entry.chatId || ''),
            role: String(entry.role || ''),
            messageId: entry.messageId ? String(entry.messageId) : undefined,
            text: text.slice(0, 20000),
        });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Leading newline: if a past write was cut off mid-line, this record starts on a
        // fresh line instead of being glued onto the torn one. Blank lines are skipped on read.
        fs.appendFileSync(file, '\n' + line + '\n');
        return true;
    } catch (e) {
        return false;
    }
}

// Torn or junk lines are skipped, never thrown on.
function readAll(file) {
    const f = file || logFile();
    const out = [];
    try {
        if (!f || !fs.existsSync(f)) return out;
        for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try { const o = JSON.parse(l); if (o && typeof o.text === 'string') out.push(o); } catch (e) { /* skip */ }
        }
    } catch (e) { /* none */ }
    return out;
}

module.exports = { record, readAll, logFile };
