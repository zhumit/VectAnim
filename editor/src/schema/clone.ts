import type { Shape, VectAnimDocument } from './types';

/** Deep-clone a document (structured clone, avoids implicit pollution from shared references) */
export function cloneDocumentDeep(document: VectAnimDocument): VectAnimDocument {
  if (typeof structuredClone === 'function') {
    return structuredClone(document);
  }
  return JSON.parse(JSON.stringify(document)) as VectAnimDocument;
}

export function cloneShape(shape: Shape): Shape {
  if (typeof structuredClone === 'function') {
    return structuredClone(shape);
  }
  return JSON.parse(JSON.stringify(shape)) as Shape;
}
