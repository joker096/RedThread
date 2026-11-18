# Temporary native validation branch

This isolated branch points at PR #459 code SHA `91d9a151e3618350a60e42b57142f29d521b83a2` and exists only to run Android/iOS builds and virtual-device smoke tests, which are configured for `feat/**` pushes. It is not part of the product change and must not be merged. App-link host and API base URL are taken only from existing repository variables; no domain or Production endpoint is invented.
