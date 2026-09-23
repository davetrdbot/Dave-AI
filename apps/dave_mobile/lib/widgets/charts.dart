import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

import '../api/models.dart';
import '../theme.dart';

/// Chart colours. Every pair here was run through the dataviz skill's validator
/// (scripts/validate_palette.js), not eyeballed -- and the validator changed the design.
///
/// The obvious heatmap is green = profit, red = loss. It FAILS for colour-blind readers: Apple's
/// systemGreen/systemRed measure CVD Delta E 6.8 (deutan), and the "accessible" high-contrast
/// variants measure WORSE (4.4-5.0), because green and red sit on exactly the axis protan/deutan
/// vision collapses. No choice of shades fixes that pair. Blue/red measures ~30 in light and ~28
/// in dark, so profit is BLUE on the heatmap.
///
/// Elsewhere in the app profit text stays green: a "+\$18.40" carries its sign, so nobody depends on
/// the colour. Heatmap cells carry no sign, so there the colour has to be safe on its own -- and a
/// tap on any cell shows its exact value, so it is never colour alone either way.
///
/// Brain map: memory blue / knowledge teal. Blue/purple was tried first and failed (5.9 light,
/// 4.3 dark). Apple's dark teal (#40c8e0) sat above the dark lightness band, so it is stepped down
/// to #23a0b0, which passes. The teal's sub-3:1 light-mode contrast is relieved by the full lists
/// rendered directly beneath the map -- the table view the check asks for.
class ChartColors {
  static const profit = CupertinoDynamicColor.withBrightness(color: Color(0xFF007AFF), darkColor: Color(0xFF0A84FF));
  static const loss = CupertinoDynamicColor.withBrightness(color: Color(0xFFFF3B30), darkColor: Color(0xFFFF453A));
  static const neutral = CupertinoDynamicColor.withBrightness(color: Color(0xFFE5E5EA), darkColor: Color(0xFF3A3A3C));
  static const memory = CupertinoDynamicColor.withBrightness(color: Color(0xFF007AFF), darkColor: Color(0xFF0A84FF));
  static const knowledge = CupertinoDynamicColor.withBrightness(color: Color(0xFF30B0C7), darkColor: Color(0xFF23A0B0));
}

/// The diverging scale every P&L heatmap uses: the neutral grey midpoint lerps toward the profit or
/// loss pole, so "no trades" and "broke even" read as nothing and intensity is magnitude.
Color heatColor(BuildContext context, double? pnl, double maxAbs) {
  final neutral = resolve(context, ChartColors.neutral);
  if (pnl == null || pnl == 0) return neutral;
  final pole = resolve(context, pnl > 0 ? ChartColors.profit : ChartColors.loss);
  final t = math.min(1.0, pnl.abs() / (maxAbs <= 0 ? 1 : maxAbs));
  return Color.lerp(neutral, pole, 0.3 + 0.7 * t)!;
}

/// "Loss [swatches] Profit" -- the heatmap's legend.
class HeatLegend extends StatelessWidget {
  const HeatLegend({super.key});

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    Widget swatch(Color c) => Container(
          width: 11,
          height: 11,
          margin: const EdgeInsets.symmetric(horizontal: 1.5),
          decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(2.5)),
        );
    return Row(children: [
      Text('Loss', style: TextStyle(fontSize: 12, color: secondary)),
      const SizedBox(width: Space.s2),
      for (final v in [-1.0, -0.55, -0.15]) swatch(heatColor(context, v, 1)),
      swatch(heatColor(context, 0, 1)),
      for (final v in [0.15, 0.55, 1.0]) swatch(heatColor(context, v, 1)),
      const SizedBox(width: Space.s2),
      Text('Profit', style: TextStyle(fontSize: 12, color: secondary)),
    ]);
  }
}

/// GitHub-style grid of daily realised P&L: one column per week, one row per weekday.
///
/// Diverging, because P&L has a real zero -- a loss day and a flat day must not look alike. Cells
/// lerp from the neutral grey midpoint toward a pole, so "no trades" and "broke even" read as
/// nothing, and intensity is magnitude.
class PnlHeatmap extends StatefulWidget {
  const PnlHeatmap({super.key, required this.days, this.weeks = 26, this.today});

  final List<HeatDay> days;
  final int weeks;

  /// Injectable for tests; defaults to now.
  final DateTime? today;

  @override
  State<PnlHeatmap> createState() => _PnlHeatmapState();
}

class _Cell {
  _Cell(this.date, this.day);
  final DateTime date;
  final HeatDay? day;
}

class _PnlHeatmapState extends State<PnlHeatmap> {
  _Cell? _selected;

