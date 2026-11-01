import type { Bridge } from "../shared/ipc.ts";

declare global {
  interface Window {
    clipsmith: Bridge;
  }
}

export {};
