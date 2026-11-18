// Token Radar: the program behind the dashboard (Node 22, standard library only).
//
// It reads the sealed DefiLlama snapshot — /input/snapshot.json, or --input
// <file|directory> — scores every pre-token protocol with the radar-6 model in
// lib/model.ts (a size curve fitted to the tokens that already trade, tested
// out of sample, with shrunk category offsets and family fallbacks, times
// launch odds from a logistic regression on the snapshot's own token
// statuses, with an age-bucket token rate as the fourth feature), and writes
// the ranked board to
// /output/board.json plus the dashboard's data as /output/data.js. The static
// dashboard (dashboard/) and the screenshots (screenshots/) are copied to
// /output unchanged. Last, it writes /output/dossier.json, the summary the
// judge reads, with the vendored make.fun library.
//
// The dashboard is a static page: no framework, no network. Its three files
// read /output/data.js, which this program writes from the same board the
// gate checks. Run it outside the grader's container with MAKEFUN_OUTPUT_DIR
// standing in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_MAX = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Stop with a message on stderr and the given exit code. */
function fail(message: string, code: number): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

/** Make a directory and its parents, if they are not there already. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** The value of --name <value> or --name=<value> on the command line, else the fallback. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const spaced = argv.indexOf(`--${name}`);
  if (spaced >= 0 && spaced + 1 < argv.length) return argv[spaced + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 3);
  return fallback;
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  ensureDir(to);
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

function main(): void {
  const inputArg = flag('input', '/input');
  const inputFile = inputArg.endsWith('.json')
    ? inputArg
    : join(inputArg, 'snapshot.json');
  if (existsSync(inputFile) === false) {
    fail(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const raw = readFileSync(inputFile, 'utf8');
  const snapshot = parseSnapshot(raw);
  const scored = buildRadar(snapshot);
  const issue = boardIssue(scored.board, snapshot);
  if (issue !== null) fail(`token radar: the model wrote a board the gate refuses: ${issue}`, 1);

  ensureDir(out);
  const boardJson = JSON.stringify({ rows: scored.board }) + '\n';
  writeFileSync(join(out, 'board.json'), boardJson);
  const script = dataScript(scored.radar);
  writeFileSync(join(out, 'data.js'), script);

  copyDir(join(REPO, 'dashboard'), join(out, 'dashboard'));
  const shots = copyDir(join(REPO, 'screenshots'), join(out, 'screenshots'));
  if (shots.length <= 2) {
    fail(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
  }
  for (const shot of shots) {
    if (!SHOT_NAME.test(shot)) {
      fail(`token radar: screenshots/${shot}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: SHOT_CAPS, dashboard: DASHBOARD_CAPS }));

  const scoredLine = `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${scored.board.length} rows scored (${scored.radar.early_size} early, ${scored.radar.live_size} live set aside)`;
  const wroteLine = `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}`;
  process.stdout.write(scoredLine + '\n' + wroteLine + '\n');
}

main();
