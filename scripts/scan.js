'use strict';

// Scans the built Windows binaries in dist/ and produces a verifiable report.
//
// The released binaries are not code-signed, so this script exists to give anyone who
// downloads them a way to check them: a SHA-256 they can reproduce locally, a Windows
// Defender verdict, and a VirusTotal link for the same hash.
//
// Zero dependencies. Usage:
//   node scripts/scan.js [--dir <path>] [--require-scan]
//   VT_API_KEY=<key> node scripts/scan.js     (also queries the VirusTotal API)
//
// --require-scan also fails when no scanner produced a verdict at all. The release workflow
// uses it: a release that ships with no antivirus evidence is not the release this project
// promises. Without the flag that case is only a warning, so the script stays useful on a
// machine that has no Defender.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'dist');

const DEFENDER_PLATFORM_DIR = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform';
const DEFENDER_FALLBACK = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
const DEFENDER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFENDER_STATUS_TIMEOUT_MS = 60 * 1000;

// The app's own code, unpacked next to the installers. Hashing it lets a reader check the
// code that actually runs without hashing a 95 MB binary.
const APP_ASAR_RELATIVE = path.join('win-unpacked', 'resources', 'app.asar');

const VT_HOST = 'www.virustotal.com';
const VT_GUI_URL = 'https://www.virustotal.com/gui/file/';
const VT_TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------- arguments

const USAGE = 'Usage: node scripts/scan.js [--dir <path>] [--require-scan]';

function parseArgs(argv) {
  let dir = DEFAULT_DIR;
  let requireScan = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      if (!argv[i + 1]) fail('scan: --dir requires a path argument.');
      dir = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i].startsWith('--dir=')) {
      dir = path.resolve(argv[i].slice('--dir='.length));
    } else if (argv[i] === '--require-scan') {
      requireScan = true;
    } else {
      fail(`scan: unknown argument "${argv[i]}". ${USAGE}`);
    }
  }
  return { dir, requireScan };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------- binaries

function findBinaries(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort();
}

// Streamed so a multi-hundred-megabyte installer is never held in memory at once.
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------- defender

// Defender updates itself into versioned directories; the newest one holds the current
// MpCmdRun.exe. Compare version segments numerically ("4.18.9" must sort below "4.18.10").
function compareVersions(a, b) {
  const parse = (name) => name.split(/[.-]/).map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findMpCmdRun() {
  if (fs.existsSync(DEFENDER_PLATFORM_DIR)) {
    const candidates = fs
      .readdirSync(DEFENDER_PLATFORM_DIR)
      .filter((name) => /^\d/.test(name))
      .sort(compareVersions)
      .reverse()
      .map((name) => path.join(DEFENDER_PLATFORM_DIR, name, 'MpCmdRun.exe'));
    const found = candidates.find((file) => fs.existsSync(file));
    if (found) return found;
  }
  if (fs.existsSync(DEFENDER_FALLBACK)) return DEFENDER_FALLBACK;
  return null;
}

// PowerShell serialises a DateTime either as ISO 8601 or as "/Date(1754260000000)/".
function toIsoDate(value) {
  if (!value) return null;
  const epoch = /^\/Date\((\d+)/.exec(String(value));
  const date = epoch ? new Date(Number(epoch[1])) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

// Which engine and signature set produced the verdicts below. A "clean" from year-old
// signatures is worth much less than a clean from current ones, so record them. Nothing here
// is fatal: on a machine without Defender this returns null and the report says so.
function findDefenderStatus() {
  const script =
    'Get-MpComputerStatus | Select-Object AMEngineVersion,AntivirusSignatureVersion,' +
    'AntivirusSignatureLastUpdated | ConvertTo-Json -Compress';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: DEFENDER_STATUS_TIMEOUT_MS,
    windowsHide: true
  });

  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    const status = JSON.parse(result.stdout);
    return {
      engineVersion: status.AMEngineVersion || null,
      signatureVersion: status.AntivirusSignatureVersion || null,
      signatureUpdated: toIsoDate(status.AntivirusSignatureLastUpdated)
    };
  } catch {
    return null;
  }
}

