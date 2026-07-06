/**
 * Ai ClipMix — API Service Layer
 * Handles all AI API communications (Veo 3, Nano Banana 2)
 * 
 * Supported APIs:
 *   - Google Veo 3 (Image-to-Video)
 *   - Nano Banana 2 (Text-to-Image)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Config File Path (lazy, computed after app ready) ──
let _configDir, _configFile;
function getConfigDir() {
  if (!_configDir) _configDir = path.join(require('electron').app.getPath('userData'), 'config');
  return _configDir;
}
function getConfigFile() {
  if (!_configFile) _configFile = path.join(getConfigDir(), 'api-config.json');
  return _configFile;
}

// ── Default Configuration ──
const DEFAULT_CONFIG = {
  veo3: {
    enabled: false,
    apiKey: '',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'veo-3.0-generate-001',
    maxRetries: 3,
    timeout: 120000,
  },
  nanoBanana2: {
    enabled: false,
    apiKey: '',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'nano-banana-2',
    maxRetries: 3,
    timeout: 60000,
  },
  proxy: {
    enabled: false,
    host: '',
    port: '',
    protocol: 'http',
  },
  general: {
    concurrentRequests: 2,
    autoRetry: true,
    saveHistory: true,
    historyLimit: 100,
    outputDir: '',
  },
};

// ── Config Management ──
function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  const configFile = getConfigFile();
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config = deepMerge(DEFAULT_CONFIG, data);
    } catch { /* use defaults */ }
  }

  // Environment variable overrides
  if (process.env.VEO3_API_KEY) {
    config.veo3.apiKey = process.env.VEO3_API_KEY;
    config.veo3.enabled = true;
  }
  if (process.env.VEO3_ENDPOINT) config.veo3.endpoint = process.env.VEO3_ENDPOINT;
  if (process.env.VEO3_MODEL) config.veo3.model = process.env.VEO3_MODEL;
  if (process.env.NANO_BANANA_API_KEY) {
    config.nanoBanana2.apiKey = process.env.NANO_BANANA_API_KEY;
    config.nanoBanana2.enabled = true;
  }
  if (process.env.NANO_BANANA_ENDPOINT) config.nanoBanana2.endpoint = process.env.NANO_BANANA_ENDPOINT;
  if (process.env.NANO_BANANA_MODEL) config.nanoBanana2.model = process.env.NANO_BANANA_MODEL;
  if (process.env.PROXY_ENABLED === 'true') config.proxy.enabled = true;
  if (process.env.PROXY_HOST) config.proxy.host = process.env.PROXY_HOST;
  if (process.env.PROXY_PORT) config.proxy.port = process.env.PROXY_PORT;
  if (process.env.PROXY_PROTOCOL) config.proxy.protocol = process.env.PROXY_PROTOCOL;

  return config;
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf8');
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── HTTP Request Helper ──
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || 60000,
    };

    const config = loadConfig();
    if (config.proxy.enabled && config.proxy.host) {
      reqOpts.agent = new (require('https-proxy-agent'))(`${config.proxy.protocol}://${config.proxy.host}:${config.proxy.port}`);
    }

    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: json });
          } else {
            reject(new ApiError(
              json.error?.message || `HTTP ${res.statusCode}`,
              res.statusCode,
              json.error?.code || 'UNKNOWN'
            ));
          }
        } catch {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data });
          } else {
            reject(new ApiError(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`, res.statusCode, 'PARSE_ERROR'));
          }
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new ApiError('Request timed out', 0, 'TIMEOUT'));
    });
    req.on('error', (err) => {
      reject(new ApiError(err.message, 0, 'NETWORK_ERROR'));
    });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Custom Error Class ──
class ApiError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ── Retry Wrapper ──
async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 429 || err.code === 'RATE_LIMIT') {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        await new Promise(r => setTimeout(r, delay));
      } else if (err.statusCode >= 500 || err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') {
        const delay = 1000 * attempt;
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// ── Veo 3: Image-to-Video ──
async function generateVideo(params, onProgress) {
  const config = loadConfig();
  const { veo3 } = config;

  if (!veo3.enabled || !veo3.apiKey) {
    throw new ApiError('Veo 3 API not configured. Please set API key in Settings.', 0, 'NOT_CONFIGURED');
  }

  const { imagePath, endImagePath, prompt, negativePrompt, duration, resolution, fps, style, camera, motion, seed } = params;

  const imageData = fs.readFileSync(imagePath);
  const imageBase64 = imageData.toString('base64');
  const mimeType = imagePath.match(/\.png$/i) ? 'image/png' : 'image/jpeg';

  const requestBody = {
    model: veo3.model,
    contents: [{
      parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: prompt || 'Generate a smooth video from this image' },
      ],
    }],
    generationConfig: {
      videoDuration: `${duration || 5}s`,
      resolution: resolution || '720x1280',
      fps: fps || 24,
      seed: seed >= 0 ? seed : undefined,
    },
  };

  if (negativePrompt) {
    requestBody.negativePrompt = negativePrompt;
  }
  if (style && style !== 'auto') requestBody.generationConfig.style = style;
  if (camera && camera !== 'auto') requestBody.generationConfig.cameraMotion = camera;
  if (motion) requestBody.generationConfig.motionIntensity = motion;

  if (endImagePath && fs.existsSync(endImagePath)) {
    const endData = fs.readFileSync(endImagePath);
    const endBase64 = endData.toString('base64');
    const endMime = endImagePath.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
    requestBody.contents[0].parts.splice(1, 0, { inlineData: { mimeType: endMime, data: endBase64 } });
  }

  const url = `${veo3.endpoint}/models/${veo3.model}:generateContent?key=${veo3.apiKey}`;

  if (onProgress) onProgress({ stage: 'submitting', progress: 10 });

  const result = await withRetry(async () => {
    return await makeRequest(url, { method: 'POST', timeout: veo3.timeout }, requestBody);
  }, veo3.maxRetries);

  if (onProgress) onProgress({ stage: 'processing', progress: 50 });

  // Handle long-running operation (polling)
  if (result.data.name) {
    return await pollOperation(result.data.name, veo3.apiKey, veo3.endpoint, veo3.timeout, onProgress);
  }

  if (onProgress) onProgress({ stage: 'complete', progress: 100 });
  return result.data;
}

// ── Nano Banana 2: Text-to-Image ──
async function generateImage(params, onProgress) {
  const config = loadConfig();
  const { nanoBanana2 } = config;

  if (!nanoBanana2.enabled || !nanoBanana2.apiKey) {
    throw new ApiError('Nano Banana 2 API not configured. Please set API key in Settings.', 0, 'NOT_CONFIGURED');
  }

  const { prompt, negativePrompt, size, quality, style, count } = params;

  const requestBody = {
    model: nanoBanana2.model,
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      numberOfImages: count || 1,
      imageSize: size || '720x1280',
      quality: quality || 'hd',
    },
  };

  if (negativePrompt) requestBody.negativePrompt = negativePrompt;
  if (style && style !== 'auto') requestBody.generationConfig.style = style;

  const url = `${nanoBanana2.endpoint}/models/${nanoBanana2.model}:generateContent?key=${nanoBanana2.apiKey}`;

  if (onProgress) onProgress({ stage: 'submitting', progress: 10 });

  const result = await withRetry(async () => {
    return await makeRequest(url, { method: 'POST', timeout: nanoBanana2.timeout }, requestBody);
  }, nanoBanana2.maxRetries);

  if (result.data.name) {
    return await pollOperation(result.data.name, nanoBanana2.apiKey, nanoBanana2.endpoint, nanoBanana2.timeout, onProgress);
  }

  if (onProgress) onProgress({ stage: 'complete', progress: 100 });
  return result.data;
}

// ── Long-running Operation Polling ──
async function pollOperation(operationName, apiKey, endpoint, timeout, onProgress) {
  const pollUrl = `${endpoint}/operations/${operationName}?key=${apiKey}`;
  const startTime = Date.now();
  let progress = 50;

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 3000));
    progress = Math.min(95, progress + 5);
    if (onProgress) onProgress({ stage: 'processing', progress });

    const res = await makeRequest(pollUrl, { method: 'GET', timeout: 30000 });
    if (res.data.done) {
      if (onProgress) onProgress({ stage: 'complete', progress: 100 });
      if (res.data.error) {
        throw new ApiError(res.data.error.message || 'Generation failed', res.data.error.code, 'GENERATION_FAILED');
      }
      return res.data.response || res.data.result;
    }
  }

  throw new ApiError('Generation timed out', 0, 'TIMEOUT');
}

// ── Task Queue (for concurrent request limiting) ──
class TaskQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(fn) {
    if (this.running >= this.concurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

// ── Generation History ──
function getHistoryPath() {
  ensureConfigDir();
  return path.join(getConfigDir(), 'generation-history.json');
}

function loadHistory() {
  const fp = getHistoryPath();
  if (fs.existsSync(fp)) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
  }
  return [];
}

function addHistory(entry) {
  const config = loadConfig();
  if (!config.general.saveHistory) return;
  const history = loadHistory();
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > config.general.historyLimit) history.length = config.general.historyLimit;
  fs.writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2), 'utf8');
}

function clearHistory() {
  const fp = getHistoryPath();
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ── Exports ──
module.exports = {
  loadConfig,
  saveConfig,
  generateVideo,
  generateImage,
  ApiError,
  TaskQueue,
  loadHistory,
  addHistory,
  clearHistory,
  DEFAULT_CONFIG,
};
