# npm publishing

The package is published by `.github/workflows/publish.yml` when a GitHub
Release is published, or when that workflow is started manually. It uses npm
trusted publishing (OIDC), not an npm token stored in GitHub.

## Bootstrap the package once

npm requires a package to exist before a trusted publisher can be configured.
The package was bootstrapped with an empty `0.0.1` version published manually
outside this repository. Do not publish `0.1.0` locally: its first publication
must come from the GitHub workflow with OIDC and provenance. No `NPM_TOKEN`
secret is needed.

## Configure trusted publishing

In the package's npmjs.com **Settings > Trusted publishing**, add a GitHub
Actions publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `macjl` |
| Repository | `signalk-victoriametrics-history-provider` |
| Workflow filename | `publish.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct `npm publish` |

The workflow file must remain at `.github/workflows/publish.yml`. In particular,
the npm form takes only the filename, not the whole path. New trusted publisher
connections permit staged publishing by default; direct `npm publish` must be
allowed because that is what the workflow runs. No GitHub npm secret is needed.

For each version, update `package.json`, `package-lock.json` and
`CHANGELOG.md`, push the release commit, create its `vX.Y.Z` tag and publish a
GitHub Release from that tag. The workflow checks that the tag matches the npm
version before publishing. Verify the resulting npm package and provenance.

After a successful OIDC release, consider setting npm **Publishing access** to
require 2FA and disallow traditional tokens. Do this only after OIDC has been
tested, so the package is not left without a working publication path.
