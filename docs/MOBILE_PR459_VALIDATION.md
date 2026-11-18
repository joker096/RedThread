# Mobile validation branch for PR #459

This isolated validation branch points at the exact PR #459 code SHA `14c4d59e3b0f32fe1fe0b964fc0c7a82a9deb21e` and exists only to run the repository's Android/iOS build and virtual-device smoke workflows, which are configured for `feat/**` push branches. It is not a product requirement, is not part of PR #459, and must not be merged into `main`.

No app-link domain is supplied; the repository variables remain authoritative and blank values must remain blank. No production endpoint or payment configuration is enabled.
