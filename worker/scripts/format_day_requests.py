"""Format the no-days roster into one text-ready block per household.

Grouping is by last name because last year's return reg ran as households texting back
together, and a single "same as last year?" question per family is far more likely to get
answered than 51 individual ones. Last year's days are shown as a prompt, never written to
the board — a guessed requested-day is indistinguishable from a confirmed one and gets a
real badge bought against it.
"""
import collections
import json
import sys

LABELS = [('p', 'Preview'), ('t', 'Thu'), ('f', 'Fri'), ('s', 'Sat'), ('u', 'Sun')]


def days_of(row):
    return tuple(row[k] for k, _ in LABELS)


def spell(row):
    return ', '.join(name for key, name in LABELS if row[key] == 1) or 'none recorded'


def join_names(names):
    if len(names) <= 2:
        return ' and '.join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


def main(src, dest):
    rows = json.load(open(src))[0]['results']
    households = collections.OrderedDict()
    for row in rows:
        households.setdefault(row['ln'], []).append(row)

    out = [
        'OCT 17 — BADGE DAYS TO COLLECT',
        f'{len(rows)} people with no days set, across {len(households)} households.',
        "Last year's days are a prompt, not a default — nothing is on the board until they confirm.",
        '=' * 74,
    ]

    unknown = []
    for last_name, people in households.items():
        out.append(f'\n## {last_name}  ({len(people)})')
        for person in people:
            flags = []
            if person['bt'] == 'JUNIOR':
                flags.append('JUNIOR last yr — check if they aged out')
            if not person['mid']:
                flags.append('NO MEMBER ID')
            if person['p'] == -1:
                flags.append('no history')
                unknown.append(f"{person['fn']} {person['ln']}")
            suffix = f"   [{'; '.join(flags)}]" if flags else ''
            history = 'not in last year\'s return reg' if person['p'] == -1 else spell(person)
            out.append(f"  {person['fn']} {person['ln']} ({person['mid'] or '—'}){suffix}")
            out.append(f'      last year: {history}')

        known = [p for p in people if p['p'] != -1]
        names = join_names([p['fn'] for p in people])
        if known and len({days_of(p) for p in known}) == 1 and len(known) == len(people):
            out.append(
                f'\n      TEXT: "Hey! SDCC 2027 return reg is Sat Oct 17. Last year {names} '
                f'did {spell(known[0])} — same again? Just reply with the days."'
            )
        else:
            out.append(
                f'\n      TEXT: "Hey! SDCC 2027 return reg is Sat Oct 17. What days does each '
                f'of you want? ({names})"'
            )

    out.append('\n' + '=' * 74)
    if unknown:
        out.append(f'No last-year history, ask from scratch: {", ".join(unknown)}')

    text = '\n'.join(out)
    open(dest, 'w').write(text)
    print(text)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
