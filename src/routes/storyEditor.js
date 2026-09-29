/**
 * File:      /var/www/VGEpaper/apps/ingest/src/routes/storyEditor.js
 * Repo path: apps/ingest/src/routes/storyEditor.js
 * System:    apps/ingest (Express, port 4158)          NEW FILE
 *
 * Story editor API, called only by apps/middleware (routes/adminStories.js),
 * authenticated exactly like the CMS webhook: x-ingest-secret header =
 * INGEST_WEBHOOK_SECRET. Unlike the webhook, a missing secret is refused
 * rather than allowed, since these routes write stories.
 *
 *   GET   /editor/editions/:editionId/pages/:pageNumber
 *   POST  /editor/editions/:editionId/pages/:pageNumber/compile           { layout }
 *   POST  /editor/editions/:editionId/pages/:pageNumber/stories           { storyDocumentId?, layout, headline? }
 *   PATCH /editor/editions/:editionId/pages/:pageNumber/stories/:storyId  { action: keep|drop|restore }
 *
 * Mounted in src/server.js with:  app.use(storyEditorRouter);
 */
import express from 'express';
import { getEditorState, compilePreview, saveManualStory, setStoryState } from '../pipeline/storyEditor.js';

export const storyEditorRouter = express.Router();
const base = '/editor/editions/:editionId/pages/:pageNumber';

storyEditorRouter.use('/editor', express.json({ limit: '1mb' }), (req, res, next) => {
  const secret = process.env.INGEST_WEBHOOK_SECRET;
  if (!secret || req.headers['x-ingest-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const handle = fn => async (req, res) => {
  const pageNumber = Number(req.params.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return res.status(400).json({ error: 'Invalid page number' });
  try {
    res.json(await fn(req, pageNumber));
  } catch (err) {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[storyEditor]', err);
    res.status(status).json({ error: status >= 500 ? 'Story editor failed. Check the ingest logs.' : err.message });
  }
};

storyEditorRouter.get(base, handle((req, n) => getEditorState(req.params.editionId, n)));
storyEditorRouter.post(`${base}/compile`, handle((req, n) => compilePreview(req.params.editionId, n, req.body?.layout)));
storyEditorRouter.post(`${base}/stories`, handle((req, n) => saveManualStory(req.params.editionId, n, req.body || {})));
storyEditorRouter.patch(`${base}/stories/:storyId`, handle((req, n) => setStoryState(req.params.editionId, n, req.params.storyId, req.body?.action)));