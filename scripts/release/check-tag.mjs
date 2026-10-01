// Fail when a release tag doesn't match package.json's version: electron-builder
// names the release and the update feed after the version, not the tag.
//
//   node scripts/release/check-tag.mjs v2.0.1
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

if (tag !== `v${version}`) {
  console.error(`::error::tag ${tag} doesn't match package.json's version ${version} (expected v${version})`);
  process.exit(1);
}
console.log(`tag ${tag} matches package.json`);
