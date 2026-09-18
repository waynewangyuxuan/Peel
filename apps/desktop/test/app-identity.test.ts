import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME, nativeAppIconPath } from "../src/main/app-identity";

const desktopRoot = resolve(import.meta.dirname, "..");
const canonicalPath = "M28 105V48C28 28 42 16 63 16H70C91 16 104 29 104 49C104 70 90 82 69 82H50V105H28ZM50 38V62H69C78 62 83 58 83 50C83 42 78 38 69 38H50Z";

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function icnsRepresentations(bytes: Buffer): Set<string> {
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("icns");
  expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  const representations = new Set<string>();
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThanOrEqual(8);
    representations.add(type);
    offset += length;
  }
  expect(offset).toBe(bytes.length);
  return representations;
}

describe("Peel native app identity", () => {
  it("uses the accepted renderer geometry in the native icon source", () => {
    const renderer = readFileSync(resolve(desktopRoot, "src/renderer/Brand.tsx"), "utf8");
    const source = readFileSync(resolve(desktopRoot, "build/Peel.svg"), "utf8");
    expect(renderer).toContain(canonicalPath);
    expect(source.match(new RegExp(canonicalPath, "g"))).toHaveLength(2);
    expect(source).toContain('width="1024" height="1024"');
    expect(source).toContain('clip-path="url(#phase-lower)"');
    expect(source).toContain('clip-path="url(#phase-upper)"');
  });

  it("ships a 1024px PNG and multi-size macOS icon", () => {
    const png = readFileSync(resolve(desktopRoot, "build/Peel.png"));
    expect(pngDimensions(png)).toEqual({ width: 1024, height: 1024 });
    expect(png.byteLength).toBeGreaterThan(10_000);

    const icns = readFileSync(resolve(desktopRoot, "build/Peel.icns"));
    const representations = icnsRepresentations(icns);
    expect([...representations]).toEqual(expect.arrayContaining(["ic07", "ic08", "ic09", "ic10"]));
  });

  it("resolves the local icon before both development and packaged windows", () => {
    expect(APP_DISPLAY_NAME).toBe("Peel");
    expect(nativeAppIconPath({ appRoot: "/repo/apps/desktop", isPackaged: false, resourcesPath: "/bundle/Resources" }))
      .toBe("/repo/apps/desktop/build/Peel.png");
    expect(nativeAppIconPath({ appRoot: "/repo/apps/desktop", isPackaged: true, resourcesPath: "/bundle/Resources" }))
      .toBe("/bundle/Resources/Peel.png");
  });
});
