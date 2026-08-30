/**
 * Strips comments before a guard matches source text.
 *
 * Three guards in this repo have now been beaten by PROSE rather than by code:
 * a SEEK_MS guard that tripped over the comment explaining the old literal, a
 * parseProject guard satisfied by a comment that merely mentioned the function,
 * and — the same shape one level out — a CI skip-rate script that read a test's
 * fixture string as a real skip. A guard that greps raw source is asserting
 * something about the documentation.
 *
 * Crude on purpose: it does not parse. It is good enough to stop a comment
 * satisfying or tripping a check, and it is used only by tests.
 */
export const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
