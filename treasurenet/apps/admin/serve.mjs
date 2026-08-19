#!/usr/bin/env node
/** Static server for the TreasureNet admin panel (port 7778). */
import { createServer, readFileFactory } from "../web/serve-util.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const readFile = readFileFactory(dirname(fileURLToPath(import.meta.url)));

const port = Number(process.env.PORT ?? 7778);
createServer(readFile, port, "Admin panel");
