# omp-webui

`omp-webui` is an installable Oh My Pi extension plugin that serves a local React/Vite WebUI for OMP chat sessions. After installation and OMP restart/reload, type `/webui` in the OMP chat box to open the UI.

## Install

```sh
omp plugin install omp-webui
```

Restart or reload OMP, then run:

```text
/webui
```

The command starts a `127.0.0.1` server, generates a per-server token, and opens the tokenized URL when `autoOpen` is enabled.

## Update

```sh
omp plugin install omp-webui@latest
```

Restart or reload OMP after updating.

## Local development

```sh
bun install
bun run build
omp plugin link .
```

Restart or reload OMP, then run `/webui`.

## Settings

Use `/settings` -> plugins tab -> `omp-webui` to enable/disable the plugin and edit plugin settings:

- `port`: preferred loopback port. If occupied, the plugin reports the actual ephemeral port it used.
- `autoOpen`: open the browser automatically when `/webui` starts the server.
- `fileTreeMaxFiles`: maximum entries returned by each file-tree request.
- `filePreviewMaxBytes`: maximum bytes returned by file preview requests.

OMP already owns plugin enable/disable state. This plugin does not add a separate `enabled` setting.

## Scripts

```sh
bun run build
bun run lint
bun run test
```

`build` runs TypeScript project checks and Vite static output. `test` covers the extension/server helpers.

## npm publishing

This repository publishes `omp-webui` to npm through `.github/workflows/publish-npm.yml`.

Repository maintainers must configure a GitHub Actions secret named `NPM_TOKEN` with an npm granular access token that can publish `omp-webui`. The workflow runs on published GitHub Releases and can also be started manually with `workflow_dispatch`.

Before creating a release, bump `package.json` to an unpublished version. The workflow fails before publishing if that exact package version already exists on npm.
