/* ── dashboard/orb.js — the Jarvis orb ─────────────────────────────────────
 *
 * Apsara, 2026-09-05: "Design jarvis logo realistically animated 3d motion
 * graphic like siri."
 *
 * WHAT SIRI'S ORB ACTUALLY DOES, AND WHY IT WORKS
 * -----------------------------------------------
 * It is not decoration. Every visual state answers a question the user has at
 * that moment, without a word of text:
 *
 *   is it on?          — the orb exists at all
 *   is it listening?   — it breathes, slowly and steadily
 *   did it hear me?    — it swells the instant the wake word lands
 *   is it working?     — it churns, faster, tighter
 *   is it talking?     — it moves with the speech and settles when done
 *
 * So this is driven by the SAME state the microphone is, from voice-machine.js.
 * The orb cannot say "listening" while the mic is shut, because both read one
 * reducer. An indicator that can disagree with the thing it indicates is worse
 * than none — and on a microphone, much worse.
 *
 * NO WEBGL, NO LIBRARY, NO EXTRA MICROPHONE
 * -----------------------------------------
 * A 2D canvas with layered, phase-shifted radial waves reads as a soft 3D
 * sphere because of the lighting, not because of geometry: a bright off-centre
 * specular, a darker rim, and blobs that pass in front of each other. Three.js
 * would be ~600KB for something that must run in the corner of a page that
 * already loads a whole dashboard.
 *
 * And it does NOT open its own microphone to react to audio. Siri does that;
 * doing it here would mean a second mic consumer running alongside the
 * recogniser, and a privacy story where "is it listening?" has two answers.
 * The motion is driven by state and by the speech recogniser's own confidence
 * that it is hearing something — which is free, and honest.
 *
 * RESPECTS prefers-reduced-motion. A permanently animating object in the
 * corner of a working screen is a real accessibility problem, and someone who
 * has asked their OS to stop that has asked this too.
 */

