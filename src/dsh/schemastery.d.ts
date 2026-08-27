/**
 * Ambient type stub for the vendored schemastery validator.
 *
 * This file is deliberately a global script (no top-level imports/exports) so
 * the `declare module` CREATES the module instead of augmenting it — the real
 * package is resolved lazily at runtime inside a profile and is not a hard
 * dependency of this plugin's own install (see settings.ts).
 */
declare module '@deepseek-ai/schemastery' {
  const Schema: {
    object(shape: Record<string, unknown>): unknown;
    string(): unknown;
    number(): unknown;
    boolean(): unknown;
    array(item: unknown): unknown;
  };
  export default Schema;
}
