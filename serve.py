# 로컬 개발 서버: 브라우저가 옛날 JS를 캐시하지 않도록 no-store 헤더를 붙임
import http.server, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
