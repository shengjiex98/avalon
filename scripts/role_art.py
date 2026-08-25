"""Shared geometry for the role portrait atlas.

The atlas is a grid of square tiles, one per role, drawn at TILE pixels and
laid out by SLOTS. `public/styles.css` mirrors this layout in percentages, and
`test/role-art.test.js` checks the two agree, so change the layout here and in
the stylesheet together.
"""

TILE = 362
COLS = 4
ROWS = 5

# Row 0-1 are Avalon, rows 2-4 One Night Ultimate Werewolf. `None` is a slot
# kept free for a role that does not exist yet.
SLOTS = [
    ['merlin',       'percival', 'servant',   'morgana'],
    ['mordred',      'assassin', 'minion',    'oberon'],
    ['werewolf',     'seer',     'robber',    'villager'],
    ['troublemaker', 'drunk',    'insomniac', 'mason'],
    ['hunter',       'tanner',   None,        None],
]

ROLES = [role for row in SLOTS for role in row if role]


def position(role):
    """The (column, row) of a role's tile."""
    for r, row in enumerate(SLOTS):
        for c, name in enumerate(row):
            if name == role:
                return c, r
    raise KeyError(role)


def percentages(role):
    """The CSS background-position a role's tile needs, as (x%, y%)."""
    c, r = position(role)
    return c * 100 / (COLS - 1), r * 100 / (ROWS - 1)
