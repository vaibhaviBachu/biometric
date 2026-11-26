import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireTrustedOriginForCookieAuth } from '../middleware/trusted-origin.middleware';
import { faceRegister, faceLogin, faceIdentify, faceStatus, faceChallenge, faceBeginEnrollment } from '../controllers/face-auth.controller';
import { blockNewRegistration } from '../../services/auth/registration-gate';

export const authRouter = Router();

/** Stricter rate limit on biometric endpoints — brute-force protection */
const biometricLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env['NODE_ENV'] === 'production' ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
});

/** Account creation: the global limiter alone let one IP mass-create accounts. */
const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env['NODE_ENV'] === 'production' ? 20 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many accounts created from this network. Please try again later.' },
});

/** Token refresh and logout: a normal browser needs a handful per hour; a script hammering them is guessing or looping. */
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env['NODE_ENV'] === 'production' ? 120 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many session requests. Please try again later.' },
});

// Cookie-only requests must come from a trusted origin: the browser sends the cookie by itself, so without this
// any page on the internet could trigger a refresh with the visitor's cookie.
authRouter.post('/refresh', sessionLimiter, requireTrustedOriginForCookieAuth, authController.refresh);
authRouter.post('/logout',  sessionLimiter, requireTrustedOriginForCookieAuth, authController.logout);
authRouter.get('/me',       requireAuth, authController.me);

// Face biometric auth (UI contract unchanged)
authRouter.post('/face/challenge', biometricLimiter, faceChallenge);
authRouter.post('/face/enroll/begin', createAccountLimiter, blockNewRegistration, faceBeginEnrollment);
authRouter.post('/face/register', biometricLimiter, blockNewRegistration, faceRegister);
authRouter.post('/face/login',    biometricLimiter, faceLogin);
// 1:N sign-in by face alone. Same rate limiter as login — this endpoint is the
// most attractive one to brute-force, since a caller supplies no account claim.
authRouter.post('/face/identify', biometricLimiter, faceIdentify);
authRouter.get('/face/status',    requireAuth, faceStatus);
