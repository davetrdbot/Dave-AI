import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Every trade Dave has closed, for any period: the P&L curve, the numbers, per pair, and each
/// trade with how it closed and why he opened it.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

enum _Range { custom, today, week, month, quarter, year, all }

class _HistoryScreenState extends State<HistoryScreen> {
  _Range _range = _Range.month;
  DateTime? _from;
  DateTime? _to;
  Map<String, dynamic>? _data;
  Object? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  (DateTime?, DateTime?) _window() {
    final now = DateTime.now();
    final midnight = DateTime(now.year, now.month, now.day);
    return switch (_range) {
      _Range.today => (midnight, null),
      _Range.week => (midnight.subtract(const Duration(days: 6)), null),
      _Range.month => (midnight.subtract(const Duration(days: 29)), null),
      _Range.quarter => (midnight.subtract(const Duration(days: 89)), null),
      _Range.year => (midnight.subtract(const Duration(days: 364)), null),
      _Range.all => (null, null),
      _Range.custom => (_from, _to == null ? null : DateTime(_to!.year, _to!.month, _to!.day, 23, 59, 59)),
    };
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() => _loading = true);
    final (from, to) = _window();
    try {
      final d = await AppScope.of(context).api.history(from: from, to: to);
      if (mounted) setState(() => (_data = d, _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickCustom() async {
    final now = DateTime.now();
    var from = _from ?? now.subtract(const Duration(days: 14));
    var to = _to ?? now;
    final ok = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (ctx) {
        final look = Look.of(ctx);
        Widget picker(String label, DateTime initial, void Function(DateTime) onChanged) => Column(children: [
              Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
              SizedBox(
                height: 150,
                child: CupertinoDatePicker(mode: CupertinoDatePickerMode.date, initialDateTime: initial, maximumDate: now.add(const Duration(days: 1)), onDateTimeChanged: onChanged),
              ),
            ]);
        return Container(
          padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + MediaQuery.paddingOf(ctx).bottom),
          decoration: BoxDecoration(color: look.card, borderRadius: const BorderRadius.vertical(top: Radius.circular(20))),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('Pick a period', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            picker('From', from, (d) => from = d),
            picker('To', to, (d) => to = d),
            const SizedBox(height: 8),
            SizedBox(width: double.infinity, child: CupertinoButton.filled(onPressed: () => Navigator.pop(ctx, true), child: const Text('Show'))),
          ]),
        );
      },
    );
    if (ok != true) return;
    if (from.isAfter(to)) (from, to) = (to, from);
    setState(() {
      _from = DateTime(from.year, from.month, from.day);
      _to = to;
      _range = _Range.custom;
    });
    await _load();
  }

  String _label(_Range r) => switch (r) {
        _Range.today => 'Today',
        _Range.week => '7 days',
        _Range.month => '30 days',
        _Range.quarter => '90 days',
        _Range.year => '1 year',
        _Range.all => 'All time',
        _Range.custom => _from == null ? 'Custom…' : '${_d(_from!)} – ${_d(_to ?? DateTime.now())}',
      };

  static String _d(DateTime t) => '${t.day}/${t.month}';

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final trades = ((d?['trades'] as List?) ?? const []).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      child: CustomScrollView(slivers: [
        const CupertinoSliverNavigationBar(largeTitle: Text('Trade history')),
        CupertinoSliverRefreshControl(onRefresh: _load),
        SliverToBoxAdapter(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, Space.s2),
            child: Row(children: [
              for (final r in _Range.values) ...[
                _RangeChip(
                  key: ValueKey('range-${r.name}'),
                  text: _label(r),
                  icon: r == _Range.custom ? CupertinoIcons.calendar : null,
                  selected: _range == r,
                  onTap: () {
                    if (r == _Range.custom) {
                      _pickCustom();
                      return;
                    }
                    setState(() => _range = r);
                    _load();
                  },
                ),
                const SizedBox(width: 6),
              ],
            ]),
          ),
        ),
        if (_error != null)
          SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.all(Space.s4), child: Text('$_error', style: TextStyle(color: Look.of(context).down))))
        else if (d == null)
          const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.only(top: 60), child: CupertinoActivityIndicator()))
        else ...[
          SliverToBoxAdapter(child: _CurveCard(trades: trades, loading: _loading)),
          SliverToBoxAdapter(child: _SummaryCard(s: (d['summary'] as Map).cast<String, dynamic>())),
          if (((d['bySymbol'] as List?) ?? const []).isNotEmpty) SliverToBoxAdapter(child: _BySymbol(rows: (d['bySymbol'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList())),
          if (trades.isEmpty)
            const SliverToBoxAdapter(child: EmptyState(icon: CupertinoIcons.chart_bar, title: 'No closed trades', message: 'Nothing closed in this period. Pick a longer one above.'))
          else ...[
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(Space.s4 + 4, Space.s4, Space.s4, Space.s2),
                child: SectionLabel('${trades.length} trades${d['truncated'] == true ? ' (newest 3000)' : ''}'),
              ),
            ),
            SliverList.builder(itemCount: trades.length, itemBuilder: (context, i) => _TradeRow(t: trades[trades.length - 1 - i])),
          ],
        ],
        SliverToBoxAdapter(child: SizedBox(height: 40 + MediaQuery.paddingOf(context).bottom)),
      ]),
    );
  }
}

