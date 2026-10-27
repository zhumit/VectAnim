/**
 * Group selection semantics.
 *
 * Groups in the document are logical groups (GroupDef.ShapeIds), not Fabric
 * Groups: at render time the members stay independent objects. For "grouped
 * means one shape" to hold, the selection has to be expanded to whole groups so
 * that drag/scale/arrow keys/delete naturally apply to the group.
 */

import type { GroupDef } from '../schema/types';

/** All members of the group a shape belongs to; empty array when it is ungrouped */
export function groupMembersOf(shapeId: string, groups: readonly GroupDef[]): string[] {
  for (const group of groups) {
    if (group.ShapeIds.includes(shapeId)) return [...group.ShapeIds];
  }
  return [];
}

/**
 * Expand a selection to whole groups: selecting any member selects the group.
 * Keeps the input order and appends new members in group order; nested/overlapping
 * groups are handled by looping until nothing changes.
 */
export function expandSelectionToGroups(ids: readonly string[], groups: readonly GroupDef[]): string[] {
  if (!ids.length || !groups.length) return [...ids];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.ShapeIds.some((id) => seen.has(id))) continue;
      for (const id of group.ShapeIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        changed = true;
      }
    }
  }
  return result;
}

/** Whether the selection already fully covers these ids */
export function containsAll(selection: readonly string[], ids: readonly string[]): boolean {
  if (!ids.length) return true;
  const set = new Set(selection);
  return ids.every((id) => set.has(id));
}
