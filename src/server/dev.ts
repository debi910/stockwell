// Runs the Stockwell server on its own for development: `npm run dev:server`, then `npm run dev:ui`.
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';

const dataDir = path.resolve('.data');
fs.mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 7400);
const { app } = await buildApp({ dbPath: process.env.STOCKWELL_DB ?? path.join(dataDir, 'dev.db'), uiDir: path.resolve('dist/ui'), logger: true });
await app.listen({ port, host: '0.0.0.0' });