// Exit code 0 = clean, 2 = threat found. Anything else means the scan itself failed.
function scanWithDefender(mpCmdRun, file) {
  if (!mpCmdRun) {
    return {
      verdict: 'unavailable',
      exitCode: null,
      output: 'MpCmdRun.exe not found on this system.'
    };
  }

  const result = spawnSync(
    mpCmdRun,
    ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'],
    { encoding: 'utf8', timeout: DEFENDER_TIMEOUT_MS, windowsHide: true }
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(0, 4000);

  if (result.error) {
    return {
      verdict: 'error',
      exitCode: null,
      output: `${result.error.message}\n${output}`.trim()
    };
  }
  if (result.status === 0) return { verdict: 'clean', exitCode: 0, output };
  if (result.status === 2) return { verdict: 'threat', exitCode: 2, output };
  return { verdict: 'error', exitCode: result.status, output };
}

// ---------------------------------------------------------------- virustotal

function vtRequest(hash, apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: VT_HOST,
        path: `/api/v3/files/${hash}`,
        method: 'GET',
        headers: { 'x-apikey': apiKey, accept: 'application/json' }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );

    req.setTimeout(VT_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${VT_TIMEOUT_MS} ms`));
    });
    req.on('error', (err) => resolve({ status: null, error: err.message }));
    req.end();
  });
}

async function lookupVirusTotal(hash, apiKey) {
  const url = VT_GUI_URL + hash;
  if (!apiKey) {
    return {
      url,
      status: 'skipped',
      note: 'VT_API_KEY not set; use the link above to check manually.'
    };
  }

  const res = await vtRequest(hash, apiKey);

  if (res.status === null) {
    return { url, status: 'error', note: `VirusTotal request failed: ${res.error}` };
  }
  if (res.status === 404) {
    return {
      url,
      status: 'not_found',
      note: 'VirusTotal has never seen this hash. Upload the file at virustotal.com to have it analysed.'
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { url, status: 'error', note: `VirusTotal rejected the API key (HTTP ${res.status}).` };
  }
  if (res.status === 429) {
    return {
      url,
      status: 'error',
      note: 'VirusTotal rate limit reached (HTTP 429). Try again later.'
    };
  }
  if (res.status !== 200) {
    return { url, status: 'error', note: `Unexpected VirusTotal response (HTTP ${res.status}).` };
  }

  try {
    const stats = JSON.parse(res.body).data.attributes.last_analysis_stats;
    return { url, status: 'ok', stats };
  } catch (err) {
    return { url, status: 'error', note: `Could not parse VirusTotal response: ${err.message}` };
  }
}

// ---------------------------------------------------------------- app code

// The packaged application code — this repository minus node_modules — is identical in both
// binaries and is a tiny fraction of the download; the rest is the Electron runtime. Hashing
// it separately lets a user check the code that actually runs.
async function hashAppCode(dir) {
  const file = path.join(dir, APP_ASAR_RELATIVE);
  if (!fs.existsSync(file)) return null;
  return {
    file: APP_ASAR_RELATIVE.split(path.sep).join('/'),
    path: file,
    sizeBytes: fs.statSync(file).size,
    sha256: await sha256(file)
  };
}

// ---------------------------------------------------------------- reporting

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${bytes.toLocaleString('en-US')} bytes (${mb.toFixed(2)} MB)`;
}

function formatDefenderVersions(defender) {
  const parts = [];
  if (defender.engineVersion) parts.push(`engine ${defender.engineVersion}`);
  if (defender.signatureVersion) parts.push(`signatures ${defender.signatureVersion}`);
  if (defender.signatureUpdated) parts.push(`updated ${defender.signatureUpdated}`);
  return parts.length > 0 ? parts.join(', ') : 'not reported';
}

const DEFENDER_LABEL = {
  clean: 'clean',
  threat: 'THREAT DETECTED',
  unavailable: 'unavailable',
  error: 'scan error'
};

function formatVirusTotalCell(vt) {
  const link = `[view](${vt.url})`;
  if (vt.status === 'ok') {
    const s = vt.stats;
    return `${link} — ${s.malicious} malicious / ${s.suspicious} suspicious / ${s.undetected} undetected`;
  }
  if (vt.status === 'not_found') return `${link} — hash unknown to VirusTotal`;
  if (vt.status === 'skipped') return `${link} — not queried (no API key)`;
  return `${link} — ${vt.note}`;
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Scan report');
  lines.push('');
  lines.push(`**${report.app.name} ${report.app.version}**`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Directory: \`${report.directory}\``);
  lines.push(
    `Windows Defender: ${report.defender.tool ? `\`${report.defender.tool}\`` : 'not available'}`
  );
  lines.push(`Defender versions: ${formatDefenderVersions(report.defender)}`);
  lines.push('');
  lines.push(
    'These binaries are not code-signed, so Windows may warn about an unknown publisher.',
    'The hashes and scan results below let you verify the exact files you downloaded.'
  );
  lines.push('');
  if (report.clean === null) {
    lines.push(
      '> **No scanner verdict.** No antivirus engine examined these files when this report was',
      '> generated, so it does not claim they are clean. Verify them yourself using the steps below.'
    );
    lines.push('');
  }
  lines.push('## Binaries');
  lines.push('');
  lines.push('| File | Size | SHA-256 | Defender | VirusTotal |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const entry of report.files) {
    lines.push(
      `| \`${entry.file}\` | ${formatSize(entry.sizeBytes)} | \`${entry.sha256}\` | ` +
        `${DEFENDER_LABEL[entry.defender.verdict]} | ${formatVirusTotalCell(entry.virustotal)} |`
    );
  }
  lines.push('');
  if (report.appCode) {
    lines.push('## Application code');
    lines.push('');
    lines.push('Both binaries bundle the same application code — this repository minus');
    lines.push('`node_modules` — as a single `app.asar`. Everything else in the download is the');
    lines.push('Electron runtime, so this hash covers the part that is actually this project.');
    lines.push('');
    lines.push('| File | Size | SHA-256 |');
    lines.push('| --- | --- | --- |');
    lines.push(
      `| \`${report.appCode.file}\` | ${formatSize(report.appCode.sizeBytes)} | ` +
        `\`${report.appCode.sha256}\` |`
    );
    lines.push('');
    lines.push('An installed copy holds the same file at `resources\\app.asar` inside the');
    lines.push('application folder, so you can check it after installing without re-hashing the');
    lines.push('whole installer:');
    lines.push('');
    lines.push('```');
    lines.push('certutil -hashfile "<application folder>\\resources\\app.asar" SHA256');
    lines.push('```');
    lines.push('');
  }
  lines.push('## How to verify yourself');
  lines.push('');
  lines.push('**1. Check the SHA-256.** In Command Prompt or PowerShell, run:');
  lines.push('');
  lines.push('```');
  lines.push(`certutil -hashfile "${report.files[0].file}" SHA256`);
  lines.push('```');
  lines.push('');
  lines.push('The hash it prints must match the SHA-256 in the table above. If it does not,');
  lines.push('the file was altered after this report was generated — do not run it.');
  lines.push('');
  lines.push('**2. Check the hash on VirusTotal.** Open <https://www.virustotal.com/>, choose the');
  lines.push('"Search" tab, and paste the SHA-256. That shows results from ~70 antivirus engines');
  lines.push('for exactly this file — no upload needed. The links in the table go straight there.');
  lines.push('');
  lines.push('**3. Scan it with your own antivirus.** On Windows you can run a Defender scan of a');
  lines.push('single file yourself:');
  lines.push('');
  lines.push('```');
  lines.push(
    '"C:\\Program Files\\Windows Defender\\MpCmdRun.exe" -Scan -ScanType 3 -File "<path to file>"'
  );
  lines.push('```');
  lines.push('');
  lines.push('**4. Read the source.** The app is plain JavaScript with no build step, so the');
  lines.push('published source is the code that runs. It makes no network calls at runtime.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const { dir, requireScan } = parseArgs(process.argv.slice(2));

  const binaries = findBinaries(dir);
  if (binaries.length === 0) {
    console.error(`scan: no .exe files found in ${dir}`);
    console.error('scan: run `npm run build` first to produce the release binaries.');
    process.exit(1);
  }

  const mpCmdRun = findMpCmdRun();
  if (!mpCmdRun) {
    console.warn(
      'scan: MpCmdRun.exe not found — Defender verdicts will be reported as "unavailable".'
    );
  } else {
    console.log(`scan: using ${mpCmdRun}`);
  }

  const defenderStatus = findDefenderStatus() || {};
  console.log(`scan: defender ${formatDefenderVersions(defenderStatus)}`);

  const apiKey = (process.env.VT_API_KEY || '').trim();
  if (!apiKey) {
    console.log('scan: VT_API_KEY not set — reporting VirusTotal links only.');
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = [];
  let detected = false;
  let errored = false;
  let vtFailed = false;
  let unverified = 0; // Binaries that no scanner actually examined.

  for (const file of binaries) {
    const name = path.basename(file);
    console.log(`scan: ${name}`);

    const sizeBytes = fs.statSync(file).size;
    const hash = await sha256(file);
    console.log(`  sha256   ${hash}`);

    const defender = scanWithDefender(mpCmdRun, file);
    console.log(`  defender ${DEFENDER_LABEL[defender.verdict]}`);

    const virustotal = await lookupVirusTotal(hash, apiKey);
    console.log(
      `  vt       ${formatVirusTotalCell(virustotal).replace(/\[view\]\([^)]*\)/, virustotal.url)}`
    );

    if (defender.verdict === 'threat') detected = true;
    if (defender.verdict === 'error') errored = true;
    if (virustotal.status === 'error') vtFailed = true;
    if (
      virustotal.status === 'ok' &&
      (virustotal.stats.malicious > 0 || virustotal.stats.suspicious > 0)
    ) {
      detected = true;
    }

    // "Defender unavailable + VirusTotal not queried" means nothing looked at this file.
    // That is not a clean verdict and must not be reported as one.
    const examined =
      defender.verdict === 'clean' || defender.verdict === 'threat' || virustotal.status === 'ok';
    if (!examined) unverified++;

    files.push({ file: name, path: file, sizeBytes, sha256: hash, defender, virustotal, examined });
  }

  const appCode = await hashAppCode(dir);
  if (appCode) {
    console.log(`scan: ${appCode.file}`);
    console.log(`  sha256   ${appCode.sha256}`);
  } else {
    console.log(`scan: ${APP_ASAR_RELATIVE} not found — app code hash omitted.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    app: { name: pkg.name, version: pkg.version },
    directory: dir,
    defender: {
      tool: mpCmdRun,
      available: Boolean(mpCmdRun),
      engineVersion: defenderStatus.engineVersion || null,
      signatureVersion: defenderStatus.signatureVersion || null,
      signatureUpdated: defenderStatus.signatureUpdated || null
    },
    virustotal: { apiQueried: Boolean(apiKey) },
    files,
    // The app.asar inside dist/win-unpacked; null when the unpacked build is not present.
    appCode,
    // true = every binary was examined and came back clean, false = flagged or a scan failed,
    // null = no scanner produced a verdict, so cleanliness is simply unknown.
    clean: detected || errored ? false : unverified === 0 ? true : null,
    unverifiedFiles: unverified
  };

  const jsonPath = path.join(dir, 'scan-report.json');
  const mdPath = path.join(dir, 'SCAN-REPORT.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');

  console.log(`scan: wrote ${jsonPath}`);
  console.log(`scan: wrote ${mdPath}`);

  if (detected) {
    console.error('scan: FAILED — a scanner flagged at least one binary.');
    process.exit(1);
  }
  if (errored) {
    console.error('scan: FAILED — a scan could not be completed.');
    process.exit(1);
  }
  // A VirusTotal API failure is not a detection — Defender is the authoritative local scan —
  // but say so plainly rather than letting "OK" imply VirusTotal confirmed anything.
  if (vtFailed)
    console.warn(
      'scan: warning — the VirusTotal API lookup did not complete; use the links in the report.'
    );
  if (unverified > 0) {
    const summary =
      `no scanner examined ${unverified} of ${files.length} ` +
      `binar${files.length === 1 ? 'y' : 'ies'}; the report makes no cleanliness claim.`;
    // A scan that never started is not a pass. Without --require-scan that is only a warning,
    // so the script stays usable on a machine with no Defender; with it, the release stops.
    if (requireScan) {
      console.error(`scan: FAILED — ${summary}`);
      console.error('scan: --require-scan was given, so this is a failure rather than a warning.');
      process.exit(1);
    }
    console.warn(`scan: UNVERIFIED — ${summary}`);
    process.exit(0);
  }
  console.log(`scan: OK — ${files.length} binar${files.length === 1 ? 'y' : 'ies'} clean.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`scan: unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
