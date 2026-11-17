// ── tests/eval-weekly.js — the weekly self-check line ─────────────────────────────────────────────
// Real child process running the real scripts/evalset.js --score against a temp DATA_DIR. No network, no model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-evalweekly-'));
process.env.DATA_DIR = dir;
process.env.JARVIS_TEST = '1';
delete require.cache[require.resolve(R('config.js'))];
const ew = require(R('helpers/evalWeekly.js'));
const F = path.join(dir, 'evalset.txt');
const block = (n, v) => `### ${n}. Subject ${n}\n  JARVIS : said something ${n}\nVERDICT: ${v}\n`;
const write = (vs) => fs.writeFileSync(F, vs.map((v, i) => block(i + 1, v)).join('\n'));

(async () => {
    ck('no review file: silence', (await ew.weeklyLine()) === null);
    write(['?', '', '?']);
    ck('nothing marked yet: silence, not a nag', (await ew.weeklyLine()) === null);
    write(['ok', 'ok', 'wrong: it was a P.O.', '?']);
    const before = fs.readFileSync(F, 'utf8');
    const l1 = await ew.weeklyLine();
    ck('marks present: one line with the right counts', /2 of 3 marked right \(67%\)/.test(l1 || ''), String(l1));
    ck('it says how many are unmarked', /1 still unmarked/.test(l1 || ''), String(l1));
    ck('under 30 marked: called a smoke test', /smoke test/.test(l1 || ''), String(l1));
    ck('THE REVIEW FILE WAS NOT TOUCHED (her marks survive)', fs.readFileSync(F, 'utf8') === before);
    ck('same marks next week: silence', (await ew.weeklyLine()) === null);
    write(['ok', 'ok', 'ok', 'ok']);
    const l2 = await ew.weeklyLine();
    ck('marks changed: speaks again', /4 of 4 marked right \(100%\)/.test(l2 || ''), String(l2));
    ck('parse() reads the script output shape', JSON.stringify(ew.parse('EVAL SET — 5 examples, 4 adjudicated, 1 still blank\n  CORRECT     3   75%\n  WRONG       1   25%')) === JSON.stringify({ examples: 5, scored: 4, blank: 1, ok: 3, bad: 1 }));
    const sched = fs.readFileSync(R('scheduler.js'), 'utf8');
    ck('scheduler runs weeklyLine and sends it to the manager', /evalWeekly'\)\.weeklyLine\(\)[\s\S]{0,80}_sendToManager\(line\)/.test(sched));
    ck('nothing in the scheduler or helper can run evalset BUILD mode', !/evalset\.js'[^\n]*(?!--score)/.test(fs.readFileSync(R('helpers/evalWeekly.js'), 'utf8').replace(/--score/g, '')) || /--score/.test(fs.readFileSync(R('helpers/evalWeekly.js'), 'utf8')));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
