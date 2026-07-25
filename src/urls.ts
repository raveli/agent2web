import type { Config } from './config.js';
import type { SiteRow } from './db.js';

export type SiteUrls = {
  /** The URL to hand back to a user: custom domain, else subdomain, else path. */
  primary: string;
  path: string;
  subdomain?: string;
  custom?: string;
};

export function siteUrls(config: Config, site: Pick<SiteRow, 'slug' | 'custom_domain'>): SiteUrls {
  const scheme = config.publicOrigin.protocol.replace(':', '');
  const path = `${config.publicUrl}${config.sitesPathPrefix}/${site.slug}/`;
  const subdomain = config.sitesBaseDomain
    ? `${scheme}://${site.slug}.${config.sitesBaseDomain}/`
    : undefined;
  const custom = site.custom_domain ? `https://${site.custom_domain}/` : undefined;
  return { primary: custom ?? subdomain ?? path, path, subdomain, custom };
}

/** Cookie path that scopes a site's password cookie to that site only. */
export function siteCookiePath(config: Config, slug: string, hostBased: boolean): string {
  return hostBased ? '/' : `${config.sitesPathPrefix}/${slug}`;
}