class _RangeChip extends StatelessWidget {
  const _RangeChip({super.key, required this.text, required this.selected, required this.onTap, this.icon});
  final String text;
  final bool selected;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
        decoration: BoxDecoration(color: selected ? look.accent : look.chip, borderRadius: BorderRadius.circular(20), border: Border.all(color: selected ? look.accent : look.line)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[Icon(icon, size: 14, color: selected ? look.tabActiveIcon : null), const SizedBox(width: 5)],
          Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: selected ? look.tabActiveIcon : null)),
        ]),
      ),
    );
  }
}

/// Cumulative P&L, trade by trade: the one line that says whether the period made money.
class _CurveCard extends StatelessWidget {
  const _CurveCard({required this.trades, required this.loading});
  final List<Map<String, dynamic>> trades;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    var run = 0.0;
    final points = <double>[0, for (final t in trades) run += (t['pnl'] as num).toDouble()];
    final net = points.last;
    final color = net >= 0 ? look.up : look.down;
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: SectionLabel('P&L over the period')),
          if (loading) const CupertinoActivityIndicator(radius: 8),
        ]),
        const SizedBox(height: 4),
        Text(formatMoney(net, signed: true), style: TextStyle(fontSize: 32, fontWeight: FontWeight.w800, letterSpacing: -1, color: color)),
        const SizedBox(height: Space.s3),
        SizedBox(height: 170, child: CustomPaint(size: Size.infinite, painter: _CurvePainter(points, color, look.line))),
      ]),
    );
  }
}

class _CurvePainter extends CustomPainter {
  _CurvePainter(this.points, this.color, this.grid);
  final List<double> points;
  final Color color;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final lo = math.min(0.0, points.reduce(math.min));
    final hi = math.max(0.0, points.reduce(math.max));
    final span = (hi - lo).abs() < 1e-9 ? 1.0 : hi - lo;
    double y(double v) => size.height - (v - lo) / span * size.height;
    double x(int i) => points.length <= 1 ? 0 : i / (points.length - 1) * size.width;
    final zero = Paint()
      ..color = grid
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, y(0)), Offset(size.width, y(0)), zero);
    if (points.length < 2) return;
    final path = Path()..moveTo(x(0), y(points[0]));
    for (var i = 1; i < points.length; i++) {
      path.lineTo(x(i), y(points[i]));
    }
    final fill = Path.from(path)
      ..lineTo(x(points.length - 1), y(0))
      ..lineTo(x(0), y(0))
      ..close();
    canvas.drawPath(fill, Paint()..color = color.withValues(alpha: 0.14));
    canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2
          ..strokeJoin = StrokeJoin.round);
    canvas.drawCircle(Offset(x(points.length - 1), y(points.last)), 4, Paint()..color = color);
  }

  @override
  bool shouldRepaint(covariant _CurvePainter old) => old.points != points || old.color != color;
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.s});
  final Map<String, dynamic> s;

  @override
  Widget build(BuildContext context) {
    String money(Object? v) => v == null ? '—' : formatMoney(v as num, signed: true);
    return ContentCard(
      child: Column(children: [
        Row(children: [
          Expanded(child: StatTile(value: '${s['trades'] ?? 0}', label: 'Trades')),
          Expanded(child: StatTile(value: s['winRatePercent'] == null ? '—' : '${s['winRatePercent']}%', label: 'Win rate')),
          Expanded(child: StatTile(value: s['profitFactor'] == null ? '—' : '${s['profitFactor']}', label: 'Profit factor')),
        ]),
        const SizedBox(height: Space.s3),
        Row(children: [
          Expanded(child: StatTile(value: money(s['avgWin']), label: 'Avg win', color: s['avgWin'] == null ? null : pnlColor(context, s['avgWin'] as num))),
          Expanded(child: StatTile(value: money(s['avgLoss']), label: 'Avg loss', color: s['avgLoss'] == null ? null : pnlColor(context, s['avgLoss'] as num))),
          Expanded(child: StatTile(value: money(s['bestTrade']), label: 'Best')),
        ]),
      ]),
    );
  }
}

