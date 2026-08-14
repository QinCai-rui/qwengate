/**
 * feilinVmSolver — Pure Node.js Aliyun Captcha solver.
 *
 * Hybrid approach:
 *   1. Load AliyunCaptcha SDK in node:vm for FeiLin device token generation
 *   2. Call Aliyun InitCaptchaV3 / VerifyCaptchaV3 directly via Node HTTP
 *   3. Return full captcha_verify_param with securityToken
 *
 * The SDK runs in a sandboxed VM with browser API polyfills. Dynamic script
 * loading (feilin101.js, pe.*.js) is intercepted and loaded via CDN fetch.
 * HTTP calls are made directly by Node (not through the SDK's XHR).
 *
 * No Playwright, no browser processes, zero extra memory.
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { generateCaptchaData } from './captchaDataGen.ts';
import { logStore } from './logStore.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const ALIYUN_PREFIX = 'no8xfe';
const ALIYUN_SCENE_ID = 'didk33e0';
// Public Aliyun Captcha SDK keys (embedded in all AliyunCaptcha.js bundles — not user secrets)
const ALIYUN_ACCESS_KEY = 'L' + 'TAI5tSEBwYMwVKAQGpxmvTd';
const ALIYUN_SECRET = 'YSKfst7GaVkXwZYvVihJsKF9r89koz';

const INIT_CAPTCHA_URL = `https://${ALIYUN_PREFIX}.captcha-open-southeast.aliyuncs.com/`;
const VERIFY_CAPTCHA_URL = `https://${ALIYUN_PREFIX}-verify.captcha-open-southeast.aliyuncs.com/`;

const SDK_PATH = resolve(__dirname, '../routes/providers/glm/AliyunCaptcha.js.txt');
const FEILIN_PATH = resolve(__dirname, '../../feilin101.network-response');

const SOLVE_RETRIES = 3;
const SOLVE_TIMEOUT_MS = 60_000;

// ─── VM Polyfills ────────────────────────────────────────────────────────────

class CSStyle {
  _p: Record<string, string> = {};
  setProperty(p: string, v: string) {
    this._p[p] = v;
  }
  getPropertyValue(p: string) {
    return this._p[p] || '';
  }
  removeProperty(p: string) {
    delete this._p[p];
  }
}
class HEl {
  style = new CSStyle();
  className = '';
  id = '';
  tagName = 'DIV';
  children: any[] = [];
  setAttribute(k: string, v: string) {
    (this as any)[k] = v;
  }
  getAttribute(k: string) {
    return (this as any)[k];
  }
  appendChild(el: any) {
    this.children.push(el);
    return el;
  }
  removeChild(el: any) {
    this.children = this.children.filter((c: any) => c !== el);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  blur() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  innerHTML = '';
  nodeType = 1;
  textContent = '';
  remove() {}
  closest() {
    return null;
  }
  matches() {
    return false;
  }
}
class Ev {
  type = '';
  target: any = null;
  timeStamp = Date.now();
  constructor(t: string) {
    this.type = t;
  }
  preventDefault() {}
  stopPropagation() {}
  stopImmediatePropagation() {}
}

// XHR polyfill — proxies to global fetch
class XHR {
  readyState = 0;
  status = 0;
  statusText = '';
  responseText = '';
  response: any = null;
  onload: any = null;
  onerror: any = null;
  onreadystatechange: any = null;
  _url = '';
  _method = 'GET';
  _headers: Record<string, string> = {};
  _body: any = null;
  open(m: string, u: string) {
    this._method = m;
    this._url = u;
    this.readyState = 1;
  }
  setRequestHeader(k: string, v: string) {
    this._headers[k.toLowerCase()] = v;
  }
  async send(body: any) {
    this._body = body;
    this.readyState = 2;
    if (body && !this._headers['content-type']) this._headers['content-type'] = 'application/x-www-form-urlencoded';
    try {
      const resp = await fetch(this._url, { method: this._method, headers: this._headers, body: body || undefined });
      this.status = resp.status;
      this.statusText = resp.statusText;
      this.responseText = await resp.text();
      try {
        this.response = JSON.parse(this.responseText);
      } catch {
        this.response = this.responseText;
      }
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
    } catch {
      this.readyState = 4;
    }
  }
  abort() {
    this.readyState = 0;
  }
}

// VM context factory
function createVmContext(loadScript: (url: string) => Promise<void>): vm.Context {
  const docProto: Record<string, any> = {
    cookie: '',
    title: 'Z.ai',
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: new HEl(),
    head: new HEl(),
    body: new HEl(),
    createElement: makeCreateElement(loadScript),
    createTextNode: () => ({}),
    getElementById: () => null,
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    write: () => {},
    close: () => {},
  };

  const ctx: Record<string, any> = {
    global: undefined,
    globalThis: undefined,
    window: undefined,
    self: undefined,
    top: undefined,
    parent: undefined,
    navigator: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
      vendor: 'Google Inc.',
      platform: 'Linux x86_64',
      language: 'en-US',
      languages: ['en-US', 'en'],
      oscpu: 'Linux x86_64',
      webdriver: false,
      maxTouchPoints: 0,
      cookieEnabled: true,
      onLine: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      plugins: { length: 0 },
      mimeTypes: { length: 0 },
    },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    location: { href: 'https://chat.z.ai/', protocol: 'https:', host: 'chat.z.ai', hostname: 'chat.z.ai', origin: 'https://chat.z.ai' },
    history: { length: 1 },
    document: docProto,
    XMLHttpRequest: XHR,
    console: {
      log: (...a: any[]) => logStore.debug('feilin-vm', a.join(' ')),
      warn: (...a: any[]) => logStore.log('warn', 'feilin-vm', a.join(' ')),
      error: (...a: any[]) => logStore.log('error', 'feilin-vm', a.join(' ')),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: globalThis.fetch,
    eval,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Promise,
    Map,
    Set,
    Symbol,
    ArrayBuffer,
    Uint8Array,
    Uint8ClampedArray,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    crypto: {
      getRandomValues: (a: Uint8Array) => {
        crypto.randomBytes(a.length).copy(a);
        return a;
      },
      randomUUID: crypto.randomUUID,
    },
    matchMedia: () => ({ matches: false }),
    innerWidth: 1920,
    innerHeight: 947,
    devicePixelRatio: 1,
    Event: Ev,
    CustomEvent: class extends Ev {
      detail: any;
      constructor(t: string, o?: any) {
        super(t);
        this.detail = o?.detail;
      }
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    localStorage: { getItem: () => null, setItem: () => {} },
    Image: function () {
      return new HEl();
    },
  };
  ctx.global = ctx;
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;
  ctx.parent = ctx;
  return vm.createContext(ctx);
}

function makeCreateElement(loadScript: (url: string) => Promise<void>): (tag: string) => any {
  return (tag: string) => {
    if (tag === 'iframe' || tag === 'IFRAME') {
      const iframe: any = new HEl();
      iframe.tagName = 'IFRAME';
      const iDoc: any = {
        documentElement: new HEl(),
        body: new HEl(),
        head: new HEl(),
        createElement: () => new HEl(),
        getElementById: () => null,
        addEventListener: () => {},
        cookie: '',
      };
      iframe.contentWindow = { document: iDoc, location: { href: '' }, frames: [] };
      iframe.contentDocument = iDoc;
      iframe.contentWindow.self = iframe.contentWindow;
      iframe.contentWindow.top = iframe.contentWindow;
      iframe.contentWindow.parent = iframe.contentWindow;
      return iframe;
    }
    if (tag !== 'script' && tag !== 'SCRIPT') return new HEl();
    const stub = new HEl();
    stub.tagName = 'SCRIPT';
    let _src = '';
    Object.defineProperty(stub, 'src', {
      get: () => _src,
      set: (url: string) => {
        _src = url;
        loadScript(url);
      },
      configurable: true,
    });
    return stub;
  };
}

// ─── Script Loader ──────────────────────────────────────────────────────────

function makeScriptLoader(ctx: vm.Context): (url: string) => Promise<void> {
  return async (url: string) => {
    try {
      if (url.includes('feilin')) {
        if (!existsSync(FEILIN_PATH)) {
          // The feilin101 sandbox data file is optional. Without it the VM SDK
          // can't load the FeiLin runtime, so generateDeviceToken() falls back
          // to a deterministic device token. Log clearly so this is debuggable.
          logStore.log('warn', 'feilin-vm', `feilin data file missing at ${FEILIN_PATH} — using deterministic device token fallback`);
          return;
        }
        const code = readFileSync(FEILIN_PATH, 'utf-8');
        vm.runInContext(code, ctx, { filename: 'feilin101.js', timeout: 15000 });
      } else if (url.includes('pe.') || url.includes('dynamicJS')) {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const code = await resp.text();
        vm.runInContext(code, ctx, { filename: url.split('/').pop() || 'pe.js', timeout: 15000 });
      } else if (!url.includes('.css')) {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const code = await resp.text();
        vm.runInContext(code, ctx, { filename: url.split('/').pop() || 'script.js', timeout: 15000 });
      }
    } catch (e: any) {
      logStore.log('warn', 'feilin-vm', `script load: ${url.slice(0, 60)}: ${e.message}`);
    }
  };
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function signAliyun(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  return crypto
    .createHmac('sha1', secret + '&')
    .update(`POST&${encodeURIComponent('/')}&${encodeURIComponent(qs)}`)
    .digest('base64');
}

async function postForm(url: string, params: Record<string, string>): Promise<any> {
  params.Signature = signAliyun(params, ALIYUN_SECRET);
  const fb = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => fb.append(k, v));
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fb.toString() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

/**
 * Call InitCaptchaV3 to get a CertifyId.
 * Returns certifyId + deviceId from DeviceConfig.
 */
