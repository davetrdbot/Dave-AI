import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../theme.dart';
import 'charts.dart';
import 'common.dart';

/// The time windows the trader can look at. Days back from now, inclusive of today.
enum PnlRange {
  day('1D', 1),
  week('1W', 7),
  month('1M', 30),
  quarter('3M', 91),
  half('6M', 182),
  year('1Y', 365);

  const PnlRange(this.label, this.days);
  final String label;
  final int days;
}

/// Summary numbers for a slice of closed trades.
class RangeStats {
  RangeStats(this.trades);
  final List<ClosedTrade> trades;

  double get pnl => trades.fold(0.0, (s, t) => s + t.pnl);
  int get wins => trades.where((t) => t.pnl > 0).length;
  int? get winRatePercent => trades.isEmpty ? null : (wins * 100 / trades.length).round();
}

/// The trades inside [range], ending now. A 1-day range starts at local midnight today -- "today"
/// is what a trader means by it, not "the last 24 hours".
List<ClosedTrade> tradesInRange(List<ClosedTrade> all, PnlRange range, DateTime now) {
  final start = rangeStart(range, now);
  return all.where((t) => !t.at.isBefore(start) && !t.at.isAfter(now)).toList();
}

DateTime rangeStart(PnlRange range, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  return today.subtract(Duration(days: range.days - 1));
}

/// Daily P&L in local days, as heatmap cells.
List<HeatDay> localDays(List<ClosedTrade> trades) {
  final byDay = <String, (double, int)>{};
  for (final t in trades) {
    final k = '${t.at.year}-${t.at.month.toString().padLeft(2, '0')}-${t.at.day.toString().padLeft(2, '0')}';
    final v = byDay[k] ?? (0.0, 0);
    byDay[k] = (v.$1 + t.pnl, v.$2 + 1);
  }
  return [for (final e in byDay.entries) HeatDay(e.key, e.value.$1, e.value.$2)];
}

/// Performance over a chosen window: the range switch, the totals, a realised P&L line, and a
/// heatmap shaped to the window (hours for a day, days for a week, a calendar beyond that).
///
/// The switch sits above everything it controls and scopes all of it, so the numbers, the line
/// and the grid always describe the same trades.
class PerformanceCard extends StatefulWidget {
  const PerformanceCard({super.key, required this.trades, this.now});

  final List<ClosedTrade> trades;

  /// Injectable for tests; defaults to now.
  final DateTime? now;

  @override
  State<PerformanceCard> createState() => _PerformanceCardState();
}

class _PerformanceCardState extends State<PerformanceCard> {
  var _range = PnlRange.month;

  @override
  Widget build(BuildContext context) {
    final now = widget.now ?? DateTime.now();
    final inRange = tradesInRange(widget.trades, _range, now);
    final stats = RangeStats(inRange);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);

    final Widget heat;
    switch (_range) {
      case PnlRange.day:
        heat = HourStrip(trades: inRange, day: now);
      case PnlRange.week:
        heat = DayStrip(trades: inRange, end: now);
      default:
        heat = PnlHeatmap(key: ValueKey(_range), days: localDays(inRange), weeks: (_range.days / 7).ceil(), today: now);
    }

    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('Performance'),
        const SizedBox(height: Space.s3),
        SizedBox(
          width: double.infinity,
          child: CupertinoSlidingSegmentedControl<PnlRange>(
            groupValue: _range,
            children: {for (final r in PnlRange.values) r: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(r.label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)))},
            onValueChanged: (r) {
              if (r == null) return;
              HapticFeedback.selectionClick();
              setState(() => _range = r);
            },
          ),
        ),
        const SizedBox(height: Space.s4),
        Row(children: [
          Expanded(child: StatTile(value: inRange.isEmpty ? '--' : formatMoney(stats.pnl, signed: true), label: 'Realised', color: inRange.isEmpty ? null : pnlColor(context, stats.pnl))),
          Expanded(child: StatTile(value: '${inRange.length}', label: 'Trades')),
          Expanded(child: StatTile(value: stats.winRatePercent == null ? '--' : '${stats.winRatePercent}%', label: 'Win rate')),
        ]),
        const SizedBox(height: Space.s4),
        if (inRange.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Space.s4),
            child: Text(
              _range == PnlRange.day ? 'No trades closed today yet.' : 'No trades closed in this period.',
              style: TextStyle(fontSize: 14, color: secondary),
            ),
          )
        else
          PnlLineChart(key: ValueKey('line-$_range'), trades: inRange, start: rangeStart(_range, now), end: now, intraday: _range == PnlRange.day),
        const SizedBox(height: Space.s5),
        heat,
      ]),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Realised P&L line

