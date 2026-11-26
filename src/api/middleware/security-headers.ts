import type { Request, Response, NextFunction } from 'express';

/** Policy for API JSON bodies: allows nothing, so a JSON response can never run as a page. */
export const API_JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Policy for the pages this process serves itself (the app when client/dist exists, the /s/:token page), in
 * report-only mode: violations appear in the browser console and nothing breaks. It matches client/vercel.json.
 * Switch to enforcing (header name Content-Security-Policy) once the console is clean.
 */
export const PAGE_CSP_REPORT_ONLY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' blob: data: https:; connect-src 'self' https: wss:; frame-src 'self' blob: https://api.razorpay.com https://checkout.razorpay.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/**
 * Sets API_JSON_CSP when the handler answers with res.json. Files (PDF, images) served by API routes are not JSON
 * responses and keep rendering inline.
 */
export function apiJsonPolicy(_req: Request, res: Response, next: NextFunction): void {
  const sendJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (!res.getHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', API_JSON_CSP);
    return sendJson(body);
  }) as typeof res.json;
  next();
}

/** Report-only page policy for every path outside the API prefix. */
export function pagePolicyReportOnly(apiPrefix: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith(apiPrefix)) res.setHeader('Content-Security-Policy-Report-Only', PAGE_CSP_REPORT_ONLY);
    next();
  };
}
