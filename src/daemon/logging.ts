import fs from "node:fs";
import path from "node:path";

type Sink =
  | { mode: "discard" }
  | { mode: "file"; filePath: string; stream: fs.WriteStream };

export class DaemonLog {
  private sink: Sink = { mode: "discard" };

  getStatus(): { mode: "discard" } | { mode: "file"; path: string } {
    if (this.sink.mode === "discard") return { mode: "discard" };
    return { mode: "file", path: this.sink.filePath };
  }

  setDiscard(): void {
    this.close();
    this.sink = { mode: "discard" };
  }

  async setFile(filePath: string): Promise<void> {
    const p = path.resolve(filePath);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });

    this.close();

    const stream = fs.createWriteStream(p, { flags: "a" });
    this.sink = { mode: "file", filePath: p, stream };
  }

  write(line: string): void {
    const text = line.endsWith("\n") ? line : line + "\n";
    if (this.sink.mode === "discard") return;
    this.sink.stream.write(text);
  }

  close(): void {
    if (this.sink.mode === "file") {
      try {
        this.sink.stream.end();
      } catch {
        // ignore
      }
    }
  }
}
