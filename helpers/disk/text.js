// ── helpers/disk/text.js — words, normalised, so "reminder" finds "reminders" ─
const STOP = new Set(('a an the and or of to for in on at by is are was were be it this that these those ' +
    'with from as we you i me my our your not no do does did have has had will would should can could ' +
    'about any all if so than then them they their there here what when which who how').split(' '));

function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    return w;
}

function tokens(text) {
    const words = String(text == null ? '' : text).toLowerCase().match(/[a-z0-9]+/g) || [];
    return words.filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

// For whole-word name matching: lower-case, everything non-alphanumeric -> one space.
const spaced = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = { tokens, stem, spaced };
