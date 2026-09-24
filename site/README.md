# Foreman website

Static GitHub Pages site. No build step or frontend dependencies.

Preview from the repository root:

```sh
python3 -m http.server 4173 --directory site
```

Open http://localhost:4173. Content lives in `index.html`, styles in `style.css`, and the workflow explorer and copy button in `app.js`.

`.github/workflows/pages.yml` publishes this directory on pushes to `main` that change the site or its deployment workflow. The repository's Pages source must be set to **GitHub Actions**.

The workflow board is an illustration, not live run telemetry. Keep product claims and the installation command aligned with the root README.

`install.sh` is the public macOS/Linux/WSL installer. It builds in a staging directory, replaces only installations carrying its ownership marker, and registers the stable path with OpenCode. Test installer behavior with `node --test tests/install/*.test.mjs`.
