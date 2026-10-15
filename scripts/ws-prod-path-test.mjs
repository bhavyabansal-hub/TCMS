// Production default-path connect test (verifies WS_SOCKET_PATH production
// default '/socket.io/'). Run while a TCMS_DEPLOY_ENV=production instance
// with NO WS_SOCKET_PATH set is listening on :3999 (the production key is
// TCMS_DEPLOY_ENV since task startup-guard-1 — a plain `bun index.ts` sets
// no NODE_ENV, so the old NODE_ENV key never fired on a real server):
//   cd mini-services/notifications && \
//   TCMS_DEPLOY_ENV=production WS_PORT=3999 NOTIFY_PORT=3998 \
//   WS_CORS_ORIGIN=https://tcms.example.com bun index.ts &
//   node scripts/ws-prod-path-test.mjs
import { io } from 'socket.io-client'

const BASE = 'http://127.0.0.1:3999'

function tryPath(path, ms = 2500) {
  return new Promise((resolve) => {
    const s = io(BASE, { path, transports: ['websocket'], reconnection: false, timeout: ms })
    let done = false
    const finish = (r) => { if (!done) { done = true; s.disconnect(); resolve(r) } }
    s.on('connect', () => finish(`CONNECTED   on path '${path}'`))
    s.on('connect_error', (e) => finish(`REJECTED    on path '${path}' — ${String(e).slice(0, 70)}`))
    setTimeout(() => finish(`TIMEOUT     on path '${path}'`), ms)
  })
}

console.log(await tryPath('/socket.io/')) // expect CONNECTED — production default
console.log(await tryPath('/'))           // expect REJECTED — gateway path no longer served
