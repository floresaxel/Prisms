/**
 * Lets a project picker mint a project on the spot. A project's only legal parent
 * is a roadmap (I1), so this offers the roadmaps to put it in; with no roadmap
 * there is nowhere to put one and the picker simply doesn't offer "New project".
 */
import { useMemo } from 'react';

import { initialSortOrder, sortOrderBetween } from '@prisms/core';
import { useNodeTree, type PrismsCommands } from '@prisms/ui';

export interface NewProjectApi {
  /** The roadmaps a new project can go under, in their own order. */
  roadmaps: { id: string; title: string }[];
  /** Creates the project (at the end of the roadmap) and returns its id. */
  create: (title: string, roadmapId: string) => Promise<string>;
}

export function useNewProject(commands: PrismsCommands): NewProjectApi | undefined {
  const tree = useNodeTree();
  return useMemo(() => {
    const roadmaps = [...tree.byId.values()]
      .filter((n) => n.node_type === 'roadmap')
      .sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : a.id < b.id ? -1 : 1))
      .map((n) => ({ id: n.id, title: n.title }));
    if (roadmaps.length === 0) return undefined;
    return {
      roadmaps,
      create: (title, roadmapId) => {
        const last = tree.childrenByParent.get(roadmapId)?.at(-1)?.sort_order ?? null;
        const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
        return commands.createProject({ roadmapId, title, sortOrder });
      },
    };
  }, [tree, commands]);
}
