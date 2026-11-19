// Sends the verification and password-reset emails.
// Real sending uses the Resend HTTPS API (https://resend.com): set EMAIL_API_KEY and EMAIL_FROM.
// With no key (local development) the email is printed to the server console instead, so you can click the link.
export function createMailer({ apiKey = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM, log = console.log } = {}) {
  if (!apiKey || !from) {
    return {
      real: false,
      async send({ to, subject, text }) { log(`\n--- email (not sent: no EMAIL_API_KEY) ---\nTo: ${to}\nSubject: ${subject}\n${text}\n---`); },
    };
  }
  return {
    real: true,
    async send({ to, subject, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`Email provider refused the message (${res.status})`);
    },
  };
}
