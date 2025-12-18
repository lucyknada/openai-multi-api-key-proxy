# Multi API Key OpenAI Endpoint Proxy

A dockerized proxy server that allows to have api keys multiplexing

## Features

- Validates incoming API keys against `allowed_api_keys.txt`
- Automatically reloads the allowed keys file when it changes (no restart needed)
- Proxies both streaming and non-streaming requests
- Supports all OpenAI API endpoints

## Setup

1. Copy and edit .env.example
2. Add allowed API keys to `allowed_api_keys.txt` (one per line)
3. Start the proxy:
   ```bash
   docker-compose up -d
   ```

## Adding New API Keys

Simply edit `allowed_api_keys.txt` and add a new line with the API key. The proxy will automatically detect the change. No restart needed.

## Health Check

Check the proxy status:
```bash
curl http://localhost:8080/health
```

(or whatever port you have it running on)

Returns:
```json
{
  "ok": true
}
```

