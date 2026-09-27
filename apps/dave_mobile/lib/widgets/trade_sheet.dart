import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import 'common.dart';

/// One trade -- open or pending -- with its stop loss and take profit edited right there: type a
/// price or nudge it with − / +, move the stop to breakeven, remove either side, save once. The
/// trader: "TP and SL -- I meant for ongoing trades... just give me the tool to configure it".
///
/// Returns true when a change (or a close) was sent.
Future<bool> showTradeSheet(
  BuildContext context, {
  required String ticket,
  required String symbol,
  required String kind,
  required bool isBuy,
  required double lots,
  required double entry,
  double? current,
  double? sl,
  double? tp,
  double? pnl,
  Future<bool> Function()? onClose,
}) async {
  final scope = AppScope.of(context);
  final sent = await showCupertinoModalPopup<bool>(
    context: context,
    builder: (ctx) => AppScope(
      api: scope.api,
      onUnpaired: scope.onUnpaired,
      child: _TradeSheet(ticket: ticket, symbol: symbol, kind: kind, isBuy: isBuy, lots: lots, entry: entry, current: current, sl: sl, tp: tp, pnl: pnl, onClose: onClose),
    ),
  );
  return sent == true;
}

class _TradeSheet extends StatefulWidget {
  const _TradeSheet({required this.ticket, required this.symbol, required this.kind, required this.isBuy, required this.lots, required this.entry, this.current, this.sl, this.tp, this.pnl, this.onClose});
  final String ticket;
  final String symbol;
  final String kind;
  final bool isBuy;
  final double lots;
  final double entry;
  final double? current;
  final double? sl;
  final double? tp;
  final double? pnl;
  final Future<bool> Function()? onClose;

  @override
  State<_TradeSheet> createState() => _TradeSheetState();
}

class _TradeSheetState extends State<_TradeSheet> {
  late final _sl = TextEditingController(text: _fmt(widget.sl));
  late final _tp = TextEditingController(text: _fmt(widget.tp));
  bool _busy = false;
  String? _error;

  /// A sensible nudge for this instrument's price scale.
  late final double _step = () {
    final p = widget.entry.abs();
    if (p >= 100000) return 100.0;
    if (p >= 10000) return 10.0;
    if (p >= 1000) return 1.0;
    if (p >= 100) return 0.1;
    if (p >= 10) return 0.01;
    return 0.0001;
  }();

  late final int _decimals = () {
    final s = _step;
    return s >= 1 ? 2 : math.max(2, (-math.log(s) / math.ln10).ceil() + 1);
  }();

  String _fmt(double? v) {
    if (v == null) return '';
    final d = widget.entry.abs() >= 1000 ? 2 : (widget.entry.abs() >= 10 ? 3 : 5);
    var s = v.toStringAsFixed(d);
    if (s.contains('.')) s = s.replaceFirst(RegExp(r'\.?0+$'), '');
    return s;
  }

  @override
  void dispose() {
    _sl.dispose();
    _tp.dispose();
    super.dispose();
  }

  double? _parse(TextEditingController c) => c.text.trim().isEmpty ? null : double.tryParse(c.text.replaceAll(',', '').trim());

  void _nudge(TextEditingController c, int dir) {
    final base = _parse(c) ?? widget.current ?? widget.entry;
    c.text = (base + dir * _step).toStringAsFixed(_decimals).replaceFirst(RegExp(r'\.?0+$'), '');
    HapticFeedback.selectionClick();
    setState(() {});
  }

  /// Where the stop and target have to sit: below/above the price the trade is judged against.
  double get _ref => widget.kind == 'position' ? (widget.current ?? widget.entry) : widget.entry;

  String? _check(double? sl, double? tp) {
    final ref = _ref;
    final where = widget.kind == 'position' ? 'the current price' : 'the entry';
    if (sl != null && (widget.isBuy ? sl >= ref : sl <= ref)) return 'For a ${widget.isBuy ? 'buy' : 'sell'} the stop loss has to be ${widget.isBuy ? 'below' : 'above'} $where (${_fmt(ref)}).';
    if (tp != null && (widget.isBuy ? tp <= ref : tp >= ref)) return 'For a ${widget.isBuy ? 'buy' : 'sell'} the take profit has to be ${widget.isBuy ? 'above' : 'below'} $where (${_fmt(ref)}).';
    return null;
  }

