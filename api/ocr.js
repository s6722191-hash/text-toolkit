const { PaddleOCRClient, Model } = require('@paddleocr/api-sdk');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHmac, timingSafeEqual } = require('node:crypto');

const MODEL = Model.PaddleOCRVL16;

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

function signature(payload, token) {
    return createHmac('sha256', token).update('smarttext-ocr-v1:' + MODEL + ':' + payload).digest();
}

function createTicket(jobId, token) {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ jobId, expiresAt })).toString('base64url');
  return {
    ticket: payload + '.' + signature(payload, token).toString('base64url'),
    expiresAt
  };
}

function readTicket(ticket, token) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = signature(parts[0], token);
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof data.jobId !== 'string' || !data.jobId || data.jobId.length > 256 ||
        !Number.isSafeInteger(data.expiresAt)) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error, retryable = false) =>
    res.status(status).json({ error, retryable });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'Use POST to access OCR.');
  }

  try {
    if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
  } catch {
    return fail(403, 'Open this tool on the website to use OCR.');
  }

  const token = process.env.PADDLEOCR_ACCESS_TOKEN?.trim();
  if (!token) return fail(503, 'OCR is not configured. Please contact the site owner.');

  const action = req.headers['x-ocr-action'] || 'submit';
  if (!['submit', 'check'].includes(action)) return fail(400, 'Invalid OCR action.');

  const contentType = req.headers['content-type']?.split(';')[0];
  let bytes, extension, job;

  if (action === 'submit') {
    if (contentType !== 'application/octet-stream') return fail(415, 'Submit an image file.');
    bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return fail(400, 'Choose an image first.');
    if (bytes.length > 3 * 1024 * 1024) return fail(413, 'Image size must be 3 MB or less.');
    extension = imageExtension(bytes);
    if (!extension) return fail(415, 'Choose a JPG, PNG, WEBP or BMP image.');
  } else {
    if (contentType !== 'application/json') return fail(415, 'Submit a valid OCR ticket.');
    job = readTicket(req.body?.ticket, token);
    if (!job) return fail(400, 'Invalid OCR session. Choose the image again.');
    if (job.expiresAt <= Date.now()) return fail(410, 'OCR session expired. Submit the image again.');
  }

  let directory;
  let oversizedResponse = false;

  try {
    const client = new PaddleOCRClient({
      token,
      requestTimeout: 45000,
      pollTimeout: 45000,
      fetch: async (url, options) => {
        const response = await globalThis.fetch(url, options);
        if (!response.body) return response;
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 5 * 1024 * 1024) {
              oversizedResponse = true;
              await reader.cancel();
              throw new Error('OCR response too large.');
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        return new Response(Buffer.concat(chunks), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    });
    const options = { signal: AbortSignal.timeout(50000) };

    if (action === 'submit') {
      directory = await mkdtemp(join(tmpdir(), 'smarttext-ocr-'));
      const filePath = join(directory, 'image.' + extension);
      await writeFile(filePath, bytes);
      const submitted = await client.submitDocumentParsing({
        filePath,
        model: MODEL,
                options: {
          useLayoutDetection: false,
          promptLabel: 'ocr'
        }
      }, options);
      return res.status(202).json({
        ...createTicket(submitted.jobId, token),
        state: 'pending',
        model: MODEL
      });
    }

        const status = await client.getStatus(job.jobId, options);

    console.info('OCR_JOB_STATE', {
      state: status.state,
      totalPages: status.progress?.totalPages ?? null,
      extractedPages: status.progress?.extractedPages ?? null
    });
    if (status.state === 'failed') return fail(422, 'OCR could not process this image. Try a clearer image.');
    if (status.state !== 'done') {
      return res.status(202).json({ state: status.state, model: MODEL });
    }

    const result = await client.waitDocumentParsingResult({
      jobId: job.jobId,
      task: 'document_parsing',
      model: MODEL
    }, options);
    const text = result.pages.map(page => page.markdownText).join('\n\n').trim();
    if (text.length > 300000) return fail(422, 'The OCR result is too large. Try a smaller image.');
    return res.status(200).json({ state: 'done', text, model: MODEL });
  } catch (error) {
        console.error('OCR_REQUEST_FAILED', {
      action,
      type: error.name,
      httpStatus: error.statusCode ?? null,
      detail: error.name === 'InvalidRequestError'
        ? String(error.message || '').replaceAll(token, '[redacted]').slice(0, 400)
        : undefined
    });
    if (oversizedResponse) return fail(422, 'The OCR result is too large. Try a smaller image.');
    if (error.name === 'AuthError') return fail(503, 'OCR access needs updating. Contact the site owner.');
    if (error.name === 'RateLimitError') return fail(429, 'OCR quota or rate limit reached. Please try later.');
    if (['JobFailedError', 'InvalidRequestError'].includes(error.name)) {
      return fail(422, 'OCR could not process this image. Try a clearer image.');
    }
    if (error.statusCode === 404) return fail(410, 'This OCR job is no longer available. Submit the image again.');

    const transient = ['TimeoutError', 'AbortError', 'RequestTimeoutError',
      'PollTimeoutError', 'NetworkError', 'ServiceUnavailableError'].includes(error.name) ||
      error.statusCode >= 500;
    if (transient) {
      return fail(504, action === 'submit'
        ? 'Could not confirm the upload. Please wait before trying again.'
        : 'OCR is taking longer. The same job can be checked again.', action === 'check');
    }
    return fail(502, 'The OCR service returned an unexpected response. Please try later.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};
