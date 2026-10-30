import { DomainError } from '../common/errors/domain-error';

/**
 * Menu/restaurant images are stored as URLs. They must be https and (when IMAGE_HOST_ALLOWLIST is set) hosted on an
 * approved domain, so owners cannot point customers' browsers at arbitrary tracking hosts.
 * Direct uploads (signed Cloudinary/S3 URLs) arrive with the storage adapter; this validates what gets attached.
 */
export function assertImageUrls(urls: readonly string[], allowedHosts: readonly string[], max = 8): void {
  if (urls.length > max) throw new DomainError('TOO_MANY_IMAGES', `At most ${max} images`, 422);
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new DomainError('INVALID_IMAGE_URL', 'Image URL is not valid', 422, { url: raw });
    }
    if (u.protocol !== 'https:' || u.username || u.password) throw new DomainError('INVALID_IMAGE_URL', 'Image URLs must be https', 422, { url: raw });
    if (allowedHosts.length && !allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
      throw new DomainError('IMAGE_HOST_NOT_ALLOWED', `Images must be hosted on: ${allowedHosts.join(', ')}`, 422, { host: u.hostname });
    }
  }
}