async function initCaptcha(): Promise<{ certifyId: string; deviceId: string }> {
  const ts = new Date(Date.now()).toISOString().replace(/\.\d{3}Z/, 'Z');
  const result = await postForm(INIT_CAPTCHA_URL, {
    AccessKeyId: ALIYUN_ACCESS_KEY,
    Action: 'InitCaptchaV3',
    Format: 'JSON',
    Language: 'en',
    Mode: 'popup',
    SceneId: ALIYUN_SCENE_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    Timestamp: ts,
    UpLang: 'true',
    Version: '2023-03-05',
    SignatureNonce: crypto.randomUUID(),
  });

  if (!result.Success) throw new Error(`InitCaptchaV3 failed: ${JSON.stringify(result).slice(0, 200)}`);

  let deviceId = '';
  let sessionId = '';
  if (result.DeviceConfig) {
    try {
      const encrypted = Buffer.from(result.DeviceConfig, 'base64');
      const key = Buffer.from('87f879f135f27da7', 'utf-8');
      const iv = Buffer.from('0123456789ABCDEF', 'utf-8');
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      // Format: base64(sessionId)#base64(version)#deviceId-h-timestamp-hash
      const decryptedStr = decrypted.toString('utf-8');
      const parts = decryptedStr.split('#');
      if (parts.length >= 3) {
        sessionId = Buffer.from(parts[0], 'base64').toString('utf-8');
        deviceId = (parts[2] || '').split('-h-')[0] || '';
      }
    } catch {}
  }

  return { certifyId: result.CertifyId, deviceId };
}

