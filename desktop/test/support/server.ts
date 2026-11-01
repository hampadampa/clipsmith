import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FilePart } from "../../src/shared/multipart.ts";

export async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.statusCode = 500;
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Minimal multipart parser, good enough to check our writer's framing from the outside. */
export function parseMultipart(body: Buffer, contentType: string): ParsedPart[] {
  const m = /boundary=(.+)$/.exec(contentType);
  if (!m) throw new Error("no boundary");
  const delim = Buffer.from(`--${m[1]}`);
  const parts: ParsedPart[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const after = pos + delim.length;
    if (body.subarray(after, after + 2).toString() === "--") break;
    const start = after + 2; // skip CRLF after the boundary line
    const next = body.indexOf(delim, start);
    if (next === -1) throw new Error("unterminated multipart body");
    const part = body.subarray(start, next - 2); // drop the CRLF that precedes the next boundary
    const sep = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, sep).toString();
    parts.push({
      name: /name="([^"]*)"/.exec(headers)?.[1] ?? "",
      filename: /filename="([^"]*)"/.exec(headers)?.[1],
      contentType: /Content-Type: (.+)/i.exec(headers)?.[1]?.trim(),
      data: part.subarray(sep + 4),
    });
    pos = next;
  }
  return parts;
}

/** A FilePart backed by memory, counting how often it was opened. */
export function memoryFile(
  data: Uint8Array,
  opts: { chunkSize?: number; name?: string; claimSize?: number; onChunk?: (i: number) => void | Promise<void> } = {},
): FilePart & { opens: number; returned: number } {
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  const f = {
    fieldName: "video",
    filename: opts.name ?? "recording.mp4",
    contentType: "video/mp4",
    size: opts.claimSize ?? data.byteLength,
    opens: 0,
    returned: 0,
    open() {
      f.opens++;
      return (async function* () {
        try {
          for (let off = 0, i = 0; off < data.byteLength; off += chunkSize, i++) {
            await opts.onChunk?.(i);
            yield data.subarray(off, Math.min(off + chunkSize, data.byteLength));
          }
        } finally {
          f.returned++;
        }
      })();
    },
  };
  return f;
}
