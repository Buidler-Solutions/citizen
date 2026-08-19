#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer as httpCreateServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

export function readFileFactory(dir) {
  return (path) => readFileSync(join(dir, path));
}

export function createServer(readFile, port, label) {
  const server = httpCreateServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try {
      const data = readFile(file);
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  server.listen(port, () => console.log(`${label} on http://127.0.0.1:${port}`));
}
