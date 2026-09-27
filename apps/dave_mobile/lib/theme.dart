import 'package:flutter/cupertino.dart';

import 'look.dart';

/// Design tokens for the Dave app, following .claude/skills/apple-design.
///
/// The rules that shape everything below, and the reason each one cuts against the obvious
/// instinct:
///   - Colours are Apple's own SEMANTIC system colours (CupertinoColors.label,
///     systemGroupedBackground, ...). They are dynamic: each resolves to the right value for
///     light or dark on its own, so the app never hardcodes a theme.
///   - Light is the default. Dark is the system's choice, not ours.
///   - ONE accent (systemBlue). Green and red appear only where they mean profit and loss.
///   - Glass, iOS-26 style: every screen sits on one soft, blurred colour field ([Aurora]), and
///     content is frosted panels over it ([glassDecoration]) -- translucent white with a bright
///     hairline edge. The field is already blurred, so the panels read as frosted without a
///     live blur per card (which would cost battery on every Android phone). Real backdrop blur is
///     kept for what floats over scrolling content: the tab bar, navigation bar and composer.
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
  return pnl > 0 ? Look.of(context).up : Look.of(context).down;
}

/// The colour field every screen sits on: a few large, soft orbs of blue, violet and teal on a
/// near-white (light) or deep navy (dark) base. Static -- nothing animates behind reading.
class Aurora extends StatelessWidget {
  const Aurora({super.key});

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(color: look.base),
      child: Stack(fit: StackFit.expand, children: [
        for (final (align, color, strength) in look.orbs)
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(center: align, radius: 0.95, colors: [color.withValues(alpha: strength), color.withValues(alpha: 0)]),
            ),
          ),
      ]),
    );
  }
}

/// A panel in the chosen look: its card colour with a hairline edge.
BoxDecoration glassDecoration(BuildContext context, {double radius = 22, Color? tint}) {
  final look = Look.of(context);
  return BoxDecoration(
    color: tint ?? look.card,
    borderRadius: BorderRadius.circular(radius),
    border: Border.all(color: look.line, width: 1),
  );
}

/// The navigation bars' glass: see-through enough for the colour field to glow through the blur.
const glassBar = CupertinoDynamicColor.withBrightness(color: Color(0x9EF4F6FC), darkColor: Color(0x8C0B0F1C));

/// A floating layer -- the bottom bar and the chat's composer -- in the look's bar colour, with
/// a hairline edge and a soft lift. No live blur: it stays smooth on every Android phone.
class Glass extends StatelessWidget {
  const Glass({super.key, required this.child, this.radius = 28, this.color});

  final Widget child;
  final double radius;

  /// Defaults to the look's bar colour.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color ?? look.bar,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: look.line, width: 1),
        boxShadow: [BoxShadow(color: look.dark ? const Color(0x66000000) : const Color(0x22000000), blurRadius: 24, offset: const Offset(0, 8))],
      ),
      child: ClipRRect(borderRadius: BorderRadius.circular(radius), child: child),
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
