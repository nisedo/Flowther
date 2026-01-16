const path = require("path");
const fs = require("fs");
const vscode = require("vscode");
const cp = require("child_process");

const WORKFLOWS_VIEW_ID = "flowther.workflows";
const VARIABLES_VIEW_ID = "flowther.variables";
const HIDDEN_FLOWS_KEY = "flowther.hiddenFlows";
const HIDDEN_FILES_KEY = "flowther.hiddenFiles";
const HIDDEN_VARS_KEY = "flowther.hiddenVars";
const REVIEWED_KEY = "flowther.reviewed";

let jumpHighlightDecoration;
let jumpHighlightTimeout;
let jumpHighlightSeq = 0;

function activate(context) {
  vscode.commands.executeCommand("setContext", "flowther.isFocused", false);

  jumpHighlightDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderRadius: "2px",
  });
  context.subscriptions.push(jumpHighlightDecoration);

  const workflowsProvider = new WorkflowsProvider(context);
  const variablesProvider = new VariablesProvider(context);

  // Link providers for shared refresh
  workflowsProvider._variablesProvider = variablesProvider;

  context.subscriptions.push(
    vscode.window.createTreeView(WORKFLOWS_VIEW_ID, {
      treeDataProvider: workflowsProvider,
      showCollapseAll: true,
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView(VARIABLES_VIEW_ID, {
      treeDataProvider: variablesProvider,
      showCollapseAll: true,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.refreshWorkflows", () => workflowsProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.openFunction", (location) =>
      openLocation(location)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.hideFlow", (node) => workflowsProvider.hideFlow(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.focusFlow", (node) => workflowsProvider.focusFlow(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.clearFocus", () => workflowsProvider.clearFocus())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.hideFile", (node) => workflowsProvider.hideFile(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.unhideFlowsInFile", (node) =>
      workflowsProvider.unhideFlowsInFile(node)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.unhideAllFlows", () => workflowsProvider.unhideAllFlows())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.unhideAllFiles", () => workflowsProvider.unhideAllFiles())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.markReviewed", (node) => workflowsProvider.markReviewed(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.unmarkReviewed", (node) => workflowsProvider.unmarkReviewed(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("flowther.clearAllReviewed", () => workflowsProvider.clearAllReviewed())
  );

  // Initial load (best-effort, non-blocking)
  workflowsProvider.refresh({ silent: true });
}

function deactivate() {}

async function openLocation(location) {
  if (!location || !location.file) {
    return;
  }
  try {
    const uri = vscode.Uri.file(location.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });

    const rawLine = Number(location.line ?? 0);
    const rawCharacter = Number(location.character ?? 0);
    const line0 = Number.isFinite(rawLine) ? Math.max(0, Math.trunc(rawLine)) : 0;
    const character0 = Number.isFinite(rawCharacter) ? Math.max(0, Math.trunc(rawCharacter)) : 0;
    const line = Math.min(line0, Math.max(0, doc.lineCount - 1));

    const pos = new vscode.Position(line, character0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

    if (jumpHighlightDecoration) {
      const seq = ++jumpHighlightSeq;
      const range = editor.document.lineAt(pos.line).range;
      editor.setDecorations(jumpHighlightDecoration, [range]);
      if (jumpHighlightTimeout) {
        clearTimeout(jumpHighlightTimeout);
      }
      jumpHighlightTimeout = setTimeout(() => {
        if (seq !== jumpHighlightSeq) {
          return;
        }
        try {
          editor.setDecorations(jumpHighlightDecoration, []);
        } catch (e) {
          // ignore
        }
      }, 500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Flowther: Failed to open location. ${msg}`);
  }
}

class WorkflowsProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    this._focusFlowId = null;
    this._loading = false;
    this._lastError = null;
    this._analysis = null;
    this._workspaceRoot = null;
    this._files = [];
  }

  getTreeItem(element) {
    const config = vscode.workspace.getConfiguration("flowther");
    const showCallOrderNumbers = !!config.get("showCallOrderNumbers");
    const reviewedSet = new Set(this._context.workspaceState.get(REVIEWED_KEY, []));

    if (element.kind === "message") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "flowther.message";
      return item;
    }

    if (element.kind === "file") {
      const item = new vscode.TreeItem(
        element.fileRel,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      // Check if all entrypoints in this file are reviewed
      const entrypoints = element.entrypoints || [];
      const allReviewed = entrypoints.length > 0 && entrypoints.every((ep) => ep.flowId && reviewedSet.has(ep.flowId));
      item.contextValue = allReviewed ? "flowther.file.reviewed" : "flowther.file";
      item.iconPath = allReviewed
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon("file-code");
      item.tooltip = element.fileAbs;
      return item;
    }

    if (element.kind === "entrypoint") {
      const item = new vscode.TreeItem(
        element.label,
        element.calls && element.calls.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      const isReviewed = element.flowId && reviewedSet.has(element.flowId);
      item.contextValue = isReviewed ? "flowther.entrypoint.reviewed" : "flowther.entrypoint";
      item.iconPath = isReviewed
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : entrypointIcon(element.label);
      item.description = element.inheritedFrom
        ? `from ${element.inheritedFrom}`
        : element.contract;
      if (element.location?.file) {
        item.command = {
          command: "flowther.openFunction",
          title: "Open Function",
          arguments: [element.location],
        };
      }
      item.tooltip = element.tooltip;
      return item;
    }

    if (element.kind === "call") {
      const displayLabel =
        showCallOrderNumbers && element.order ? `${element.order}. ${element.label}` : element.label;
      const item = new vscode.TreeItem(
        displayLabel,
        element.calls && element.calls.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      const callReviewId = element.location?.file
        ? `${element.location.file}:${element.location.line}:${element.label}`
        : null;
      const isReviewed = callReviewId && reviewedSet.has(callReviewId);
      item.contextValue = isReviewed
        ? "flowther.call.reviewed"
        : element.cycle
          ? "flowther.call.cycle"
          : "flowther.call";
      item.iconPath = isReviewed
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : callIcon(element.kindLabel, element.cycle);
      item.description = callDescription(element.contract, element.kindLabel);
      if (element.location?.file) {
        item.command = {
          command: "flowther.openFunction",
          title: "Open Function",
          arguments: [element.location],
        };
      }
      item.tooltip = element.tooltip;
      return item;
    }

    const fallback = new vscode.TreeItem(
      "Unknown item",
      vscode.TreeItemCollapsibleState.None
    );
    return fallback;
  }

  async getChildren(element) {
    if (this._loading) {
      return [{ kind: "message", message: "Loading workflows…" }];
    }

    if (this._lastError) {
      return [
        { kind: "message", message: `Flowther error: ${this._lastError}` },
        { kind: "message", message: "Run “Flowther: Refresh Workflows” to retry." },
      ];
    }

    if (!this._files.length) {
      if (this._focusFlowId) {
        return [{ kind: "message", message: "Focus mode is active. Clear focus to show all workflows." }];
      }
      const hadAny =
        !!this._analysis &&
        Array.isArray(this._analysis.files) &&
        this._analysis.files.some((f) => (f.entrypoints || []).length > 0);
      if (hadAny) {
        const hiddenFiles = new Set(this._context.workspaceState.get(HIDDEN_FILES_KEY, []));
        const analysisFiles = (this._analysis && Array.isArray(this._analysis.files) && this._analysis.files) || [];
        const anyVisibleFile = analysisFiles.some((f) => !hiddenFiles.has(f.path));
        if (!anyVisibleFile && analysisFiles.length) {
          return [{ kind: "message", message: "All files are hidden. Use “Flowther: Unhide All Files”." }];
        }
        return [{ kind: "message", message: "All workflows are hidden. Use “Flowther: Unhide All Flows”." }];
      }
      return [{ kind: "message", message: "No workflows yet. Run “Flowther: Refresh Workflows”." }];
    }

    if (!element) {
      return this._files;
    }

    if (element.kind === "file") {
      return element.entrypoints;
    }

    if (element.kind === "entrypoint" || element.kind === "call") {
      return element.calls || [];
    }

    return [];
  }

  async focusFlow(node) {
    if (!node || node.kind !== "entrypoint" || !node.flowId) {
      return;
    }
    this._focusFlowId = node.flowId;
    vscode.commands.executeCommand("setContext", "flowther.isFocused", true);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async clearFocus() {
    this._focusFlowId = null;
    vscode.commands.executeCommand("setContext", "flowther.isFocused", false);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async refresh(options = {}) {
    const { silent } = options;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this._files = [];
      this._lastError = "No workspace folder open";
      this._analysis = null;
      this._workspaceRoot = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    const config = vscode.workspace.getConfiguration("flowther");
    const targetPathSetting = String(config.get("targetPath") || "").trim();
    const pythonPathSetting = String(config.get("pythonPath") || "").trim();
    const slitherRepoPath = config.get("slitherRepoPath") || "";
    const solcPath = config.get("solcPath") || "";
    const solcArgs = config.get("solcArgs") || "";
    const filterPaths = config.get("filterPaths") || [];
    const excludeDependencies = !!config.get("excludeDependencies");
    const expandDependencies = !!config.get("expandDependencies");
    const maxCallDepth = Number(config.get("maxCallDepth") || 10);

    const extractor = this._context.asAbsolutePath(
      path.join("python", "extract_workflows.py")
    );

    this._loading = true;
    this._lastError = null;
    this._onDidChangeTreeData.fire();

    try {
      const analysisTarget = await resolveSlitherTarget({
        workspaceRoot: workspace.uri.fsPath,
        targetPathSetting,
      });
      const analysisCwd = resolveAnalysisCwd(analysisTarget);
      const pythonRunner = await resolvePythonPathForSlither({
        workspaceRoot: workspace.uri.fsPath,
        pythonPathSetting,
        slitherRepoPath,
      });

      const raw = await runExtractor(
        pythonRunner,
        extractor,
        analysisTarget,
        workspace.uri.fsPath,
        analysisCwd,
        {
          slitherRepoPath,
          solcPath,
          solcArgs,
          filterPaths,
          excludeDependencies,
          expandDependencies,
          maxCallDepth,
        },
        { silent }
      );

      if (!raw.ok) {
        this._analysis = null;
        this._workspaceRoot = workspace.uri.fsPath;
        this._files = [];
        this._lastError = raw.error || "Unknown error";
        this._loading = false;
        this._onDidChangeTreeData.fire();
        return;
      }

      this._analysis = raw;
      this._workspaceRoot = workspace.uri.fsPath;
      this._rebuildFiles();

      // Share analysis with variables provider
      if (this._variablesProvider) {
        this._variablesProvider.setAnalysis(raw, workspace.uri.fsPath);
      }

      this._loading = false;
      this._lastError = null;
      this._onDidChangeTreeData.fire();
    } catch (e) {
      this._files = [];
      this._loading = false;
      this._lastError = e instanceof Error ? e.message : String(e);
      // Notify variables provider of error
      if (this._variablesProvider) {
        this._variablesProvider.setError(this._lastError);
      }
      this._onDidChangeTreeData.fire();
    }
  }

  async hideFlow(node) {
    if (!node || node.kind !== "entrypoint" || !node.flowId) {
      return;
    }
    const current = this._context.workspaceState.get(HIDDEN_FLOWS_KEY, []);
    const next = Array.from(new Set([...current, node.flowId]));
    await this._context.workspaceState.update(HIDDEN_FLOWS_KEY, next);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async unhideAllFlows() {
    await this._context.workspaceState.update(HIDDEN_FLOWS_KEY, []);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async unhideFlowsInFile(node) {
    if (!node || node.kind !== "file" || !node.fileRel) {
      return;
    }
    const fileRel = String(node.fileRel);
    const current = this._context.workspaceState.get(HIDDEN_FLOWS_KEY, []);
    const prefix = `${fileRel}::`;
    const next = (current || []).filter((flowId) => typeof flowId !== "string" || !flowId.startsWith(prefix));
    await this._context.workspaceState.update(HIDDEN_FLOWS_KEY, next);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async hideFile(node) {
    if (!node || node.kind !== "file" || !node.fileRel) {
      return;
    }
    const current = this._context.workspaceState.get(HIDDEN_FILES_KEY, []);
    const next = Array.from(new Set([...current, node.fileRel]));
    await this._context.workspaceState.update(HIDDEN_FILES_KEY, next);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async unhideAllFiles() {
    await this._context.workspaceState.update(HIDDEN_FILES_KEY, []);
    if (this._analysis) {
      this._rebuildFiles();
      this._onDidChangeTreeData.fire();
    } else {
      await this.refresh({ silent: true });
    }
  }

  async markReviewed(node) {
    const id = this._getReviewId(node);
    if (!id) return;
    const current = this._context.workspaceState.get(REVIEWED_KEY, []);
    const next = Array.from(new Set([...current, id]));
    await this._context.workspaceState.update(REVIEWED_KEY, next);
    this._onDidChangeTreeData.fire();
  }

  async unmarkReviewed(node) {
    const id = this._getReviewId(node);
    if (!id) return;
    const current = this._context.workspaceState.get(REVIEWED_KEY, []);
    const next = current.filter((x) => x !== id);
    await this._context.workspaceState.update(REVIEWED_KEY, next);
    this._onDidChangeTreeData.fire();
  }

  async clearAllReviewed() {
    await this._context.workspaceState.update(REVIEWED_KEY, []);
    this._onDidChangeTreeData.fire();
  }

  _getReviewId(node) {
    if (!node) return null;
    if (node.kind === "entrypoint" && node.flowId) return node.flowId;
    if (node.kind === "call" && node.location?.file) {
      return `${node.location.file}:${node.location.line}:${node.label}`;
    }
    return null;
  }

  _rebuildFiles() {
    const workspaceRoot = this._workspaceRoot;
    if (!this._analysis || !workspaceRoot) {
      this._files = [];
      return;
    }
    const hiddenFlows = new Set(this._context.workspaceState.get(HIDDEN_FLOWS_KEY, []));
    const hiddenFiles = new Set(this._context.workspaceState.get(HIDDEN_FILES_KEY, []));
    this._files = (this._analysis.files || [])
      .filter((file) => !hiddenFiles.has(file.path))
      .map((file) => ({
        kind: "file",
        fileRel: file.path,
        fileAbs: path.isAbsolute(file.path) ? file.path : path.join(workspaceRoot, file.path),
        entrypoints: (file.entrypoints || [])
          .filter((ep) => !hiddenFlows.has(ep.flowId))
          .map((ep) => normalizeEntrypoint(ep, workspaceRoot)),
      }))
      .filter((fileNode) => (fileNode.entrypoints || []).length > 0);

    if (this._focusFlowId) {
      const focusId = this._focusFlowId;
      this._files = this._files
        .map((file) => ({
          ...file,
          entrypoints: (file.entrypoints || []).filter((ep) => ep.flowId === focusId),
        }))
        .filter((fileNode) => (fileNode.entrypoints || []).length > 0);
    }

    this._files.sort((a, b) => a.fileRel.localeCompare(b.fileRel));
    for (const f of this._files) {
      f.entrypoints.sort((a, b) => {
        // Sort by: inherited (false first), then line number, then label
        const ia = a.inherited ? 1 : 0;
        const ib = b.inherited ? 1 : 0;
        if (ia !== ib) {
          return ia - ib;
        }
        const la = Number(a.location?.line ?? Number.POSITIVE_INFINITY);
        const lb = Number(b.location?.line ?? Number.POSITIVE_INFINITY);
        if (la !== lb) {
          return la - lb;
        }
        return String(a.label || "").localeCompare(String(b.label || ""));
      });
    }
  }
}

class VariablesProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    this._analysis = null;
    this._workspaceRoot = null;
    this._variables = [];
    this._lastError = null;
  }

  setAnalysis(analysis, workspaceRoot) {
    this._analysis = analysis;
    this._workspaceRoot = workspaceRoot;
    this._lastError = null;
    this._rebuildVariables();
    this._onDidChangeTreeData.fire();
  }

  setError(error) {
    this._lastError = error;
    this._variables = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.kind === "message") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "flowther.message";
      return item;
    }

    if (element.kind === "varFile") {
      const item = new vscode.TreeItem(
        element.fileRel,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "flowther.varFile";
      item.iconPath = new vscode.ThemeIcon("file-code");
      item.description = element.contract;
      item.tooltip = `${element.contract} - ${element.fileAbs}`;
      return item;
    }

    if (element.kind === "variable") {
      const item = new vscode.TreeItem(
        element.name,
        element.modifiers && element.modifiers.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "flowther.variable";
      item.iconPath = new vscode.ThemeIcon("symbol-variable");
      // Show inherited indicator or type as description
      item.description = element.inheritedFrom
        ? `${element.type} • from ${element.inheritedFrom}`
        : element.type;
      item.tooltip = element.inheritedFrom
        ? `${element.contract}.${element.name} (${element.type}) - inherited from ${element.inheritedFrom}`
        : `${element.contract}.${element.name} (${element.type})`;
      if (element.location?.file) {
        item.command = {
          command: "flowther.openFunction",
          title: "Open Variable",
          arguments: [element.location],
        };
      }
      return item;
    }

    if (element.kind === "modifier") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "flowther.modifier";
      item.iconPath = new vscode.ThemeIcon("debug-start");
      item.description = element.contract;
      item.tooltip = `Entry point: ${element.contract}.${element.label}`;
      if (element.location?.file) {
        item.command = {
          command: "flowther.openFunction",
          title: "Open Entry Point",
          arguments: [element.location],
        };
      }
      return item;
    }

    const fallback = new vscode.TreeItem(
      "Unknown item",
      vscode.TreeItemCollapsibleState.None
    );
    return fallback;
  }

  getChildren(element) {
    if (this._lastError) {
      return [
        { kind: "message", message: `Flowther error: ${this._lastError}` },
        { kind: "message", message: 'Run "Flowther: Refresh Workflows" to retry.' },
      ];
    }

    if (!this._variables.length) {
      if (!this._analysis) {
        return [{ kind: "message", message: 'No variables yet. Run "Flowther: Refresh Workflows".' }];
      }
      return [{ kind: "message", message: "No state variables with modifying entry points found." }];
    }

    if (!element) {
      return this._variables;
    }

    if (element.kind === "varFile") {
      return element.vars || [];
    }

    if (element.kind === "variable") {
      return element.modifiers || [];
    }

    return [];
  }

  _rebuildVariables() {
    const workspaceRoot = this._workspaceRoot;
    if (!this._analysis || !workspaceRoot) {
      this._variables = [];
      return;
    }

    const rawVariables = this._analysis.variables || [];
    this._variables = rawVariables.map((fileEntry) => ({
      kind: "varFile",
      fileRel: fileEntry.path,
      fileAbs: path.isAbsolute(fileEntry.path) ? fileEntry.path : path.join(workspaceRoot, fileEntry.path),
      contract: fileEntry.contract,
      vars: (fileEntry.vars || []).map((v) => ({
        kind: "variable",
        varId: v.varId,
        name: v.name,
        type: v.type,
        contract: v.contract,
        inherited: !!v.inherited,
        inheritedFrom: v.inheritedFrom || null,
        location: normalizeLocation(v.location, workspaceRoot),
        modifiers: (v.modifiers || []).map((m) => ({
          kind: "modifier",
          flowId: m.flowId,
          label: m.label,
          contract: m.contract,
          location: normalizeLocation(m.location, workspaceRoot),
        })),
      })),
    })).filter((f) => f.vars && f.vars.length > 0);

    this._variables.sort((a, b) => a.fileRel.localeCompare(b.fileRel));
  }
}

function entrypointIcon(label) {
  const s = String(label || "").toLowerCase();
  if (s.startsWith("constructor")) {
    return new vscode.ThemeIcon("tools");
  }
  if (s.startsWith("receive")) {
    return new vscode.ThemeIcon("symbol-event");
  }
  if (s.startsWith("fallback")) {
    return new vscode.ThemeIcon("symbol-misc");
  }
  return new vscode.ThemeIcon("debug-start");
}

function callIcon(kindLabel, cycle) {
  if (cycle) {
    return new vscode.ThemeIcon("warning");
  }
  const k = String(kindLabel || "");
  if (k === "Modifier") {
    return new vscode.ThemeIcon("shield");
  }
  if (k === "BaseConstructor") {
    return new vscode.ThemeIcon("tools");
  }
  if (k === "External") {
    return new vscode.ThemeIcon("link-external");
  }
  if (k === "Library") {
    return new vscode.ThemeIcon("library");
  }
  if (k === "Solidity") {
    return new vscode.ThemeIcon("symbol-function");
  }
  return new vscode.ThemeIcon("symbol-method");
}

function callKindBadge(kindLabel) {
  const k = String(kindLabel || "");
  if (!k) {
    return "";
  }
  const map = {
    External: "EXT",
    Internal: "INT",
    Library: "LIB",
    Solidity: "SOL",
    Modifier: "MOD",
    BaseConstructor: "BASE",
  };
  return map[k] || k.toUpperCase();
}

function callDescription(contract, kindLabel) {
  const badge = callKindBadge(kindLabel);
  const c = String(contract || "").trim();
  if (c && badge) {
    return `${c} • ${badge}`;
  }
  if (c) {
    return c;
  }
  return badge || undefined;
}

function isSupportedProjectRoot(dir) {
  return (
    fs.existsSync(path.join(dir, "foundry.toml")) ||
    fs.existsSync(path.join(dir, "hardhat.config.js")) ||
    fs.existsSync(path.join(dir, "hardhat.config.ts")) ||
    fs.existsSync(path.join(dir, "hardhat.config.cjs")) ||
    fs.existsSync(path.join(dir, "hardhat.config.mjs")) ||
    fs.existsSync(path.join(dir, "truffle-config.js")) ||
    fs.existsSync(path.join(dir, "truffle.js")) ||
    fs.existsSync(path.join(dir, "brownie-config.yml")) ||
    fs.existsSync(path.join(dir, "brownie-config.yaml"))
  );
}

async function resolveSlitherTarget({ workspaceRoot, targetPathSetting }) {
  if (targetPathSetting) {
    const resolved = path.isAbsolute(targetPathSetting)
      ? targetPathSetting
      : path.join(workspaceRoot, targetPathSetting);
    if (!fs.existsSync(resolved)) {
      throw new Error(`flowther.targetPath does not exist: ${resolved}`);
    }
    return resolved;
  }

  if (isSupportedProjectRoot(workspaceRoot)) {
    return workspaceRoot;
  }

  const patterns = [
    "**/foundry.toml",
    "**/hardhat.config.{js,ts,cjs,mjs}",
    "**/truffle-config.js",
    "**/truffle.js",
    "**/brownie-config.{yml,yaml}",
  ];

  const base = vscode.Uri.file(workspaceRoot);
  const hits = [];
  for (const glob of patterns) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, glob),
      "**/{node_modules,.git}/**",
      25
    );
    hits.push(...found);
  }

  if (!hits.length) {
    return workspaceRoot;
  }

  const dirs = Array.from(new Set(hits.map((u) => path.dirname(u.fsPath))));
  dirs.sort((a, b) => {
    const ra = path.relative(workspaceRoot, a);
    const rb = path.relative(workspaceRoot, b);
    const da = ra.split(path.sep).length;
    const db = rb.split(path.sep).length;
    return da !== db ? da - db : ra.length - rb.length;
  });
  return dirs[0] || workspaceRoot;
}

function resolveAnalysisCwd(analysisTarget) {
  try {
    const stat = fs.statSync(analysisTarget);
    if (stat.isDirectory()) {
      return analysisTarget;
    }
  } catch (e) {
    // ignore
  }
  return path.dirname(analysisTarget);
}

async function resolvePythonPathForSlither({ workspaceRoot, pythonPathSetting, slitherRepoPath }) {
  const candidates = [];

  const slitherPython = await pythonFromSlitherCLI(workspaceRoot);
  if (slitherPython) {
    candidates.push(slitherPython);
  }

  if (pythonPathSetting) {
    candidates.push(pythonPathSetting);
  }

  const pythonConfig = vscode.workspace.getConfiguration("python");
  const defaultInterpreterPath = String(pythonConfig.get("defaultInterpreterPath") || "").trim();
  if (defaultInterpreterPath) {
    candidates.push(defaultInterpreterPath);
  }

  const pythonFromExt = await pythonFromPythonExtension(workspaceRoot);
  if (pythonFromExt) {
    candidates.push(pythonFromExt);
  }

  candidates.push(...pythonFromEnv());

  candidates.push("python3", "python");

  const unique = Array.from(new Set(candidates.filter(Boolean)));

  for (const candidate of unique) {
    const ok = await canImportSlither(candidate, { workspaceRoot, slitherRepoPath });
    if (ok) {
      return { cmd: candidate, args: [] };
    }
  }

  // Try uvx (uv tool) as fallback
  const uvxOk = await canRunSlitherViaUvx(workspaceRoot);
  if (uvxOk) {
    return { cmd: "uvx", args: ["--from", "slither-analyzer", "python"] };
  }

  // Try pipx as fallback
  const pipxOk = await canRunSlitherViaPipx(workspaceRoot);
  if (pipxOk) {
    return { cmd: "pipx", args: ["run", "--spec", "slither-analyzer", "python"] };
  }

  // Best-effort fallback (will surface the extractor error)
  if (pythonPathSetting) {
    return { cmd: pythonPathSetting, args: [] };
  }
  if (slitherPython) {
    return { cmd: slitherPython, args: [] };
  }
  return { cmd: "python3", args: [] };
}

async function canRunSlitherViaUvx(workspaceRoot) {
  try {
    await execFileAsync("uvx", ["--from", "slither-analyzer", "python", "-c", "import slither; print('OK')"], {
      cwd: workspaceRoot,
      timeout: 30000,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function canRunSlitherViaPipx(workspaceRoot) {
  try {
    await execFileAsync("pipx", ["run", "--spec", "slither-analyzer", "python", "-c", "import slither; print('OK')"], {
      cwd: workspaceRoot,
      timeout: 30000,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function canImportSlither(pythonPath, { workspaceRoot, slitherRepoPath }) {
  const repo = String(slitherRepoPath || "").trim();
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  const code = repo
    ? `import os, sys; sys.path.insert(0, os.environ["FLOWTHER_SLITHER_REPO"]); import slither; print("OK")`
    : `import slither; print("OK")`;
  if (repo) {
    env.FLOWTHER_SLITHER_REPO = repo;
  }

  try {
    await execFileAsync(pythonPath, ["-c", code], {
      cwd: workspaceRoot,
      timeout: 5000,
      env,
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function pythonFromSlitherCLI(workspaceRoot) {
  const slitherPath = await findOnPath("slither", workspaceRoot);
  if (!slitherPath) {
    return null;
  }
  try {
    const fd = fs.openSync(slitherPath, "r");
    const buf = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf
      .subarray(0, bytes)
      .toString("utf8")
      .split(/\r?\n/)[0]
      .trim();
    if (!firstLine.startsWith("#!")) {
      return null;
    }
    const shebang = firstLine.slice(2).trim();
    const parts = shebang.split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return null;
    }
    // #!/usr/bin/env python3
    if (parts[0].endsWith("/env") && parts.length > 1) {
      return parts[1];
    }
    return parts[0];
  } catch (e) {
    return null;
  }
}

async function pythonFromPythonExtension(workspaceRoot) {
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (!ext) {
      return null;
    }
    const api = await ext.activate();
    const resource = vscode.Uri.file(workspaceRoot);

    const details =
      api?.settings?.getExecutionDetails?.(resource) ??
      api?.settings?.getExecutionDetails?.(workspaceRoot);

    const execCommand = details?.execCommand;
    if (Array.isArray(execCommand) && execCommand.length > 0 && typeof execCommand[0] === "string") {
      return execCommand[0];
    }

    const envPath = api?.environments?.getActiveEnvironmentPath?.(resource);
    if (envPath && typeof envPath.path === "string" && envPath.path) {
      return envPath.path;
    }

    const env = api?.environments?.getActiveEnvironment?.(resource);
    const envExecutable =
      env?.executable?.uri?.fsPath || env?.executable?.sysPrefix || env?.executable?.path;
    if (typeof envExecutable === "string" && envExecutable) {
      return envExecutable;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function pythonFromEnv() {
  const env = process.env;
  const candidates = [];
  const venv = env.VIRTUAL_ENV || env.CONDA_PREFIX;
  if (venv) {
    const binDir = process.platform === "win32" ? "Scripts" : "bin";
    const exe = process.platform === "win32" ? "python.exe" : "python";
    candidates.push(path.join(venv, binDir, exe));
  }
  return candidates;
}

async function findOnPath(command, cwd) {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(tool, [command], { cwd, timeout: 2000 });
    const first = String(stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l);
    return first || null;
  } catch (e) {
    return null;
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, options || {}, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalizeEntrypoint(ep, workspaceRoot) {
  return {
    kind: "entrypoint",
    flowId: ep.flowId,
    label: ep.label,
    contract: ep.contract,
    tooltip: ep.tooltip,
    inherited: !!ep.inherited,
    inheritedFrom: ep.inheritedFrom || null,
    location: normalizeLocation(ep.location, workspaceRoot),
    calls: (ep.calls || []).map((c, idx) => normalizeCall(c, workspaceRoot, idx + 1)),
  };
}

function normalizeCall(call, workspaceRoot, order) {
  return {
    kind: "call",
    order: Number(order || 0) || undefined,
    label: call.label,
    contract: call.contract,
    kindLabel: call.kindLabel,
    tooltip: call.tooltip,
    cycle: !!call.cycle,
    location: normalizeLocation(call.location, workspaceRoot),
    calls: (call.calls || []).map((c, idx) => normalizeCall(c, workspaceRoot, idx + 1)),
  };
}

function normalizeLocation(location, workspaceRoot) {
  if (!location || !location.file) {
    return null;
  }
  const file = path.isAbsolute(location.file)
    ? location.file
    : path.join(workspaceRoot, location.file);
  return {
    file,
    line: Number(location.line || 0),
    character: Number(location.character || 0),
  };
}

function buildExtractorArgs(scriptPath, analysisTarget, workspaceRoot, options) {
  const scriptArgs = [
    scriptPath,
    "--target",
    analysisTarget,
    "--workspace-root",
    workspaceRoot,
    "--exclude-dependencies",
    String(!!options.excludeDependencies),
    "--expand-dependencies",
    String(!!options.expandDependencies),
    "--max-depth",
    String(options.maxCallDepth),
  ];

  if (options.slitherRepoPath) {
    scriptArgs.push("--slither-repo", options.slitherRepoPath);
  }
  if (options.solcPath) {
    scriptArgs.push("--solc", options.solcPath);
  }
  if (options.solcArgs) {
    scriptArgs.push("--solc-args", options.solcArgs);
  }
  for (const p of options.filterPaths || []) {
    if (typeof p === "string" && p) {
      scriptArgs.push("--filter-path", p);
    }
  }

  return scriptArgs;
}

function runExtractor(
  pythonRunner,
  scriptPath,
  analysisTarget,
  workspaceRoot,
  analysisCwd,
  options,
  progressOptions
) {
  const spawnOnce = (token) =>
    new Promise((resolve, reject) => {
      const scriptArgs = buildExtractorArgs(scriptPath, analysisTarget, workspaceRoot, options);

      // pythonRunner is {cmd, args} where args are prepended to scriptArgs
      const cmd = pythonRunner.cmd;
      const args = [...(pythonRunner.args || []), ...scriptArgs];

      const proc = cp.spawn(cmd, args, {
        cwd: analysisCwd || workspaceRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });

      let stdout = "";
      let stderr = "";

      const disposeCancel =
        token && typeof token.onCancellationRequested === "function"
          ? token.onCancellationRequested(() => {
              try {
                proc.kill();
              } catch (e) {
                // ignore
              }
            })
          : { dispose: () => {} };

      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("error", (err) => {
        disposeCancel.dispose();
        reject(err);
      });

      proc.on("close", (code) => {
        disposeCancel.dispose();
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed);
        } catch (e) {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Extractor exited with code ${code}`));
          } else {
            reject(
              new Error(`Failed to parse extractor output as JSON. stderr: ${stderr.trim()}`)
            );
          }
        }
      });
    });

  if (progressOptions?.silent) {
    return spawnOnce(undefined);
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Flowther: Analyzing Solidity workflows (Slither)…",
      cancellable: true,
    },
    (_progress, token) => spawnOnce(token)
  );
}

module.exports = {
  activate,
  deactivate,
};
