# @example.com/hello-regesta

Minimal tarball-backed package used to exercise the Regesta v0 publish and verify loop.

The example keeps native npm metadata and bundled exports in `package.json`, then uses `regesta.json` for the canonical Regesta package id, source selection, languages, source-attached provenance, and compatibility intent. The `prepack` script builds `dist` with tsdown before the package manager creates the install artifact during publish.
