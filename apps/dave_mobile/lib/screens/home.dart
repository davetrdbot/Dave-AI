import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/performance.dart';
import '../widgets/common.dart';
import 'mt5_screen.dart';
import 'nous.dart';
import 'shell.dart';

class _HomeData {
  _HomeData(this.dashboard, this.bot);
  final Dashboard dashboard;
  final BotState bot;
}

/// The live dashboard: balance, whether Dave is trading, what is open right now, how it has gone.
///
/// Ordered by what the trader needs first when they pick up the phone between trades: the money,
/// then whether the bot is on, then what is open, then history.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<_HomeData>(
      title: 'Dave',
      autoRefresh: const Duration(seconds: 15),
      load: (api) async {
        final results = await Future.wait([api.dashboard(), api.bot()]);
        return _HomeData(results[0] as Dashboard, results[1] as BotState);
      },
      builder: (context, data, reload) {
        final d = data.dashboard;
        return [
          SliverToBoxAdapter(child: _BalanceCard(d: d)),
          SliverToBoxAdapter(child: _TradingCard(bot: data.bot, eaConnected: d.eaConnected, onChanged: reload)),
          SliverToBoxAdapter(child: _OpenTrades(d: d, onChanged: reload)),
          if (d.pendingOrders.isNotEmpty) SliverToBoxAdapter(child: _PendingOrders(orders: d.pendingOrders)),
          SliverToBoxAdapter(child: PerformanceCard(trades: d.trades)),
          SliverToBoxAdapter(child: _Results(d: d)),
        ];
      },
    );
  }
}

/// The top of Home, in the chosen look's layout: Midnight Lime's grid of tiles, or Pearl's big
/// editorial numbers. Both lead with the money and put Chat, Live, the MT5 screen and Nous one tap
/// away.
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) => switch (Look.of(context).layout) {
        HomeLayout.bento => _Bento(d: d),
        HomeLayout.editorial => _Editorial(d: d),
      };
}

void _openAction(BuildContext context, String what) {
  final shell = ShellScope.of(context);
  switch (what) {
    case 'chat':
      shell?.goTo(ShellScope.chat);
    case 'live':
      shell?.goTo(ShellScope.live);
    case 'screen':
      pushScoped<void>(context, const Mt5ScreenPage());
    case 'nous':
      pushScoped<void>(context, const NousPage());
  }
}

/// Profit or loss of trades closed since midnight, phone time.
double _today(Dashboard d) {
  final now = DateTime.now();
  final midnight = DateTime(now.year, now.month, now.day);
  return d.trades.where((t) => !t.at.isBefore(midnight)).fold(0.0, (s, t) => s + t.pnl);
}

class _Bento extends StatelessWidget {
  const _Bento({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final updated = d.accountUpdatedAt;
    Widget tile({required Widget child, EdgeInsets padding = const EdgeInsets.all(Space.s4)}) =>
        Container(padding: padding, decoration: glassDecoration(context, radius: 26), child: child);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
      child: Column(children: [
        tile(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text('Balance', style: TextStyle(fontSize: 13.5, color: secondary)),
              const Spacer(),
              if (updated != null) Text(formatAgo(updated), style: TextStyle(fontSize: 12, color: secondary)),
            ]),
            const SizedBox(height: 4),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(d.balance == null ? 'Waiting for MT5' : formatMoney(d.balance!),
                  style: const TextStyle(fontSize: 38, fontWeight: FontWeight.w800, letterSpacing: -1.4, fontFeatures: [FontFeature.tabularFigures()])),
            ),
            const SizedBox(height: Space.s2),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(14)),
              child: Row(children: [
                if (d.balance != null) ...[
                  Container(width: 7, height: 7, decoration: BoxDecoration(color: d.eaConnected ? look.accent : look.down, shape: BoxShape.circle)),
                  const SizedBox(width: 7),
                ],
                Expanded(
                  child: Text(
                    d.balance == null ? (d.emptyReason ?? 'Connect MT5 to see a real balance.') : '${d.eaConnected ? 'MT5 live' : 'MT5 offline'}${d.accountName != null ? '  ·  ${d.accountName}' : (d.equity == null ? '' : '  ·  Equity ${formatMoney(d.equity!)}')}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: d.eaConnected ? look.accent : look.down),
                  ),
                ),
              ]),
            ),
            const SizedBox(height: Space.s4),
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              for (final (icon, label, what) in [
                (CupertinoIcons.chat_bubble_2, 'Chat', 'chat'),
                (CupertinoIcons.waveform_path_ecg, 'Live', 'live'),
                (CupertinoIcons.desktopcomputer, 'Screen', 'screen'),
                (CupertinoIcons.antenna_radiowaves_left_right, 'Nous', 'nous'),
              ])
                _RoundAction(icon: icon, label: label, onTap: () => _openAction(context, what)),
            ]),
          ]),
        ),
        const SizedBox(height: 10),
        IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(
              child: tile(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Open P&L', style: TextStyle(fontSize: 13.5, color: secondary)),
                  const SizedBox(height: 6),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(d.positions.isEmpty ? '--' : formatMoney(d.openPnl, signed: true),
                        style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.8, color: d.positions.isEmpty ? null : pnlColor(context, d.openPnl))),
                  ),
                  const SizedBox(height: 2),
                  Text('${d.positions.length} open  ·  today ${formatMoney(_today(d), signed: true)}', style: TextStyle(fontSize: 12.5, color: secondary)),
                ]),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: tile(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Win rate', style: TextStyle(fontSize: 13.5, color: secondary)),
                  const SizedBox(height: 8),
                  _Ring(percent: d.winRatePercent),
                ]),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}

