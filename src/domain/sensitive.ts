/**
 * Deterministic sensitive-content detection for the memory write path.
 * Every write passes through this before it can reach storage.
 */

export interface SensitiveDetector {
  /** Returns the reasons this text looks sensitive; empty means clean. */
  detect(text: string): string[];
}

const PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: 'deepseek-api-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: 'openai-api-key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { reason: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { reason: 'github-token', re: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}\b/ },
  { reason: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { reason: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { reason: 'ethereum-address', re: /\b0x[a-fA-F0-9]{40}\b/ },
  { reason: 'long-hex-hash', re: /\b[0-9a-fA-F]{64}\b/ },
  { reason: 'bearer-token', re: /\bBearer [A-Za-z0-9._~+/-]{20,}\b/i },
];

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const c of counts.values()) {
    const p = c / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY = 4.2;
const LONG_TOKEN_RE = /[A-Za-z0-9._~+/-]{32,}/g;

export function createSensitiveDetector(): SensitiveDetector {
  return {
    detect(text: string): string[] {
      const reasons: string[] = [];
      for (const { reason, re } of PATTERNS) {
        if (re.test(text)) {
          reasons.push(reason);
        }
      }
      for (const match of text.matchAll(LONG_TOKEN_RE)) {
        const token = match[0];
        if (token.length >= 40 && entropy(token) >= HIGH_ENTROPY) {
          reasons.push('high-entropy-secret');
          break;
        }
      }
      return reasons;
    },
  };
}
