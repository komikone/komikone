/** Clerk application invitations — sends signup email, no Organizations required. */

export type ClerkInviteResult =
  | { ok: true; invitationId: string }
  | { ok: false; error: string };

function parseInviteEmailError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const errs = (body as { errors?: { message?: string; long_message?: string }[] }).errors;
    const raw = errs?.[0]?.long_message ?? errs?.[0]?.message;
    if (raw) return raw.replace(/\bClerk\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  }
  return `Could not send invitation email (${status})`;
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
      // Someone who already signed in before being invited still needs the join link.
      // Failing the whole invite in that case leaves them with no way in.
      ignore_existing: true,
    }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return { ok: false, error: parseInviteEmailError(body, res.status) };
  }

  const id = body && typeof body === 'object' && 'id' in body
    ? String((body as { id: string }).id)
    : '';
  return { ok: true, invitationId: id };
}

/**
 * Primary verified email for a Clerk user. Read from the Backend API rather than the JWT so
 * this works without requiring a specific claim in the `komikone` JWT template.
 * Best-effort: identity linking falls back to Member ID when this is unavailable.
 */
export async function fetchClerkUserEmail(opts: {
  secretKey: string;
  userId: string;
}): Promise<string> {
  if (!opts.secretKey || !opts.userId) return '';

  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(opts.userId)}`, {
      headers: { Authorization: `Bearer ${opts.secretKey}` },
    });
    if (!res.ok) return '';

    const body = await res.json() as {
      primary_email_address_id?: string;
      email_addresses?: { id?: string; email_address?: string; verification?: { status?: string } }[];
    };
    const addresses = body.email_addresses ?? [];
    const primary = addresses.find((a) => a.id === body.primary_email_address_id) ?? addresses[0];
    const email = primary?.email_address?.trim().toLowerCase() ?? '';

    // An unverified address is attacker-controlled, so it must not be usable to claim a row.
    if (primary?.verification?.status && primary.verification.status !== 'verified') return '';
    return email;
  } catch {
    return '';
  }
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
  const message = parseInviteEmailError(body, res.status);
  // Already revoked or accepted — treat as non-fatal for delete/resend prep
  if (res.status === 404 || /revoked|not found|already/i.test(message)) {
    return { ok: true, invitationId };
  }
  return { ok: false, error: message };
}
