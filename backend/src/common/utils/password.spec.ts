import { hashPassword, needsRehash, verifyPassword } from './password';
import { generateOpaqueToken, sha256 } from './tokens';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same-password-1')).not.toEqual(await hashPassword('same-password-1'));
  });
  it('fails closed on malformed stored values', async () => {
    for (const bad of ['', 'plaintext', 'scrypt$1$2', 'bcrypt$x$y$z$a$b', 'scrypt$x$8$1$AAAA$AAAA']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
  it('flags hashes made with old parameters', async () => {
    expect(needsRehash(await hashPassword('x-password-123'))).toBe(false);
    expect(needsRehash('scrypt$16384$8$1$AAAA$AAAA')).toBe(true);
  });
});

describe('opaque tokens', () => {
  it('are unique, long and hashed deterministically', () => {
    const a = generateOpaqueToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toEqual(generateOpaqueToken());
    expect(sha256(a)).toEqual(sha256(a));
    expect(sha256(a)).not.toContain(a);
  });
});
