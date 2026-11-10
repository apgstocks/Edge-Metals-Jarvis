"""learner/server.py — the learner as a small local HTTP service. 127.0.0.1 only, shared-secret header.
    LEARNER_TOKEN=... LEARNER_DATA=/path/to/data/learner python3 learner/server.py [port]
Shadow only: nothing here acts, and every answer can be an abstention.
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core

TOKEN = os.environ.get('LEARNER_TOKEN', '')
MAX_BODY = 200_000


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _authed(self):
        if not TOKEN or self.headers.get('X-Learner-Token') != TOKEN:
            self._send(401, {'error': 'unauthorised'})
            return False
        return True

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True})
        if not self._authed():
            return
        if self.path == '/report':
            return self._send(200, core.report())
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        if not self._authed():
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                return self._send(413, {'error': 'too large'})
            body = json.loads(self.rfile.read(n) or b'{}')
            if self.path == '/judge':
                return self._send(200, core.judge(body['kind'], body['case'], body.get('ref')))
            if self.path == '/example':
                return self._send(200, core.add_example(body['kind'], body['case'], body['decision'],
                                                        body.get('by', 'apsara'), body.get('ref'), body.get('reason')))
            if self.path == '/actual':
                core.record_actual(body['ref'], body['decision'])
                return self._send(200, {'ok': True})
            self._send(404, {'error': 'not found'})
        except (KeyError, ValueError) as e:
            self._send(400, {'error': f'bad request: {e}'})
        except Exception as e:
            self._send(500, {'error': type(e).__name__})


if __name__ == '__main__':
    if not TOKEN:
        sys.exit('LEARNER_TOKEN is required')
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('LEARNER_PORT', '8765'))
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