  List<List<_Cell>> _grid() {
    final byDay = {for (final d in widget.days) d.day: d};
    final today = widget.today ?? DateTime.now();
    final end = DateTime(today.year, today.month, today.day);
    // Align the first column to a Sunday so rows are always the same weekday.
    var start = end.subtract(Duration(days: widget.weeks * 7 - 1));
    start = start.subtract(Duration(days: start.weekday % 7));
    final cols = <List<_Cell>>[];
    for (var w = 0; w < widget.weeks + 1; w++) {
      final col = <_Cell>[];
      for (var d = 0; d < 7; d++) {
        final date = start.add(Duration(days: w * 7 + d));
        if (date.isAfter(end)) break;
        col.add(_Cell(date, byDay[_key(date)]));
      }
      if (col.isNotEmpty) cols.add(col);
    }
    return cols;
  }

  static String _key(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Color _colorFor(BuildContext context, HeatDay? day, double maxAbs) => heatColor(context, day?.pnl, maxAbs);

  @override
  Widget build(BuildContext context) {
    final cols = _grid();
    final maxAbs = widget.days.isEmpty ? 1.0 : widget.days.map((d) => d.pnl.abs()).reduce(math.max).clamp(1e-9, double.infinity);

    return LayoutBuilder(builder: (context, box) {
      // Fits any span: a year (53 columns) packs tight with hairline gaps, a month (5 columns)
      // gets big, easy-to-tap cells instead of being stretched across the card.
      final fit = box.maxWidth / cols.length;
      final gap = fit < 9 ? 1.5 : 3.0;
      final cell = math.max(2.0, math.min(fit - gap, 30.0));
      final pitch = cell + gap;
      final height = 7 * (cell + gap);

      _Cell? cellAt(Offset p) {
        final c = (p.dx / pitch).floor();
        final r = (p.dy / (cell + gap)).floor();
        if (c < 0 || c >= cols.length || r < 0 || r >= cols[c].length) return null;
        return cols[c][r];
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        // The hit target is the whole cell PITCH, not the painted square -- bigger than the mark.
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => setState(() => _selected = cellAt(d.localPosition)),
          onPanUpdate: (d) => setState(() => _selected = cellAt(d.localPosition)),
          child: SizedBox(
            height: height,
            width: box.maxWidth,
            child: CustomPaint(
              painter: _HeatmapPainter(
                cols: [for (final col in cols) [for (final c in col) _colorFor(context, c.day, maxAbs.toDouble())]],
                pitch: pitch,
                cell: cell,
                gap: gap,
                selected: _selected == null ? null : _indexOf(cols, _selected!),
                ring: resolve(context, CupertinoColors.label),
              ),
            ),
          ),
        ),
        const SizedBox(height: Space.s3),
        // The value readout: identity is never colour alone.
        SizedBox(
          height: 20,
          child: Text(_describe(_selected), style: TextStyle(fontSize: 13, color: resolve(context, _selected == null ? CupertinoColors.secondaryLabel : CupertinoColors.label))),
        ),
        const SizedBox(height: Space.s2),
        const HeatLegend(),
      ]);
    });
  }

  static (int, int)? _indexOf(List<List<_Cell>> cols, _Cell target) {
    for (var c = 0; c < cols.length; c++) {
      final r = cols[c].indexOf(target);
      if (r != -1) return (c, r);
    }
    return null;
  }

  String _describe(_Cell? c) {
    if (c == null) return 'Tap a day to see its result.';
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final label = '${days[c.date.weekday - 1]} ${c.date.day} ${months[c.date.month - 1]}';
    final d = c.day;
    if (d == null || d.trades == 0) return '$label  ·  no closed trades';
    return '$label  ·  ${formatMoney(d.pnl, signed: true)}  ·  ${d.trades} trade${d.trades == 1 ? '' : 's'}';
  }
}

class _HeatmapPainter extends CustomPainter {
  _HeatmapPainter({required this.cols, required this.pitch, required this.cell, required this.gap, required this.selected, required this.ring});

  final List<List<Color>> cols;
  final double pitch;
  final double cell;
  final double gap;
  final (int, int)? selected;
  final Color ring;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint();
    for (var c = 0; c < cols.length; c++) {
      for (var r = 0; r < cols[c].length; r++) {
        paint.color = cols[c][r];
        final rect = RRect.fromRectAndRadius(Rect.fromLTWH(c * pitch, r * (cell + gap), cell, cell), const Radius.circular(2.5));
        canvas.drawRRect(rect, paint);
      }
    }
    final s = selected;
    if (s != null) {
      final rect = RRect.fromRectAndRadius(Rect.fromLTWH(s.$1 * pitch, s.$2 * (cell + gap), cell, cell).inflate(1.5), const Radius.circular(3.5));
      canvas.drawRRect(rect, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = ring);
    }
  }

  @override
  bool shouldRepaint(_HeatmapPainter old) => old.cols != cols || old.selected != selected || old.pitch != pitch;
}

