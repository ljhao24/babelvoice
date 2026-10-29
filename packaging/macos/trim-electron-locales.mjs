// electron-builder afterPack hook (runs before signing). electronLanguages
// trims only the app's Contents/Resources/*.lproj, but Electron 44 keeps
// Chromium's locale.pak files inside the framework; drop the unwanted ones
// there too, with their gendered variants (zh_CN_FEMININE.lproj…). Chromium
// falls back to en-US for anything missing.
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const VARIANT = /_(FEMININE|MASCULINE|NEUTER)$/;

export default function afterPack({ appOutDir, packager }) {
  const wanted = [packager.platformSpecificBuildOptions.electronLanguages ?? packager.config.electronLanguages ?? []].flat();
  if (wanted.length === 0) return;
  const resources = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'
  );
  for (const name of readdirSync(resources)) {
    if (!name.endsWith('.lproj')) continue;
    const language = name.slice(0, -'.lproj'.length).replace(VARIANT, '');
    if (!wanted.includes(language)) rmSync(path.join(resources, name), { recursive: true, force: true });
  }
}
