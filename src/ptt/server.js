import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { attachWebSocket } from './ws-handler.js';
import { detectProjects, getActiveProject, setActiveProject } from '../shared/tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use(express.static(join(publicDir, 'ptt')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await detectProjects();
    res.json({ projects, activeProject: getActiveProject() });
  } catch (err) {
    logger.error({ err: err.message }, 'Projects endpoint error');
    res.status(500).json({ error: 'Failed to detect projects' });
  }
});

app.post('/api/projects/active', (req, res) => {
  const { name, path, screenSession } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Missing project name' });
  }
  setActiveProject(name, path || null, screenSession || null);
  res.json({ activeProject: getActiveProject() });
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host }, 'PTT server started');
  console.log(`\n  PTT server: http://localhost:${config.port}\n`);
});

attachWebSocket(server);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal({ port: config.port }, 'Port already in use');
  } else {
    logger.fatal({ err }, 'Server error');
  }
  process.exit(1);
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));