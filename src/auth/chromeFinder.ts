// Locate a Chromium-family browser on the user's system. We need any
// engine that speaks the Chrome DevTools Protocol — Chrome, Chromium,
// Brave, Edge, Arc all qualify and share the same flag/CDP surface.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichOne(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      const { stdout } = await execFileP("which", [name]);
      const line = stdout.trim().split("\n")[0]?.trim();
      if (line && (await exists(line))) return line;
    } catch {
      // not on PATH, try next
    }
  }
  return undefined;
}

function macCandidates(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

function windowsCandidates(): string[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
}

export async function findChrome(override?: string): Promise<string> {
  if (override) {
    if (await exists(override)) return override;
    throw new Error(`OL_BROWSER points to a missing or non-executable path: ${override}`);
  }
  if (process.platform === "darwin") {
    for (const p of macCandidates()) {
      if (await exists(p)) return p;
    }
  } else if (process.platform === "win32") {
    for (const p of windowsCandidates()) {
      if (await exists(p)) return p;
    }
  } else {
    const hit = await whichOne([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
    ]);
    if (hit) return hit;
  }
  throw new Error(
    "No Chromium-family browser found (Chrome / Brave / Edge / Arc / Chromium). " +
      "Install one, or set OL_BROWSER to an explicit binary path.",
  );
}
