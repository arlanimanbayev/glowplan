// POST /api/analyze: run YouCam AI Skin Analysis on a photo (JSON base64 or multipart) or a bundled sample.
// GET  /api/analyze?task_id=...: keep polling a task that was still running. See lib/http.js.
import { handleAnalyze } from '../lib/http.js';

export default handleAnalyze;