/// The win rate as a ring in the accent colour.
class _Ring extends StatelessWidget {
  const _Ring({required this.percent});
  final int? percent;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return SizedBox(
      width: 66,
      height: 66,
      child: Stack(alignment: Alignment.center, children: [
        SizedBox.expand(
          child: CircularProgressRing(value: (percent ?? 0) / 100, color: look.accent, track: look.chip),
        ),
        Text(percent == null ? '--' : '$percent%', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
      ]),
    );
  }
}

class CircularProgressRing extends StatelessWidget {
  const CircularProgressRing({super.key, required this.value, required this.color, required this.track});
  final double value;
  final Color color;
  final Color track;
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _RingPainter(value.clamp(0, 1), color, track));
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.value, this.color, this.track);
  final double value;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 7.0;
    final rect = Offset.zero & size;
    final r = rect.deflate(stroke / 2);
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = track;
    canvas.drawArc(r, 0, 6.2832, false, base);
    canvas.drawArc(r, -1.5708, 6.2832 * value, false, base..color = color..strokeCap = StrokeCap.round);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.value != value || old.color != color;
}

class _Editorial extends StatelessWidget {
  const _Editorial({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final label = resolve(context, CupertinoColors.label);
    final money = d.balance == null ? null : formatMoney(d.balance!);
    final dot = money?.lastIndexOf('.') ?? -1;
    Widget kpi(String title, String value, [Color? color]) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: TextStyle(fontSize: 13, color: secondary)),
          const SizedBox(height: 2),
          Text(value, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: color ?? label)),
        ]);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s5, Space.s2, Space.s5, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('TOTAL BALANCE', style: TextStyle(fontSize: 12, letterSpacing: 1.6, fontWeight: FontWeight.w600, color: secondary)),
          const SizedBox(width: 12),
          const Spacer(),
          Container(width: 7, height: 7, decoration: BoxDecoration(color: d.eaConnected ? look.up : look.down, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Flexible(child: Text('${d.eaConnected ? 'MT5 live' : 'MT5 offline'}${d.accountName != null ? ' · ${d.accountName}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: secondary))),
        ]),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: money == null
              ? Text('Waiting for MT5', style: TextStyle(fontSize: 40, fontWeight: FontWeight.w800, letterSpacing: -1.6, color: secondary))
              : Text.rich(TextSpan(children: [
                  TextSpan(text: money.substring(0, dot)),
                  TextSpan(text: money.substring(dot), style: TextStyle(color: resolve(context, CupertinoColors.tertiaryLabel))),
                ]), style: const TextStyle(fontSize: 56, fontWeight: FontWeight.w800, letterSpacing: -2.6, fontFeatures: [FontFeature.tabularFigures()])),
        ),
        const SizedBox(height: Space.s3),
        Container(
          padding: const EdgeInsets.symmetric(vertical: Space.s3),
          decoration: BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: look.line))),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            kpi('Open', d.positions.isEmpty ? '--' : formatMoney(d.openPnl, signed: true), d.positions.isEmpty ? null : pnlColor(context, d.openPnl)),
            kpi('Today', formatMoney(_today(d), signed: true), pnlColor(context, _today(d))),
            kpi('Win rate', d.winRatePercent == null ? '--' : '${d.winRatePercent}%'),
          ]),
        ),
        const SizedBox(height: Space.s4),
        Row(children: [
          for (final (i, (icon, text, what)) in [
            (CupertinoIcons.chat_bubble_2, 'Ask Dave', 'chat'),
            (CupertinoIcons.waveform_path_ecg, 'Live', 'live'),
            (CupertinoIcons.desktopcomputer, 'MT5', 'screen'),
          ].indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: GestureDetector(
                onTap: () {
                  HapticFeedback.selectionClick();
                  _openAction(context, what);
                },
                child: Container(
                  height: 50,
                  decoration: BoxDecoration(color: i == 0 ? label : look.chip, borderRadius: BorderRadius.circular(16)),
                  child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Icon(icon, size: 18, color: i == 0 ? look.base : label),
                    const SizedBox(width: 6),
                    Text(text, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: i == 0 ? look.base : label)),
                  ]),
                ),
              ),
            ),
          ],
        ]),
      ]),
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Column(children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(color: look.chip, shape: BoxShape.circle, border: Border.all(color: look.line)),
            child: Icon(icon, size: 22, color: resolve(context, CupertinoColors.label)),
          ),
          const SizedBox(height: 6),
          Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }
}

