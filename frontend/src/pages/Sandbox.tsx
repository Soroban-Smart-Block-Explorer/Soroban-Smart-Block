import React, { useState, useRef, useEffect, Suspense, lazy } from "react";
import "../styles/Sandbox.css";
import FileExplorer from "../components/FileExplorer";
import Terminal from "../components/Terminal";
import Preview from "../components/Preview";
import ActionBar from "../components/ActionBar";
import TemplateSelector from "../components/TemplateSelector";
import { initWebContainer, mountFiles, runCommand, SandboxFile } from "../services/webcontainer";
import { getTemplate } from "../services/templates";
import { generateSandboxId } from "../services/export";
import { saveSandbox } from "../services/sandbox-api";
import { createAutoSaver } from "../services/session";
import { WebContainer } from "@webcontainer/api";

const Editor = lazy(() => import("../components/Editor"));

const Sandbox: React.FC = () => {
  const [files, setFiles] = useState<Map<string, SandboxFile>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showTemplateSelector, setShowTemplateSelector] = useState(true);
  const [sandboxId] = useState(generateSandboxId());
  const [templateId, setTemplateId] = useState<string>("");
  const webcontainerRef = useRef<WebContainer | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const autoSaverRef = useRef<(() => void) | null>(null);

  const initializeSandbox = async (templateId: string) => {
    setIsInitializing(true);
    setTemplateId(templateId);
    try {
      const container = await initWebContainer();
      webcontainerRef.current = container;

      const template = getTemplate(templateId);
      if (!template) throw new Error("Template not found");

      const templateMap = new Map(Object.entries(template.files));
      setFiles(templateMap);
      setSelectedFile(Object.keys(template.files)[0]);

      await mountFiles(container, templateMap);

      // Start auto-saver
      if (autoSaverRef.current) autoSaverRef.current();
      autoSaverRef.current = createAutoSaver(sandboxId, templateId, templateMap, Object.keys(template.files)[0]);

      // Persist to backend
      await saveSandbox(sandboxId, templateId, templateMap);

      setTerminalOutput(["> Sandbox initialized with " + template.name]);
      setShowTemplateSelector(false);
    } catch (error) {
      console.error("Initialization error:", error);
      setTerminalOutput([
        "✗ Failed to initialize WebContainer",
        "Note: WebContainer requires COOP/COEP headers. Running in demo mode.",
      ]);
      setShowTemplateSelector(false);
    } finally {
      setIsInitializing(false);
    }
  };

  const currentFile = selectedFile ? files.get(selectedFile) : null;

  const handleFileSelect = (path: string) => {
    setSelectedFile(path);
  };

  const handleFileChange = (content: string) => {
    if (selectedFile) {
      const updatedFile = { ...files.get(selectedFile)!, content };
      const newFiles = new Map(files).set(selectedFile, updatedFile);
      setFiles(newFiles);
    }
  };

  // Auto-persist files when they change
  useEffect(() => {
    if (files.size > 0 && templateId && sandboxId) {
      saveSandbox(sandboxId, templateId, files).catch((error) => {
        console.warn("Failed to auto-save:", error);
      });
    }
  }, [files, templateId, sandboxId]);

  const handleRun = async () => {
    if (!webcontainerRef.current) {
      setTerminalOutput((prev) => [...prev, "✗ WebContainer not available"]);
      return;
    }

    setIsRunning(true);
    setTerminalOutput((prev) => [...prev, "$ npm start", ""]);

    try {
      await runCommand(webcontainerRef.current, "npm install", (line) => {
        setTerminalOutput((prev) => [...prev, line]);
      });

      await runCommand(webcontainerRef.current, "npm start", (line) => {
        setTerminalOutput((prev) => [...prev, line]);
      });
    } catch (error) {
      setTerminalOutput((prev) => [...prev, `✗ Error: ${error instanceof Error ? error.message : "Unknown error"}`]);
    } finally {
      setIsRunning(false);
    }
  };

  if (showTemplateSelector) {
    return (
      <div className="sandbox-container">
        <div className="sandbox-header">
          <h1>Soroban Sandbox</h1>
        </div>
        <TemplateSelector onSelect={initializeSandbox} />
      </div>
    );
  }

  if (isInitializing) {
    return (
      <div className="sandbox-container">
        <div className="sandbox-header">
          <h1>Soroban Sandbox</h1>
        </div>
        <div className="placeholder">Initializing WebContainer...</div>
      </div>
    );
  }

  return (
    <div className="sandbox-container">
      <div className="sandbox-header">
        <h1>Soroban Sandbox</h1>
        <button onClick={handleRun} disabled={isRunning}>
          {isRunning ? "Running..." : "Run"}
        </button>
      </div>

      <ActionBar files={files} sandboxId={sandboxId} />

      <div className="sandbox-layout">
        <FileExplorer files={Array.from(files.values())} selectedFile={selectedFile} onSelectFile={handleFileSelect} />

        <div className="editor-section">
          {currentFile ? (
            <Suspense fallback={<div className="placeholder">Loading editor...</div>}>
              <Editor file={currentFile} onChange={handleFileChange} />
            </Suspense>
          ) : (
            <div className="placeholder">Select a file to edit</div>
          )}
        </div>

        <div className="right-panel">
          <Preview packageJsonContent={files.get("package.json")?.content || ""} />
          <Terminal output={terminalOutput} />
        </div>
      </div>
    </div>
  );
};

export default Sandbox;
