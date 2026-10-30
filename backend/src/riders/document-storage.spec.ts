import { v2 as cloudinary } from 'cloudinary';
import { validateEnv } from '../config/env';
import { RiderDocumentStorage } from './document-storage';

const storage = new RiderDocumentStorage(validateEnv({
  DATABASE_URL: 'postgresql://localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  CORS_ORIGINS: 'http://localhost:3000',
  APP_URL: 'http://localhost:3000',
  CLOUDINARY_CLOUD_NAME: 'foodflow-test',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
}));

describe('rider document storage', () => {
  it('creates a short-lived signed upload scoped to the rider folder', () => {
    const userId = 'c0a80123-4567-4890-abcd-ef0123456789';
    const result = storage.createUploadSignature(userId);
    const expectedSignature = cloudinary.utils.api_sign_request({
      overwrite: false,
      public_id: result.publicId,
      timestamp: result.timestamp,
      type: 'authenticated',
    }, 'test-secret');

    expect(result.publicId).toMatch(new RegExp(`^riders/${userId}/[0-9a-f-]{36}$`));
    expect(result.signature).toBe(expectedSignature);
    expect(result.type).toBe('authenticated');
    expect(result.expiresAt - result.timestamp).toBe(300);
    expect(result.maxUploadBytes).toBe(10 * 1024 * 1024);
  });
});
