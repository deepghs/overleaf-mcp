// Minimal Chrome DevTools Protocol client over ws@8. Just enough to drive
// a single visible Chrome window: create a tab, navigate, poll location,
// read cookies, close the tab. No retries, no domain abstractions —
// callers compose commands themselves.

import WebSocket from "ws";

import { logger } from "../util/logger.js";

interface CdpResponse {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface PendingCall {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export type EventListener = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, EventListener[]>();
  private closed = false;
  private closeWaiters: Array<() => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
    ws.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`CDP socket closed before '${p.method}' completed`));
      }
      this.pending.clear();
      const waiters = this.closeWaiters;
      this.closeWaiters = [];
      for (const w of waiters) w();
    });
    ws.on("error", (err) => logger.debug(`cdp ws error: ${(err as Error).message}`));
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect to ${url} timed out`)), timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (err) => { clearTimeout(timer); reject(err as Error); });
    });
    return new CdpClient(ws);
  }

  private handleMessage(text: string): void {
    let msg: CdpResponse;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${p.method} failed: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const ls = this.listeners.get(msg.method);
      if (ls) for (const l of ls) try { l(msg.params ?? {}, msg.sessionId); } catch (e) {
        logger.warn(`cdp listener for ${msg.method} threw: ${(e as Error).message}`);
      }
    }
  }

  on(event: string, listener: EventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.closed) throw new Error(`CDP socket already closed (sending ${method})`);
    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
        timer,
        method,
      });
      try { this.ws.send(JSON.stringify(frame)); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  onClose(cb: () => void): void {
    if (this.closed) { cb(); return; }
    this.closeWaiters.push(cb);
  }

  close(): void {
    if (this.closed) return;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
