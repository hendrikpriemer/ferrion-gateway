/**
 * Headers every control-plane response carries.
 *
 * The Content-Security-Policy is what keeps an injected string from running
 * as script: the pages build parts of themselves with innerHTML (escaped,
 * see app.js), and `script-src 'self'` without 'unsafe-inline' means that
 * even a missed escape cannot execute - no inline <script>, no on*= handler,
 * no javascript: URL. That needed every page script in its own file
 * (2026-10-17) and both fonts self-hosted (#76), so no directive names a
 * foreign host. Inline styles stay allowed: the pages use style="" in a few
 * places, and a style cannot run code.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** nosniff/no-referrer/DENY cost nothing; the CSP is explained above. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};
