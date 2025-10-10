#!/usr/bin/env python3
"""
Simple HTTP server with CORS headers for SharedArrayBuffer support
Run with: python3 serve.py
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required headers for SharedArrayBuffer
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        # Standard CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        SimpleHTTPRequestHandler.end_headers(self)

if __name__ == '__main__':
    port = 8005
    if len(sys.argv) > 1:
        port = int(sys.argv[1])

    server = HTTPServer(('localhost', port), CORSRequestHandler)
    print(f'Server running at http://localhost:{port}/')
    print('SharedArrayBuffer enabled via CORS headers')
    server.serve_forever()