class _BySymbol extends StatelessWidget {
  const _BySymbol({required this.rows});
  final List<Map<String, dynamic>> rows;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final maxAbs = rows.fold<double>(1, (m, r) => math.max(m, (r['pnl'] as num).abs().toDouble()));
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('By pair'),
        const SizedBox(height: Space.s2),
        for (final r in rows.take(12))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(children: [
              SizedBox(width: 92, child: Text('${r['symbol']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13))),
              Expanded(
                child: LayoutBuilder(builder: (context, c) {
                  final w = c.maxWidth * ((r['pnl'] as num).abs() / maxAbs);
                  return Align(
                    alignment: Alignment.centerLeft,
                    child: Container(height: 10, width: math.max(3, w), decoration: BoxDecoration(color: (r['pnl'] as num) >= 0 ? look.up : look.down, borderRadius: BorderRadius.circular(5))),
                  );
                }),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 118,
                child: Text('${formatMoney(r['pnl'] as num, signed: true)} · ${r['trades']}× · ${r['winRatePercent']}%',
                    textAlign: TextAlign.right, style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel))),
              ),
            ]),
          ),
      ]),
    );
  }
}

class _TradeRow extends StatelessWidget {
  const _TradeRow({required this.t});
  final Map<String, dynamic> t;

  static String _how(Object? r) => switch ('$r') {
        'tp' => 'hit TP',
        'sl' => 'hit SL',
        'dave' => 'closed by Dave',
        'manual' => 'closed by you',
        _ => 'closed',
      };

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final pnl = t['pnl'] as num;
    final at = DateTime.fromMillisecondsSinceEpoch((t['closedAt'] as num).toInt());
    final why = (t['why'] as Map?)?.cast<String, dynamic>();
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final when = '${at.day}/${at.month} ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: why == null
          ? null
          : () => showCupertinoDialog<void>(
                context: context,
                builder: (ctx) => CupertinoAlertDialog(
                  title: Text('${t['symbol']} ${t['side'] ?? ''} · ${formatMoney(pnl, signed: true)}'),
                  content: Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text([
                      if (why['entry'] != null) 'Entry ${why['entry']}${why['sl'] != null ? ' · SL ${why['sl']}' : ''}${why['tp'] != null ? ' · TP ${why['tp']}' : ''}',
                      'Why Dave took it: ${why['reason'] == '' ? '—' : why['reason']}',
                    ].join('\n\n')),
                  ),
                  actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
                ),
              ),
      child: Container(
        margin: const EdgeInsets.fromLTRB(Space.s4, 3, Space.s4, 3),
        padding: const EdgeInsets.symmetric(horizontal: Space.s3, vertical: 10),
        decoration: glassDecoration(context, radius: 14),
        child: Row(children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: (pnl >= 0 ? look.up : look.down).withValues(alpha: 0.15), shape: BoxShape.circle),
            child: Icon(t['side'] == 'sell' ? CupertinoIcons.arrow_down_right : CupertinoIcons.arrow_up_right, size: 16, color: pnl >= 0 ? look.up : look.down),
          ),
          const SizedBox(width: Space.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${t['symbol']}  ${t['side'] ?? ''}'.trim(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5)),
              Text('$when · ${_how(t['closedBy'])}${t['ticket'] != null ? ' · #${t['ticket']}' : ''}', style: TextStyle(fontSize: 12, color: secondary)),
            ]),
          ),
          Text(formatMoney(pnl, signed: true), style: TextStyle(fontWeight: FontWeight.w800, color: pnlColor(context, pnl), fontFeatures: const [FontFeature.tabularFigures()])),
          if (why != null) Padding(padding: const EdgeInsets.only(left: 4), child: Icon(CupertinoIcons.info_circle, size: 15, color: secondary)),
        ]),
      ),
    );
  }
}
