/**
 * File:      /var/www/VGEpaper/apps/ingest/src/server.js
 * Repo path: apps/ingest/src/server.js
 * System:    apps/ingest (Express, port 4158)          MODIFIED
 *
 * Change: mounts the story editor router (routes/storyEditor.js).
 */
import 'dotenv/config';
import express from 'express';
import { runIngest } from './pipeline/runIngest.js';
import { storyEditorRouter } from './routes/storyEditor.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4158;
const INGEST_WEBHOOK_SECRET = process.env.INGEST_WEBHOOK_SECRET;

// In-memory status board, just for the /status endpoint below — fine for a
// single-instance scaffold. Move to Redis/a DB if you run more than one
// ingest worker, so status isn't split across instances.
const runs = new Map(); // editionId -> { state, startedAt, finishedAt, error, result }

app.post('/ingest/edition/:id', (req, res) => {
  if (INGEST_WEBHOOK_SECRET && req.headers['x-ingest-secret'] !== INGEST_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid ingest secret' });
  }
  const editionId = req.params.id;

  // Respond immediately — PDF processing can take a while, and Strapi's
  // lifecycle hook shouldn't be left waiting on it.
  res.status(202).json({ accepted: true, editionId });

  runs.set(editionId, { state: 'processing', startedAt: new Date().toISOString() });
  runIngest(editionId)
    .then(result => {
      runs.set(editionId, { state: 'done', finishedAt: new Date().toISOString(), result });
    })
    .catch(err => {
      runs.set(editionId, { state: 'failed', finishedAt: new Date().toISOString(), error: String(err?.message || err) });
    });
});

// Handy while wiring things up locally — check progress without opening Strapi.
app.get('/ingest/edition/:id/status', (req, res) => {
  const status = runs.get(req.params.id);
  if (!status) return res.status(404).json({ error: 'no run recorded for this edition (yet, or ever)' });
  res.json(status);
});

// Manual story editor (handle app -> middleware -> here). Same x-ingest-secret as the webhook above.
app.use(storyEditorRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[ingest] listening on :${PORT}`);
});