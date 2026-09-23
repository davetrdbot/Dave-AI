import 'dart:ui' show ImageFilter;

import 'package:flutter/cupertino.dart';

/// Design tokens for the Dave app, following .claude/skills/apple-design.
///
/// The rules that shape everything below, and the reason each one cuts against the obvious
/// instinct:
///   - Colours are Apple's own SEMANTIC system colours (CupertinoColors.label,
///     systemGroupedBackground, ...). They are dynamic: each resolves to the right value for
///     light or dark on its own, so the app never hardcodes a theme.
///   - Light is the default. Dark is the system's choice, not ours.
///   - ONE accent (systemBlue). Green and red appear only where they mean profit and loss.
///   - Glass is for CHROME ONLY -- the floating tab bar and the navigation bar. Content never
///     wears glass, and glass never sits on glass.
///   - No emoji anywhere. Iconography is CupertinoIcons, the SF-Symbols-style set.

/// 8pt grid.
class Space {
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 24;
  static const double s6 = 32;

  /// HIG minimum touch target.
  static const double tap = 44;
}

/// Resolves one of Apple's dynamic colours against the current brightness.
Color resolve(BuildContext context, Color color) => CupertinoDynamicColor.resolve(color, context);

/// Profit / loss colour. Zero is neutral, because a flat trade is not good news.
Color pnlColor(BuildContext context, num? pnl) {
  if (pnl == null || pnl == 0) return resolve(context, CupertinoColors.secondaryLabel);
  return resolve(context, pnl > 0 ? CupertinoColors.systemGreen : CupertinoColors.systemRed);
}

/// A floating layer that samples and blurs what is behind it.
///
/// Used ONLY for chrome. Under high contrast it becomes an opaque surface: Flutter exposes no
/// "reduce transparency" flag, and high contrast is the closest honest signal that translucency is
/// hurting legibility for this person. A translucent bar that stays translucent there is the
/// accessibility failure, not a lesser effect.
class Glass extends StatelessWidget {
  const Glass({super.key, required this.child, this.radius = 28});

  final Widget child;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final brightness = CupertinoTheme.brightnessOf(context);
    final dark = brightness == Brightness.dark;
    final opaque = MediaQuery.highContrastOf(context);
    final fill = opaque
        ? resolve(context, CupertinoColors.secondarySystemGroupedBackground)
        : (dark ? const Color(0xB81E1E20) : const Color(0xB8FFFFFF));
    // The light top edge is what makes glass read as a physical layer rather than as a tint.
    final edge = dark ? const Color(0x24FFFFFF) : const Color(0x80FFFFFF);

    final body = DecoratedBox(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: edge, width: 0.5),
        boxShadow: const [BoxShadow(color: Color(0x1A000000), blurRadius: 24, offset: Offset(0, 8))],
      ),
      child: child,
    );

    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: opaque ? body : BackdropFilter(filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24), child: body),
    );
  }
}

/// "12,345.67" -- grouped thousands, two decimals. [signed] adds an explicit "+" for gains.
String formatMoney(num value, {bool signed = false}) {
  final negative = value < 0;
  final fixed = value.abs().toStringAsFixed(2);
  final parts = fixed.split('.');
  final grouped = _group(parts[0]);
  final sign = negative ? '-' : (signed && value > 0 ? '+' : '');
  return '$sign\$$grouped.${parts[1]}';
}

/// A market price exactly as precise as it is -- "196,740" for a synthetic index, "1.095" for a
/// forex pair -- rather than forcing one decimal count on every instrument.
String formatPrice(num value) {
  var s = value.toStringAsFixed(5);
  s = s.replaceFirst(RegExp(r'0+$'), '');
  if (s.endsWith('.')) s = s.substring(0, s.length - 1);
  final parts = s.split('.');
  final grouped = _group(parts[0].replaceFirst('-', ''));
  final sign = value < 0 ? '-' : '';
  return parts.length > 1 ? '$sign$grouped.${parts[1]}' : '$sign$grouped';
}

String _group(String digits) {
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}

/// "just now", "4 min ago", "2 h ago", then a date.
String formatAgo(DateTime at, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(at);
  if (diff.inSeconds < 45) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24) return '${diff.inHours} h ago';
  return '${at.year}-${at.month.toString().padLeft(2, '0')}-${at.day.toString().padLeft(2, '0')}';
}
