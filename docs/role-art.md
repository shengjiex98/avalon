# Role portraits

Every role a player can be dealt has a portrait: 110px on the reveal card, 36px
beside a name in the role list, the player list, and the end-of-game summary.
They all come out of one image, `public/art/jrpg-role-atlas.webp`, so a phone
opening the game fetches a single file rather than eighteen.

## The atlas

The atlas is a grid of 362px square tiles, four columns by five rows, one role
per tile. `public/styles.css` slices it with `background-size: 400% 500%` and a
`background-position` per role:

|       | col 0        | col 1     | col 2     | col 3    |
| ----- | ------------ | --------- | --------- | -------- |
| row 0 | merlin       | percival  | servant   | morgana  |
| row 1 | mordred      | assassin  | minion    | oberon   |
| row 2 | werewolf     | seer      | robber    | villager |
| row 3 | troublemaker | drunk     | insomniac | mason    |
| row 4 | hunter       | tanner    | —         | —        |

Rows 0 and 1 are Avalon, rows 2 to 4 are One Night Ultimate Werewolf, and
`minion` is shared because both games deal a role by that name. The two free
slots in row 4 are room for a role that does not exist yet.

Three places have to agree about that grid — the layout, the stylesheet, and the
atlas that shipped. `scripts/role_art.py` holds the layout, and
`test/role-art.test.js` checks the stylesheet against it: every role positioned,
no two roles on the same tile, and every tile inside the atlas the repository
actually contains. That last check is not pedantry. Six roles used to borrow
another role's face — the Drunk was a healthy village girl with a basket of
flowers, the Tanner wore Oberon's antlers — and nothing in the browser can
report a portrait that is merely wrong.

## Replacing a portrait

The tiles are the art; the atlas is built from them.

```bash
python3 -m pip install pillow
# put a 362x362 tile at public/art/tiles/<role>.webp, then
python3 scripts/build-role-atlas.py
npm test
```

A tile is 362x362 with transparency outside its frame. Anything that is not
that size is scaled to fit, which is worth avoiding for painted work.

## The six placeholders

`drunk`, `insomniac`, `troublemaker`, `mason`, `hunter`, and `tanner` have no
painted portrait yet. Rather than wear someone else's face they carry a gold
emblem — a tankard, a sleepless eye, the exchange sign, a trowel over brick, a
drawn bow, a pelt on a rack — drawn by `scripts/render-role-emblems.py` on the
frame lifted off a painted tile. They read at both sizes and they are at least
about the right role, but they are placeholders: a painted bust dropped into
`public/art/tiles/` replaces one for good. That script writes only the tiles
that are missing, so it cannot paint over a portrait somebody has since drawn;
`--force` redraws them all.

The existing portraits are painted anime busts, front-facing, shoulders in
frame, lit from the upper left against a deep blue night, inside a gold ring
with four diamond studs, transparent outside the ring. A prompt for a matching
one runs roughly:

> A detailed JRPG-style anime portrait bust of **<the role>**, facing the
> viewer, shoulders in frame, dramatic rim lighting against a deep midnight-blue
> background, framed in an ornate circular gold border with four diamond studs,
> transparent outside the frame, painted fantasy game art, square, 362x362.

with the role written as:

| Role         | Who they are                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| drunk        | a ruddy, half-lidded tavern drunkard raising a foaming tankard, tunic askew        |
| insomniac    | a hollow-eyed figure in nightclothes holding a guttering candle, wide awake        |
| troublemaker | a smirking hooded youth palming two cards behind their back                        |
| mason        | a broad stonemason in a dusty apron, trowel in hand, a night-watch lantern at hip  |
| hunter       | a grizzled archer with a longbow and a nocked arrow, hood up                        |
| tanner       | a weary leatherworker in a stained apron holding a curved skiving knife             |

The Chinese names differ in flavour from the English ones and are worth reading
before drawing: the Mason is 守夜人, a night watchman, and the Tanner is 皮匠, a
leather worker who wins only by dying.

## Adding a role

Give it a slot in `SLOTS` in `scripts/role_art.py`, put its tile in
`public/art/tiles/`, add a `.portrait-<role>` rule to `public/styles.css`, and
rebuild the atlas. The tests will tell you if you missed one of those.
