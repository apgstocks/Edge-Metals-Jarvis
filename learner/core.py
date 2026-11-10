"""learner/core.py — "what would Apsara do here?", from her own past decisions.

SHADOW ONLY. This never acts. It reads examples (her past decisions), predicts a decision for a new case, and logs
the prediction. Later the REAL decision (hers, or what Jarvis's rules did) is logged next to it, and /report says how
often they agreed. Nothing is changed by a prediction; acting on one needs her yes, per kind of decision.

It reads and writes ONLY its own folder (LEARNER_DATA, default data/learner). It never touches Jarvis's other data.
Pure stdlib except the language model, which is imported lazily (and replaced by a deterministic stub in tests).
"""
import json, math, os, re, time, threading
from collections import Counter

MIN_EXAMPLES = 5        # fewer than this for a kind: abstain, do not guess from nothing
K = 8                   # how many similar past decisions go to the model
_lock = threading.Lock()


def data_dir():
    d = os.environ.get('LEARNER_DATA') or os.path.join(os.getcwd(), 'data', 'learner')
    os.makedirs(d, exist_ok=True)
    return d


def _path(name):
    return os.path.join(data_dir(), name)


def _append(name, row):
    line = json.dumps(row, ensure_ascii=False) + '\n'
    with _lock, open(_path(name), 'a', encoding='utf-8') as f:
        f.write(line)


