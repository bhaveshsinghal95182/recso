// The board's parser and serializer round-trip, so a drag cannot mangle board.md.
//
// This is the one check the board actually needs. Every mutation in the UI --
// a drag, an edit, a quick-add -- rewrites the entire file from the parsed
// structure. So if `serialize(parse(x))` is not `x`, then the first time you
// move a card you also silently reformat, reorder or drop everything the parser
// did not understand, and you find out weeks later from a git diff.
//
// The interesting cases are all about what the structure does *not* model: the
// preamble, each column's intro prose, blank lines inside a body. Those have to
// survive by being carried through verbatim rather than regenerated, and that is
// what most of the fixtures below are poking at.
//
// usage: node scripts/board-check.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBoard, serializeBoard } from './board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** The property everything else depends on. */
const roundTrips = (text) => serializeBoard(parseBoard(text)) === text;

const firstDiff = (text) => {
  const a = text.split('\n');
  const b = serializeBoard(parseBoard(text)).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `line ${i + 1}: ${JSON.stringify(a[i])} -> ${JSON.stringify(b[i])}`;
  }
  return '';
};

console.log('\n  board.md');

const real = await readFile(path.join(here, '..', 'board.md'), 'utf8');
check('the real board round-trips byte-identical', roundTrips(real), firstDiff(real));

const board = parseBoard(real);
check('columns were found', board.columns.length > 0, `${board.columns.length} columns`);
check(
  'cards were found',
  board.columns.some((c) => c.cards.length > 0),
  `${board.columns.reduce((n, c) => n + c.cards.length, 0)} cards`,
);
check('the preamble survived', board.preamble.length > 0);

console.log('\n  fixtures');

const fixtures = {
  'a card with no tags and no body': '# b\n\n## Todo\n\n### Just a title\n',
  'a card with tags but no body': '# b\n\n## Todo\n\n### Title\n\n`bug` `engine`\n',
  'a card with a body but no tags': '# b\n\n## Todo\n\n### Title\n\nSome prose.\n',
  'an empty column between two full ones':
    '# b\n\n## A\n\n### One\n\n## Empty\n\n## C\n\n### Two\n',
  'a column intro above its cards': '# b\n\n## Todo\n\n_Sorted weekly._\n\n### One\n\nBody.\n',
  'a preamble under the title': '# b\n\nHow this file works.\n\n## Todo\n\n### One\n',
  'a blank line inside a body': '# b\n\n## Todo\n\n### One\n\nFirst para.\n\nSecond para.\n',
  'em dashes and non-ascii': '# b\n\n## Todo\n\n### 170–280ms — the last big number\n\nÜnicode ✓\n',
  'a backticked line after body text stays body':
    '# b\n\n## Todo\n\n### One\n\nSee also:\n\n`velocity/src/engine`\n',
  'a board with no cards at all': '# b\n\n## Todo\n\n## Done\n',
};

for (const [label, text] of Object.entries(fixtures)) {
  check(label, roundTrips(text), firstDiff(text));
}

console.log('\n  semantics');

const tagged = parseBoard('# b\n\n## Todo\n\n### One\n\n`bug` `engine`\n\nBody here.\n');
check(
  'the tag line becomes tags, not body',
  tagged.columns[0].cards[0].tags.join(',') === 'bug,engine',
);
check('the body excludes the tag line', tagged.columns[0].cards[0].body === 'Body here.');

const late = parseBoard('# b\n\n## Todo\n\n### One\n\nSee also:\n\n`some/path`\n');
check('a backticked line after prose is not tags', late.columns[0].cards[0].tags.length === 0);

// Moving a card is the operation the whole tool exists for, so it gets its own
// assertion: nothing may be lost or altered, only relocated.
const before = parseBoard(real);
const moved = parseBoard(real);
const from = moved.columns.find((c) => c.cards.length);
const to = moved.columns.find((c) => c !== from);
to.cards.push(from.cards.shift());

const bodyLines = (b) =>
  b.columns
    .flatMap((c) => c.cards)
    .flatMap((c) => [c.title, ...c.tags, c.body])
    .sort();

check(
  'moving a card relocates it and changes nothing else',
  JSON.stringify(bodyLines(before)) === JSON.stringify(bodyLines(moved)),
);
check('the moved board still round-trips', roundTrips(serializeBoard(moved)));

console.log('\n  formatting');

const out = serializeBoard(parseBoard(real));
check('ends with exactly one newline', out.endsWith('\n') && !out.endsWith('\n\n'));
check('no trailing whitespace on any line', !/[ \t]+$/m.test(out));
check('no run of three or more blank lines', !/\n{4}/.test(out));

console.log(`\n  ${failures ? `${failures} failed` : 'all passed'}\n`);
process.exitCode = failures ? 1 : 0;
