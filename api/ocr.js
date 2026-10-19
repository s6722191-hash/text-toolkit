const { PaddleOCRClient, Model } = require('@paddleocr/api-sdk');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  const fail = (status, error) => res.status(status).json({ error });
  
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'Use POST to submit an image.');
  }
  
  let sourceHost;
  try {
    sourceHost = new URL(req.headers.origin).host;
  } catch {
    return fail(403, 'Open this tool on the website to use OCR.');
  }
  
  if (sourceHost !== req.headers.host) {
    return fail(403, 'Cross-site requests are not allowed.');
  }
  
  const token = process.env.PADDLEOCR_ACCESS_TOKEN?.trim();
  
  if (!token) {
    return fail(503, 'PaddleOCR-VL is not configured yet. Please contact the site owner.');
  }
  
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') {
    return fail(415, 'Submit an image file.');
  }
  
  const bytes = req.body;
  
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    return fail(400, 'Choose an image first.');
  }
  
  if (bytes.length > 3 * 1024 * 1024) {
    return fail(413, 'Image size must be 3 MB or less.');
  }
  
  const extension = imageExtension(bytes);
  
  if (!extension) {
    return fail(415, 'Choose a JPG, PNG, WEBP or BMP image.');
  }
  
  let directory;
  let ocrStage = 'preparing image';
  const startedAt = Date.now();  
  try {
    directory = await mkdtemp(join(tmpdir(), 'smarttext-ocr-'));
    const filePath = join(directory, 'image.' + extension);
    await writeFile(filePath, bytes);
    
    const client = new PaddleOCRClient({
      token,
      requestTimeout: 15000,
      pollTimeout: 40000,
      
      fetch: async (url, options) => {
        const path = new URL(url).pathname;
        
        ocrStage = options?.method === 'POST' ?
          'sending image to PaddleOCR' :
          path.includes('/ocr/jobs/') ?
          'checking OCR job status' :
          'downloading OCR result';
        
        return globalThis.fetch(url, options);
      }
    });
    
    const result = await client.parseDocument({
      filePath,
      model: Model.PaddleOCRVL,
      options: { useLayoutDetection: true }
    }, {
      signal: AbortSignal.timeout(50000)
    });
    
    const text = result.pages
      .map(page => page.markdownText)
      .join('\n\n')
      .trim();
    
    if (text.length > 300000) {
      return fail(502, 'The extracted result is too large. Try a smaller image.');
    }
    
    return res.status(200).json({
      text,
      model: Model.PaddleOCRVL
    });
  } catch (error) {
    if (error.name === 'AuthError') {
      return fail(503, 'OCR access needs updating. Please contact the site owner.');
    }
    
    if (error.name === 'RateLimitError') {
      return fail(429, 'OCR quota or rate limit reached. Please try later.');
    }
    
    if (['TimeoutError', 'RequestTimeoutError', 'PollTimeoutError'].includes(error.name)) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      
      console.error('OCR_TIMEOUT', {
        type: error.name,
        stage: ocrStage,
        seconds
      });
      
      return fail(504,
        `OCR timeout: ${error.name}; stage: ${ocrStage}; elapsed: ${seconds}s.`
      );
    }
    
    if (['InvalidRequestError', 'JobFailedError'].includes(error.name)) {
      return fail(422, 'This image could not be processed. Try a clearer JPG or PNG image.');
    }
    
    return fail(502, 'The OCR service is unavailable. Please try again later.');
  } finally {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
};
