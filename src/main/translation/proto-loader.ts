import protobuf from 'protobufjs';
import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

let cachedRoot: protobuf.Root | null = null;

const candidateProtoDirs = (): string[] => {
  const dirs: string[] = [];
  // Packaged: extraResources puts protos under resourcesPath.
  if (app.isPackaged) {
    dirs.push(resolve(process.resourcesPath, 'protos'));
  }
  // Dev: protos sit at repo root, two levels above out/main/.
  const here = dirname(fileURLToPath(import.meta.url));
  dirs.push(resolve(here, '..', '..', 'protos'));
  dirs.push(resolve(here, '..', '..', '..', 'protos'));
  dirs.push(resolve(process.cwd(), 'protos'));
  return dirs;
};

const findProtoRoot = (): string => {
  for (const dir of candidateProtoDirs()) {
    if (existsSync(resolve(dir, 'common', 'events.proto'))) return dir;
  }
  throw new Error(
    `Could not locate protos/ dir. Searched: ${candidateProtoDirs().join(', ')}`
  );
};

export const loadProtoRoot = async (): Promise<protobuf.Root> => {
  if (cachedRoot) return cachedRoot;
  const baseDir = findProtoRoot();
  const root = new protobuf.Root();
  // Resolve imports relative to baseDir.
  root.resolvePath = (_origin, target) => {
    if (target.startsWith('common/') || target.startsWith('products/')) {
      return resolve(baseDir, target);
    }
    return target;
  };
  await root.load(
    resolve(baseDir, 'products', 'understanding', 'ast', 'ast_service.proto'),
    { keepCase: true }
  );
  cachedRoot = root;
  return root;
};

export interface ProtoTypes {
  TranslateRequest: protobuf.Type;
  TranslateResponse: protobuf.Type;
}

let typesPromise: Promise<ProtoTypes> | null = null;
let loadedTypes: ProtoTypes | null = null;

/**
 * The single async init: load the .proto tree and resolve both message
 * Types once. Concurrent callers share one load; a failed load is not
 * cached, so the next session start can retry.
 */
export const ensureProtoTypes = (): Promise<ProtoTypes> => {
  if (loadedTypes) return Promise.resolve(loadedTypes);
  if (!typesPromise) {
    typesPromise = loadProtoRoot().then(
      (root) => {
        loadedTypes = {
          TranslateRequest: root.lookupType('data.speech.ast.TranslateRequest'),
          TranslateResponse: root.lookupType('data.speech.ast.TranslateResponse')
        };
        return loadedTypes;
      },
      (err: unknown) => {
        typesPromise = null;
        throw err;
      }
    );
  }
  return typesPromise;
};

/**
 * Synchronous accessor for the per-frame hot path (every uplink audio chunk
 * and every server frame): no await and no `lookupType` walk per frame.
 * Throws until `ensureProtoTypes()` has resolved — DoubaoClient awaits it
 * during start(), before any frame is encoded or decoded.
 */
export const getLoadedProtoTypes = (): ProtoTypes => {
  if (!loadedTypes) {
    throw new Error(
      'Doubao protobuf types not loaded — await ensureProtoTypes() first'
    );
  }
  return loadedTypes;
};

/** Async accessor kept for callers that only need the Types once. */
export const getProtoTypes = ensureProtoTypes;