(function () {
    'use strict';
    if (window.__jarvisOrbLoaded) return;
    window.__jarvisOrbLoaded = true;

    // The five things the orb can be. Named after what the PERSON is doing,
    // not after internal flags, because that is what each look has to convey.
    var LOOKS = {
        off:       { hue: 210, sat: 8,  speed: 0.10, amp: 0.05, glow: 0.10, spin: 0.05 },
        listening: { hue: 28,  sat: 70, speed: 0.45, amp: 0.16, glow: 0.55, spin: 0.30 },
        hearing:   { hue: 34,  sat: 95, speed: 1.05, amp: 0.26, glow: 1.00, spin: 0.70 },
        thinking:  { hue: 265, sat: 70, speed: 0.95, amp: 0.18, glow: 0.75, spin: 1.40 },
        speaking:  { hue: 190, sat: 80, speed: 0.80, amp: 0.22, glow: 0.85, spin: 0.45 },
    };

    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    var canvas = document.createElement('canvas');
    canvas.id = 'jarvisOrb';
    canvas.width = 132; canvas.height = 132;      // backing store, in real pixels
    var ctx = canvas.getContext('2d');

    var css = document.createElement('style');
    css.textContent = [
        '#jarvisOrb{position:fixed;right:22px;bottom:148px;z-index:901;width:66px;height:66px;',
        '  cursor:pointer;filter:drop-shadow(0 6px 20px rgba(0,0,0,.55));transition:transform .18s ease;}',
        '#jarvisOrb:hover{transform:scale(1.06);}',
        '#jarvisOrb.hidden{display:none;}',
    ].join('');

    // Current look, eased toward the target so a state change GLIDES rather
    // than snapping. The snap is what makes this kind of thing look cheap.
    var cur = Object.assign({}, LOOKS.off);
    var target = LOOKS.off;
    var t = 0;

    function lookFor(s) {
        if (!s) return LOOKS.off;
        if (s.speaking) return LOOKS.speaking;
        if (s.thinking) return LOOKS.thinking;
        if (s.capturing) return LOOKS.hearing;
        if (s.enabled && s.foreground) return LOOKS.listening;
        return LOOKS.off;
    }

    // A closed blob whose radius is the sum of a few sine waves at different
    // frequencies and phases. Summing them is what stops it looking like a
    // pulsing circle: the lobes travel around the edge at different rates and
    // interfere, which is the organic bit.
    function blob(cx, cy, base, wobble, phase, spin) {
        var STEPS = 72;
        ctx.beginPath();
        for (var i = 0; i <= STEPS; i += 1) {
            var a = (i / STEPS) * Math.PI * 2;
            // Harmonic weights matter more than the amplitude. The first
            // version used 0.55/0.32/0.18 and the busy states came out lumpy
            // and angular — rendered and looked at, not guessed. Leaning on
            // the LOW harmonics (2 and 3) keeps it a rounded thing that
            // breathes; the 5th is what made it spiky, so it is small.
            var r = base * (1
                + wobble * 0.46 * Math.sin(a * 2 + phase * 1.3 + spin)
                + wobble * 0.30 * Math.sin(a * 3 - phase * 1.7 + spin * 0.6)
                + wobble * 0.11 * Math.sin(a * 5 + phase * 2.1));
            var x = cx + Math.cos(a) * r;
            var y = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function frame() {
        t += reduced ? 0.004 : 0.016;

        // Ease every property toward the target. One lerp, so a state change
        // is a glide and there is no special-case transition code.
        var k = reduced ? 0.04 : 0.08;
        for (var key in target) if (Object.prototype.hasOwnProperty.call(target, key)) {
            cur[key] += (target[key] - cur[key]) * k;
        }

        var W = canvas.width, H = canvas.height;
        var cx = W / 2, cy = H / 2;
        var base = W * 0.30;
        ctx.clearRect(0, 0, W, H);

        var phase = t * cur.speed * 4;
        var spin = t * cur.spin;

        // ── the glow ──────────────────────────────────────────────────────
        var glow = ctx.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 2.0);
        glow.addColorStop(0, 'hsla(' + cur.hue + ',' + cur.sat + '%,60%,' + (0.30 * cur.glow) + ')');
        glow.addColorStop(1, 'hsla(' + cur.hue + ',' + cur.sat + '%,50%,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);

        // ── three layered blobs ───────────────────────────────────────────
        // Different phases and slightly different sizes, drawn with additive
        // blending so where they overlap reads as depth rather than as three
        // shapes stacked up.
        ctx.globalCompositeOperation = 'lighter';
        var layers = [
            { s: 1.00, h: 0,   a: 0.40, p: 0 },
            { s: 0.88, h: 18,  a: 0.34, p: 2.1 },
            { s: 0.74, h: -22, a: 0.30, p: 4.2 },
        ];
        for (var L = 0; L < layers.length; L += 1) {
            var l = layers[L];
            var g = ctx.createRadialGradient(
                cx - base * 0.32, cy - base * 0.34, base * 0.05,   // off-centre: the light source
                cx, cy, base * l.s * 1.25);
            g.addColorStop(0, 'hsla(' + (cur.hue + l.h) + ',' + cur.sat + '%,78%,' + l.a + ')');
            g.addColorStop(0.55, 'hsla(' + (cur.hue + l.h) + ',' + cur.sat + '%,52%,' + (l.a * 0.75) + ')');
            g.addColorStop(1, 'hsla(' + (cur.hue + l.h - 14) + ',' + cur.sat + '%,26%,0)');
            ctx.fillStyle = g;
            blob(cx, cy, base * l.s, cur.amp, phase + l.p, spin + L * 0.7);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';

        // ── the specular ──────────────────────────────────────────────────
        // One small bright highlight, up and left, that drifts a little. This
        // is what actually makes a flat gradient read as a sphere.
        var hx = cx - base * 0.30 + Math.sin(t * 0.7) * base * 0.05;
        var hy = cy - base * 0.34 + Math.cos(t * 0.5) * base * 0.04;
        var hi = ctx.createRadialGradient(hx, hy, 0, hx, hy, base * 0.42);
        hi.addColorStop(0, 'hsla(' + cur.hue + ',40%,100%,' + (0.55 * (0.35 + cur.glow * 0.65)) + ')');
        hi.addColorStop(1, 'hsla(' + cur.hue + ',40%,100%,0)');
        ctx.fillStyle = hi;
        ctx.beginPath(); ctx.arc(hx, hy, base * 0.42, 0, Math.PI * 2); ctx.fill();

        // ── the rim ───────────────────────────────────────────────────────
        // A thin bright edge on the shadow side. Cheap, and it separates the
        // orb from a dark page instead of letting it dissolve into it.
        ctx.strokeStyle = 'hsla(' + cur.hue + ',' + cur.sat + '%,70%,' + (0.10 + 0.28 * cur.glow) + ')';
        ctx.lineWidth = 1.4;
        blob(cx, cy, base * 1.02, cur.amp * 0.8, phase, spin);
        ctx.stroke();

        requestAnimationFrame(frame);
    }

    // ── the only input ────────────────────────────────────────────────────
    // Read from the voice state, so the orb and the microphone cannot
    // disagree. `thinking` is the one thing the reducer does not track — it is
    // about the network, not the mic — so voice.js sets it here directly.
    var thinking = false;
    function sync() {
        var s = (window.JarvisVoice && window.JarvisVoice.state && window.JarvisVoice.state()) || null;
        if (s) s = Object.assign({}, s, { thinking: thinking });
        target = lookFor(s);
    }

    function mount() {
        document.head.appendChild(css);
        document.body.appendChild(canvas);
        // Clicking the orb is the same as clicking the toggle. It is the
        // biggest, most obvious thing on the screen; it should do the obvious.
        canvas.addEventListener('click', function () {
            if (window.JarvisVoice && window.JarvisVoice.dispatch) window.JarvisVoice.dispatch('USER_TOGGLE');
            sync();
        });
        setInterval(sync, 120);
        sync();
        requestAnimationFrame(frame);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();

    window.JarvisOrb = {
        setThinking: function (v) { thinking = !!v; sync(); },
        look: function () { return target; },
        LOOKS: LOOKS,
        reducedMotion: reduced,
    };
}());
