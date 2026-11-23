/**
 * The small pentagon beside a project's name, in the colour of the vision the
 * project belongs to (the colour picked for that vision, so everything under one
 * vision reads as one tint). A project with no vision above it — not reachable in
 * a well-formed tree — keeps its id-derived tone.
 */
import { ancestorsOf, type TreeIndex } from '@prisms/core';
import { projectTone, visionColorOf, visionHex } from '@prisms/ui';

/** The vision's hex for `projectId`, or null when no vision sits above it. */
export function projectVisionHex(tree: TreeIndex, projectId: string): string | null {
  const vision = ancestorsOf(tree, projectId).find((a) => a.node_type === 'vision');
  return vision ? visionHex(visionColorOf(vision)) : null;
}

/**
 * `projectId` may be null (a row whose project is unknown): that keeps the old
 * neutral tone, like every other pentagon that has no vision to take a colour from.
 */
export function ProjectDot({ tree, projectId }: { tree: TreeIndex; projectId: string | null }) {
  const hex = projectId === null ? null : projectVisionHex(tree, projectId);
  return (
    <span
      className={`px-pdot${hex ? '' : ` px-pdot--${projectTone(projectId)}`}`}
      style={hex ? { background: hex } : undefined}
      data-vision-colour={hex ?? undefined}
      data-testid={projectId === null ? undefined : `project-dot-${projectId}`}
    />
  );
}
