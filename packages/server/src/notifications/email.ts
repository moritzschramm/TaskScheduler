/**
 * The email channel (spec §11: "email when offline").
 *
 * A **port with a logging default**, not a transport. Nothing in §14's
 * deployment story says which provider this deployment will use, and choosing
 * one here would be choosing for everybody who runs it — while a real
 * dependency would also mean the offline path could not be exercised locally
 * without credentials.
 *
 * So the interface is the decision and the implementation is configuration.
 * The development one writes to the log, which is enough to see that the right
 * message went to the right person at the right moment — the part the
 * application is responsible for. Whether the bytes reach an inbox is the
 * transport's problem, and swapping one in is a composition-root change.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSender {
  send: (message: EmailMessage) => Promise<void>;
}

/**
 * Logs instead of sending.
 *
 * Deliberately loud rather than silent: an implementation that quietly did
 * nothing would let a deployment ship with no email at all and no sign of it.
 */
export function loggingEmailSender(): EmailSender {
  return {
    send: async (message) => {
      console.warn(`[email] would send to ${message.to}: ${message.subject}\n${message.body}`);
      return Promise.resolve();
    },
  };
}

/** Collects messages instead of sending them. For tests. */
export function recordingEmailSender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, send: async (message) => void sent.push(message) };
}