/// Running total of realised P&L across the window, drawn as steps: the total only changes when a
/// trade closes, and a sloped line between closes would claim money moved when none did.
///
/// One series, so no legend -- the section names it. Drag across it for the exact running total
/// and the trade that moved it.
class PnlLineChart extends StatefulWidget {
  const PnlLineChart({super.key, required this.trades, required this.start, required this.end, this.intraday = false, this.height = 150});

  final List<ClosedTrade> trades;
  final DateTime start;
  final DateTime end;
  final bool intraday;
  final double height;

  @override
  State<PnlLineChart> createState() => _PnlLineChartState();
}

class _PnlLineChartState extends State<PnlLineChart> {
  int? _selected;

  List<double> get _running {
    var total = 0.0;
    return [for (final t in widget.trades) total += t.pnl];
  }

  @override
  Widget build(BuildContext context) {
    final running = _running;
    final line = resolve(context, CupertinoColors.systemBlue);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final grid = resolve(context, CupertinoColors.separator);
    final span = widget.end.difference(widget.start).inMilliseconds.clamp(1, 1 << 62);

    String readout() {
      final i = _selected;
      if (i == null) {
        return 'Total ${formatMoney(running.last, signed: true)}  ·  drag the line for detail';
      }
      final t = widget.trades[i];
      final when = widget.intraday ? _time(t.at) : '${_date(t.at)}  ${_time(t.at)}';
      return '$when  ·  ${t.symbol} ${formatMoney(t.pnl, signed: true)}  ·  total ${formatMoney(running[i], signed: true)}';
    }

    return LayoutBuilder(builder: (context, box) {
      double xOf(DateTime at) => box.maxWidth * (at.difference(widget.start).inMilliseconds / span).clamp(0.0, 1.0);

      int? nearest(double dx) {
        var best = 0;
        var bestD = double.infinity;
        for (var i = 0; i < widget.trades.length; i++) {
          final d = (xOf(widget.trades[i].at) - dx).abs();
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        return best;
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => setState(() => _selected = nearest(d.localPosition.dx)),
          onHorizontalDragUpdate: (d) => setState(() => _selected = nearest(d.localPosition.dx)),
          onHorizontalDragEnd: (_) {},
          child: SizedBox(
            width: box.maxWidth,
            height: widget.height,
            child: CustomPaint(
              painter: _LinePainter(
                xs: [for (final t in widget.trades) xOf(t.at)],
                ys: running,
                width: box.maxWidth,
                line: line,
                fill: line.withValues(alpha: 0.10),
                grid: grid,
                label: secondary,
                labelStyle: DefaultTextStyle.of(context).style.copyWith(fontSize: 11, color: secondary),
                selected: _selected,
                surface: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
              ),
            ),
          ),
        ),
        const SizedBox(height: Space.s2),
        SizedBox(
          height: 18,
          child: Text(readout(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: resolve(context, _selected == null ? CupertinoColors.secondaryLabel : CupertinoColors.label))),
        ),
      ]);
    });
  }
}

