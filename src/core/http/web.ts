import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PublicConfig } from '../../config/installation.js';

/**
 * Serves the built SPA and the deployment's branding files from the API
 * process (one origin per installation). Files are loaded into memory at
 * startup: only names that exist can be served, so path traversal is
 * impossible by construction.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json',
};
const BRANDING_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico']);
const MAX_BRANDING_BYTES = 2 * 1024 * 1024;

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
/** Branding files: never executable, even an SVG opened directly. */
export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** SPA policy; an https logo/favicon host is added to img-src. Inline styles are needed by React style attributes. */
export function spaCsp(assetUrls: (string | null | undefined)[]): string {
  const origins = [...new Set(assetUrls.filter((u): u is string => !!u && u.startsWith('https://')).map((u) => new URL(u).origin))];
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:${origins.map((o) => ' ' + o).join('')}; ` +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
}

function walk(dir: string, base = dir, out = new Map<string, Buffer>()) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.set('/' + path.relative(base, full).split(path.sep).join('/'), readFileSync(full));
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** index.html with this installation's title, favicon and theme colour (no unbranded flash, no rebuild). */
export function renderIndex(template: string, cfg: PublicConfig): string {
  const title = `${cfg.brand.shortName} · ${cfg.product.name}`;
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="application-name" content="${esc(cfg.product.name)}" />`,
    `<meta name="theme-color" content="${esc(cfg.brand.primaryColor)}" />`,
    cfg.brand.faviconUrl ? `<link rel="icon" href="${esc(cfg.brand.faviconUrl)}" />` : '',
  ].filter(Boolean).join('\n    ');
  return template.replace(/<title>[\s\S]*?<\/title>/, head);
}

/** Loads image files from the mounted branding directory; configured /branding/* references must exist. */
export function registerBrandingAssets(dir: string, configured: (string | undefined)[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [p, body] of walk(dir)) {
    if (p.split('/').length !== 2 || !BRANDING_EXT.has(path.extname(p).toLowerCase()) || body.length > MAX_BRANDING_BYTES) continue;
    files.set('/branding' + p, body);
  }
  for (const ref of configured) {
    if (ref?.startsWith('/branding/') && !files.has(ref)) {
      throw new Error(`Branding file ${ref} not found in BRANDING_DIR (${dir}); allowed: svg, png, jpg, webp, ico up to 2 MB`);
    }
  }
  return files;
}

export function registerWeb(app: FastifyInstance, distDir: string | null, cfg: PublicConfig, branding: Map<string, Buffer> | null) {
  const files = distDir ? walk(distDir) : new Map<string, Buffer>();
  const template = files.get('/index.html');
  if (distDir && !template) throw new Error(`WEB_DIST_DIR ${distDir} has no index.html`);
  const index = template ? Buffer.from(renderIndex(template.toString('utf8'), cfg)) : null;

  const find = (url: string) => {
    const p = url.split('?')[0]!;
    const b = branding?.get(p);
    if (b) return { body: b, type: TYPES[path.extname(p).toLowerCase()]!, cache: 'public, max-age=300' };
    if (p === '/index.html' || p === '/') return index ? { body: index, type: TYPES['.html']!, cache: 'no-cache' } : null;
    const f = files.get(p);
    if (f) return { body: f, type: TYPES[path.extname(p)] ?? 'application/octet-stream', cache: p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
    // SPA fallback: unknown non-asset paths get index.html (client-side routing).
    if (!index || p.startsWith('/assets/') || p.startsWith('/branding/') || path.extname(p)) return null;
    return { body: index, type: TYPES['.html']!, cache: 'no-cache' };
  };

  app.setNotFoundHandler((req, reply) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/') && !req.url.startsWith('/health/')) {
      const f = find(req.url);
      if (f) return reply.header('content-type', f.type).header('cache-control', f.cache).header('x-content-type-options', 'nosniff').send(f.body);
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });
}
