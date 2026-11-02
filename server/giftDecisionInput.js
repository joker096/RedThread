export function validateGiftDecisionInput(body, publicReference) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => key !== 'action') ||
      !['accept', 'decline'].includes(body.action)) {
    return { valid: false, error: 'invalid_gift_decision' };
  }
  if (typeof publicReference !== 'string' || !/^gift_[a-f0-9]{32}$/i.test(publicReference)) {
    return { valid: false, error: 'gift_request_not_available', notFound: true };
  }
  return { valid: true, action: body.action, publicReference };
}
