/**
 * liveView.js
 *
 * Gives a real person a real, interactive window into the actual browser
 * this actor is driving, using the same idea Apify's own container web
 * server is built for: a small server inside the running actor, reachable
 * through the run's own container URL, streaming what the browser sees and
 * accepting real mouse and keyboard input back.
 *
 * Under the hood this talks to Chrome directly through the Chrome DevTools
 * Protocol, the same protocol Playwright itself is built on. Page.startScreencast
 * streams a live picture of the page as a sequence of JPEG frames.
 * Input.dispatchMouseEvent and Input.dispatchKeyEvent take a real click or a
 * real keystroke and inject it into the page exactly as if a person were
 * sitting at that browser, which is exactly what a person is doing at that
 * moment.
 *
 * This exists for one purpose: when the actor lands on a page that requires
 * an actual human being to click through a verification step, this hands
 * that step to an actual human being, live, rather than trying to automate
 * around it. Nothing here scripts or solves the check itself.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { log } from 'crawlee';

let serverStarted = false;
let wss = null;
let activeSocket = null;
let activeCdpSession = null;

function pageHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Solve the check, then leave this tab open</title>
<style>
  body { margin: 0; background: #111; color: #eee; font-family: sans-serif; }
  #bar { padding: 10px 16px; background: #1b1b1b; border-bottom: 1px solid #333; }
  #wrap { display: flex; justify-content: center; padding: 16px; }
  canvas { border: 1px solid #333; cursor: default; max-width: 100%; height: auto; }
  #status { color: #9ad; }
</style>
</head>
<body>
<div id="bar">Solve whatever check is shown below the normal way you always would. The actor is waiting and will continue automatically the moment it clears. <span id="status">connecting...</span></div>
<div id="wrap"><canvas id="c" width="1280" height="800"></canvas></div>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const status = document.getElementById('status');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  ws.onopen = () => { status.textContent = 'connected, waiting for the page'; };
  ws.onclose = () => { status.textContent = 'disconnected, refresh once the run is still active'; };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'frame') {
      img.src = 'data:image/jpeg;base64,' + msg.data;
      status.textContent = 'live';
    }
    if (msg.type === 'cleared') {
      status.textContent = 'check cleared, the actor is continuing on its own now';
    }
  };

  function scaled(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (canvas.height / rect.height)),
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    const p = scaled(e);
    ws.send(JSON.stringify({ type: 'mouse', kind: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }));
  });
  canvas.addEventListener('mouseup', (e) => {
    const p = scaled(e);
    ws.send(JSON.stringify({ type: 'mouse', kind: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }));
  });
  canvas.addEventListener('mousemove', (e) => {
    const p = scaled(e);
    ws.send(JSON.stringify({ type: 'mouse', kind: 'mouseMoved', x: p.x, y: p.y, button: 'none' }));
  });
  window.addEventListener('keydown', (e) => {
    ws.send(JSON.stringify({ type: 'key', kind: 'keyDown', key: e.key, code: e.code }));
  });
  window.addEventListener('keyup', (e) => {
    ws.send(JSON.stringify({ type: 'key', kind: 'keyUp', key: e.key, code: e.code }));
  });
</script>
</body>
</html>`;
}

function ensureServerStarted() {
    if (serverStarted) return;
    serverStarted = true;

    const app = express();
    app.get('/', (req, res) => res.send(pageHtml()));

    const server = http.createServer(app);
    wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (socket) => {
        activeSocket = socket;
        socket.on('message', (raw) => {
            handleClientMessage(raw).catch((error) => log.debug(`Live view input error: ${error.message}`));
        });
        socket.on('close', () => {
            if (activeSocket === socket) activeSocket = null;
        });
    });

    const port = process.env.ACTOR_WEB_SERVER_PORT || process.env.APIFY_CONTAINER_PORT || 4321;
    server.listen(port, () => {
        log.info(`Live view server ready. Open the run's container URL in a browser to use it.`);
    });
}

async function handleClientMessage(raw) {
    if (!activeCdpSession) return;
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'mouse') {
        await activeCdpSession.send('Input.dispatchMouseEvent', {
            type: msg.kind,
            x: msg.x,
            y: msg.y,
            button: msg.button,
            clickCount: msg.clickCount || 0,
        });
    }

    if (msg.type === 'key') {
        await activeCdpSession.send('Input.dispatchKeyEvent', {
            type: msg.kind,
            key: msg.key,
            code: msg.code,
            text: msg.kind === 'keyDown' && msg.key.length === 1 ? msg.key : undefined,
        });
    }
}

/**
 * Streams the given Playwright page live to whoever opens the container URL,
 * and waits until isCleared(page) returns true or the timeout is reached.
 *
 * isCleared is checked every couple of seconds. A sensible default checks
 * whether the page title has stopped looking like a Cloudflare challenge
 * page, but the caller can pass something more specific.
 */
export async function waitForHumanToClearChallenge(page, { reason = 'a verification check', timeoutMs = 15 * 60 * 1000, isCleared } = {}) {
    ensureServerStarted();

    const containerUrl = process.env.ACTOR_WEB_SERVER_URL || process.env.APIFY_CONTAINER_URL || 'the container URL for this run';
    log.warning(`Paused on ${reason}. Open ${containerUrl} in a real browser tab and solve what is shown there. Waiting up to ${Math.round(timeoutMs / 60000)} minutes.`);

    const cdpSession = await page.context().newCDPSession(page);
    activeCdpSession = cdpSession;

    cdpSession.on('Page.screencastFrame', async (frame) => {
        if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
            activeSocket.send(JSON.stringify({ type: 'frame', data: frame.data }));
        }
        await cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });

    await cdpSession.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800 });

    const defaultIsCleared = async () => {
        const title = await page.title().catch(() => '');
        return !/just a moment|checking your browser|attention required/i.test(title);
    };
    const check = isCleared || defaultIsCleared;

    const started = Date.now();
    let cleared = false;
    while (Date.now() - started < timeoutMs) {
        if (await check()) {
            cleared = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }

    await cdpSession.send('Page.stopScreencast').catch(() => undefined);
    activeCdpSession = null;

    if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'cleared' }));
    }

    if (!cleared) {
        throw new Error(`Nobody cleared ${reason} within ${Math.round(timeoutMs / 60000)} minutes.`);
    }

    log.info('Challenge cleared. Continuing automatically.');
}