/// Dave's brain, drawn from what is actually in it: one dot per real memory entry on the inner
/// ring, one per real knowledge entry on the outer rings, sized by how much it holds.
///
/// A visualisation, not decoration -- the trader asked to "see inside the brain", and every mark
/// here is an entry that exists. Static on purpose: this is a utility surface, and the apple-design
/// restraint rule is that motion must carry meaning. A pulsing neural animation would not.
class BrainMap extends StatelessWidget {
  const BrainMap({super.key, required this.memorySizes, required this.knowledgeSizes, this.height = 220});

  final List<int> memorySizes;
  final List<int> knowledgeSizes;
  final double height;

  @override
  Widget build(BuildContext context) {
    final label = resolve(context, CupertinoColors.label);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return Column(children: [
      SizedBox(
        height: height,
        width: double.infinity,
        child: CustomPaint(
          painter: _BrainPainter(
            memory: memorySizes,
            knowledge: knowledgeSizes,
            memoryColor: resolve(context, ChartColors.memory),
            knowledgeColor: resolve(context, ChartColors.knowledge),
            spoke: resolve(context, CupertinoColors.separator),
            surface: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
            core: resolve(context, CupertinoColors.systemGrey4),
          ),
        ),
      ),
      const SizedBox(height: Space.s3),
      // Legend: two series, so it is always present. Text wears text tokens; the dot carries identity.
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        _legend(resolve(context, ChartColors.memory), 'Memory', memorySizes.length, label, secondary),
        const SizedBox(width: Space.s5),
        _legend(resolve(context, ChartColors.knowledge), 'Knowledge', knowledgeSizes.length, label, secondary),
      ]),
    ]);
  }

  Widget _legend(Color dot, String name, int count, Color label, Color secondary) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 9, height: 9, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(name, style: TextStyle(fontSize: 13, color: label)),
        const SizedBox(width: 4),
        Text('$count', style: TextStyle(fontSize: 13, color: secondary, fontFeatures: const [FontFeature.tabularFigures()])),
      ]);
}

class _BrainPainter extends CustomPainter {
  _BrainPainter({required this.memory, required this.knowledge, required this.memoryColor, required this.knowledgeColor, required this.spoke, required this.surface, required this.core});

  final List<int> memory;
  final List<int> knowledge;
  final Color memoryColor;
  final Color knowledgeColor;
  final Color spoke;
  final Color surface;
  final Color core;

  static double dotRadius(int chars) => 3 + math.min(4.5, math.sqrt(chars) / 10);

  /// Lays [count] dots on concentric rings starting at [r0], never closer than [spacing] apart.
  static List<Offset> ringLayout(int count, Offset center, double r0, double step, double spacing, double maxR) {
    final out = <Offset>[];
    var r = r0;
    var remaining = count;
    var ring = 0;
    while (remaining > 0 && r <= maxR) {
      final capacity = math.max(1, (2 * math.pi * r / spacing).floor());
      final n = math.min(capacity, remaining);
      // Offset alternate rings by half a slot so dots on neighbouring rings interleave.
      final phase = ring.isOdd ? math.pi / n : 0.0;
      for (var i = 0; i < n; i++) {
        final a = -math.pi / 2 + phase + 2 * math.pi * i / n;
        out.add(center + Offset(math.cos(a), math.sin(a)) * r);
      }
      remaining -= n;
      r += step;
      ring++;
    }
    return out;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final maxR = math.min(size.width, size.height) / 2 - 8;
    final memoryPts = ringLayout(memory.length, center, maxR * 0.34, maxR * 0.13, 15, maxR * 0.5);
    final knowledgePts = ringLayout(knowledge.length, center, maxR * 0.66, maxR * 0.14, 15, maxR);

    final spokePaint = Paint()
      ..color = spoke
      ..strokeWidth = 0.5;
    for (final p in [...memoryPts, ...knowledgePts]) {
      canvas.drawLine(center, p, spokePaint);
    }

    void dots(List<Offset> pts, List<int> sizes, Color color) {
      for (var i = 0; i < pts.length; i++) {
        final r = dotRadius(sizes[i]);
        // 2px surface ring so overlapping dots stay separable.
        canvas.drawCircle(pts[i], r + 2, Paint()..color = surface);
        canvas.drawCircle(pts[i], r, Paint()..color = color);
      }
    }

    dots(memoryPts, memory, memoryColor);
    dots(knowledgePts, knowledge, knowledgeColor);

    canvas.drawCircle(center, 9, Paint()..color = surface);
    canvas.drawCircle(center, 7, Paint()..color = core);
  }

  @override
  bool shouldRepaint(_BrainPainter old) => old.memory != memory || old.knowledge != knowledge || old.memoryColor != memoryColor;
}
