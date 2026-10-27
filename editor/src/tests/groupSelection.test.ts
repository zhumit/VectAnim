import { describe, expect, it } from 'vitest';
import { containsAll, expandSelectionToGroups, groupMembersOf } from '../editor/groupSelection';
import type { GroupDef } from '../schema/types';

const groups: GroupDef[] = [
  { GroupId: 'g1', Name: 'Gear', ShapeIds: ['a', 'b', 'c'], Visible: true },
  { GroupId: 'g2', Name: 'Gauge', ShapeIds: ['d', 'e'], Visible: true },
];

describe('group selection expansion', () => {
  it('selecting any member → whole group', () => {
    expect(expandSelectionToGroups(['b'], groups)).toEqual(['b', 'a', 'c']);
  });

  it('ungrouped shapes stay unchanged', () => {
    expect(expandSelectionToGroups(['x'], groups)).toEqual(['x']);
  });

  it('multiple groups + ungrouped shapes mixed', () => {
    expect(expandSelectionToGroups(['e', 'x'], groups)).toEqual(['e', 'x', 'd']);
  });

  it('no duplicate appends when the whole group is already selected', () => {
    expect(expandSelectionToGroups(['a', 'b', 'c'], groups)).toEqual(['a', 'b', 'c']);
  });

  it('empty selection stays empty', () => {
    expect(expandSelectionToGroups([], groups)).toEqual([]);
    expect(expandSelectionToGroups(['a'], [])).toEqual(['a']);
  });

  it('member lookup', () => {
    expect(groupMembersOf('c', groups)).toEqual(['a', 'b', 'c']);
    expect(groupMembersOf('x', groups)).toEqual([]);
  });

  it('coverage check', () => {
    expect(containsAll(['a', 'b', 'c'], ['a', 'c'])).toBe(true);
    expect(containsAll(['a'], ['a', 'c'])).toBe(false);
    expect(containsAll([], [])).toBe(true);
  });
});