/// Start / stop, right on the home screen: the most important control in the app should not be
/// two taps deep in settings.
class _TradingCard extends StatefulWidget {
  const _TradingCard({required this.bot, required this.eaConnected, required this.onChanged});
  final BotState bot;
  final bool eaConnected;
  final Future<void> Function() onChanged;

  @override
  State<_TradingCard> createState() => _TradingCardState();
}

class _TradingCardState extends State<_TradingCard> {
  bool? _pending;

  Future<void> _set(bool running) async {
    if (!running) {
      final ok = await confirmDestructive(
        context,
        title: 'Stop autonomous trading?',
        message: 'Dave stops looking for new trades within a few seconds. Open positions are NOT closed -- close them yourself if that is what you want.',
        action: 'Stop trading',
      );
      if (!ok) return;
    }
    if (!mounted) return;
    HapticFeedback.mediumImpact();
    setState(() => _pending = running);
    final scope = AppScope.of(context);
    try {
      await scope.api.updateBot(running: running);
      await widget.onChanged();
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final running = _pending ?? widget.bot.running;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final String detail;
    if (!running) {
      detail = 'Not looking for trades.';
    } else if (!widget.bot.executionEnabled) {
      detail = 'Watching only -- asks before opening a trade. Scans every ${widget.bot.intervalMinutes} min.';
    } else {
      detail = 'Looking for trades every ${widget.bot.intervalMinutes} min.';
    }
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Autonomous trading', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(detail, style: TextStyle(fontSize: 13, color: secondary)),
            ]),
          ),
          const SizedBox(width: Space.s3),
          if (_pending != null) const Padding(padding: EdgeInsets.only(right: Space.s2), child: CupertinoActivityIndicator()),
          CupertinoSwitch(activeTrackColor: Look.of(context).accent, value: running, onChanged: _pending != null ? null : _set),
        ]),
        const SizedBox(height: Space.s3),
        Pill(text: widget.eaConnected ? 'MT5 connected' : 'MT5 not connected', good: widget.eaConnected),
      ]),
    );
  }
}

class _OpenTrades extends StatelessWidget {
  const _OpenTrades({required this.d, required this.onChanged});
  final Dashboard d;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) {
    final header = d.maxOpenTrades == null ? 'Open trades' : 'Open trades  ${d.positions.length} of ${d.maxOpenTrades}';
    if (d.positions.isEmpty) {
      return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: ListHeader(header),
        children: const [
          CupertinoListTile(
            leading: Icon(CupertinoIcons.moon_zzz),
            title: Text('Nothing open right now'),
            subtitle: Text('New trades appear here the moment they open.'),
          ),
        ],
      );
    }
    return CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
      header: ListHeader(header),
      footer: const ListFooter('Tap a trade to close it.'),
      children: [for (final p in d.positions) _PositionTile(p: p, onChanged: onChanged)],
    );
  }
}

class _PositionTile extends StatelessWidget {
  const _PositionTile({required this.p, required this.onChanged});
  final Position p;
  final Future<void> Function() onChanged;

