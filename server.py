#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import http.server
import socketserver
import os

PORT = 3000
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

if __name__ == "__main__":
    os.chdir(DIRECTORY)
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Haku-sensei's Japanese App running at http://localhost:{PORT}")
        httpd.serve_forever()
