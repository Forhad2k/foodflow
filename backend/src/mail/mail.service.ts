import type { Env } from '../config/env';
import { createLogger } from '../common/logger';

/**
 * DEVELOPMENT ADAPTER: no email is actually sent.
 * In development the reset link is written to the log so the flow can be exercised locally.
 * In production this logs a warning (never the link/token). Replace the body with a real provider
 * (SES, Resend, SendGrid...) before launch; the method signature used by callers stays the same.
 */
export class MailService {
  private readonly logger = createLogger(MailService.name);
  constructor(private readonly config: Env) {}

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    if (this.config.NODE_ENV === 'production') {
      this.logger.warn('No mail provider configured: password reset email was NOT delivered');
      return;
    }
    this.logger.log(`[DEV MAIL ADAPTER] password reset for ${to}: ${resetUrl}`);
  }
}
