export interface OutputFile {
  path: string;
  url: string;
  type?: string;
  build?: string;
}

export interface CompileResponse {
  status?: "success" | "failure" | "error" | "timedout" | "stopped-on-first-error" | "validation-fail" | "exception" | string;
  outputFiles?: OutputFile[];
  compileGroup?: string;
  clsiServerId?: string;
  pdfDownloadDomain?: string;
  stats?: Record<string, number>;
  timings?: Record<string, number>;
  validationProblems?: Record<string, unknown>;
}
