import { randomBytes, scrypt as scryptCb, timingSafeEqual, ScryptOptions } from 'crypto';

/**
 * Password hashing with scrypt (built into Node: memory-hard, no native addon).
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64>. Parameters travel with the hash so they can be raised later.
 */
const PARAMS = { N: 2 ** 16, r: 8, p: 1, keyLen: 64 } as const;
const MAXMEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  const opts: ScryptOptions = { N, r, p, maxmem: MAXMEM };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS.N, PARAMS.r, PARAMS.p, PARAMS.keyLen);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (![N, r, p].every(Number.isFinite) || expected.length === 0) return false;
  const actual = await derive(password, salt, N, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return !(parts[0] === 'scrypt' && Number(parts[1]) === PARAMS.N && Number(parts[2]) === PARAMS.r && Number(parts[3]) === PARAMS.p);
}
