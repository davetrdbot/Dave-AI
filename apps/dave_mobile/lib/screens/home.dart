import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
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

/// The hero: the balance on a purple gradient, with round buttons to what the trader reaches for
/// most -- Dave's chat, the live loop, the MT5 screen, Nous.
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    const white = CupertinoColors.white;
    const soft = Color(0xCCFFFFFF);
    final updated = d.accountUpdatedAt;
    final shell = ShellScope.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, Space.s2),
      padding: const EdgeInsets.fromLTRB(Space.s5, Space.s5, Space.s5, Space.s4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(30),
        gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF6D5BFF), Color(0xFFA27BFF), Color(0xFF4A35C9)]),
        border: Border.all(color: const Color(0x40FFFFFF), width: 0.8),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Text('Main account', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: soft)),
          const Spacer(),
          if (d.balance != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(color: const Color(0x26FFFFFF), borderRadius: BorderRadius.circular(20)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(width: 7, height: 7, decoration: BoxDecoration(color: d.eaConnected ? const Color(0xFFB8F36A) : const Color(0xFFFF8A8A), shape: BoxShape.circle)),
                const SizedBox(width: 6),
                Text(d.eaConnected ? 'MT5 live' : 'MT5 offline', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: white)),
              ]),
            ),
        ]),
        const SizedBox(height: Space.s2),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            d.balance == null ? 'Waiting for MT5' : formatMoney(d.balance!),
            style: const TextStyle(fontSize: 42, fontWeight: FontWeight.w700, letterSpacing: -1.4, color: white, fontFeatures: [FontFeature.tabularFigures()]),
          ),
        ),
        Text(
          d.balance == null
              ? (d.emptyReason ?? 'Connect the MT5 terminal to see a real balance.')
              : [
                  if (d.equity != null) 'Equity ${formatMoney(d.equity!)}',
                  if (d.positions.isNotEmpty) 'Open ${formatMoney(d.openPnl, signed: true)}',
                  if (updated != null) formatAgo(updated),
                ].join('  ·  '),
          style: const TextStyle(fontSize: 13.5, color: soft),
        ),
        const SizedBox(height: Space.s5),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          _RoundAction(icon: CupertinoIcons.chat_bubble_2_fill, label: 'Chat', onTap: () => shell?.goTo(ShellScope.chat)),
          _RoundAction(icon: CupertinoIcons.waveform_path_ecg, label: 'Live', onTap: () => shell?.goTo(ShellScope.live)),
          _RoundAction(icon: CupertinoIcons.desktopcomputer, label: 'MT5 screen', onTap: () => pushScoped<void>(context, const Mt5ScreenPage())),
          _RoundAction(icon: CupertinoIcons.antenna_radiowaves_left_right, label: 'Nous', onTap: () => pushScoped<void>(context, const NousPage())),
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
  Widget build(BuildContext context) => Semantics(
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
              width: 56,
              height: 56,
              decoration: BoxDecoration(color: const Color(0x2EFFFFFF), shape: BoxShape.circle, border: Border.all(color: const Color(0x40FFFFFF), width: 0.8)),
              child: Icon(icon, size: 24, color: CupertinoColors.white),
            ),
            const SizedBox(height: 6),
            Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: CupertinoColors.white)),
          ]),
        ),
      );
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
          CupertinoSwitch(value: running, onChanged: _pending != null ? null : _set),
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
