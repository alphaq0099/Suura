# Code signing policy

## Current state

Public installers are **not code-signed**. There is no certificate in this project and no signing step in the release
process yet.

Consequences, stated plainly:

- Windows shows **Unknown publisher** in the installer and SmartScreen may show *"Windows protected your PC"* on a
  downloaded installer. The documented path is *More info → Run anyway*.
- SmartScreen reputation is per file while a build is unsigned, so each release starts from zero and warns again.
- The updater verifies a downloaded update against the SHA-512 recorded in the channel file (`latest.yml` /
  `beta.yml`), not against a publisher signature. That detects corruption and a truncated download, not a compromised
  feed host.

Integrity today is provided by `SHA256SUMS.txt` beside each installer. Verify a download with:

```powershell
Get-FileHash .\Suura-0.1.0-Setup.exe -Algorithm SHA256
```

Compare it with the matching line in `SHA256SUMS.txt` from the same release.

## What will be signed

If signing becomes available, the policy is:

- **Only CI builds from this repository are signed.** A local `npm run package:win` is never signed and never shipped.
- The signed set is the NSIS installer and the application executable it contains, built from a tagged commit by the
  workflow in `.github/workflows/`.
- **No binary produced outside CI will carry the signature**, including hotfixes built on a maintainer's machine.
- The updater will be configured to verify the publisher signature before installing, and the publisher name will be
  documented here.

Suura intends to apply to the [SignPath Foundation](https://signpath.org), which signs open-source projects at no cost.
Acceptance is not guaranteed and no date is promised. If accepted:

- Signing happens inside SignPath's service; the private key is held in their hardware security module, not in this
  repository, and not on any maintainer's machine.
- Each release request is approved manually by a project maintainer before it is signed.
- The certificate is issued to **SignPath Foundation**, so Windows will show *SignPath Foundation* as the publisher,
  not "Suura".
- This page will be updated with the exact publisher name and the verification command.

## Roles

Suura is maintained by a single maintainer at present.

| Role | Who |
|---|---|
| Authors (may change source) | Repository maintainer |
| Reviewers (review outside contributions) | Repository maintainer |
| Approvers (approve a signing request) | Repository maintainer |

If the team grows, this table changes before signing access is granted to anyone new.

## Privacy

Suura has no telemetry and does not transfer information to other networked systems unless the user asks it to:
YouTube playback and search, streamed artwork, and the metadata/lyrics providers behind their buttons. Diagnostics and
crash reports are local files. See the README's **Privacy** section.

## Contact

Questions about this policy: open an issue, or use the private channel in [`SECURITY.md`](./SECURITY.md) if the
question is itself sensitive.