class _LinePainter extends CustomPainter {
  _LinePainter({required this.xs, required this.ys, required this.width, required this.line, required this.fill, required this.grid, required this.label, required this.labelStyle, required this.selected, required this.surface});

  final List<double> xs;
  final List<double> ys;
  final double width;
  final Color line;
  final Color fill;
  final Color grid;
  final Color label;
  final TextStyle labelStyle;
  final int? selected;
  final Color surface;

  static const _top = 14.0;
  static const _bottom = 14.0;

  @override
  void paint(Canvas canvas, Size size) {
    final hi = math.max(0.0, ys.reduce(math.max));
    final lo = math.min(0.0, ys.reduce(math.min));
    final span = (hi - lo) == 0 ? 1.0 : hi - lo;
    final plotH = size.height - _top - _bottom;
    double yOf(double v) => _top + plotH * (1 - (v - lo) / span);

    // Zero baseline, dashed and recessive: above it is profit, below it is loss.
    final zeroY = yOf(0);
    final dash = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var x = 0.0; x < size.width; x += 6) {
      canvas.drawLine(Offset(x, zeroY), Offset(math.min(x + 3, size.width), zeroY), dash);
    }

    // Step path from (start, 0).
    final path = Path()..moveTo(0, zeroY);
    var prevY = zeroY;
    for (var i = 0; i < xs.length; i++) {
      path.lineTo(xs[i], prevY);
      prevY = yOf(ys[i]);
      path.lineTo(xs[i], prevY);
    }
    path.lineTo(size.width, prevY);

    final area = Path.from(path)
      ..lineTo(size.width, zeroY)
      ..close();
    canvas.drawPath(area, Paint()..color = fill);
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeJoin = StrokeJoin.round,
    );

    // Two quiet labels: the top and bottom of the scale, only when they are not zero.
    void text(String s, double y) {
      final tp = TextPainter(text: TextSpan(text: s, style: labelStyle), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, Offset(size.width - tp.width, y));
    }

    if (hi > 0) text(formatMoney(hi, signed: true), 0);
    if (lo < 0) text(formatMoney(lo, signed: true), size.height - 12);

    // Crosshair on the selected close.
    final s = selected;
    if (s != null) {
      final x = xs[s];
      canvas.drawLine(Offset(x, _top - 6), Offset(x, size.height - _bottom + 6), Paint()
        ..color = label
        ..strokeWidth = 1);
      final p = Offset(x, yOf(ys[s]));
      canvas.drawCircle(p, 6, Paint()..color = surface);
      canvas.drawCircle(p, 4.5, Paint()..color = line);
    }
  }

  @override
  bool shouldRepaint(_LinePainter old) => old.ys != ys || old.selected != selected || old.width != width || old.line != line;
}

// ---------------------------------------------------------------------------------------------
// Short-range heatmaps

class _StripCell {
  _StripCell(this.label, this.detail, this.pnl, this.trades);
  final String label;
  final String detail;
  final double pnl;
  final int trades;
}

/// A row-wrapped strip of labelled cells, sharing the calendar heatmap's colour scale and tap
/// readout. Used where a calendar grid would be one sad column.
class _Strip extends StatefulWidget {
  const _Strip({required this.cells, required this.perRow, required this.hint});
  final List<_StripCell> cells;
  final int perRow;
  final String hint;

  @override
  State<_Strip> createState() => _StripState();
}

class _StripState extends State<_Strip> {
  int? _selected;

