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
    <Pentagon
      tone={hex ? undefined : projectTone(projectId)}
      hex={hex ?? undefined}
      testId={projectId === null ? undefined : `project-dot-${projectId}`}
    />
  );
}

/** A pentagon in the id-derived tone, for the rows that don't take a vision colour yet. */
export function PentagonTone({ projectId }: { projectId: string | null }) {
  return <Pentagon tone={projectTone(projectId)} />;
}

/**
 * Drawn as an inline SVG polygon, NOT a CSS `clip-path`: a non-rectangular clip-path
 * gets its own compositor mask layer, and that layer scrolls out of step with the
 * page (the pentagons lag behind or run ahead of their rows). An SVG is painted
 * into the same layer as the row, so it moves with the page. The vertices are those
 * of a regular pentagon in its 1.902 : 1.809 bounding box (see `.px-pdot`).
 */
function Pentagon({ tone, hex, testId }: { tone?: ReturnType<typeof projectTone>; hex?: string; testId?: string }) {
  return (
    <svg
      className={`px-pdot${tone ? ` px-pdot--${tone}` : ''}`}
      style={hex ? { fill: hex } : undefined}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-vision-colour={hex}
      data-testid={testId}
    >
      <polygon points="50,0 100,38.2 80.9,100 19.1,100 0,38.2" />
    </svg>
  );
}
