/**
 * Creates Ethereal (https://ethereal.email) test SMTP accounts and prints a
 * ready-to-paste ETHEREAL_SENDERS_JSON line. Ethereal never delivers mail to
 * real inboxes; every message is viewable at its preview URL.
 *
 *   npm run ethereal:create          # 2 accounts
 *   npm run ethereal:create -- 3     # 3 accounts
 *
 * Deliberately independent of src/config so it runs before .env is complete.
 */
import nodemailer from 'nodemailer';

async function main(): Promise<void> {
  const count = Math.min(Math.max(Number(process.argv[2] ?? 2) || 2, 1), 10);
  const senders = [];
  for (let i = 0; i < count; i++) {
    const account = await nodemailer.createTestAccount();
    senders.push({
      name: `ReachInbox Sender ${String.fromCharCode(65 + i)}`,
      email: account.user,
      user: account.user,
      pass: account.pass,
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
    });
    process.stdout.write(`Created ${account.user} (log in at https://ethereal.email/login to view mail)\n`);
  }
  process.stdout.write(`\nAdd this line to backend/.env:\n\nETHEREAL_SENDERS_JSON=${JSON.stringify(senders)}\n\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to create Ethereal accounts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
