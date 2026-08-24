// ── helpers/writingStyle.js — learn how Apsara actually writes ───────────────
//
// Apsara, 2026-08-23, after asking what real AI email assistants do that this
// one doesn't. The answer from the field was consistent: the good ones read a
// sample of your SENT mail once and learn your voice, so drafts sound like you
// instead of like a language model being professional at someone.
//
// Every draft this app produces currently opens "Dear X" and signs off "Edge
// Metals Inc." because that's hardcoded in the prompt. Nothing has ever looked
// at how she actually writes to Joey versus to a carrier.
//
// ── THE PRIVACY DECISION, WHICH IS THE WHOLE DESIGN ────────────────────────
//
// Her sent folder is the most commercially sensitive thing in this business:
// quoted prices, margins, supplier terms, who got what rate. Pointing an LLM
// at it to "learn style" is exactly the move that produced a real incident
// elsewhere — Microsoft 365 Copilot had a bug where it read and summarised
// Sent Items and Drafts including messages carrying sensitivity labels meant
// to block automated access.
//
// So this extracts HOW she writes and deliberately never retains WHAT she
// wrote about. The prompt says so explicitly, and — because a prompt is a
// request, not a guarantee — scrubProfile() below independently strips
// anything that looks like a figure, a price or a long number from the result
// before it is stored. If the model leaks a rate into a style note anyway, it
// does not reach disk.
//
// The stored profile is a handful of short strings about tone and habits. It
// is safe to read, safe to log, and useless to anyone who obtains it.
//
// Nothing here changes what gets SENT. Drafts still go through the same
// confirm-before-send gate every outbound email in this app already uses —
// which is also what every serious assistant in the field does, and the one
// part of the existing design that already matched them.

const { loadJson, saveJson } = require('./json');
const cfg = require('../config');
const path = require('path');

const STYLE_FILE = path.join(path.dirname(cfg.SETTINGS_FILE), 'writing_style.json');
const SAMPLE_SIZE = 40;

function loadStyle() {
    return loadJson(STYLE_FILE, null);
}

// Removes anything that could carry business content out of the sample and
// into storage. Deliberately aggressive: a style profile has no legitimate
// need for a number, so stripping every one of them costs nothing and closes
// the whole category of leak rather than guessing at which figures matter.
function scrubProfile(profile) {
    const clean = (v) => String(v == null ? '' : v)
        .replace(/\$\s?[\d,.]+/g, '')                       // prices
        // Identifiers: any token mixing letters and digits. Container and
        // booking numbers are exactly this shape — 26JY90, HMMU6247533,
        // 25RMT158 — and the first version of this scrubber let 26JY90
        // straight through, because a digits-and-commas pattern doesn't match
        // something with letters in the middle. Caught by testing the
        // scrubber against a deliberately leaky profile rather than trusting
        // the prompt to have been obeyed.
        .replace(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d-]{4,}\b/g, '')
        .replace(/\b[\d][\d,.]*\b/g, '')                    // any bare number
        .replace(/\s+([,.;:])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
    const cleanList = (arr) => (Array.isArray(arr) ? arr : []).map(clean).filter(Boolean).slice(0, 8);
    return {
        greeting: clean(profile.greeting).slice(0, 120),
        sign_off: clean(profile.sign_off).slice(0, 120),
        tone: clean(profile.tone).slice(0, 300),
        sentence_style: clean(profile.sentence_style).slice(0, 300),
        habits: cleanList(profile.habits),
        avoids: cleanList(profile.avoids),
        formality_note: clean(profile.formality_note).slice(0, 300),
    };
}

function buildStylePrompt(samples) {
    return `Below are ${samples.length} emails written by ONE person. Work out HOW she writes.

CRITICAL: describe only her STYLE. Never record what any email was about. Do not quote figures, prices, rates, company names, container numbers, dates or any business detail — not even as an example. If you cannot make a point about style without naming a business fact, leave that point out. What you return will be stored; it must be worthless to anyone who reads it.

EMAILS:
${samples.map((s, i) => `--- ${i + 1} ---\n${s.slice(0, 1200)}`).join('\n\n')}

Return ONLY this JSON:
{
  "greeting": "how she opens, as a pattern e.g. \\"Hi <first name>,\\" or \\"Dear <name>,\\"",
  "sign_off": "how she closes, as a pattern, including whether she uses her name, the company, both, or neither",
  "tone": "one or two sentences: warm or brisk, direct or hedged, formal or plain",
  "sentence_style": "sentence and paragraph length, whether she uses bullets, how she asks for things",
  "habits": ["short phrases or constructions she genuinely uses often, style only, no business words"],
  "avoids": ["things she notably does NOT do, e.g. no exclamation marks, no small talk, never apologises for delay"],
  "formality_note": "whether she writes differently to different kinds of recipient, and how"
}`;
}

