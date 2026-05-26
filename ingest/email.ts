import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Email is used for one thing only: password-reset links. The interface keeps
// the dev/test path (ConsoleEmailSender) decoupled from SES so neither needs
// AWS credentials.

export interface EmailSender {
  sendPasswordReset(to: string, resetLink: string): Promise<void>;
}

export interface SesEmailSenderOptions {
  fromAddress: string;
  client?: SESClient;
}

export class SesEmailSender implements EmailSender {
  private readonly ses: SESClient;
  private readonly from: string;

  constructor(opts: SesEmailSenderOptions) {
    this.from = opts.fromAddress;
    this.ses = opts.client ?? new SESClient({});
  }

  async sendPasswordReset(to: string, resetLink: string): Promise<void> {
    const text = `Reset your Draw! password by opening this link (valid for 1 hour):\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`;
    await this.ses.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: "Reset your Draw! password" },
          Body: { Text: { Data: text } },
        },
      }),
    );
  }
}

// Dev/test stub: logs the link instead of sending. Lets the local e2e reset
// flow work without SES — copy the link from the ingest dev-server console.
export class ConsoleEmailSender implements EmailSender {
  async sendPasswordReset(to: string, resetLink: string): Promise<void> {
    console.log(`[email] password reset for ${to}: ${resetLink}`);
  }
}
