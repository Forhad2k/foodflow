import { randomUUID } from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { DomainError } from '../common/errors/domain-error';
import type { Env } from '../config/env';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_SIGNATURE_TTL_SECONDS = 5 * 60;
const PREVIEW_URL_TTL_SECONDS = 5 * 60;

export class RiderDocumentStorage {
  constructor(private readonly env: Env) {}

  createUploadSignature(userId: string) {
    const config = this.requireConfig();
    const publicId = `riders/${userId}/${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { overwrite: false, public_id: publicId, timestamp, type: 'authenticated' };
    const signature = cloudinary.utils.api_sign_request(params, config.apiSecret);

    return {
      cloudName: config.cloudName,
      apiKey: config.apiKey,
      publicId,
      timestamp,
      type: 'authenticated',
      signature,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      expiresAt: timestamp + UPLOAD_SIGNATURE_TTL_SECONDS,
    };
  }

  async verifyUploadedImage(userId: string, publicId: string): Promise<void> {
    this.requireConfig();
    if (!publicId.startsWith(`riders/${userId}/`)) {
      throw new DomainError('INVALID_STORAGE_KEY', 'Document must be stored under your own folder', 422);
    }

    let resource;
    try {
      resource = await cloudinary.api.resource(publicId, {
        resource_type: 'image',
        type: 'authenticated',
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'http_code' in error && error.http_code === 404) {
        throw new DomainError('DOCUMENT_UPLOAD_NOT_FOUND', 'Upload the document before submitting it', 422);
      }
      throw error;
    }
    if (resource.public_id !== publicId || resource.type !== 'authenticated') {
      throw new DomainError('DOCUMENT_UPLOAD_NOT_FOUND', 'Upload the document before submitting it', 422);
    }
    if (resource.bytes > MAX_UPLOAD_BYTES || !['jpg', 'jpeg', 'png', 'webp'].includes(resource.format)) {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', type: 'authenticated' });
      throw new DomainError('INVALID_DOCUMENT_FILE', 'Use a JPEG, PNG, or WebP image up to 10 MB', 422);
    }
  }

  async createPreviewUrl(publicId: string): Promise<string> {
    this.requireConfig();
    const resource = await cloudinary.api.resource(publicId, {
      resource_type: 'image',
      type: 'authenticated',
    });
    return cloudinary.utils.private_download_url(publicId, resource.format, {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + PREVIEW_URL_TTL_SECONDS,
      attachment: false,
    });
  }

  private requireConfig() {
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = this.env;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new DomainError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Document uploads are not configured. Contact support.', 503);
    }

    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    return { cloudName, apiKey, apiSecret };
  }
}
