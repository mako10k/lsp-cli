import { pathToFileURL } from "node:url";

export function pathToFileUri(p: string): string {
  return pathToFileURL(p).toString();
}