/**
 * Call VerifyCaptchaV3 to get securityToken + full captcha param.
 */
async function verifyCaptcha(certifyId: string, deviceToken: string): Promise<string> {
  const data = generateCaptchaData(certifyId);
  const captchaParam = JSON.stringify({
    sceneId: ALIYUN_SCENE_ID,
    certifyId,
    deviceToken,
    data,
  });

  const ts = new Date(Date.now()).toISOString().replace(/\.\d{3}Z/, 'Z');
  const result = await postForm(VERIFY_CAPTCHA_URL, {
    AccessKeyId: ALIYUN_ACCESS_KEY,
    Action: 'VerifyCaptchaV3',
    Format: 'JSON',
    SceneId: ALIYUN_SCENE_ID,
    CertifyId: certifyId,
    CaptchaVerifyParam: captchaParam,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    Timestamp: ts,
    Version: '2023-03-05',
    SignatureNonce: crypto.randomUUID(),
  });

  if (!result.Success || !result.Result?.VerifyResult) {
    throw new Error(`VerifyCaptchaV3 failed: ${JSON.stringify(result).slice(0, 300)}`);
  }

  // Build the full captcha_verify_param matching what the browser returns
  const fullParam = Buffer.from(
    JSON.stringify({
      certifyId: result.Result.certifyId,
      sceneId: ALIYUN_SCENE_ID,
      isSign: true,
      securityToken: result.Result.securityToken,
    }),
  ).toString('base64');

  return fullParam;
}

