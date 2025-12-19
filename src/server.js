'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://localhost:8000';
const ALLOWED_KEYS_FILE = process.env.ALLOWED_KEYS_FILE || '/app/allowed_api_keys.txt';
const DEFAULT_TIMEOUT_MS = process.env.DEFAULT_TIMEOUT_MS ? Number(process.env.DEFAULT_TIMEOUT_MS) : 600000;
const VERBOSE = process.env.VERBOSE === 'true';
const LOG_FILE = process.env.LOG_FILE || '/app/logs/logs.jsonl';

function writeLog(entry) {
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

function isKeyAllowed(key) {
  try {
    if (!fs.existsSync(ALLOWED_KEYS_FILE)) {
      return false;
    }

    const content = fs.readFileSync(ALLOWED_KEYS_FILE, 'utf8');
    const keys = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    return keys.includes(key);
  } catch (err) {
    console.error(`Error reading allowed keys file: ${err.message}`);
    return false;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

function chooseHttpModule(urlString) {
  const isHttps = urlString.startsWith('https://');
  return isHttps ? https : http;
}

function handleProxy(pathname) {
  return async (req, res) => {
    const timestamp = new Date().toISOString();
    const requestStartTime = Date.now();
    let apiKey = null;

    try {
      const authorization = req.headers['authorization'];
      if (!authorization) {
        res.status(401).json({ error: { message: 'Missing authorization header', type: 'invalid_request_error' } });
        return;
      }

      const authMatch = authorization.match(/^Bearer\s+(.+)$/i);
      if (!authMatch) {
        res.status(401).json({ error: { message: 'Invalid authorization header format', type: 'invalid_request_error' } });
        return;
      }

      const providedKey = authMatch[1].trim();
      apiKey = providedKey;

      if (!isKeyAllowed(providedKey)) {
        if (VERBOSE) {
          console.log(`API key validation failed for key: ${providedKey.substring(0, 10)}...`);
        }
        res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
        return;
      }

      const upstreamUrl = `${OPENAI_BASE_URL}${pathname}`;
      if (VERBOSE) {
        console.log(`Proxying request to: ${upstreamUrl}`);
      }
      const httpModule = chooseHttpModule(upstreamUrl);
      const urlObj = new URL(upstreamUrl);

      const clientAccept = typeof req.headers['accept'] === 'string' ? req.headers['accept'] : undefined;
      const wantsStream = Boolean(req.body && typeof req.body === 'object' && req.body.stream === true);

      let clientAborted = false;
      const isGetRequest = req.method === 'GET' || req.method === 'HEAD';
      const body = isGetRequest ? null : JSON.stringify(req.body || {});

      let usage = null;
      let buffer = '';
      let isStreaming = false;

      const upstreamHeaders = {
        'accept': wantsStream ? 'text/event-stream' : (clientAccept || 'application/json'),
        'authorization': `Bearer ${OPENAI_API_KEY}`,
        'accept-encoding': 'identity',
        'user-agent': req.headers['user-agent'] || 'openai-proxy'
      };

      if (!isGetRequest && req.headers['content-type']) {
        upstreamHeaders['content-type'] = req.headers['content-type'];
      } else if (!isGetRequest) {
        upstreamHeaders['content-type'] = 'application/json';
      }

      const upstreamReq = httpModule.request(
        {
          protocol: urlObj.protocol,
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: urlObj.pathname + urlObj.search,
          headers: upstreamHeaders,
          timeout: DEFAULT_TIMEOUT_MS
        },
        (upstreamRes) => {
          if (clientAborted) {
            upstreamRes.destroy();
            return;
          }

          res.status(upstreamRes.statusCode || 502);
          Object.entries(upstreamRes.headers).forEach(([key, value]) => {
            if (typeof value !== 'undefined' && key.toLowerCase() !== 'content-encoding') {
              res.setHeader(key, value);
            }
          });

          const contentType = (upstreamRes.headers['content-type'] || '').toString();
          if (contentType.includes('text/event-stream')) {
            isStreaming = true;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache, no-transform');
            res.setHeader('connection', 'keep-alive');
          }

          function logMetrics() {
            if (usage) {
              const requestSeconds = (Date.now() - requestStartTime) / 1000;
              const tokensPerSecond = usage.completion_tokens && requestSeconds > 0
                ? Math.round((usage.completion_tokens / requestSeconds) * 100) / 100
                : null;
              const logEntry = {
                apikey: apiKey || null,
                timestamp: timestamp,
                request_seconds: requestSeconds,
                tokens_per_second: tokensPerSecond,
                usage: usage
              };
              writeLog(logEntry);
            }
          }

          if (isStreaming) {
            function processChunkForLogging(chunk) {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const dataStr = line.slice(6);
                  if (dataStr === '[DONE]') continue;
                  try {
                    const data = JSON.parse(dataStr);
                    if (data.usage) {
                      usage = data.usage;
                    }
                  } catch (e) {
                  }
                }
              }
            }

            upstreamRes.on('data', (chunk) => {
              if (!clientAborted) {
                processChunkForLogging(chunk);
                res.write(chunk);
              }
            });

            upstreamRes.on('end', () => {
              if (!clientAborted) {
                if (buffer) {
                  const remainingLines = buffer.split('\n');
                  for (const line of remainingLines) {
                    if (line.startsWith('data: ')) {
                      const dataStr = line.slice(6);
                      if (dataStr === '[DONE]') continue;
                      try {
                        const data = JSON.parse(dataStr);
                        if (data.usage) {
                          usage = data.usage;
                        }
                      } catch (e) {
                      }
                    }
                  }
                }
                logMetrics();
                res.end();
              }
            });
          } else {
            let responseBody = '';
            upstreamRes.on('data', (chunk) => {
              if (!clientAborted) {
                res.write(chunk);
                responseBody += chunk.toString();
              }
            });

            upstreamRes.on('end', () => {
              if (!clientAborted) {
                res.end();
                try {
                  const parsed = JSON.parse(responseBody);
                  if (parsed.usage) {
                    usage = parsed.usage;
                    logMetrics();
                  }
                } catch (e) {
                }
              }
            });
          }

          upstreamRes.on('error', (err) => {
            if (clientAborted) return;
            console.error(`Upstream response error: ${err.message}`);
            const payload = {
              error: {
                message: err.message || 'Upstream response error',
                type: 'server_error'
              }
            };
            if (contentType.includes('text/event-stream')) {
              res.write(`event: error\n`);
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }
            res.end();
          });
        }
      );

      upstreamReq.on('timeout', () => {
        console.error('Upstream request timeout');
        upstreamReq.destroy(new Error('upstream-timeout'));
      });

      upstreamReq.on('error', (err) => {
        if (clientAborted) return;
        console.error(`Upstream request error: ${err.message} (code: ${err.code})`);
        const payload = {
          error: {
            message: err.message || 'Upstream request error',
            type: 'server_error'
          }
        };
        if (!res.headersSent) {
          res.status(502).json(payload);
        } else {
          if (res.getHeader('content-type')?.includes('text/event-stream')) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
          res.end();
        }
      });

      req.on('aborted', () => {
        clientAborted = true;
        try {
          if (!upstreamReq.destroyed) {
            upstreamReq.destroy();
          }
        } catch { }
      });

      if (body) {
        upstreamReq.end(body);
      } else {
        upstreamReq.end();
      }
    } catch (err) {
      res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Internal server error', type: 'server_error' } });
    }
  };
}

app.use('*', (req, res) => {
  handleProxy(req.originalUrl)(req, res);
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI proxy listening on :${PORT}`);
  console.log(`OpenAI base URL: ${OPENAI_BASE_URL}`);
});