# omp-webui

`omp-webui` is an installable Oh My Pi extension plugin that serves a local React/Vite WebUI for OMP chat sessions. After installation and OMP restart/reload, type `/webui` in the OMP chat box to open the UI.

This repository is also a self-contained OMP marketplace. The plugin source is the repository root and the catalog lives at `.claude-plugin/marketplace.json`.

## Remote install

```sh
omp plugin marketplace add dibin666/omp-webui
omp plugin install omp-webui@omp-webui
```

Or from inside OMP:

```text
/marketplace add dibin666/omp-webui
/marketplace install omp-webui@omp-webui
```

Restart or reload OMP, then run:

```text
/webui
```

## Remote update

```sh
omp plugin marketplace update omp-webui
omp plugin upgrade omp-webui@omp-webui
```

Or from inside OMP:

```text
/marketplace update omp-webui
/marketplace upgrade omp-webui@omp-webui
```

## Local development

```sh
bun install
bun run build
omp plugin link .
```

Restart or reload OMP, then run `/webui`.

The command starts a `127.0.0.1` server, generates a per-server token, and opens the tokenized URL when `autoOpen` is enabled.

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

## Publishing note

Marketplace installs copy the plugin repository as-is. Keep `dist/` committed so `/webui` can serve the built frontend without requiring users to run a build step.
