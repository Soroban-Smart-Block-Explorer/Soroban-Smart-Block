/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_STELLAR_NETWORK?: string;
  readonly VITE_CONTRACT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "monaco-editor" {
  export type editor = typeof import("monaco-editor").editor;
  export namespace editor {
    let create: (domElement: HTMLElement, options?: any) => IStandaloneCodeEditor;
    let setModelLanguage: (model: unknown, languageId: string) => void;
    interface IStandaloneCodeEditor {
      getValue(): string;
      setValue(value: string): void;
      getModel(): unknown;
      onDidChangeModelContent(cb: () => void): void;
      dispose(): void;
    }
  }
}

declare module "@webcontainer/api" {
  export class WebContainer {
    static boot(): Promise<WebContainer>;
    mount(tree: any): Promise<void>;
    install(deps: string[]): Promise<void>;
    spawn(command: string, args?: string[]): WebContainerProcess;
    on(event: string, cb: (...args: any[]) => void): void;
    teardown(): void;
  }
  interface WebContainerProcess {
    output: {
      pipeTo(writer: WritableStream<string>): Promise<void>;
    };
    exit: Promise<number>;
  }
}

declare module "jszip" {
  interface JSZipGeneratorOptions {
    type?: "blob" | "nodebuffer" | "uint8array";
  }
  class JSZip {
    file(path: string, data: string | ArrayBuffer | Uint8Array | Blob): this;
    generateAsync(options: JSZipGeneratorOptions): Promise<Blob>;
  }
  export default JSZip;
}
