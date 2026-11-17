# Dependency updates

- npm is the only supported package manager; commit the root `package-lock.json`.
- Change dependencies with npm, not by editing the lockfile manually. For the Paddle SDK, keep an exact version in `package.json` and review its release notes before updating.
- After changing dependencies, run `npm install --save-exact <package>@<version>`, then `npm ci`, `npm run lockfile:check`, `npm test`, `npm run lint`, and `npm run build`.
- CI, Browser E2E and Docker builds use `npm ci`; a manifest/lockfile mismatch must fail the build.
- Review the full dependency diff and security advisories. Do not update unrelated transitive packages unless required and explained.
- Paddle webhook signature verification requires a reviewed SDK version. Version 3.11.1 is pinned because it rejects future timestamps and uses constant-time signature comparison.
- Never place API keys, webhook secrets, provider credentials or real customer payloads in tests or logs.
