import type { Candidate } from './domain';

type Photo = Pick<Candidate, 'image' | 'imageCredit'>;
const cache = new Map<string, Promise<Photo | null>>();
const text = (value: unknown) => typeof value === 'string' ? value : '';
const plain = (value: unknown) => text(value).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 240);
const headers = { 'User-Agent': 'RoamerTravelDemo/0.1 (https://roamer-chi.vercel.app)' };

async function json(url: string) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Destination photography is unavailable.');
  return response.json();
}

export function reusableLicense(name: string, url: string) {
  if (/^public domain$/i.test(name)) return true;
  try {
    const license = new URL(url);
    return license.hostname === 'creativecommons.org' && /^\/(?:licenses\/by(?:-sa)?\/|publicdomain\/zero\/)/.test(license.pathname);
  } catch { return false; }
}

async function lookup(name: string): Promise<Photo | null> {
  const summary = await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`);
  if (summary.type === 'disambiguation' || !summary.coordinates || !/city|town|capital|municipality|resort|commune/i.test(text(summary.description))) return null;
  const original = new URL(text(summary.originalimage?.source));
  if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(original.hostname)) return null;
  const file = decodeURIComponent(original.pathname.split('/').at(original.pathname.includes('/thumb/') ? -2 : -1)!);
  const query = new URLSearchParams({ action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '960', format: 'json' });
  const result = await json(`https://commons.wikimedia.org/w/api.php?${query}`);
  const page = Object.values(result.query?.pages ?? {})[0] as { imageinfo?: Array<Record<string, any>> } | undefined;
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const metadata = info.extmetadata ?? {};
  const license = plain(metadata.LicenseShortName?.value);
  const licenseUrl = text(metadata.LicenseUrl?.value).replace(/^\/\//, 'https://') || 'https://commons.wikimedia.org/wiki/Commons:Public_domain';
  if (!reusableLicense(license, licenseUrl)) return null;
  const image = new URL(text(info.thumburl ?? info.url));
  const source = new URL(text(info.descriptionurl));
  if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(image.hostname) || source.hostname !== 'commons.wikimedia.org') return null;
  return { image: image.href, imageCredit: { author: plain(metadata.Artist?.value) || 'Wikimedia Commons contributor', license, licenseUrl, source: source.href } };
}

export function destinationPhoto(name: string, country: string): Promise<Photo | null> {
  const key = `${name.trim().toLowerCase()}:${country.trim().toLowerCase()}`;
  let result = cache.get(key);
  if (!result) {
    result = lookup(name).catch(() => null);
    cache.set(key, result);
    void result.then(value => { if (!value) cache.delete(key); });
  }
  return result;
}