  Future<void> _save() async {
    final bad = (_sl.text.trim().isNotEmpty && _parse(_sl) == null) || (_tp.text.trim().isNotEmpty && _parse(_tp) == null);
    if (bad) return setState(() => _error = 'Enter prices as numbers, e.g. 2645.5');
    final sl = _parse(_sl);
    final tp = _parse(_tp);
    final problem = _check(sl, tp);
    if (problem != null) return setState(() => _error = problem);
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await runAction(context, (api) => api.setStops(widget.ticket, sl: sl, tp: tp));
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      HapticFeedback.mediumImpact();
      Navigator.of(context).pop(true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final sl = _parse(_sl);
    final tp = _parse(_tp);
    final risk = sl == null ? null : (widget.entry - sl).abs();
    final reward = tp == null ? null : (tp - widget.entry).abs();
    final changed = _sl.text.trim() != _fmt(widget.sl) || _tp.text.trim() != _fmt(widget.tp);
    return Container(
      decoration: BoxDecoration(color: look.card, borderRadius: const BorderRadius.vertical(top: Radius.circular(22))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(16, 10, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Center(child: Container(width: 36, height: 4, decoration: BoxDecoration(color: look.line, borderRadius: BorderRadius.circular(2)))),
            const SizedBox(height: 12),
            Row(children: [
              Icon(widget.isBuy ? CupertinoIcons.arrow_up_right : CupertinoIcons.arrow_down_right, color: widget.isBuy ? look.up : look.down, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text('${widget.symbol}  ${widget.kind == 'position' ? (widget.isBuy ? 'Buy' : 'Sell') : widget.kind}',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700), maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
              if (widget.pnl != null)
                Text(formatMoney(widget.pnl!, signed: true), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: pnlColor(context, widget.pnl))),
            ]),
            const SizedBox(height: 4),
            Text(
              '${widget.lots} lots · ${widget.kind == 'position' ? 'opened' : 'entry'} at ${_fmt(widget.entry)}${widget.current != null && widget.kind == 'position' ? ' · now ${_fmt(widget.current)}' : ''}',
              style: TextStyle(fontSize: 13, color: secondary),
            ),
            const SizedBox(height: 16),
            _PriceRow(label: 'Stop loss', color: look.down, controller: _sl, onMinus: () => _nudge(_sl, -1), onPlus: () => _nudge(_sl, 1), onClear: () => setState(() => _sl.clear()), onChanged: () => setState(() {})),
            const SizedBox(height: 10),
            _PriceRow(label: 'Take profit', color: look.up, controller: _tp, onMinus: () => _nudge(_tp, -1), onPlus: () => _nudge(_tp, 1), onClear: () => setState(() => _tp.clear()), onChanged: () => setState(() {})),
            const SizedBox(height: 10),
            Wrap(spacing: 6, runSpacing: 6, children: [
              if (widget.kind == 'position')
                _Quick('Breakeven', () => setState(() => _sl.text = _fmt(widget.entry))),
              if (widget.sl != null || widget.tp != null) _Quick('Undo', () => setState(() {
                    _sl.text = _fmt(widget.sl);
                    _tp.text = _fmt(widget.tp);
                  })),
              if (risk != null && risk > 0 && reward != null) _Info('Risk ${_fmt(risk)} · reward ${_fmt(reward)} · 1:${(reward / risk).toStringAsFixed(1)}'),
            ]),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: TextStyle(color: look.down, fontSize: 13.5))),
            const SizedBox(height: 14),
            CupertinoButton(
              color: changed ? look.accent : look.chip,
              borderRadius: BorderRadius.circular(14),
              padding: const EdgeInsets.symmetric(vertical: 13),
              onPressed: _busy || !changed ? null : _save,
              child: _busy
                  ? const CupertinoActivityIndicator()
                  : Text('Save SL / TP', style: TextStyle(fontWeight: FontWeight.w700, color: changed ? look.tabActiveIcon : secondary)),
            ),
            if (widget.onClose != null)
              CupertinoButton(
                padding: const EdgeInsets.only(top: 8),
                onPressed: _busy
                    ? null
                    : () async {
                        final closed = await widget.onClose!();
                        if (closed && context.mounted) Navigator.of(context).pop(true);
                      },
                child: Text(widget.kind == 'position' ? 'Close trade' : 'Delete order', style: TextStyle(color: look.down, fontWeight: FontWeight.w600)),
              ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Sent to MT5 and shown here on the EA\'s next report, in a few seconds. Clear a field to remove it.', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: secondary)),
            ),
          ]),
        ),
      ),
    );
  }
}

class _PriceRow extends StatelessWidget {
  const _PriceRow({required this.label, required this.color, required this.controller, required this.onMinus, required this.onPlus, required this.onClear, required this.onChanged});
  final String label;
  final Color color;
  final TextEditingController controller;
  final VoidCallback onMinus;
  final VoidCallback onPlus;
  final VoidCallback onClear;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Row(children: [
      SizedBox(
        width: 92,
        child: Row(children: [
          Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Flexible(child: Text(label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
        ]),
      ),
      _Btn(icon: CupertinoIcons.minus, onTap: onMinus),
      const SizedBox(width: 6),
      Expanded(
        child: CupertinoTextField(
          controller: controller,
          textAlign: TextAlign.center,
          placeholder: 'none',
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => onChanged(),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()]),
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
          decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(10), border: Border.all(color: color.withValues(alpha: 0.35))),
          suffix: controller.text.isEmpty
              ? null
              : GestureDetector(onTap: onClear, child: Padding(padding: const EdgeInsets.only(right: 8), child: Icon(CupertinoIcons.xmark_circle_fill, size: 17, color: resolve(context, CupertinoColors.tertiaryLabel)))),
        ),
      ),
      const SizedBox(width: 6),
      _Btn(icon: CupertinoIcons.plus, onTap: onPlus),
    ]);
  }
}

class _Btn extends StatelessWidget {
  const _Btn({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: Look.of(context).chip, borderRadius: BorderRadius.circular(10)),
          child: Icon(icon, size: 16),
        ),
      );
}

class _Quick extends StatelessWidget {
  const _Quick(this.label, this.onTap);
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(color: Look.of(context).accent.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(12)),
          child: Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Look.of(context).accent)),
        ),
      );
}

class _Info extends StatelessWidget {
  const _Info(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(color: Look.of(context).chip, borderRadius: BorderRadius.circular(12)),
        child: Text(text, style: TextStyle(fontSize: 12.5, color: resolve(context, CupertinoColors.secondaryLabel))),
      );
}
