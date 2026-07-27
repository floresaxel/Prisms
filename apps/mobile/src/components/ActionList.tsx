/**
 * A choose-one list, used for the itinerary's ••• menu and the "which block?"
 * picker.
 *
 * NOT `Alert.alert`: Android silently renders at most THREE buttons and
 * reorders them, so a six-action row menu lost half its actions and a block
 * picker dropped both "No block" and "Cancel" — with no error anywhere. This
 * renders every action, in order, and scrolls when there are many.
 *
 * Used on iOS too rather than `ActionSheetIOS`, so there is one behaviour and
 * one set of styles to reason about.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { theme } from '../ui';

export interface ActionItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface ActionRequest {
  title: string;
  message?: string;
  actions: ActionItem[];
}

export function ActionList({ request, onDismiss }: { request: ActionRequest | null; onDismiss: () => void }) {
  return (
    <Modal visible={request !== null} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={s.scrim} onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss">
        {/* Swallow presses on the card so they do not dismiss. */}
        <Pressable style={s.card} onPress={() => undefined} testID="action-list">
          <Text style={s.title} numberOfLines={2}>
            {request?.title}
          </Text>
          {request?.message !== undefined && <Text style={s.message}>{request.message}</Text>}

          <ScrollView style={s.list} bounces={false}>
            {(request?.actions ?? []).map((action) => (
              <Pressable
                key={action.label}
                onPress={() => {
                  onDismiss();
                  action.onPress();
                }}
                accessibilityRole="button"
                testID={`action-${action.label}`}
                style={({ pressed }) => [s.action, pressed && s.actionPressed]}
              >
                <Text style={[s.actionText, action.destructive === true && s.actionDestructive]}>{action.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable onPress={onDismiss} testID="action-cancel" style={({ pressed }) => [s.cancel, pressed && s.actionPressed]}>
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: theme.scrim, justifyContent: 'flex-end' },
  card: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: 24,
    maxHeight: '75%',
  },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', paddingHorizontal: 20 },
  message: { color: theme.dim, fontSize: 13, paddingHorizontal: 20, marginTop: 4 },
  list: { marginTop: 10, flexGrow: 0 },
  action: { paddingHorizontal: 20, paddingVertical: 15, borderTopWidth: 1, borderTopColor: theme.border },
  actionPressed: { backgroundColor: theme.surface2 },
  actionText: { color: theme.text, fontSize: 15.5, fontWeight: '500' },
  actionDestructive: { color: theme.danger },
  cancel: { marginTop: 8, marginHorizontal: 16, paddingVertical: 13, borderRadius: 12, backgroundColor: theme.surface2, alignItems: 'center' },
  cancelText: { color: theme.dim, fontSize: 15, fontWeight: '600' },
});
