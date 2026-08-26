import { describe, it, expect } from 'vitest';
import { createSensitiveDetector } from '../domain/sensitive.js';

const detect = createSensitiveDetector();

describe('sensitive detector', () => {
  it('flags a deepseek API key', () => {
    const reasons = detect.detect('use sk-abc123XYZ456def789ABC123XYZ456def789 for inference');
    expect(reasons).toContain('deepseek-api-key');
  });

  it('flags an openai project key', () => {
    expect(detect.detect('key=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJK')).toContain(
      'openai-api-key',
    );
  });

  it('flags aws access keys', () => {
    expect(detect.detect('AKIAIOSFODNN7EXAMPLE')).toContain('aws-access-key');
  });

  it('flags a private key block', () => {
    expect(
      detect.detect('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...'),
    ).toContain('private-key-block');
  });

  it('flags a github token', () => {
    expect(detect.detect('token github_pat_1234567890abcdefghijklmnopqrstuvwxyz')).toContain(
      'github-token',
    );
  });

  it('flags a long high-entropy secret', () => {
    expect(
      detect.detect('secret = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
    ).toContain('long-hex-hash');
  });

  it('passes ordinary prose', () => {
    expect(
      detect.detect('The user prefers pnpm over npm and keeps the build in ./dist.'),
    ).toEqual([]);
  });

  it('flags an ethereum address', () => {
    expect(detect.detect('send to 0x52908400098527886E0F7030069857D2E4169EE7')).toContain(
      'ethereum-address',
    );
  });
});