// Reads her own sent mail and derives the profile. Returns
// { ok, profile, sampled } or { ok:false, error }.
async function learnStyle({ sampleSize = SAMPLE_SIZE } = {}) {
    const { getGmailRead, listMessages, getMessage, getEmailContent, getMyEmailAddress } = require('./gmail');
    const { callGeminiJSON } = require('./gemini');

    let gmail, me;
    try {
        gmail = getGmailRead();
        me = await getMyEmailAddress(gmail).catch(() => null);
    } catch (err) {
        return { ok: false, error: `Gmail unavailable: ${err.message}` };
    }

    let msgs;
    try {
        // in:sent only. Never the inbox — learning "her" style from mail other
        // people wrote would be worse than not learning it at all.
        msgs = await listMessages(gmail, 'in:sent -in:chats', sampleSize);
    } catch (err) {
        return { ok: false, error: `Couldn't read sent mail: ${err.message}` };
    }
    if (!msgs || !msgs.length) return { ok: false, error: 'No sent mail found to learn from.' };

    const { extractLatestMessage } = require('../workflow/replyWatch');
    const samples = [];
    for (const m of msgs) {
        try {
            const full = await getMessage(gmail, m.id);
            const { body } = getEmailContent(full.payload);
            // Quoted history stripped: a reply chain is mostly other people's
            // writing, and including it would teach her style from theirs.
            const own = extractLatestMessage(body || '');
            const trimmed = String(own || '').trim();
            if (trimmed.length >= 40) samples.push(trimmed);
        } catch (e) { /* skip an unreadable message rather than fail the run */ }
    }
    if (samples.length < 3) return { ok: false, error: `Only found ${samples.length} usable sent email(s) — not enough to learn from.` };

    let raw;
    try {
        raw = await callGeminiJSON(buildStylePrompt(samples), 2);
    } catch (err) {
        return { ok: false, error: `Couldn't analyse the writing: ${err.message}` };
    }
    if (!raw || !raw.tone) return { ok: false, error: "Couldn't work out a clear style from those emails." };

    const profile = scrubProfile(raw);
    profile.learned_at = new Date().toISOString();
    profile.sampled = samples.length;
    profile.account = me || null;
    await saveJson(STYLE_FILE, profile);
    return { ok: true, profile, sampled: samples.length };
}

// The fragment injected into every draft prompt. Empty string when nothing has
// been learned yet, so callers can concatenate it unconditionally and drafting
// behaves exactly as before until she runs the learn step.
function getStyleGuidance() {
    const p = loadStyle();
    if (!p || !p.tone) return '';
    const bits = [
        'WRITE IN HER VOICE. This is how the sender actually writes, learned from her own sent mail — match it rather than defaulting to generic business English:',
        p.greeting ? `- Opens: ${p.greeting}` : '',
        p.sign_off ? `- Closes: ${p.sign_off}` : '',
        p.tone ? `- Tone: ${p.tone}` : '',
        p.sentence_style ? `- Sentences: ${p.sentence_style}` : '',
        (p.habits || []).length ? `- Habits: ${p.habits.join('; ')}` : '',
        (p.avoids || []).length ? `- Never: ${p.avoids.join('; ')}` : '',
        p.formality_note ? `- By recipient: ${p.formality_note}` : '',
        'Match the voice, not the content — the email must still say what it needs to say.',
    ];
    return bits.filter(Boolean).join('\n');
}

function describeStyle() {
    const p = loadStyle();
    if (!p || !p.tone) return null;
    return [
        `Learned from ${p.sampled} of your sent emails on ${new Date(p.learned_at).toLocaleDateString('en-US')}.`,
        '',
        p.greeting ? `Opens: ${p.greeting}` : '',
        p.sign_off ? `Closes: ${p.sign_off}` : '',
        p.tone ? `Tone: ${p.tone}` : '',
        (p.habits || []).length ? `Habits: ${p.habits.join('; ')}` : '',
        (p.avoids || []).length ? `Never: ${p.avoids.join('; ')}` : '',
        p.formality_note ? `By recipient: ${p.formality_note}` : '',
    ].filter(Boolean).join('\n');
}

module.exports = { learnStyle, loadStyle, getStyleGuidance, describeStyle, scrubProfile, buildStylePrompt, STYLE_FILE };
