/**
 * Read-only graph (§12.1 mobile: "read-and-navigate only"): renders a diagram
 * root's children from their saved `diagram_layouts` positions; tapping a node
 * that has its own children drills into it (navigation). No editing on mobile —
 * the web/desktop flowchart owns that.
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useFlowchart, useIsHydrated, useNodeTree } from '@prisms/ui';

import { Badge, H1, Muted, Row, Screen, Skeleton, theme, Txt } from '../ui';

const SCALE = 0.8;
const NODE_W = 150;
const NODE_H = 64;

export function Graph() {
  const tree = useNodeTree();
  const roots = useMemo(
    () => [...tree.byId.values()].filter((n) => n.node_type === 'vision' || n.node_type === 'roadmap' || n.node_type === 'project').sort((a, b) => (a.title < b.title ? -1 : 1)),
    [tree],
  );
  const [rootId, setRootId] = useState<string | null>(null);
  const active = rootId ?? roots[0]?.id ?? null;
  const view = useFlowchart(active, 'nodates');
  const hydrated = useIsHydrated();

  const activeNode = active !== null ? tree.byId.get(active) : undefined;
  const hasChildren = (id: string) => (tree.childrenByParent.get(id)?.length ?? 0) > 0;

  const width = Math.max(...view.nodes.map((n) => n.x * SCALE + NODE_W), 320) + 20;
  const height = Math.max(...view.nodes.map((n) => n.y * SCALE + NODE_H), 120) + 20;

  return (
    <Screen testID="graph">
      <H1>Graph</H1>
      <Muted>Tap a node to navigate into it. Read-only on mobile.</Muted>

      <Row>
        {roots.map((r) => (
          <Pressable key={r.id} testID={`graph-root-${r.id}`} onPress={() => setRootId(r.id)}>
            <Badge>{active === r.id ? `▶ ${r.title}` : r.title}</Badge>
          </Pressable>
        ))}
      </Row>

      {activeNode !== undefined && (
        <Row>
          <Txt>{activeNode.title}</Txt>
          {activeNode.parent_id !== null && hasChildren(activeNode.parent_id) && (
            <Pressable testID="graph-up" onPress={() => setRootId(activeNode.parent_id)}>
              <Badge>↑ up</Badge>
            </Pressable>
          )}
        </Row>
      )}

      {view.nodes.length === 0 ? (
        hydrated ? <Muted>No child nodes to show.</Muted> : <Skeleton testID="graph-skeleton" />
      ) : (
        <ScrollView horizontal style={{ borderColor: theme.border, borderWidth: 1, borderRadius: 10, backgroundColor: theme.bg }}>
          <View style={{ width, height, position: 'relative' }}>
            {view.nodes.map((n) => (
              <Pressable
                key={n.id}
                testID={`graph-node-${n.id}`}
                onPress={() => { if (hasChildren(n.id)) setRootId(n.id); }}
                style={{
                  position: 'absolute',
                  left: n.x * SCALE + 6,
                  top: n.y * SCALE + 6,
                  width: NODE_W,
                  minHeight: NODE_H,
                  backgroundColor: theme.surface2,
                  borderColor: hasChildren(n.id) ? theme.accent : theme.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <Txt>{n.title}</Txt>
                <Muted>{n.nodeType}{hasChildren(n.id) ? ' · tap to open' : ''}</Muted>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      <Muted>{view.edges.length} dependency edge(s)</Muted>
    </Screen>
  );
}
