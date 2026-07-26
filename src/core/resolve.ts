import type { Config } from './config.js';
import type { SiteRow } from '../store.js';
import type { SiteStore } from '../store.js';
import { isValidSlug } from '../util/ids.js';

export type Resolution =
  | { kind: 'app' }
  | { kind: 'redirect'; location: string }
  | { kind: 'unknown-site'; hostname: string; slug?: string }
  | {
      kind: 'site';
      site: SiteRow;
      /** Path within the site, always starting with '/'. */
      innerPath: string;
      /** True when the site owns the whole hostname (subdomain or custom domain). */
      hostBased: boolean;
      /** URL prefix that addresses this site; '' when host-based. */
      basePath: string;
    };

/**
 * Decides whether a request belongs to a published site or to the application
 * itself (MCP, OAuth, admin, health).
 *
 * Resolution order: custom domain → `<slug>.<A2W_SITES_BASE_DOMAIN>` →
 * `${A2W_SITES_PATH_PREFIX}/<slug>/…` → the app.
 */
export async function resolveRequest(
  config: Config,
  store: SiteStore,
  hostname: string,
  url: string,
): Promise<Resolution> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const appHost = config.publicOrigin.hostname.toLowerCase();
  const [rawPath = '/', query] = splitUrl(url);

  if (host !== appHost) {
    const byDomain = await store.getSiteByDomain(host);
    if (byDomain) {
      return { kind: 'site', site: byDomain, innerPath: rawPath, hostBased: true, basePath: '' };
    }
    const base = config.sitesBaseDomain;
    if (base && host.endsWith(`.${base}`)) {
      const label = host.slice(0, -(base.length + 1));
      if (!label.includes('.') && isValidSlug(label)) {
        const site = await store.getSiteBySlug(label);
        if (site) {
          return { kind: 'site', site, innerPath: rawPath, hostBased: true, basePath: '' };
        }
        return { kind: 'unknown-site', hostname: host, slug: label };
      }
      return { kind: 'unknown-site', hostname: host };
    }
  }

  const prefix = config.sitesPathPrefix;
  if (rawPath === prefix || rawPath === `${prefix}/`) {
    return { kind: 'app' };
  }
  if (rawPath.startsWith(`${prefix}/`)) {
    const rest = rawPath.slice(prefix.length + 1);
    const slash = rest.indexOf('/');
    const slug = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    if (!isValidSlug(slug)) return { kind: 'unknown-site', hostname: host, slug };
    const site = await store.getSiteBySlug(slug);
    if (!site) return { kind: 'unknown-site', hostname: host, slug };
    if (slash === -1) {
      // /s/<slug> → /s/<slug>/ so relative asset links resolve correctly.
      return { kind: 'redirect', location: `${prefix}/${slug}/${query ? `?${query}` : ''}` };
    }
    return {
      kind: 'site',
      site,
      innerPath: rest.slice(slash),
      hostBased: false,
      basePath: `${prefix}/${slug}`,
    };
  }

  return { kind: 'app' };
}

function splitUrl(url: string): [string, string | undefined] {
  const index = url.indexOf('?');
  if (index === -1) return [url, undefined];
  return [url.slice(0, index), url.slice(index + 1)];
}
