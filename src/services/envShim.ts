/**
 * envShim — Browser environment shims for node:vm sandbox.
 *
 * Builds a fake browser global scope inside a node:vm Context that
 * passes fireyejs integrity checks. Inspired by sdenv + js-env patterns.
 *
 * Layers:
 *   1. Basic globals (window, document, navigator, screen, location)
 *   2. Storage (localStorage, sessionStorage)
 *   3. Performance + timing (performance.now with 100μs coarsening)
 *   4. Function.prototype.toString global Proxy (critical for nativeness)
 *   5. window.chrome (runtime, app, csi, loadTimes)
 *   6. navigator.plugins (PluginArray with MimeType circular refs)
 *   7. Canvas (toDataURL/getImageData proxy)
 *   8. WebGL (getParameter + method proxies)
 *   9. Math.random (seeded for reproducibility)
 */
import vm from 'node:vm';
import crypto from 'node:crypto';

// ─── Seeded PRNG (xoshiro128**) ──────────────────────────────────────────────

function createSeededRandom(seed: number): () => number {
  // ponytail: simple mulberry32, not crypto-secure. Fine for env shims.
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Function.prototype.toString Proxy ───────────────────────────────────────
// This is the ONLY way to pass Function.prototype.toString.call(fn) checks.
// Must be installed BEFORE fireyejs loads. Every shimmed function registered
// here will appear as native code when .toString() is called.

const patchedFunctions = new Map<Function, string>();
let fnToStringProxyInstalled = false;

type PatchedFunction = { (...args: unknown[]): unknown; __patchedName?: string };

function installFnToStringProxy(context: vm.Context): void {
  if (fnToStringProxyInstalled) return;
  fnToStringProxyInstalled = true;

  const origToString = Function.prototype.toString;
  Function.prototype.toString = new Proxy(origToString, {
    apply(target, thisArg, args) {
      const name = patchedFunctions.get(thisArg as Function);
      if (name) return `function ${name}() { [native code] }`;
      if (typeof thisArg === 'function') {
        const fnName = (thisArg as PatchedFunction).__patchedName || thisArg.name || '';
        if (patchedFunctions.has(thisArg)) {
          return `function ${fnName}() { [native code] }`;
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  }) as typeof Function.prototype.toString;
}

/**
 * Register a function as appearing "native" to toString checks.
 * Returns the same function. Compatible with both vanilla and Proxy-wrapped fns.
 */
function markNative<T extends Function>(fn: T, name: string): T {
  patchedFunctions.set(fn, name);
  (fn as unknown as PatchedFunction).__patchedName = name;
  return fn;
}

// ─── Build env shim script ───────────────────────────────────────────────────

export interface EnvShimConfig {
  /** Seed for Math.random replacement (default: Date.now()) */
  randomSeed?: number;
  /** User agent string */
  userAgent?: string;
  /** Coarsened performance.now interval in μs (default: 100) */
  perfCoarseningUs?: number;
}

/**
 * Create a node:vm Context with full browser env shims.
 * Returns the context ready for fireyejs.js execution.
 */
export function createEnvContext(config: EnvShimConfig = {}): vm.Context {
  const seed = config.randomSeed ?? Date.now();
  const ua = config.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const perfCoarsening = config.perfCoarseningUs ?? 100;

  const context = vm.createContext({}) as vm.Context;

  // ── Timing base ──────────────────────────────────────────────────────────
  const timeOrigin = Date.now();
  let lastPerfNow = 0;

  // ── Layer 1: Basic globals ───────────────────────────────────────────────

  const windowShim: Record<string, unknown> = {};
  const navigatorShim: Record<string, unknown> = {
    userAgent: ua,
    appVersion: ua.match(/Mozilla\/[\d.]+/)?.[0] || '5.0',
    platform: 'Linux x86_64',
    vendor: 'Google Inc.',
    language: 'en-US',
    languages: ['en-US', 'en'],
    cookieEnabled: true,
    doNotTrack: null,
    onLine: true,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
    webdriver: false,
    deviceMemory: 8,
    product: 'Gecko',
    productSub: '20030107',
    vendorSub: '',
    appCodeName: 'Mozilla',
    appName: 'Netscape',
    pdfViewerEnabled: false,
  };
  const screenShim: Record<string, unknown> = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    availLeft: 0,
    availTop: 0,
  };
  const locationShim: Record<string, unknown> = {
    href: 'https://chat.qwen.ai/',
    origin: 'https://chat.qwen.ai',
    protocol: 'https:',
    host: 'chat.qwen.ai',
    hostname: 'chat.qwen.ai',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
  };

  // ── Layer 2: Storage ─────────────────────────────────────────────────────

  function createStorage(): {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
    clear: () => void;
    key: (i: number) => string | null;
    get length(): number;
  } {
    const store = new Map<string, string>();
    return {
      getItem: markNative((k: string) => store.get(String(k)) ?? null, 'getItem'),
      setItem: markNative((k: string, v: string) => {
        store.set(String(k), String(v));
      }, 'setItem'),
      removeItem: markNative((k: string) => {
        store.delete(String(k));
      }, 'removeItem'),
      clear: markNative(() => {
        store.clear();
      }, 'clear'),
      key: markNative((i: number) => {
        const keys = [...store.keys()];
        return keys[i] ?? null;
      }, 'key'),
      get length() {
        return store.size;
      },
    };
  }

  // ── Layer 3: Performance ─────────────────────────────────────────────────

  const performanceShim: Record<string, unknown> = {
    now: markNative(() => {
      const elapsed = Date.now() - timeOrigin;
      // Coarsen to configurable μs interval to match real browser granularity
      const coarsened = Math.floor(elapsed / (perfCoarsening / 1000)) * (perfCoarsening / 1000);
      // Ensure monotonic (Chrome never goes backwards)
      if (coarsened < lastPerfNow) return lastPerfNow;
      lastPerfNow = coarsened;
      return coarsened;
    }, 'now'),
    timing: {
      navigationStart: timeOrigin,
      unloadEventStart: 0,
      unloadEventEnd: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: timeOrigin + 10,
      domainLookupStart: timeOrigin + 15,
      domainLookupEnd: timeOrigin + 25,
      connectStart: timeOrigin + 25,
      connectEnd: timeOrigin + 80,
      secureConnectionStart: timeOrigin + 40,
      requestStart: timeOrigin + 82,
      responseStart: timeOrigin + 180,
      responseEnd: timeOrigin + 220,
      domLoading: timeOrigin + 230,
      domInteractive: timeOrigin + 500,
      domContentLoadedEventStart: timeOrigin + 520,
      domContentLoadedEventEnd: timeOrigin + 530,
      domComplete: timeOrigin + 800,
      loadEventStart: timeOrigin + 810,
      loadEventEnd: timeOrigin + 820,
    },
    navigation: { type: 0, redirectCount: 0 },
    memory: { jsHeapSizeLimit: 4_173_148_160, totalJSHeapSize: 25_000_000, usedJSHeapSize: 20_000_000 },
    getEntries: markNative(() => [], 'getEntries'),
    getEntriesByType: markNative(() => [], 'getEntriesByType'),
    getEntriesByName: markNative(() => [], 'getEntriesByName'),
  };

  // ── Layer 5: window.chrome ───────────────────────────────────────────────

  const chromeShim: Record<string, unknown> = {
    loadTimes: markNative(
      () => ({
        requestTime: (timeOrigin - 500) / 1000,
        startLoadTime: (timeOrigin - 200) / 1000,
        commitLoadTime: (timeOrigin + 300) / 1000,
        finishDocumentLoadTime: (timeOrigin + 500) / 1000,
        finishLoadTime: (timeOrigin + 800) / 1000,
        firstPaintTime: (timeOrigin + 350) / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'http2',
      }),
      'loadTimes',
    ),
    csi: markNative(
      () => ({
        onloadT: 800,
        startE: 0,
        pageT: 800,
        tran: 15,
      }),
      'csi',
    ),
    app: {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    },
    runtime: {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' },
      getManifest: markNative(() => ({}), 'getManifest'),
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
  Object.defineProperty(chromeShim, 'loadTimes', { configurable: false, writable: false });
  Object.defineProperty(chromeShim, 'csi', { configurable: false, writable: false });

  // ── Layer 6: navigator.plugins (PluginArray) ─────────────────────────────
  // Real Chrome has: Chrome PDF Plugin, Chrome PDF Viewer, Native Client
  // Each Plugin has MimeType entries with circular enabledPlugin refs.

  const pluginNames = ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client'];
  const pluginDesc = ['Portable Document Format', '', ''];
  const pluginFilename = ['internal-pdf-viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'internal-nacl-plugin'];
  const mimeTypes = [
    ['application/pdf', 'pdf'],
    ['application/pdf', 'pdf'],
    ['application/x-nacl', 'nexe', 'application/x-pnacl', 'pnacl'],
  ];

  function buildPluginArray() {
    const plugins: Array<Record<string, unknown>> = [];
    pluginNames.forEach((name, i) => {
      const mimes = [] as Record<string, unknown>[];
      for (let j = 0; j < mimeTypes[i].length; j += 2) {
        const mime: Record<string, unknown> = {
          type: mimeTypes[i][j],
          suffixes: mimeTypes[i][j + 1],
          description: '',
          enabledPlugin: null as Record<string, unknown> | null,
        };
        // Circular ref: each MimeType.enabledPlugin points back to its Plugin
        mimes.push(mime);
      }
      const plugin: Record<string, unknown> = {
        name,
        description: pluginDesc[i],
        filename: pluginFilename[i],
        length: mimes.length,
        item: markNative((idx: number) => mimes[idx] ?? null, 'item'),
        namedItem: markNative((_name: string) => mimes.find((m) => m.type === _name) ?? null, 'namedItem'),
      };
      // Set up circular refs after plugin is built
      mimes.forEach((mime) => {
        mime.enabledPlugin = plugin;
      });
      plugins.push(plugin);
    });
    return plugins;
  }

  const pluginsArray = buildPluginArray();
  const pluginsShim = {
    length: pluginsArray.length,
    item: markNative((idx: number) => pluginsArray[idx] ?? null, 'item'),
    namedItem: markNative((_name: string) => pluginsArray.find((p: Record<string, unknown>) => p.name === _name) ?? null, 'namedItem'),
    refresh: markNative(() => {}, 'refresh'),
    // JSON.stringify returns [] for PluginArray
    toJSON: markNative(() => [], 'toJSON'),
  };
  navigatorShim.plugins = pluginsShim;
  navigatorShim.mimeTypes = {
    length: 0,
    item: markNative(() => null, 'item'),
    namedItem: markNative(() => null, 'namedItem'),
  };

  // Mark top-level navigator methods as native
  for (const [key, val] of Object.entries(navigatorShim)) {
    if (typeof val === 'function') {
      markNative(val as Function, key);
    }
  }

  // ── Layer 7: Canvas shim ─────────────────────────────────────────────────
  // ponytail: pre-recorded canvas values. In production, record from real browser
  // and store in a JSON file loaded at startup. For now, returns fixed values.

  const canvasShim: Record<string, unknown> = {
    getContext: markNative((_type: string) => null, 'getContext'),
    toDataURL: markNative(
      (_type?: string) =>
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'toDataURL',
    ),
    toBlob: markNative((_cb: Function) => {}, 'toBlob'),
    getImageData: markNative(
      (_x: number, _y: number, _w: number, _h: number) => ({ data: new Uint8ClampedArray(4), width: _w, height: _h }),
      'getImageData',
    ),
    measureText: markNative((_text: string) => ({ width: 100, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 }), 'measureText'),
  };

  // ── Layer 8: WebGL shim ──────────────────────────────────────────────────
  // ponytail: static WebGL parameters. Pre-record from real browser for accuracy.

  const webglParams: Record<number, unknown> = {
    0x1f02: 'WebKit WebGL', // RENDERER
    0x1f01: 'WebKit', // VENDOR
    0x1f00: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', // VERSION
    0x8b8c: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)', // SHADING_LANGUAGE_VERSION
    0x9245: 0x0001, // UNMASKED_VENDOR_WEBGL
    0x9246: 0x0001, // UNMASKED_RENDERER_WEBGL
    0x8869: 16384, // MAX_VERTEX_ATTRIBS
    0x8ddf: 32, // MAX_VERTEX_UNIFORM_VECTORS
    0x8df8: 16, // MAX_VARYING_VECTORS
    0x8871: 1, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    0x8872: 16384, // MAX_TEXTURE_SIZE
    0x8843: 16384, // MAX_CUBE_MAP_TEXTURE_SIZE
    0x886a: 64, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    0x889f: 256, // MAX_RENDERBUFFER_SIZE
    0x8dfb: 16, // MAX_FRAGMENT_UNIFORM_VECTORS
    0x84fe: 60, // MAX_TEXTURE_MAX_ANISOTROPY_EXT (0x84FE)
    0x84fd: 16, // MAX_TEXTURE_MAX_ANISOTROPY
    0x8861: 0x84c0, // MAX_TEXTURE_IMAGE_UNITS
    0x8b4d: 0x8b50, // SHADER_COMPILER
  };

  // Shader methods that fireyejs may call
  const webglShim = {
    getParameter: markNative((pname: number) => webglParams[pname] ?? 0, 'getParameter'),
    getExtension: markNative((_name: string) => null, 'getExtension'),
    getSupportedExtensions: markNative(() => ['EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info'], 'getSupportedExtensions'),
    getShaderPrecisionFormat: markNative(() => ({ rangeMin: 127, rangeMax: 127, precision: 23 }), 'getShaderPrecisionFormat'),
    createShader: markNative((_type: number) => ({ __webglShader: true }), 'createShader'),
    shaderSource: markNative(() => {}, 'shaderSource'),
    compileShader: markNative(() => {}, 'compileShader'),
    getShaderParameter: markNative((_shader: unknown, _pname: number) => true, 'getShaderParameter'),
    getShaderInfoLog: markNative(() => '', 'getShaderInfoLog'),
    createProgram: markNative(() => ({ __webglProgram: true }), 'createProgram'),
    attachShader: markNative(() => {}, 'attachShader'),
    linkProgram: markNative(() => {}, 'linkProgram'),
    getProgramParameter: markNative((_program: unknown, _pname: number) => true, 'getProgramParameter'),
    getProgramInfoLog: markNative(() => '', 'getProgramInfoLog'),
    useProgram: markNative(() => {}, 'useProgram'),
    getAttribLocation: markNative(() => 0, 'getAttribLocation'),
    getUniformLocation: markNative(() => ({ __webglUniform: true }), 'getUniformLocation'),
    enableVertexAttribArray: markNative(() => {}, 'enableVertexAttribArray'),
    vertexAttribPointer: markNative(() => {}, 'vertexAttribPointer'),
    drawArrays: markNative(() => {}, 'drawArrays'),
    drawElements: markNative(() => {}, 'drawElements'),
    readPixels: markNative(() => new Uint8Array(4), 'readPixels'),
    bindBuffer: markNative(() => {}, 'bindBuffer'),
    bufferData: markNative(() => {}, 'bufferData'),
    createBuffer: markNative(() => ({ __webglBuffer: true }), 'createBuffer'),
    clear: markNative(() => {}, 'clear'),
    clearColor: markNative(() => {}, 'clearColor'),
    viewport: markNative(() => {}, 'viewport'),
    enable: markNative(() => {}, 'enable'),
    disable: markNative(() => {}, 'disable'),
    blendFunc: markNative(() => {}, 'blendFunc'),
    getError: markNative(() => 0, 'getError'),
    isEnabled: markNative(() => true, 'isEnabled'),
    getContextAttributes: markNative(
      () => ({
        alpha: true,
        antialias: true,
        depth: true,
        stencil: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'default',
      }),
      'getContextAttributes',
    ),
    pixelStorei: markNative(() => {}, 'pixelStorei'),
    texImage2D: markNative(() => {}, 'texImage2D'),
    texParameteri: markNative(() => {}, 'texParameteri'),
    uniform1i: markNative(() => {}, 'uniform1i'),
    uniform2i: markNative(() => {}, 'uniform2i'),
    uniform3i: markNative(() => {}, 'uniform3i'),
    uniform4i: markNative(() => {}, 'uniform4i'),
    uniform1f: markNative(() => {}, 'uniform1f'),
    uniform2f: markNative(() => {}, 'uniform2f'),
    uniform3f: markNative(() => {}, 'uniform3f'),
    uniform4f: markNative(() => {}, 'uniform4f'),
    uniformMatrix4fv: markNative(() => {}, 'uniformMatrix4fv'),
    activeTexture: markNative(() => {}, 'activeTexture'),
    bindTexture: markNative(() => {}, 'bindTexture'),
    generateMipmap: markNative(() => {}, 'generateMipmap'),
    deleteTexture: markNative(() => {}, 'deleteTexture'),
  };

  // ── Layer 9: Math.random ─────────────────────────────────────────────────

  const seededRandom = createSeededRandom(seed);
  const mathShim = {
    random: markNative(() => seededRandom(), 'random'),
  };

  // ── Assemble context ────────────────────────────────────────────────────

  const defineGlobal = (name: string, value: unknown) => {
    context[name] = value;
  };

  defineGlobal('window', windowShim);
  defineGlobal('self', windowShim);
  defineGlobal('globalThis', context);
  defineGlobal('navigator', navigatorShim);
  defineGlobal('screen', screenShim);
  defineGlobal('location', locationShim);
  defineGlobal('document', {
    cookie: '',
    documentElement: { style: {} },
    createElement: markNative((tag: string) => {
      if (tag === 'canvas')
        return { ...canvasShim, getContext: canvasShim.getContext, toDataURL: canvasShim.toDataURL, toBlob: canvasShim.toBlob };
      return {};
    }, 'createElement'),
    createEvent: markNative(() => ({}), 'createEvent'),
    addEventListener: markNative(() => {}, 'addEventListener'),
    removeEventListener: markNative(() => {}, 'removeEventListener'),
    querySelector: markNative(() => null, 'querySelector'),
    querySelectorAll: markNative(() => [], 'querySelectorAll'),
    getElementById: markNative(() => null, 'getElementById'),
    getElementsByTagName: markNative(() => [], 'getElementsByTagName'),
    getElementsByClassName: markNative(() => [], 'getElementsByClassName'),
    body: { appendChild: markNative(() => {}, 'appendChild') },
    head: { appendChild: markNative(() => {}, 'appendChild') },
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    referrer: '',
    title: 'Qwen',
    all: { length: 0, item: markNative(() => null, 'item'), namedItem: markNative(() => null, 'namedItem') },
    documentMode: undefined,
    compatMode: 'CSS1Compat',
    characterSet: 'UTF-8',
    charset: 'UTF-8',
    contentType: 'text/html',
  });
  defineGlobal('localStorage', createStorage());
  defineGlobal('sessionStorage', createStorage());
  defineGlobal('performance', performanceShim);
  defineGlobal('chrome', chromeShim);
  defineGlobal('Math', { ...Math, random: mathShim.random });
  defineGlobal('crypto', {
    getRandomValues: markNative((arr: Uint8Array | Uint16Array | Uint32Array) => {
      // Use actual crypto for getRandomValues (bypasses seeded random)
      const bytes = crypto.randomBytes(arr.byteLength);
      arr.set(new Uint8Array(bytes.buffer, bytes.byteOffset, arr.byteLength));
      return arr;
    }, 'getRandomValues'),
    randomUUID: markNative(() => crypto.randomUUID(), 'randomUUID'),
    subtle: {},
  });
  defineGlobal('console', {
    log: markNative(() => {}, 'log'),
    warn: markNative(() => {}, 'warn'),
    error: markNative(() => {}, 'error'),
    info: markNative(() => {}, 'info'),
    debug: markNative(() => {}, 'debug'),
  });

  // WebGL context via HTMLCanvasElement.getContext('webgl')
  // Override canvasShim.getContext to return the WebGL context when 'webgl' is requested
  canvasShim.getContext = markNative((type: string) => {
    if (type === 'webgl' || type === 'experimental-webgl') return webglShim;
    return null;
  }, 'getContext');

  // window.HTMLCanvasElement.prototype.getContext = canvasShim.getContext
  defineGlobal('HTMLCanvasElement', { prototype: { getContext: canvasShim.getContext } });

  // Install Function.prototype.toString Proxy LAST (after all fns registered)
  installFnToStringProxy(context);

  return context;
}

/**
 * Run a script inside a browser-env-shimmed node:vm context.
 */
export function runInEnvContext(code: string, filename = 'sandbox.js', config?: EnvShimConfig): { context: vm.Context; result: unknown } {
  const context = createEnvContext(config);
  const script = new vm.Script(code, { filename });
  const result = script.runInContext(context, { timeout: 15_000 }); // 15s timeout
  return { context, result };
}
