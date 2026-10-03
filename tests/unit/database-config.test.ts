import { describe, expect, it } from 'vitest';
import { describeDatabase, resolveDatabaseConfig } from '../../src/config/database.js';

const LOCAL = 'mysql://root:root@127.0.0.1:8889/instant_doctor';
const LIVE = 'mysql://2abc.root:p%40ss@gateway01.eu-central-1.prod.aws.tidbcloud.com:4000/instant_doctor';

describe('resolveDatabaseConfig', () => {
  it('defaults to the local target without TLS', () => {
    const cfg = resolveDatabaseConfig({ DATABASE_URL_LOCAL: LOCAL, DATABASE_URL_LIVE: LIVE });
    expect(cfg).toMatchObject({ target: 'local', host: '127.0.0.1', port: 8889, database: 'instant_doctor', ssl: undefined });
  });

  it('switches to live with TLS and decoded credentials', () => {
    const cfg = resolveDatabaseConfig({ DB_TARGET: 'live', DATABASE_URL_LOCAL: LOCAL, DATABASE_URL_LIVE: LIVE });
    expect(cfg).toMatchObject({ target: 'live', port: 4000, user: '2abc.root', password: 'p@ss' });
    expect(cfg.ssl).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
    expect(describeDatabase(cfg)).toBe('live → gateway01.eu-central-1.prod.aws.tidbcloud.com:4000/instant_doctor (TLS)');
  });

  it('lets an explicit DATABASE_URL override the target', () => {
    const cfg = resolveDatabaseConfig({ DB_TARGET: 'live', DATABASE_URL: LOCAL, DATABASE_URL_LIVE: LIVE });
    expect(cfg.target).toBe('custom');
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('honours DATABASE_SSL=false and TLS hints in the URL', () => {
    expect(resolveDatabaseConfig({ DB_TARGET: 'live', DATABASE_URL_LIVE: LIVE, DATABASE_SSL: 'false' }).ssl).toBeUndefined();
    expect(resolveDatabaseConfig({ DATABASE_URL_LOCAL: `${LOCAL}?sslaccept=strict` }).ssl).toBeDefined();
  });

  it('fails clearly when the selected target is not configured', () => {
    expect(() => resolveDatabaseConfig({ DB_TARGET: 'live', DATABASE_URL_LOCAL: LOCAL, DATABASE_URL_LIVE: '' })).toThrow(
      'DB_TARGET=live but DATABASE_URL_LIVE is not set',
    );
  });
});
