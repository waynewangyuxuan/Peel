import { join } from "node:path";

export const APP_DISPLAY_NAME = "Peel";
export const APP_ICON_FILENAME = "Peel.png";

export function nativeAppIconPath(input: {
  appRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, APP_ICON_FILENAME)
    : join(input.appRoot, "build", APP_ICON_FILENAME);
}