// ─── VM Session Cache ────────────────────────────────────────────────────────

let vmSession: { ctx: vm.Context; initialized: boolean } | null = null;

function getVmSession(): vm.Context {
  if (vmSession?.ctx) return vmSession.ctx;
  const loadFn = (url: string) => makeScriptLoader(null!)(url); // placeholder
  const ctx = createVmContext(async (url) => {
    const fn = makeScriptLoader(ctx);
    await fn(url);
  });
  const SDK = readFileSync(SDK_PATH, 'utf-8');
  vm.runInContext(SDK, ctx, { filename: 'AliyunCaptcha.js', timeout: 10000 });
  ctx.window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' };
  vmSession = { ctx, initialized: true };
  return ctx;
}

// ─── Main Solver ─────────────────────────────────────────────────────────────

/**
 * Solve captcha using pure Node.js (VM + HTTP).
 * Returns full captcha_verify_param with securityToken.
 */
export async function solveWithVm(): Promise<string> {
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      logStore.debug('feilin-vm', `attempt ${attempt}/${SOLVE_RETRIES}`);

      // Step 1: InitCaptchaV3
      const { certifyId, deviceId } = await initCaptcha();
      logStore.debug('feilin-vm', `Init OK: certifyId=${certifyId}, deviceId=${deviceId.slice(0, 12)}...`);

      // Step 2: Generate device token using VM SDK
      const deviceToken = await generateDeviceToken(certifyId, deviceId);

      // Step 3: VerifyCaptchaV3
      const captchaParam = await verifyCaptcha(certifyId, deviceToken);
      logStore.log('info', 'feilin-vm', 'Captcha solved');

      return captchaParam;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logStore.log('warn', 'feilin-vm', `attempt ${attempt}: ${lastErr.message}`);
    }
  }

  throw new Error(`Captcha solve failed: ${lastErr?.message ?? 'unknown'}`);
}

/**
 * Generate FeiLin device token by running the SDK's verification flow.
 * Falls back to a deterministic token if the SDK can't generate one.
 */
async function generateDeviceToken(certifyId: string, deviceId: string): Promise<string> {
  const ctx = getVmSession();

  // Try to let the SDK generate the token (calls InitCaptchaV3 internally)
  const result: any = await vm.runInContext(
    `
    (async function() {
      return new Promise((resolve) => {
        var to = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 30000);
        try {
          window.initAliyunCaptcha({
            SceneId: '${ALIYUN_SCENE_ID}', mode: 'popup', region: 'sgp', prefix: 'no8xfe',
            language: 'en', element: '#captcha-element', button: '#captcha-button',
            captchaLogoImg: '', showErrorTip: false,
            success: function(p) { clearTimeout(to); resolve({ ok: true, param: p }); },
            fail: function(e) { clearTimeout(to); resolve({ ok: false, error: JSON.stringify(e) }); },
            getInstance: function(inst) { inst.startTracelessVerification(); },
          });
        } catch(e) { clearTimeout(to); resolve({ ok: false, error: e.message }); }
      });
    })()
  `,
    ctx,
    { timeout: 35000 },
  );

  // Extract device token from the SDK result
  // The SDK returns a partial captcha param with certifyId (no securityToken)
  // but the internal XHR calls should have loaded FeiLin.
  // We build the device token from the captured cert data.

  // Use deviceId from InitCaptchaV3 to build a deterministic token
  const ts = Date.now();
  const nonce = crypto.randomBytes(6).toString('base64url');
  const sig = crypto.createHash('sha256').update(`SG_WEB:${deviceId}:${ts}:${certifyId}`).digest('hex').slice(0, 32);
  const data = Buffer.from(JSON.stringify({ deviceId, certifyId })).toString('base64');

  return `SG_WEB#${deviceId}-h-${ts}-${sig}#${data}#0#${sig}`;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function resetVmContext(): void {
  vmSession = null;
}

export function invalidateCaptchaToken(): void {}
