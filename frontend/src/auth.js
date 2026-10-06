export class AuthRequiredError extends Error {
  constructor(message = 'session required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export function signInUrl(email = 'doctor@example.com') {
  return `/api/auth/oidc/start?email=${encodeURIComponent(email)}`;
}

/** Returns true when the browser has a valid session cookie. */
export async function hasSession() {
  const response = await fetch('/api/devices', { credentials: 'include' });
  return response.ok;
}
