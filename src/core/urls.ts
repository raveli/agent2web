import type { Config } from './config.js';
import type { SiteRow } from '../store.js';

export type SiteUrls = {
  /** The URL to hand back to a user: custom domain, else subdomain, else path. */
  primary: string;
  path: string;
  subdomain?: string;
  custom?: string;
};

export function siteUrls(config: Config, site: Pick<SiteRow, 'slug' | 'custom_domain'>): SiteUrls {
  const scheme = config.publicOrigin.protocol.replace(':', '');
  // Host-based URLs reach the same listener as the app, so they carry the app's
  // port when it is non-default. In production that is empty; on localhost:8080
  // it is what makes the printed URL actually resolve.
  const port = config.publicOrigin.port ? `:${config.publicOrigin.port}` : '';
  const path = `${config.publicUrl}${config.sitesPathPrefix}/${site.slug}/`;
  const subdomain = config.sitesBaseDomain
    ? `${scheme}://${site.slug}.${config.sitesBaseDomain}${port}/`
    : undefined;
  const custom = site.custom_domain ? `${scheme}://${site.custom_domain}${port}/` : undefined;
  return { primary: custom ?? subdomain ?? path, path, subdomain, custom };
}

/** Cookie path that scopes a site's password cookie to that site only. */
export function siteCookiePath(config: Config, slug: string, hostBased: boolean): string {
  return hostBased ? '/' : `${config.sitesPathPrefix}/${slug}`;
}
