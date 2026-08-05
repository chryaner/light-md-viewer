# Security

## Reporting a vulnerability

Report it privately, not in a public issue. Open a draft advisory on the
[Security tab](https://github.com/chryaner/light-md-viewer/security/advisories/new). That starts a
private thread with me. Include what an attacker gets, a Markdown file that triggers it, the app
version (Help > About) and your Windows version.

First reply usually takes a few days. Fixes go into the next release, credited in `CHANGELOG.md`
unless you would rather not be. Only the latest release is patched.

In scope: anything that lets an opened Markdown file escape the viewer. Script execution in the
renderer, reading or writing files you did not open, starting a process, network access.

Out of scope: SmartScreen and antivirus warnings about the unsigned build, and bugs in Electron or
Chromium, which go to [Electron](https://github.com/electron/electron/security/policy). Do tell me
if this app ships an Electron version that is behind on a known fix.

## Unsigned binaries

The releases are not code-signed. A certificate costs money every year and this app is free.
SmartScreen will show "Windows protected your PC" and an unknown publisher, because the file has no
certificate and no download reputation. Nothing below removes that warning. Windows reads none of
it. The app has no build step, so the published source is the code that runs.

## Verifying a download

Replace `FILE.exe` with the file you downloaded.

Compare the hash with `SHA256SUMS.txt` on the release page:

```
certutil -hashfile FILE.exe SHA256
```

Check where the file was built, using the [GitHub CLI](https://cli.github.com/):

```
gh attestation verify FILE.exe --repo chryaner/light-md-viewer --signer-workflow chryaner/light-md-viewer/.github/workflows/release.yml --deny-self-hosted-runners
```

A pass means those bytes came out of this repository's release workflow, on a GitHub runner, from a
commit `gh` prints. Keep both long flags. Without them any workflow in the repo, on any machine,
passes. Add `--bundle attestation.jsonl` from the release to check without a GitHub account. A release
made before attestations were added has none, which `gh` reports as no attestation found. That is
not a verification failure.

## Automated checks

These run in public GitHub Actions ([`.github/workflows/`](.github/workflows)). Every log is public.

| Check              | What it does                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeQL             | Scans the app source for DOM XSS in the render path, path traversal, command injection and the Electron queries. Runs on push, on PRs, on release tags and weekly. `renderer/vendor/` is excluded.    |
| Vendored libraries | `scripts/verify-vendor.js` installs the versions pinned in `package-lock.json` and compares every file in `renderer/vendor/` byte for byte. It runs again inside the release build, before packaging. |
| Defender scan      | `scripts/scan.js` scans each release artifact, hashes it and adds a VirusTotal link. The release runs it with `--require-scan`, so a detection fails the release, and so does a scan that never ran.  |

What they do not prove:

- A clean CodeQL run means no query matched. It looks for known patterns of known bug classes.
- The Defender scan is one engine, at one moment, on one file, on the machine that built it.
- Provenance proves origin, not intent. A bad commit gets a valid attestation naming its source.
- The vendor check compares `renderer/vendor/` with the published packages. It audits nothing: not
  those libraries, not the build-time dependencies, not Chromium.
- The `.exe` is not reproducible. Installers embed timestamps, so your own build gets another hash.
- Only the vendor check and the scan gate a release. CodeQL, lint and the tests run alongside it.
- Attestation assumes GitHub ran the workflow it published, and that Sigstore's log is honest.
