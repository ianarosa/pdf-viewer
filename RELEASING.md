# Releasing

The installed (NSIS) build auto-updates from GitHub Releases of `ianarosa/pdf-viewer`.
The portable exe cannot self-update; it never checks.

1. Bump `version` in `package.json` (e.g. 1.0.1).
2. `npm run release` (builds the NSIS installer without publishing; output in `dist/`).
3. On GitHub, create a Release with tag `vX.Y.Z` (matching the version) and upload:
   - `PDF-Viewer-Setup-X.Y.Z.exe`
   - `latest.yml`
   - `PDF-Viewer-Setup-X.Y.Z.exe.blockmap`
4. Installed copies pick it up on next launch, download in the background, and show
   "Update ready - Restart to install" (or install on quit).

Nothing is uploaded automatically. Get Thiago's go-ahead before creating the repo or any release.
The unsigned build may trigger SmartScreen on first install.
