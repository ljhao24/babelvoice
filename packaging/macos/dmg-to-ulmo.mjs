// electron-builder afterAllArtifactBuild hook: recompress each DMG with LZMA
// (ULMO), about a quarter smaller than the zlib image electron-builder writes.
// Its config schema rejects ULMO in dmg.format, hence the hook. ULMO opens on
// macOS 10.15+; the app itself needs 14.
import { execFileSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';

export default function afterAllArtifactBuild({ artifactPaths }) {
  for (const dmg of artifactPaths.filter((p) => p.endsWith('.dmg'))) {
    const tmp = dmg.replace(/\.dmg$/, '.ulmo.dmg');
    execFileSync('hdiutil', ['convert', dmg, '-format', 'ULMO', '-ov', '-quiet', '-o', tmp]);
    renameSync(tmp, dmg);
    // The block map hashes the zlib image; nothing reads it (no auto-update).
    rmSync(`${dmg}.blockmap`, { force: true });
  }
  return [];
}
