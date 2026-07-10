import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendClerkInvitationEmail, revokeClerkInvitation } from './clerk';

describe('sendClerkInvitationEmail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid email without calling Clerk', async () => {
    const result = await sendClerkInvitationEmail({
      secretKey: 'sk_test',
      emailAddress: 'not-an-email',
      redirectUrl: 'https://komikone.com/join/ABC',
    });
    expect(result).toEqual({ ok: false, error: 'Invalid email address' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends invitation with notify and redirect_url', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv_123' }), { status: 200 }),
    );

    const result = await sendClerkInvitationEmail({
      secretKey: 'sk_test',
      emailAddress: 'Friend@Example.com',
      redirectUrl: 'https://komikone.com/join/XYZ123',
    });

    expect(result).toEqual({ ok: true, invitationId: 'inv_123' });
    expect(fetch).toHaveBeenCalledWith('https://api.clerk.com/v1/invitations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk_test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: 'friend@example.com',
        redirect_url: 'https://komikone.com/join/XYZ123',
        notify: true,
        ignore_existing: false,
      }),
    });
  });

  it('returns Clerk error message on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: 'duplicate', long_message: 'Invitation already exists' }] }),
        { status: 422 },
      ),
    );

    const result = await sendClerkInvitationEmail({
      secretKey: 'sk_test',
      emailAddress: 'friend@example.com',
      redirectUrl: 'https://komikone.com/join/XYZ',
    });

    expect(result).toEqual({ ok: false, error: 'Invitation already exists' });
  });
});

describe('revokeClerkInvitation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revokes invitation via Clerk API', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv_123', status: 'revoked' }), { status: 200 }),
    );

    const result = await revokeClerkInvitation({
      secretKey: 'sk_test',
      invitationId: 'inv_123',
    });

    expect(result).toEqual({ ok: true, invitationId: 'inv_123' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/invitations/inv_123/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('treats already-revoked as success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: 'already revoked' }] }),
        { status: 404 },
      ),
    );

    const result = await revokeClerkInvitation({
      secretKey: 'sk_test',
      invitationId: 'inv_old',
    });

    expect(result).toEqual({ ok: true, invitationId: 'inv_old' });
  });
});
