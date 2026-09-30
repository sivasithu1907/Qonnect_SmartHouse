import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../server/db';

describe('resolveDatabaseUrl', () => {
  it('prefers DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a:b@h/d' })).toBe('postgres://a:b@h/d');
  });
  it('URL-encodes passwords with reserved characters (e.g. Base64)', () => {
    const url = resolveDatabaseUrl({ DB_HOST: 'db', DB_NAME: 'smarthouse', DB_USER: 'smarthouse', DB_PASSWORD: 'a+b/c=d@e:f#g' });
    expect(url).toBe('postgres://smarthouse:a%2Bb%2Fc%3Dd%40e%3Af%23g@db:5432/smarthouse');
    expect(decodeURIComponent(new URL(url).password)).toBe('a+b/c=d@e:f#g');
  });
  it('fails clearly when not configured', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/not configured/);
  });
});