  @override
  Widget build(BuildContext context) {
    final maxAbs = widget.cells.map((c) => c.pnl.abs()).fold(0.0, math.max);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final rows = <List<int>>[];
    for (var i = 0; i < widget.cells.length; i += widget.perRow) {
      rows.add([for (var j = i; j < math.min(i + widget.perRow, widget.cells.length); j++) j]);
    }
    final sel = _selected;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final row in rows) ...[
        Row(children: [
          for (final i in row)
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => setState(() => _selected = i),
                child: Padding(
                  padding: const EdgeInsets.all(1.5),
                  child: Column(children: [
                    AspectRatio(
                      aspectRatio: 1,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: heatColor(context, widget.cells[i].trades == 0 ? null : widget.cells[i].pnl, maxAbs),
                          borderRadius: BorderRadius.circular(3),
                          border: sel == i ? Border.all(color: resolve(context, CupertinoColors.label), width: 1.5) : null,
                        ),
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(widget.cells[i].label, style: TextStyle(fontSize: 10, color: secondary)),
                  ]),
                ),
              ),
            ),
          // Keep a short last row's cells the same size as the rows above.
          for (var k = row.length; k < widget.perRow; k++) const Expanded(child: SizedBox()),
        ]),
        const SizedBox(height: Space.s1),
      ],
      const SizedBox(height: Space.s2),
      SizedBox(
        height: 20,
        child: Text(
          sel == null
              ? widget.hint
              : widget.cells[sel].trades == 0
                  ? '${widget.cells[sel].detail}  ·  no closed trades'
                  : '${widget.cells[sel].detail}  ·  ${formatMoney(widget.cells[sel].pnl, signed: true)}  ·  ${widget.cells[sel].trades} trade${widget.cells[sel].trades == 1 ? '' : 's'}',
          style: TextStyle(fontSize: 13, color: resolve(context, sel == null ? CupertinoColors.secondaryLabel : CupertinoColors.label)),
        ),
      ),
      const SizedBox(height: Space.s2),
      const HeatLegend(),
    ]);
  }
}

/// Today, hour by hour: 24 cells in two rows (midnight to noon, noon to midnight).
class HourStrip extends StatelessWidget {
  const HourStrip({super.key, required this.trades, required this.day});
  final List<ClosedTrade> trades;
  final DateTime day;

  @override
  Widget build(BuildContext context) {
    final byHour = List.generate(24, (_) => (0.0, 0));
    for (final t in trades) {
      if (t.at.year != day.year || t.at.month != day.month || t.at.day != day.day) continue;
      final v = byHour[t.at.hour];
      byHour[t.at.hour] = (v.$1 + t.pnl, v.$2 + 1);
    }
    return _Strip(
      perRow: 12,
      hint: 'Tap an hour to see its result.',
      cells: [
        for (var h = 0; h < 24; h++)
          _StripCell(h % 3 == 0 ? _hourTick(h) : '', '${_hourLabel(h)} to ${_hourLabel((h + 1) % 24)}', byHour[h].$1, byHour[h].$2),
      ],
    );
  }
}

/// The last seven days, one cell each, oldest first.
class DayStrip extends StatelessWidget {
  const DayStrip({super.key, required this.trades, required this.end});
  final List<ClosedTrade> trades;
  final DateTime end;

  @override
  Widget build(BuildContext context) {
    final today = DateTime(end.year, end.month, end.day);
    final days = [for (var i = 6; i >= 0; i--) today.subtract(Duration(days: i))];
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return _Strip(
      perRow: 7,
      hint: 'Tap a day to see its result.',
      cells: [
        for (final d in days)
          () {
            final inDay = trades.where((t) => t.at.year == d.year && t.at.month == d.month && t.at.day == d.day);
            return _StripCell(names[d.weekday - 1], _date(d), inDay.fold(0.0, (s, t) => s + t.pnl), inDay.length);
          }(),
      ],
    );
  }
}

String _hourLabel(int h) => h == 0 ? '12am' : h < 12 ? '${h}am' : h == 12 ? '12pm' : '${h - 12}pm';

/// The narrow form under a cell: "12a", "3p".
String _hourTick(int h) => h == 0 ? '12a' : h < 12 ? '${h}a' : h == 12 ? '12p' : '${h - 12}p';

String _time(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

String _date(DateTime d) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${days[d.weekday - 1]} ${d.day} ${months[d.month - 1]}';
}
