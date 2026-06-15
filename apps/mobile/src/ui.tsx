/** Base RN design system — the dark-theme primitives every screen builds on. */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

export const theme = {
  bg: '#0f1115',
  surface: '#171a21',
  surface2: '#1f2430',
  border: '#2a3140',
  text: '#e6e9ef',
  dim: '#98a2b3',
  accent: '#5b8cff',
  danger: '#ff6b6b',
  ok: '#46c08a',
};

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.screenContent} testID={testID} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={s.h1}>{children}</Text>;
}

export function H2({ children }: { children: ReactNode }) {
  return <Text style={s.h2}>{children}</Text>;
}

export function Txt({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Text style={s.txt} testID={testID}>{children}</Text>;
}

export function Muted({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Text style={s.muted} testID={testID}>{children}</Text>;
}

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  return <View style={s.card} testID={testID}>{children}</View>;
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <Text style={s.badge}>{children}</Text>;
}

export function Btn({
  title,
  onPress,
  variant = 'default',
  disabled,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' && s.btnPrimary,
        disabled === true && s.btnDisabled,
        pressed && !(disabled === true) && s.btnPressed,
      ]}
    >
      <Text style={[s.btnText, variant === 'primary' && s.btnTextPrimary, variant === 'danger' && s.btnTextDanger]}>{title}</Text>
    </Pressable>
  );
}

export function Field({
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  testID,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'numeric';
  testID?: string;
}) {
  return (
    <TextInput
      style={s.field}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.dim}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      autoCapitalize="none"
      testID={testID}
    />
  );
}

/** A small progress meter (0..1, capped). */
export function Meter({ fill }: { fill: number }) {
  return (
    <View style={s.meter}>
      <View style={[s.meterFill, { width: `${Math.min(100, Math.max(0, fill * 100))}%` }]} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  screenContent: { padding: 16, gap: 10 },
  h1: { color: theme.text, fontSize: 24, fontWeight: '700', marginBottom: 4 },
  h2: { color: theme.text, fontSize: 17, fontWeight: '600', marginTop: 12 },
  txt: { color: theme.text, fontSize: 15 },
  muted: { color: theme.dim, fontSize: 13 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { color: theme.dim, backgroundColor: theme.surface2, fontSize: 11, textTransform: 'uppercase', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: 'hidden' },
  btn: { borderColor: theme.border, borderWidth: 1, backgroundColor: theme.surface2, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnPressed: { opacity: 0.7 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: theme.text, fontSize: 14, fontWeight: '500' },
  btnTextPrimary: { color: '#ffffff' },
  btnTextDanger: { color: theme.danger },
  field: { color: theme.text, backgroundColor: theme.bg, borderColor: theme.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  meter: { height: 8, borderRadius: 999, backgroundColor: theme.surface2, overflow: 'hidden' },
  meterFill: { height: '100%', backgroundColor: theme.accent, borderRadius: 999 },
});
