# Repository Guidelines

## Project Structure & Module Organization

- `extension.js`: VSCode extension entrypoint (TreeView UI, commands, settings, python/slither autodetection, navigation/highlighting).
- `python/extract_workflows.py`: Slither-based analyzer that outputs workflows as JSON (entrypoints + ordered call trees).
- `package.json`: Extension manifest, contributed commands/menus, and configuration settings (`flowther.*`).
- `media/`: UI assets (icons).
- `.vscode/launch.json`: Local debugging configuration for running the extension in an Extension Host.

## Build, Test, and Development Commands

- Run locally (recommended): use VSCode **Run → Start Debugging** with the included `.vscode/launch.json` to open an Extension Host.
- Package a VSIX: `vsce package --no-dependencies --allow-missing-repository --skip-license --allow-package-all-secrets --allow-package-env-file`
- Install locally: `code --install-extension flowther-<version>.vsix --force`

## Coding Style & Naming Conventions

- JavaScript (`extension.js`): 2-space indentation, CommonJS (`require`, `module.exports`), keep functions small and side-effect boundaries clear.
- Python (`python/extract_workflows.py`): 4-space indentation, prefer explicit helpers over complex inline logic.
- IDs/keys: keep stable strings (e.g., `flowther.hiddenFlows`, `flowther.hiddenFiles`) because they persist in workspace state.

## Testing Guidelines

- No automated test suite currently. Validate changes by:
  - launching the Extension Host and using **Flowther: Refresh Workflows** on a real Solidity workspace;
  - checking navigation (jump + 0.5s highlight), hide/unhide behaviors, and call ordering.

## Commit & Pull Request Guidelines

- History is minimal (baseline commit). Use short, imperative commit messages (e.g., `Fix call order`, `Add per-file unhide`).
- For PRs: include a brief description, screenshots/GIFs for UI changes, and any settings changes (`package.json`) noted in the PR body.

## Security & Configuration Tips

- Flowther runs Slither via Python; avoid executing untrusted workspaces with elevated privileges.
- If analysis fails, the usual fixes are setting `flowther.targetPath` (monorepos) and/or `flowther.pythonPath` (Slither environment).
