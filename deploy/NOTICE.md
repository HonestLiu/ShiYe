# Chromium seccomp policy

`chromium-seccomp.json` is based on the Moby profiles default seccomp policy:

- Source: https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json
- License: Apache License 2.0, reproduced in `LICENSE.seccomp`.
- Modification: allow `clone`, `setns`, and `unshare` so non-root Chromium can create its sandbox user namespaces, following https://playwright.dev/docs/docker. Also allow the `chroot` syscall for Chromium's sandbox setup when container capabilities are dropped; the kernel still enforces the caller's namespace capabilities.

The current Moby base is used instead of the older bundled Playwright policy to retain modern runtime syscalls such as `openat2` and `close_range`.
