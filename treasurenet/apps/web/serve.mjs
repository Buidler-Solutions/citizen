#!/usr/bin/env node
/** Static server for the TreasureNet GM console (port 7777). */
import { createServer, readFileFactory } from "./serve-util.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const readFile = readFileFactory(dirname(fileURLToPath(import.meta.url)));

const port = Number(process.env.PORT ?? 7777);
createServer(readFile, port, "GM console");
