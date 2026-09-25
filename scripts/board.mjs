// A kanban board over `board.md`, and nothing else.
//
// The point of this tool is what it refuses to own. It has no database, no
// config and no state of its own -- `board.md` is the truth, and this is a view
// that happens to be able to write back to it. Delete this script and the board
// still works, because the board was always just a markdown file.
//
// That constraint is the whole design. A tracker with its own storage is a
// second copy of the project's state, and a second copy drifts -- which is
// exactly how `tasks.md` ended up listing two features that had already
// shipped. Keeping the data in the repo means it lands in the same commit as
// the code and every agent working here reads it for free.
//
// Zero dependencies on purpose. This is dev tooling that must not break when a
// package upgrade lands, and `node:http` plus `node:fs` is genuinely enough.
//
// usage:
//   node scripts/board.mjs                 open the board in a browser
//   node scripts/board.mjs list            print the board to the terminal
//   node scripts/board.mjs add "title"     file a card in Inbox
//     --tags bug,engine                    ...with tags
//     --column Backlog                     ...somewhere other than Inbox
//     --body "notes"                       ...with a body

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(here, '..', 'board.md');
const UI = path.join(here, 'board.html');

// ---------------------------------------------------------------- parse

// A line of nothing but backticked words is the tag line, e.g. `bug` `engine`.
// Anchored and total so a body that merely opens with `code` is not mistaken
// for one -- the tag line has to be tags and only tags.
const TAG_LINE = /^`[^`]+`(?:\s+`[^`]+`)*$/;

/**
 * Markdown in, board structure out.
 *
 * Everything the editor does not model is preserved verbatim rather than
 * regenerated: the `#` title, the preamble under it, and each column's intro
 * text. The serializer writes those back untouched, so hand-written prose
 * survives a drag-and-drop -- which is the difference between a file you can
 * still edit by hand and one the tool has taken over.
 */
export function parseBoard(text) {
  const lines = text.split('\n');
  const board = { title: '', preamble: [], columns: [] };

  let column = null;
  let card = null;

  const flushCard = () => {
    if (!card) return;
    card.body = trimBlank(card.body).join('\n');
    column.cards.push(card);
    card = null;
  };

  for (const line of lines) {
    if (!board.title && line.startsWith('# ')) {
      board.title = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      flushCard();
      column = { name: line.slice(3).trim(), intro: [], cards: [] };
      board.columns.push(column);
      continue;
    }

    if (line.startsWith('### ') && column) {
      flushCard();
      card = { title: line.slice(4).trim(), tags: [], body: [] };
      continue;
    }

    if (card) {
      // The tag line is only a tag line before any body has been written.
      if (!card.tags.length && !trimBlank(card.body).length && TAG_LINE.test(line.trim())) {
        card.tags = line
          .trim()
          .match(/`[^`]+`/g)
          .map((t) => t.slice(1, -1));
        continue;
      }
      card.body.push(line);
      continue;
    }

    if (column) column.intro.push(line);
    else if (board.title) board.preamble.push(line);
  }

  flushCard();

  for (const c of board.columns) c.intro = trimBlank(c.intro).join('\n');
  board.preamble = trimBlank(board.preamble).join('\n');

  return board;
}

/** Board structure in, markdown out. Round-trips `parseBoard`. */
export function serializeBoard(board) {
  const out = [`# ${board.title}`, ''];

  if (board.preamble) out.push(board.preamble, '');

  for (const column of board.columns) {
    out.push(`## ${column.name}`, '');
    if (column.intro) out.push(column.intro, '');

    for (const c of column.cards) {
      out.push(`### ${c.title}`, '');
      if (c.tags.length) out.push(c.tags.map((t) => `\`${t}\``).join(' '), '');
      if (c.body) out.push(c.body, '');
    }
  }

  // One trailing newline, no trailing blank line -- what Prettier would leave,
  // so committing a board change does not fight the lint-staged hook.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

const trimBlank = (arr) => {
  let start = 0;
  let end = arr.length;
  while (start < end && !arr[start].trim()) start += 1;
  while (end > start && !arr[end - 1].trim()) end -= 1;
  return arr.slice(start, end);
};

const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

const readBoard = async () => {
  const text = await readFile(BOARD, 'utf8');
  return { board: parseBoard(text), hash: hashOf(text) };
};

// ---------------------------------------------------------------- commands

async function commandList() {
  const { board } = await readBoard();
  for (const column of board.columns) {
    const count = column.cards.length;
    console.log(`\n  ${column.name.toUpperCase()}  (${count})`);
    if (!count) console.log('    --');
    for (const card of column.cards) {
      const tags = card.tags.length ? `  [${card.tags.join(' ')}]` : '';
      console.log(`    - ${card.title}${tags}`);
    }
  }
  console.log('');
}

async function commandAdd(argv) {
  const title = argv.find((a) => !a.startsWith('--'));
  if (!title) {
    console.error('usage: node scripts/board.mjs add "title" [--tags a,b] [--column Backlog]');
    process.exitCode = 1;
    return;
  }

  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const text = await readFile(BOARD, 'utf8');
  const board = parseBoard(text);
  const wanted = (flag('column') ?? 'Inbox').toLowerCase();
  const column = board.columns.find((c) => c.name.toLowerCase() === wanted) ?? board.columns[0];

  if (!column) {
    console.error('board.md has no columns -- add a `## Something` heading first');
    process.exitCode = 1;
    return;
  }

  column.cards.unshift({
    title,
    tags: (flag('tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    body: flag('body') ?? '',
  });

  await writeFile(BOARD, serializeBoard(board), 'utf8');
  console.log(`filed in ${column.name}: ${title}`);
}

// ---------------------------------------------------------------- server

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, await readFile(UI, 'utf8'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/board') {
    const { board, hash } = await readBoard();
    return send(res, 200, JSON.stringify({ ...board, hash }));
  }

  if (req.method === 'PUT' && url.pathname === '/api/board') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    // Optimistic concurrency, and the only real data-loss path this tool has:
    // edit board.md in your editor while the board is open and a drag would
    // otherwise silently overwrite you. The client reloads on a 409.
    const current = await readFile(BOARD, 'utf8');
    if (hashOf(current) !== incoming.hash) {
      return send(res, 409, JSON.stringify({ error: 'board.md changed on disk' }));
    }

    const next = serializeBoard(incoming);
    await writeFile(BOARD, next, 'utf8');
    return send(res, 200, JSON.stringify({ hash: hashOf(next) }));
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  // Best effort. A headless box or a locked-down desktop just gets the URL.
  exec(cmd, () => {});
}

async function commandServe(argv) {
  const portFlag = argv.indexOf('--port');
  const port = portFlag === -1 ? 5178 : Number(argv[portFlag + 1]);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      send(res, 500, JSON.stringify({ error: String(err.message ?? err) }));
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} is busy -- try: pnpm board --port ${port + 1}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  recso board  ${url}`);
    console.log('  editing board.md directly is fine -- reload to pick it up\n');
    openBrowser(url);
  });
}

// Only dispatch when run directly. Importing this module has to be free of
// side effects, or the round-trip check below would boot a web server.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'list') await commandList();
  else if (command === 'add') await commandAdd(rest);
  else await commandServe(command ? [command, ...rest] : rest);
}
