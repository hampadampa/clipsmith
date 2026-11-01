/**
 * Streaming multipart/form-data writer.
 *
 * `FormData` + `Blob` would load the whole recording into memory; an hour of screen
 * recording is several GB. Here the file is pulled chunk by chunk from `open()`, and the
 * total size is known up front so the request can carry an exact Content-Length.
 */

export interface FilePart {
  fieldName: string;
  filename: string;
  contentType: string;
  size: number;
  /** Called once per upload attempt (retries open the file again). */
  open(): AsyncIterable<Uint8Array>;
}

export interface MultipartBody {
  contentType: string;
  contentLength: number;
  stream(onFileBytes?: (n: number) => void, onError?: (e: unknown) => void): ReadableStream<Uint8Array>;
  /**
   * Stops reading and closes the file. Call it when the request is over, however it ended:
   * fetch (undici) does NOT cancel the body stream on abort, it just stops listening, so
   * without this the file would stay open and keep being read in the background.
   */
  dispose(): Promise<void>;
}

function randomBoundary(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return "----clipsmith" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const quoteName = (s: string): string => s.replaceAll('"', "%22").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function buildMultipart(fields: Record<string, string>, file: FilePart, boundary: string = randomBoundary()): MultipartBody {
  const enc = new TextEncoder();
  let headText = "";
  for (const [name, value] of Object.entries(fields)) {
    headText += `--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(name)}"\r\n\r\n${value}\r\n`;
  }
  headText +=
    `--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(file.fieldName)}"; filename="${quoteName(file.filename)}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`;
  const head = enc.encode(headText);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);

  let iterator: AsyncIterator<Uint8Array> | null = null;
  let disposed = false;

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.byteLength + file.size + tail.byteLength,
    async dispose() {
      disposed = true;
      await iterator?.return?.();
    },
    stream(onFileBytes, onError) {
      let phase: 0 | 1 | 2 = 0;
      let total = 0;
      const fail = (controller: ReadableStreamDefaultController<Uint8Array>, e: unknown) => {
        onError?.(e);
        controller.error(e);
      };
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              if (disposed) return controller.close();
              if (phase === 0) {
                controller.enqueue(head);
                iterator = file.open()[Symbol.asyncIterator]();
                phase = 1;
              } else if (phase === 1) {
                const r = await iterator!.next();
                if (disposed) return controller.close();
                if (r.done) {
                  if (total !== file.size) throw new Error(`The file changed while uploading (read ${total} of ${file.size} bytes).`);
                  controller.enqueue(tail);
                  phase = 2;
                } else {
                  total += r.value.byteLength;
                  if (total > file.size) throw new Error("The file grew while uploading.");
                  onFileBytes?.(r.value.byteLength);
                  controller.enqueue(r.value);
                }
              } else {
                controller.close();
              }
            } catch (e) {
              if (!disposed) fail(controller, e);
            }
          },
          async cancel() {
            disposed = true;
            await iterator?.return?.();
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}
