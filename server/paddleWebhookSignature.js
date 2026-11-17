function parsePaddleSignatureHeader(signature) {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 4096) {
    throw new Error('invalid_paddle_webhook_signature_header');
  }
  const timestamps = [];
  const hashes = [];
  for (const rawPart of signature.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) throw new Error('invalid_paddle_webhook_signature_header');
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 'ts') timestamps.push(value);
    else if (key === 'h1') hashes.push(value);
  }
  if (timestamps.length !== 1 || !/^[0-9]{1,12}$/.test(timestamps[0]) ||
      !Number.isSafeInteger(Number(timestamps[0])) || Number(timestamps[0]) <= 0 ||
      hashes.length < 1 || hashes.length > 10 ||
      hashes.some(hash => !/^[a-f0-9]{64}$/i.test(hash))) {
    throw new Error('invalid_paddle_webhook_signature_header');
  }
  return { timestamp: timestamps[0], hashes };
}

/**
 * Paddle may include multiple h1 values during secret rotation. SDK v3.11.1
 * validates one h1 at a time, so try each candidate independently while
 * retaining the SDK's timestamp and constant-time signature verification.
 */
export async function unmarshalPaddleWebhook({ unmarshal, rawBody, secret, signature }) {
  if (typeof unmarshal !== 'function' || typeof rawBody !== 'string' ||
      rawBody.length === 0 || typeof secret !== 'string' || secret.length === 0) {
    throw new Error('invalid_paddle_webhook_verification_input');
  }
  const { timestamp, hashes } = parsePaddleSignatureHeader(signature);
  let lastError;
  for (const hash of hashes) {
    try {
      return await unmarshal(rawBody, secret, `ts=${timestamp};h1=${hash}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('invalid_paddle_webhook_signature');
}
