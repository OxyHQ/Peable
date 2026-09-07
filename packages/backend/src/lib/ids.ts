const ID_ENTROPY_BYTES = 12;
const SECRET_ENTROPY_BYTES = 16;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Mint a public id.
 *
 * The prefix union is CLOSED on purpose: a public id is the thing a merchant
 * quotes back in a support conversation, and a typo'd prefix produces an id
 * that looks valid, is unique, and belongs to no object type anyone can look
 * up. A new object type adds itself here deliberately.
 */
export function newId(
  prefix: 'pi' | 'evt' | 'merch' | 'link' | 'cs' | 'ca' | 'tr' | 're' | 'dp'
): string {
  return `${prefix}_${randomHex(ID_ENTROPY_BYTES)}`;
}

export function clientSecretFor(id: string): string {
  return `${id}_secret_${randomHex(SECRET_ENTROPY_BYTES)}`;
}
