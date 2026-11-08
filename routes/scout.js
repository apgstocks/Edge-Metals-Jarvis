// routes/scout.js — Scout, with a screen (helpers/sourceParts.js reconstructs the original)
module.exports = function (app, ctx) {
    const { actorOf } = ctx;
// @@chunk-start
    // ── SCOUT ON THE RIGHT OF EVERY EDGE YARD SCREEN ─────────────────────
    // Apsara, 2026-11-08: "There should be a scout AI to assist us with yard
    // on the right side ... If i say show spend report for last three days.
    // it should do that from any screen in edge yard."
    //
    // SCOUT IS NOT NEW. helpers/voiceRouter.js has named her for weeks and
    // helpers/yardAsk.js is the brain behind her, driving 17 read tools.
    // What she has never had is a screen and a pair of hands. This route is
    // both, and it deliberately asks THE SAME askYard the voice path asks —
    // a second assistant that knew less than the first would be the worst
    // possible outcome, and is exactly the drift that cost a day this
    // morning when two files disagreed about whose bank Chase was.
    //
    // ── THE SCREEN MOVES ON HER WORDS, NEVER ON THE MODEL'S ──────────────
    // The action is worked out by helpers/scoutActions.js from the text SHE
    // typed, against an explicit allowlist of screens and filter keys. The
    // model's answer is printed in the panel and is never, on any path,
    // able to decide where she is taken. A model that hallucinates a number
    // is a wrong answer she can see; a model that can navigate is a wrong
    // answer she acts on without noticing.
    app.post('/api/scout/ask', async (req, res) => {
        try {
            const text = String((req.body || {}).text || '').trim();
            if (!text) return res.status(400).json({ error: 'nothing was asked' });

            const scoutActions = require('./helpers/scoutActions');
            // The company she is LOOKING AT carries over when she does not
            // name one, because changing companies is never implied. Edge
            // Yard and Edge Metals are different companies (rule 5) and
            // moving her between them on a guess is the one navigation
            // mistake that silently answers about the wrong business.
            const company = String((req.body || {}).company || '').trim() || null;

            const { askYard } = require('./helpers/yardAsk');
            let out = null;
            try {
                // THE MODEL RESOLVES WHAT SHE MEANT, however she phrased it
                // — helpers/scoutActions.promptFor() tells it what it may
                // ask for, generated from the same constants that validate
                // the reply, so it cannot be told about a screen that would
                // then be rejected.
                out = await askYard(text, { role: req.role, show: scoutActions.promptFor() });
            } catch (e) {
                // ── A BROKEN BRAIN MUST NOT COST HER THE NAVIGATION ──────
                // "Show me the spend report for the last three days" is
                // answered by the ACTION, not by the model. If the model is
                // down, rate-limited or slow, she should still land on the
                // right screen with the right dates — that is the half of
                // this feature that cannot be wrong. Same reasoning as the
                // voice route's WhatsApp fallback: one transport being out
                // must not take the whole assistant dark.
                out = { answer: null, ok: false, error: e && e.message };
            }

            // ── THE SEATBELT, AND THEN THE FALLBACK ──────────────────────
            // What the model asked for is checked before it can move her:
            // sanitise drops a screen that does not exist and any filter
            // key that is not a real field. If the model named nothing — it
            // was down, or it correctly judged this to be a question — the
            // word-based resolver gets a turn, so "show me the spend report
            // for the last three days" still works with no model at all.
            //
            // ORDER MATTERS. The model first, because she asked for the AI
            // to resolve it and the patterns only know the phrasings I
            // thought of. The patterns second, because landing on the right
            // screen is the half of this that must not depend on a model
            // being reachable.
            let action = scoutActions.sanitise((out && out.show) || null);
            if (!action) {
                action = scoutActions.sanitise(
                    scoutActions.actionFromWords(text, { company }));
            } else if (!action.filters.company && company) {
                action.filters.company = company;
                action.said = scoutActions.describe(action.label, action.filters);
            }

            const said = action
                ? `Opening ${action.said}.`
                : null;

            res.json({
                ok: out && out.ok !== false,
                // When there is an action, what Scout SAYS is what she is
                // about to do — said before the screen moves, so a wrong
                // read is visible before a number is believed.
                answer: said || (out && out.answer) || null,
                detail: said && out && out.answer ? out.answer : null,
                proposal: (out && out.proposal) || null,
                action: action || null,
                degraded: !!(out && out.error) || undefined,
            });

            try {
                require('./helpers/yardChatLog').logExchange({
                    question: text, answer: said || (out && out.answer),
                    have_data: out && out.have_data, ok: out && out.ok !== false,
                    role: req.role || null, source: 'scout-panel',
                });
            } catch (e) { /* never let logging break answering */ }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // What Scout can be asked to open, so the panel can offer it rather
    // than leaving her to guess the words. Served rather than restated in
    // the client, for the usual reason: two lists drift.
    app.get('/api/scout/screens', (req, res) => {
        const { SCREENS } = require('./helpers/scoutActions');
        res.json({ screens: Object.entries(SCREENS).map(([k, v]) => ({ key: k, ...v })) });
    });
// @@chunk-end
    return {};
};
