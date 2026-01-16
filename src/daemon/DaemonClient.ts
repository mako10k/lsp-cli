import net from "node:net";
import { parseJsonlLine, toJsonl, type DaemonRequest } from "./protocol";

type Pending = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

export class DaemonClient {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<string, Pending>();

  static async connect(socketPath: string, timeoutMs = 1500): Promise<DaemonClient> {
    const socket = net.createConnection({ path: socketPath });

    await new Promise<void>((resolve, reject) => {
      const onError = (e: unknown) => {
        cleanup();
        reject(e);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout connecting to daemon: ${socketPath}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("connect", onConnect);
      };

      socket.on("error", onError);
      socket.on("connect", onConnect);
    });

    return new DaemonClient(socket);
  }

  private constructor(socket: net.Socket) {
    this.socket = socket;

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");

      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx < 0) break;
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);

        if (!line.trim()) continue;
        const msg = parseJsonlLine(line) as any;
        if (!msg || typeof msg !== "object") continue;

        const id: string | undefined = msg.id;
        if (!id) continue;

        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);

        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error ?? "unknown daemon error")));
      }
    });

    socket.on("error", (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
    });

    socket.on("close", () => {
      for (const [, p] of this.pending) p.reject(new Error("daemon connection closed"));
      this.pending.clear();
    });
  }

  async request<T = any>(req: DaemonRequest): Promise<T> {
    const id = req.id;
    if (!id) throw new Error("request id is required");

    const payload = toJsonl(req);

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.socket.write(payload);
    return promise;
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      // ignore
    }
  }
}
