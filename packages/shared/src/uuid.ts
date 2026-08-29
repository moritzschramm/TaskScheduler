/**
 * UUID v7 (RFC 9562), the id format used everywhere (spec §5.1).
 *
 * Postgres 18 generates these natively for primary keys, so this exists for the
 * one id the database cannot assign: a **command's**. A command is a
 * serializable intent object (spec §7.1) that a client constructs, queues and
 * may retry, so it has to carry an identity before it reaches a database — and
 * once M12 computes an optimistic schedule client-side, the same code runs in a
 * browser, which is why this uses Web Crypto rather than `node:crypto`.
 *
 * Time-ordered, but **not** the authoritative ordering of the log: two commands
 * issued in the same millisecond on two machines can tie, so replay and undo
 * key on `commands.seq` instead (§7.5, §12).
 */

/**
 * Web Crypto — the only platform API this package touches. Declared here rather
 * than by widening `lib`, so nothing else in the shared package can quietly
 * start depending on the DOM or on Node.
 */
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** Timestamp of the last id handed out, in milliseconds. */
let lastMillis = 0;
/** Sub-millisecond counter, keeping ids issued in one millisecond in order. */
let counter = 0;

/**
 * 48-bit big-endian millisecond timestamp, then a 12-bit counter, then 62 bits
 * of randomness, with the version and variant bits fixed in between.
 *
 * The counter is seeded into the *lower half* of its range so a burst has room
 * to increment (RFC 9562 §6.2, method 1). A clock that jumps backwards does not
 * produce a smaller id: the previous millisecond is reused and the counter
 * carries on, which keeps the sequence monotonic without waiting on the clock.
 */
export function uuidv7(): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);

  const millis = Date.now();
  if (millis > lastMillis) {
    lastMillis = millis;
    counter = (((random[6]! & 0x0f) << 8) | random[7]!) & 0x07ff;
  } else {
    counter += 1;
    if (counter > 0x0fff) {
      lastMillis += 1;
      counter = 0;
    }
  }

  const bytes = random;
  bytes[0] = Math.floor(lastMillis / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(lastMillis / 0x100000000) & 0xff;
  bytes[2] = (lastMillis >>> 24) & 0xff;
  bytes[3] = (lastMillis >>> 16) & 0xff;
  bytes[4] = (lastMillis >>> 8) & 0xff;
  bytes[5] = lastMillis & 0xff;
  // Version 7 in the high nibble, the counter's top four bits below it.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  // RFC 4122 variant: the two high bits of byte 8 are `10`.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(bytes);
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

function format(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    out += HEX[bytes[index]!]!;
  }
  return out;
}