def _read(name):
    out = []
    try:
        with open(_path(name), encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass            # a half-written last line must not poison the file
    except FileNotFoundError:
        pass
    return out


def text_of(case):
    if isinstance(case, str):
        return case
    return json.dumps(case, ensure_ascii=False, sort_keys=True)


_tok = re.compile(r"[a-z0-9$.]+")


def tokens(s):
    return _tok.findall(str(s).lower())


def similar(kind, case, k=K):
    """The k past decisions of this kind most like this case (TF-IDF cosine, no model, no network)."""
    docs = [e for e in _read('examples.jsonl') if e.get('kind') == kind and e.get('decision')]
    if not docs:
        return []
    toks = [tokens(text_of(e.get('case'))) for e in docs]
    df = Counter(t for ts in toks for t in set(ts))
    n = len(docs)
    idf = lambda t: math.log((n + 1) / (df.get(t, 0) + 1)) + 1

    def vec(ts):
        c = Counter(ts)
        return {t: (1 + math.log(v)) * idf(t) for t, v in c.items()}

    q = vec(tokens(text_of(case)))
    qn = math.sqrt(sum(v * v for v in q.values())) or 1.0
    scored = []
    for e, ts in zip(docs, toks):
        d = vec(ts)
        dn = math.sqrt(sum(v * v for v in d.values())) or 1.0
        dot = sum(q[t] * d.get(t, 0) for t in q)
        scored.append((dot / (qn * dn), e))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [dict(e, similarity=round(s, 3)) for s, e in scored[:k]]


def add_example(kind, case, decision, by='apsara', ref=None, reason=None):
    if not kind or not decision:
        raise ValueError('kind and decision are required')
    row = {'kind': str(kind), 'case': case, 'decision': str(decision), 'by': by, 'ref': ref,
           'reason': (reason or None), 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    _append('examples.jsonl', row)
    return row


def count_examples(kind):
    return sum(1 for e in _read('examples.jsonl') if e.get('kind') == kind and e.get('decision'))


def _stub_lm(case, neighbours):
    """Deterministic stand-in for tests: the neighbours' most common decision, confidence = its share."""
    c = Counter(n['decision'] for n in neighbours)
    d, v = c.most_common(1)[0]
    return {'decision': d, 'confidence': v / len(neighbours), 'reason': f'{v} of {len(neighbours)} similar past decisions were "{d}"'}


_dspy_program = None


def _real_lm(case, neighbours, options):
    global _dspy_program
    import dspy                                    # lazy: the service starts and tests run without it
    if _dspy_program is None:
        dspy.configure(lm=dspy.LM(os.environ.get('LEARNER_MODEL', 'gemini/gemini-2.5-flash'),
                                  api_key=os.environ.get('GEMINI_API_KEY'), temperature=0))

        class Judge(dspy.Signature):
            """Decide as Apsara, who runs Edge Metals, would, using only her similar past decisions below.
            If those decisions do not settle it, answer with low confidence rather than guessing."""
            case: str = dspy.InputField()
            past: str = dspy.InputField(desc='her similar past decisions, most similar first')
            options: str = dspy.InputField(desc='the only allowed answers')
            decision: str = dspy.OutputField(desc='exactly one of the options')
            confidence: float = dspy.OutputField(desc='0 to 1, how sure you are that she would decide this')
            reason: str = dspy.OutputField(desc='one short sentence citing the past decision that settles it')
        _dspy_program = dspy.Predict(Judge)
    past = '\n'.join(f"- ({n['similarity']}) {text_of(n['case'])} -> {n['decision']}" + (f" because {n['reason']}" if n.get('reason') else '')
                     for n in neighbours)
    r = _dspy_program(case=text_of(case), past=past, options=', '.join(options))
    return {'decision': str(r.decision).strip(), 'confidence': float(r.confidence), 'reason': str(r.reason).strip()}


def judge(kind, case, ref=None):
    """Predict, log, return. Abstains (decision None) when there is too little to go on or the model is unsure/off-menu."""
    have = count_examples(kind)
    out = {'kind': kind, 'ref': ref, 'decision': None, 'confidence': 0.0, 'reason': None, 'examples': have, 'abstained': True}
    if have < MIN_EXAMPLES:
        out['reason'] = f'only {have} past decision(s) of this kind (need {MIN_EXAMPLES}); not guessing'
    else:
        nb = similar(kind, case)
        options = sorted({n['decision'] for n in nb})
        try:
            r = _stub_lm(case, nb) if os.environ.get('LEARNER_FAKE_LM') == '1' else _real_lm(case, nb, options)
            conf = max(0.0, min(1.0, float(r['confidence'])))
            if r['decision'] in options:
                out.update(decision=r['decision'], confidence=round(conf, 3), reason=r['reason'], abstained=False)
            else:
                out['reason'] = 'the model answered outside the options seen in her past decisions; abstaining'
        except Exception as e:                      # a model failure is an abstention, never a crash
            out['reason'] = f'could not judge: {type(e).__name__}'
        out['neighbours'] = [{'ref': n.get('ref'), 'decision': n['decision'], 'similarity': n['similarity']} for n in nb]
    _append('shadow.jsonl', dict(out, t='predicted', case=case, at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    return out


def record_actual(ref, decision):
    """What really happened for a case we predicted."""
    if not ref or not decision:
        raise ValueError('ref and decision are required')
    _append('shadow.jsonl', {'t': 'actual', 'ref': str(ref), 'decision': str(decision),
                             'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})


def report():
    """How often would acting on the prediction have matched what really happened — the number that earns autonomy."""
    pred, act = {}, {}
    for r in _read('shadow.jsonl'):
        if r.get('t') == 'predicted' and r.get('ref') is not None:
            pred[str(r['ref'])] = r
        elif r.get('t') == 'actual':
            act[str(r['ref'])] = r
    rows = {'judged': len(pred), 'abstained': 0, 'compared': 0, 'agree': 0, 'by_confidence': {}}
    for ref, p in pred.items():
        if p.get('abstained'):
            rows['abstained'] += 1
            continue
        a = act.get(ref)
        if not a:
            continue
        rows['compared'] += 1
        hit = p['decision'] == a['decision']
        rows['agree'] += 1 if hit else 0
        band = 'high (>=0.8)' if p['confidence'] >= 0.8 else 'medium (0.5-0.8)' if p['confidence'] >= 0.5 else 'low (<0.5)'
        b = rows['by_confidence'].setdefault(band, {'compared': 0, 'agree': 0})
        b['compared'] += 1
        b['agree'] += 1 if hit else 0
    rows['agreement'] = round(rows['agree'] / rows['compared'], 3) if rows['compared'] else None
    return rows
