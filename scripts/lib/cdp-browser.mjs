// Headless Chrome over the DevTools protocol for the UI test suites — no new dependency
// (Node's global WebSocket). Extracted (copied) from scripts/verify-ui-gates.mjs, which keeps
// its own inline copy unchanged.
//
// Contract:
//   - launchChrome(profileDir): own --user-data-dir (never the owner's profile), random
//     debugging port read from DevToolsActivePort.
//   - RolePage.open(cdp, { cookies, user }, base): one isolated browser context per session,
//     session cookies injected with Network.setCookie AND the `tcms-user` localStorage display
//     profile seeded before any app script runs (without it the AuthGate lands on /login,
//     src/store/index.ts initialize).
//   - shutdownChrome(cdp, child, profileDir): Browser.close, then taskkill /PID <spawned pid> /T /F
//     (never by image name), proves no chrome.exe command line still holds the profile, deletes it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Parses one Set-Cookie header into a CDP cookie spec. */
export function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim())
  const eq = pair.indexOf('=')
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/', httpOnly: false }
  for (const a of attrs) {
    const [k, v] = a.split('=')
    if (k.toLowerCase() === 'path') cookie.path = v
    if (k.toLowerCase() === 'httponly') cookie.httpOnly = true
  }
  return cookie
}

/** Minimal CDP client (flattened sessions). */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    this.closed = false
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message}`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }
  on(fn) {
    this.listeners.push(fn)
  }
  off(fn) {
    this.listeners = this.listeners.filter((l) => l !== fn)
  }
  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

/** One isolated tab (own browser context) with network capture. */
export class RolePage {
  static async open(cdp, { cookies, user }, base, { readyTimeoutMs = 90_000 } = {}) {
    const page = new RolePage()
    page.cdp = cdp
    page.base = base
    page.readyTimeoutMs = readyTimeoutMs
    page.requests = []
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
    page.contextId = browserContextId
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    page.sessionId = sessionId
    page.listener = (msg) => {
      if (msg.sessionId !== sessionId) return
      // t0 / t1 (ms, monotonic) let suites measure parallelism and network idle.
      if (msg.method === 'Network.requestWillBeSent') {
        page.requests.push({ id: msg.params.requestId, url: msg.params.request.url, method: msg.params.request.method, status: null, t0: msg.params.timestamp * 1000, t1: null })
      } else if (msg.method === 'Network.responseReceived') {
        for (const r of page.requests) if (r.id === msg.params.requestId) r.status = msg.params.response.status
      } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
        for (const r of page.requests) if (r.id === msg.params.requestId) r.t1 = msg.params.timestamp * 1000
      }
    }
    cdp.on(page.listener)
    await page.send('Network.enable')
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const c of cookies) {
      await page.send('Network.setCookie', { name: c.name, value: c.value, url: base, path: c.path, httpOnly: c.httpOnly, sameSite: 'Lax' })
    }
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('tcms-user', ${JSON.stringify(JSON.stringify(user))}) } catch {}`,
    })
    return page
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId)
  }
  /** Evaluates a self-contained function in the page with JSON-serializable args. */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.text}`)
    return res.result.value
  }
  async goto(urlPath) {
    const mark = this.requests.length
    await this.send('Page.navigate', { url: `${this.base}${urlPath}` })
    return mark
  }
  async reload() {
    const mark = this.requests.length
    await this.send('Page.reload', { ignoreCache: true })
    return mark
  }
  /** Polls `fn(...args)` until it returns { ready: true }; returns the last state. */
  async waitFor(fn, args = [], timeout = this.readyTimeoutMs) {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end) {
      if (this.cdp.closed) throw new Error('CDP socket closed')
      try {
        last = await this.evaluate(fn, ...args)
        if (last && last.ready) return last
      } catch (err) {
        if (this.cdp.closed) throw err
      }
      await sleep(400)
    }
    return last ?? { ready: false }
  }
  /** Real mouse click (mousePressed/Released) at the centre of the element found by `locate`.
   *  `locate` runs in the page, must scroll the element into view and return {x,y} or null. */
  async clickAt(locate, ...args) {
    const pt = await this.evaluate(locate, ...args)
    if (!pt) return false
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    return true
  }
  since(mark) {
    return this.requests.slice(mark)
  }
  async close() {
    this.cdp.off(this.listener)
    await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {})
  }
}

/** Starts headless Chrome with its own profile dir. Returns { child, wsUrl|null }.
 *  extraArgs (optional, added for tester 2): extra command-line flags, e.g. memory limits. */
export async function launchChrome(profileDir, chromePath = DEFAULT_CHROME, extraArgs = []) {
  mkdirSync(profileDir, { recursive: true })
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', ...extraArgs, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    if (existsSync(portFile)) {
      let text = ''
      try {
        text = readFileSync(portFile, 'utf8')
      } catch (e) {
        // Windows: Chrome may still hold the file open while writing it (EBUSY) — retry.
        if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e
      }
      const [port, wsPath] = text.split(/\r?\n/)
      if (port && wsPath) return { child, wsUrl: `ws://127.0.0.1:${port}${wsPath}` }
    }
    await sleep(250)
  }
  return { child, wsUrl: null }
}

function chromeProcessesWithProfile(profileDir) {
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }",
  ], { encoding: 'utf8', windowsHide: true })
  return (ps.stdout || '').split(/\r?\n/).filter((l) => l.includes(profileDir))
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Closes Chrome, kills only the spawned pid tree, removes the profile.
 *  Returns { processGone, leftovers, profileRemoved }. */
export async function shutdownChrome(cdp, child, profileDir) {
  if (cdp && !cdp.closed) {
    await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(3000)])
  }
  cdp?.close()
  if (child?.pid) {
    await sleep(1000)
    if (isAlive(child.pid)) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  await sleep(1000)
  const leftovers = chromeProcessesWithProfile(profileDir)
  let profileRemoved = false
  for (let i = 0; i < 10 && !profileRemoved; i++) {
    try { rmSync(profileDir, { recursive: true, force: true }); profileRemoved = !existsSync(profileDir) } catch { await sleep(500) }
  }
  return { processGone: !(child?.pid && isAlive(child.pid)) && leftovers.length === 0, leftovers: leftovers.length, profileRemoved }
}
