"""Mint one year-5 invite per person on the Oct 17 board who has no account yet.

Codes are generated here rather than through the API so each invite can carry the
person's name as its label — the bulk endpoint only takes a numbered prefix, which
would leave you matching anonymous codes to people by hand.

Alphabet and length mirror generateInviteCode in worker/src/index.ts.
"""
import json
import secrets
import sys

CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
YEAR_ID = 5
JOIN_BASE = 'https://komikone.com/join'


def code():
    return ''.join(secrets.choice(CHARS) for _ in range(12))


def sql_str(value):
    return "'" + value.replace("'", "''") + "'"


def main(roster_path, invited_by, sql_out, list_out):
    people = json.load(open(roster_path))[0]['results']
    rows, listing = [], []
    seen = set()

    for person in people:
        name = f"{person['first_name']} {person['last_name']}"
        c = code()
        while c in seen:
            c = code()
        seen.add(c)
        rows.append(
            f'  ({YEAR_ID}, {sql_str(c)}, {sql_str(name)}, {sql_str(invited_by)})'
        )
        listing.append((name, person['member_id'], f'{JOIN_BASE}/{c}'))

    sql = (
        '-- One invite per unregistered person on the Oct 17 board.\n'
        'INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id) VALUES\n'
        + ',\n'.join(rows)
        + ';\n'
    )
    open(sql_out, 'w').write(sql)

    width = max(len(n) for n, _, _ in listing)
    out = [
        'OCT 17 JOIN LINKS — one per person, single use.',
        'Send each person only their own link; a used code is dead for everyone else.',
        '',
    ]
    out += [f'{n:<{width}}  {m:<18}  {u}' for n, m, u in listing]
    open(list_out, 'w').write('\n'.join(out) + '\n')

    print(f'{len(listing)} invites prepared')


if __name__ == '__main__':
    main(*sys.argv[1:])