  /// Closing is irreversible and moves real money, so it is always confirmed, and the sheet says
  /// exactly which trade and at roughly what result.
  Future<void> _close(BuildContext context) async {
    final result = p.pnl == null ? '' : ' at about ${formatMoney(p.pnl!, signed: true)}';
    final ok = await confirmDestructive(
      context,
      title: 'Close ${p.symbol} ${p.isBuy ? 'buy' : 'sell'}?',
      message: 'Closes ${p.lots} lots at the market price$result. This cannot be undone.',
      action: 'Close trade',
    );
    if (!ok || !context.mounted) return;
    HapticFeedback.mediumImpact();
    final sent = await runAction(context, (api) => api.closeTrade(p.ticket));
    if (!sent || !context.mounted) return;
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('Close sent'),
        content: const Text('MT5 closes it on its next check-in, usually within seconds. You will get a notification when it is done.'),
        actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
    await onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final levels = [
      '${p.lots} lots at ${formatPrice(p.openPrice)}',
      if (p.sl != null) 'SL ${formatPrice(p.sl!)}',
      if (p.tp != null) 'TP ${formatPrice(p.tp!)}',
    ].join('  ·  ');
    return CupertinoListTile(
      onTap: () => _close(context),
      leading: Icon(p.isBuy ? CupertinoIcons.arrow_up_right : CupertinoIcons.arrow_down_right, color: resolve(context, CupertinoColors.secondaryLabel)),
      title: Text('${p.symbol}  ${p.isBuy ? 'Buy' : 'Sell'}'),
      subtitle: Text(levels),
      trailing: Text(
        p.pnl == null ? '--' : formatMoney(p.pnl!, signed: true),
        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: pnlColor(context, p.pnl), fontFeatures: const [FontFeature.tabularFigures()]),
      ),
    );
  }
}

class _PendingOrders extends StatelessWidget {
  const _PendingOrders({required this.orders});
  final List<PendingOrder> orders;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: ListHeader('PENDING ORDERS  ${orders.length}'),
        children: [
          for (final o in orders)
            CupertinoListTile(
              leading: Icon(CupertinoIcons.clock, color: resolve(context, CupertinoColors.secondaryLabel)),
              title: Text('${o.symbol}  ${o.label}'),
              subtitle: Text('${o.lots} lots at ${formatPrice(o.price)}\n'
                  'SL ${o.sl == null ? 'none' : formatPrice(o.sl!)}  ·  TP ${o.tp == null ? 'none' : formatPrice(o.tp!)}'),
              trailing: const CupertinoListTileChevron(),
              onTap: () => _editStops(context, o),
            ),
        ],
      );
}

/// SL and TP on a pending order, from the phone. Empty removes it.
Future<void> _editStops(BuildContext context, PendingOrder o) async {
  final sl = await promptText(context,
      title: 'Stop loss', message: '${o.symbol} ${o.label} at ${formatPrice(o.price)}. Leave empty for no SL.', initial: o.sl == null ? '' : formatPrice(o.sl!).replaceAll(',', ''),
      keyboardType: const TextInputType.numberWithOptions(decimal: true), action: 'Next');
  if (sl == null || !context.mounted) return;
  final tp = await promptText(context,
      title: 'Take profit', message: 'Leave empty for no TP.', initial: o.tp == null ? '' : formatPrice(o.tp!).replaceAll(',', ''),
      keyboardType: const TextInputType.numberWithOptions(decimal: true), action: 'Set');
  if (tp == null || !context.mounted) return;
  double? parse(String s) => s.trim().isEmpty ? null : double.tryParse(s.replaceAll(',', '').trim());
  if ((sl.trim().isNotEmpty && parse(sl) == null) || (tp.trim().isNotEmpty && parse(tp) == null)) {
    await showError(context, 'Enter prices as numbers, e.g. 2645.5');
    return;
  }
  if (await runAction(context, (api) => api.setStops(o.ticket, sl: parse(sl), tp: parse(tp))) && context.mounted) {
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('Sent to MT5'),
        content: const Text('The new SL / TP shows here on the EA\'s next report, in a few seconds.'),
        actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }
}

class _Results extends StatelessWidget {
  const _Results({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) => ContentCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SectionLabel('All time'),
          const SizedBox(height: Space.s3),
          Row(children: [
            Expanded(child: StatTile(value: d.winRatePercent == null ? '--' : '${d.winRatePercent}%', label: 'Win rate')),
            Expanded(child: StatTile(value: '${d.wins}/${d.losses}', label: 'Won / lost')),
            Expanded(
              child: StatTile(
                value: d.closedTrades == 0 ? '--' : formatMoney(d.realisedPnl, signed: true),
                label: 'Realised',
                color: d.closedTrades == 0 ? null : pnlColor(context, d.realisedPnl),
              ),
            ),
          ]),
        ]),
      );
}
