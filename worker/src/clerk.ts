/** Clerk application invitations — sends signup email, no Organizations required. */

export type ClerkInviteResult =
  | { ok: true; invitationId: string }
  | { ok: false; error: string };

function parseClerkError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const errs = (body as { errors?: { message?: string; long_message?: string }[] }).errors;
    if (errs?.[0]?.long_message) return errs[0].long_message;
    if (errs?.[0]?.message) return errs[0].message;
  }
  return `Clerk invitation failed (${status})`;
}

export async function sendClerkInvitationEmail(opts: {
  secretKey: string;
  emailAddress: string;
  redirectUrl: string;
}): Promise<ClerkInviteResult> {
  const email = opts.emailAddress.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Invalid email address' };
  }

  const res = await fetch('https://api.clerk.com/v1/invitations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email_address: email,
      redirect_url: opts.redirectUrl,
      notify: true,
      ignore_existing: false,
    }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return { ok: false, error: parseClerkError(body, res.status) };
  }

  const id = body && typeof body === 'object' && 'id' in body
    ? String((body as { id: string }).id)
    : '';
  return { ok: true, invitationId: id };
}

/** Revoke a pending Clerk invitation. Best-effort — ignores already-revoked. */
export async function revokeClerkInvitation(opts: {
  secretKey: string;
  invitationId: string;
}): Promise<ClerkInviteResult> {
  const invitationId = opts.invitationId.trim();
  if (!invitationId) {
    return { ok: false, error: 'Missing invitation id' };
  }

  const res = await fetch(
    `https://api.clerk.com/v1/invitations/${encodeURIComponent(invitationId)}/revoke`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (res.ok) {
    const body = await res.json().catch(() => null);
    const id = body && typeof body === 'object' && 'id' in body
      ? String((body as { id: string }).id)
      : invitationId;
    return { ok: true, invitationId: id };
  }

  const body = await res.json().catch(() => null);
  const message = parseClerkError(body, res.status);
  // Already revoked or accepted — treat as non-fatal for delete/resend prep
  if (res.status === 404 || /revoked|not found|already/i.test(message)) {
    return { ok: true, invitationId };
  }
  return { ok: false, error: message };
}
